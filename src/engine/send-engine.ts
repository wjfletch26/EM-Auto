/**
 * Send Engine — orchestrates a single outbound email send cycle.
 *
 * Flow: Read Sheets → evaluate eligibility → render templates → send via SMTP → update Sheets.
 * Called by the scheduler on each cron tick.
 *
 * Uses a simple mutex to prevent overlapping cycles.
 *
 * Reference: specs/SEND_ENGINE.md
 */

import fs from 'node:fs';
import path from 'node:path';
import Handlebars from 'handlebars';
import { config } from '../config/index.js';
import { logger } from '../logging/logger.js';
import * as sheets from '../services/sheets.js';
import { sendEmail, extractSmtpCode } from '../services/smtp.js';
import { evaluateContact } from './sequence-engine.js';
import { generateUnsubscribeUrl } from './unsubscribe.js';
import { classifySmtpError, recordBounce } from './bounce-handler.js';
import {
  savePendingSends, clearPendingSends, saveLastRun,
  type PendingContact,
} from '../state/local-store.js';
import type { Contact, Campaign, CampaignStep } from '../services/sheets-types.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SendRunResult {
  runId: string;
  startedAt: string;
  completedAt: string;
  eligible: number;
  sent: number;
  failed: number;
  skipped: number;
  durationMs: number;
}

// ─── Mutex ───────────────────────────────────────────────────────────────────

let sendCycleRunning = false;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Generates a run ID in the format "run_YYYYMMDD_HHmmss". */
function generateRunId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `run_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** Sleep for the given number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Strips HTML tags to produce a plain-text version of the email body. */
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Loads a Handlebars template file from the templates/ directory.
 * Returns null if the file doesn't exist (the campaign is skipped).
 */
function loadTemplate(templateFile: string): string | null {
  const templatePath = path.resolve('templates', templateFile);
  try {
    return fs.readFileSync(templatePath, 'utf-8');
  } catch {
    logger.error(
      { module: 'send-engine', templateFile, path: templatePath },
      'Template file not found — skipping campaign',
    );
    return null;
  }
}

// ─── Main send cycle ─────────────────────────────────────────────────────────

/**
 * Executes a single send cycle. Returns null if a previous cycle is still running.
 *
 * Steps:
 * 1. Load contacts, campaigns from Sheets
 * 2. Filter eligible contacts via sequence engine
 * 3. Cap to SEND_BATCH_SIZE
 * 4. For each: render template → send email → update Sheets
 * 5. Write run summary to local state
 */
export async function executeSendCycle(): Promise<SendRunResult | null> {
  // Mutex — prevent overlapping cycles
  if (sendCycleRunning) {
    logger.info({ module: 'send-engine' }, 'Send cycle skipped: previous run in progress');
    return null;
  }

  sendCycleRunning = true;
  const runId = generateRunId();
  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  logger.info({ module: 'send-engine', runId }, 'Send cycle starting');

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  let eligibleCount = 0;

  try {
    // Step 1: Read data from Sheets
    const [contacts, campaigns] = await Promise.all([
      sheets.getContacts(),
      sheets.getCampaigns(),
    ]);

    // Build a campaign lookup map for fast access
    const campaignMap = new Map<string, Campaign>();
    for (const c of campaigns) {
      campaignMap.set(c.campaignId, c);
    }

    // Step 2: Evaluate eligibility for every contact
    const now = new Date();
    const eligible: Array<{ contact: Contact; step: CampaignStep }> = [];

    for (const contact of contacts) {
      const campaign = campaignMap.get(contact.campaignId);
      const result = evaluateContact(contact, campaign, now);

      if (result.eligible && result.nextStep) {
        eligible.push({ contact, step: result.nextStep });
      } else {
        logger.debug(
          { module: 'send-engine', email: contact.email, reason: result.reason },
          'Contact not eligible',
        );
      }
    }

    eligibleCount = eligible.length;

    if (eligibleCount === 0) {
      logger.info({ module: 'send-engine', runId }, 'No eligible contacts this cycle');
      return buildResult(runId, startedAt, startMs, 0, 0, 0, 0);
    }

    // Step 3: Cap to batch size
    const batch = eligible.slice(0, config.schedule.sendBatchSize);
    skipped = eligibleCount - batch.length;

    logger.info(
      { module: 'send-engine', runId, eligible: eligibleCount, batch: batch.length, skipped },
      'Eligible contacts identified',
    );

    // Step 4: Write pending-sends state for crash recovery
    const pendingContacts: PendingContact[] = batch.map((b) => ({
      email: b.contact.email,
      step: b.step.stepNumber,
      status: 'queued' as const,
    }));
    savePendingSends({ run_id: runId, started_at: startedAt, contacts: pendingContacts });

    // Step 5: Send each email sequentially with delay between sends
    for (let i = 0; i < batch.length; i++) {
      const { contact, step } = batch[i];
      const campaign = campaignMap.get(contact.campaignId)!;

      try {
        // Load the template
        const templateSource = loadTemplate(step.templateFile);
        if (templateSource === null) {
          skipped++;
          updatePendingStatus(pendingContacts, i, 'failed');
          continue;
        }

        // Build the template context
        const unsubscribeUrl = generateUnsubscribeUrl(contact.email);
        const context = {
          first_name: contact.firstName,
          last_name: contact.lastName,
          company: contact.company,
          title: contact.title,
          custom_1: contact.custom1,
          custom_2: contact.custom2,
          unsubscribe_url: unsubscribeUrl,
          physical_address: config.app.physicalAddress,
        };

        // Render HTML body and subject line
        const html = Handlebars.compile(templateSource)(context);
        const subject = Handlebars.compile(step.subject)(context);
        const text = stripHtml(html);

        // Update pending state to "sending"
        updatePendingStatus(pendingContacts, i, 'sending');
        savePendingSends({ run_id: runId, started_at: startedAt, contacts: pendingContacts });

        // Send the email
        const result = await sendEmail({
          to: contact.email,
          from: { name: config.smtp.fromName, address: config.smtp.user },
          subject,
          html,
          text,
          headers: {
            'List-Unsubscribe': `<${unsubscribeUrl}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          },
        });

        // Check for rejected recipients (rare — usually throws instead)
        if (result.rejected.length > 0) {
          await handleRejection(contact, result.rejected[0]);
          failed++;
          updatePendingStatus(pendingContacts, i, 'failed');
        } else {
          // Success — update Sheets
          const isLastStep = step.stepNumber >= campaign.totalSteps;
          await recordSuccess(contact, campaign, step, result.messageId, isLastStep);
          sent++;
          updatePendingStatus(pendingContacts, i, 'sent');
        }
      } catch (err: unknown) {
        // SMTP send error — classify and record
        await handleSmtpError(contact, campaign, step, err);
        failed++;
        updatePendingStatus(pendingContacts, i, 'failed');
      }

      // Delay between sends (skip after the last one)
      if (i < batch.length - 1 && config.schedule.sendDelayMs > 0) {
        await sleep(config.schedule.sendDelayMs);
      }
    }

    // Step 6: Clean up pending state
    clearPendingSends();

  } catch (err: unknown) {
    // Top-level error (Sheets read failure, auth failure, etc.) — halt the cycle
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ module: 'send-engine', runId, error: message }, 'Send cycle failed');
    throw err;
  } finally {
    sendCycleRunning = false;
  }

  // Step 7: Write run summary and return
  const result = buildResult(runId, startedAt, startMs, eligibleCount, sent, failed, skipped);

  saveLastRun({
    timestamp: result.completedAt,
    contacts_eligible: result.eligible,
    contacts_sent: result.sent,
    contacts_failed: result.failed,
    contacts_skipped: result.skipped,
    duration_ms: result.durationMs,
  });

  logger.info(
    { module: 'send-engine', runId, sent, failed, skipped, durationMs: result.durationMs },
    'Send cycle complete',
  );

  return result;
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/** Builds the final SendRunResult. */
function buildResult(
  runId: string, startedAt: string, startMs: number,
  eligible: number, sent: number, failed: number, skipped: number,
): SendRunResult {
  const completedAt = new Date().toISOString();
  return { runId, startedAt, completedAt, eligible, sent, failed, skipped, durationMs: Date.now() - startMs };
}

