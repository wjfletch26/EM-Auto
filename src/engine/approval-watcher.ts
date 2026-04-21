/**
 * Approval Watcher — detects approved emails and loads them into the send pipeline.
 *
 * Scans the Review Queue for contacts where all 12 emails have status = 'approved'.
 * When found, creates a campaign entry and marks the contact as ready to send.
 */

import { logger } from '../logging/logger.js';
import * as sheets from '../services/sheets.js';
import type { ReviewQueueEntry } from '../services/sheets-types.js';

/**
 * Runs a single approval check cycle. Called by the cron scheduler.
 *
 * For each contact with all 12 emails approved:
 * 1. Generate a campaign_id
 * 2. Write a campaign row to the Campaigns tab
 * 3. Update the contact's pipeline_status to 'approved'
 * 4. Mark review queue rows with the campaign_id
 */
export async function runApprovalWatcherCycle(): Promise<void> {
  try {
    const [reviewQueue, contacts] = await Promise.all([
      sheets.getReviewQueue(),
      sheets.getContacts(),
    ]);

    // Group review queue entries by contact email
    const byEmail = new Map<string, ReviewQueueEntry[]>();
    for (const entry of reviewQueue) {
      if (!entry.contactEmail) continue;
      const list = byEmail.get(entry.contactEmail) || [];
      list.push(entry);
      byEmail.set(entry.contactEmail, list);
    }

    // Find contacts where all 12 emails are approved and no campaign_id assigned yet
    for (const [email, entries] of byEmail) {
      const approved = entries.filter((e) => e.status === 'approved');
      const alreadyLoaded = entries.some((e) => e.campaignId);

      if (approved.length < 12 || alreadyLoaded) continue;

      // All 12 approved and not yet loaded — create campaign
      const contact = contacts.find((c) => c.email === email);
      if (!contact) {
        logger.warn({ module: 'approval-watcher', email }, 'Contact not found for approved emails');
        continue;
      }

      logger.info({ module: 'approval-watcher', email }, 'All 12 emails approved — creating campaign');

      // Generate a unique campaign_id
      const slug = contact.company.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30);
      const campaignId = `ai_${slug}_${Date.now()}`;

      // Sort entries by step number for correct ordering
      const sorted = [...approved].sort((a, b) => a.stepNumber - b.stepNumber);

      // Build the campaign row values (up to 12 steps × 3 cols each)
      // Format: id, name, total_steps, [step_N_template, step_N_subject, step_N_delay_days] × 12, active, campaign_type
      const stepValues: string[] = [];
      for (let s = 0; s < 12; s++) {
        const entry = sorted[s];
        if (entry) {
          // For AI-generated campaigns, the template field stores a reference key
          stepValues.push(
            `ai_review_queue:${entry._rowIndex}`,
            entry.subject,
            s === 0 ? '0' : '30', // First step immediate, rest use 30-day cadence
          );
        } else {
          stepValues.push('', '', '');
        }
      }

      // Build full row: campaign_id, name, total_steps, ...steps, active, campaign_type
      const campaignRow = [
        campaignId,
        `AI: ${contact.company}`,
        '12',
        ...stepValues,
        'TRUE',
        'ai_generated',
      ];

      // Append the campaign row
      const sheetsClient = await getSheetsClientForAppend();
      await sheetsClient.spreadsheets.values.append({
        spreadsheetId: getSpreadsheetId(),
        range: 'Campaigns!A:AO',
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [campaignRow] },
      });

      // Update Review Queue rows with campaign_id
      for (const entry of sorted) {
        await sheets.updateReviewQueueEntry(entry._rowIndex, {
          campaignId,
          approvedDate: new Date().toISOString(),
        });
      }

      // Update the contact to use the new campaign and mark as ready
      await sheets.updateContact(email, contact._rowIndex, {
        status: 'new',
        lastStepSent: 0,
        pipelineStatus: 'approved',
      });

      // Also update the campaignId on the contact row directly
      const directSheets = await getSheetsClientForAppend();
      await directSheets.spreadsheets.values.update({
        spreadsheetId: getSpreadsheetId(),
        range: `Contacts!F${contact._rowIndex}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[campaignId]] },
      });

      logger.info(
        { module: 'approval-watcher', email, campaignId },
        'Campaign created and contact updated',
      );
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ module: 'approval-watcher', error: msg }, 'Approval watcher cycle failed');
  }
}

// ─── Helpers for direct Sheets access ────────────────────────────────────────
// The approval watcher needs to append campaigns, which isn't covered by the
// standard sheets service functions. We reuse the authenticated client.

import { google, type sheets_v4 } from 'googleapis';
import { config } from '../config/index.js';

let cachedClient: sheets_v4.Sheets | null = null;

async function getSheetsClientForAppend(): Promise<sheets_v4.Sheets> {
  if (cachedClient) return cachedClient;
  const auth = new google.auth.GoogleAuth({
    keyFile: config.google.serviceAccountPath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  cachedClient = google.sheets({ version: 'v4', auth });
  return cachedClient;
}

function getSpreadsheetId(): string {
  return config.google.spreadsheetId;
}