/** Updates the status of a pending contact in the local array. */
function updatePendingStatus(
  contacts: PendingContact[], index: number, status: PendingContact['status'],
): void {
  contacts[index].status = status;
}

/** Records a successful send in Sheets (Send Log + Contact update). */
async function recordSuccess(
  contact: Contact, campaign: Campaign, step: CampaignStep,
  messageId: string, isLastStep: boolean,
): Promise<void> {
  // Append to Send Log
  await sheets.appendSendLog({
    timestamp: new Date().toISOString(),
    contactEmail: contact.email,
    campaignId: campaign.campaignId,
    step: step.stepNumber,
    status: 'sent',
    messageId,
    errorMessage: '',
    templateUsed: step.templateFile,
  });

  // Update the contact row
  await sheets.updateContact(contact.email, contact._rowIndex, {
    lastStepSent: step.stepNumber,
    lastSendDate: new Date().toISOString(),
    status: isLastStep ? 'sequence_complete' : 'active',
  });
}

/** Handles SMTP send errors — classifies bounces and logs failures. */
async function handleSmtpError(
  contact: Contact, campaign: Campaign, step: CampaignStep, err: unknown,
): Promise<void> {
  const error = err instanceof Error ? err : new Error(String(err));
  const code = extractSmtpCode(error as Error & { responseCode?: number });
  const bounceType = code ? classifySmtpError(code, error.message) : null;

  logger.error(
    { module: 'send-engine', email: contact.email, code, error: error.message },
    'SMTP send failed',
  );

  if (bounceType) {
    // Record the bounce (updates Sheets contact row)
    await recordBounce({
      contactEmail: contact.email,
      bounceType,
      errorCode: code ? String(code) : undefined,
      errorMessage: error.message,
      source: 'smtp',
    });
  }

  // Always append to Send Log regardless of bounce classification
  try {
    await sheets.appendSendLog({
      timestamp: new Date().toISOString(),
      contactEmail: contact.email,
      campaignId: campaign.campaignId,
      step: step.stepNumber,
      status: bounceType ? 'bounced' : 'failed',
      messageId: '',
      errorMessage: error.message.slice(0, 500),
      templateUsed: step.templateFile,
    });
  } catch (logErr: unknown) {
    // Sheets write failure after send — log but don't throw (send already failed)
    const msg = logErr instanceof Error ? logErr.message : String(logErr);
    logger.error({ module: 'send-engine', error: msg }, 'Failed to write send log entry');
  }
}

/** Handles rejected recipients (accepted by server but recipient rejected). */
async function handleRejection(contact: Contact, _rejection: string): Promise<void> {
  const bounceType = classifySmtpError(550, 'Recipient rejected');
  if (bounceType) {
    await recordBounce({
      contactEmail: contact.email,
      bounceType,
      errorCode: '550',
      errorMessage: 'Recipient rejected by server',
      source: 'smtp',
    });
  }
}
