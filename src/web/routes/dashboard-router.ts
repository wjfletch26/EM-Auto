/**
 * All `/api/dashboard/*` routes — public summary plus token-protected list + mutation APIs.
 */

import express, { type Request, type RequestHandler, type Response, type Router } from 'express';
import { z } from 'zod';
import { config } from '../../config/index.js';
import { runApprovalWatcherCycle } from '../../engine/approval-watcher.js';
import { runPipelineCycle } from '../../engine/pipeline-orchestrator.js';
import { logger } from '../../logging/logger.js';
import { runPipelineForContact } from '../../ops/pipeline-contact-run.js';
import { regenerateReviewQueueRow } from '../../ops/regenerate-review-queue-row.js';
import {
  deleteReviewQueueRow,
  getCompanyIntelligence,
  getCompanyProfiles,
  getContacts,
  getReviewQueue,
  updateCompanyIntelligence,
  updateCompanyProfileRow,
  updateContact,
  updateReviewQueueEntry,
} from '../../services/sheets.js';
import type { CompanyIntelUpdate, ContactUpdate, StoredCompanyProfile } from '../../services/sheets-types.js';
import { COMPANY_PROFILE_FIELD_TO_COLUMN, FIELD_TO_COLUMN, INTEL_FIELD_TO_COLUMN } from '../../services/sheets-types.js';
import { createRateLimiterMiddleware } from '../../utils/rate-limiter.js';
import { buildDashboardSummary } from '../dashboard-summary.js';
import { requireDashboardAuth } from '../dashboard-auth.js';
import { dashboardSummaryHandler } from './dashboard-api.js';

const summaryLimiter = createRateLimiterMiddleware({ maxRequests: 24, windowMs: 60_000 });
const protectedLimiter = createRateLimiterMiddleware({ maxRequests: 48, windowMs: 60_000 });

function parseSheetRow(param: string | string[] | undefined): number {
  const raw = Array.isArray(param) ? param[0] : param;
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n < 2) throw new Error('Invalid row index (must be integer >= 2)');
  return n;
}

function parseContactUpdates(body: unknown): Partial<ContactUpdate> {
  if (!body || typeof body !== 'object') throw new Error('Request body must be a JSON object');
  const src = body as Record<string, unknown>;
  const out: Partial<ContactUpdate> = {};
  const keys = Object.keys(FIELD_TO_COLUMN) as (keyof ContactUpdate)[];
  for (const key of keys) {
    if (src[key] === undefined) continue;
    const v = src[key];
    if (key === 'unsubscribed' || key === 'bounced') {
      (out as Record<string, unknown>)[key] = Boolean(v);
    } else if (key === 'lastStepSent' || key === 'softBounceCount') {
      (out as Record<string, unknown>)[key] = Number(v);
    } else {
      (out as Record<string, unknown>)[key] = String(v);
    }
  }
  return out;
}

function parseIntelUpdates(body: unknown): Partial<CompanyIntelUpdate> {
  if (!body || typeof body !== 'object') throw new Error('Request body must be a JSON object');
  const src = body as Record<string, unknown>;
  const out: Partial<CompanyIntelUpdate> = {};
  const keys = Object.keys(INTEL_FIELD_TO_COLUMN) as (keyof CompanyIntelUpdate)[];
  for (const key of keys) {
    if (src[key] === undefined) continue;
    (out as Record<string, unknown>)[key] = String(src[key]);
  }
  return out;
}

/** Dashboard PATCH body: any profile column except A (`canonical_company_url`), which stays stable per row. */
function parseCompanyProfileUpdates(
  body: unknown,
): Partial<Omit<StoredCompanyProfile, '_rowIndex' | 'canonicalCompanyUrl'>> {
  if (!body || typeof body !== 'object') throw new Error('Request body must be a JSON object');
  const src = body as Record<string, unknown>;
  const out: Partial<Omit<StoredCompanyProfile, '_rowIndex' | 'canonicalCompanyUrl'>> = {};
  const keys = Object.keys(COMPANY_PROFILE_FIELD_TO_COLUMN) as (keyof StoredCompanyProfile)[];
  for (const key of keys) {
    if (key === 'canonicalCompanyUrl' || key === '_rowIndex') continue;
    if (src[key] === undefined) continue;
    (out as Record<string, unknown>)[key] = String(src[key]);
  }
  return out;
}

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res) => {
    void fn(req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ module: 'web', route: 'dashboard', error: message }, 'Dashboard route failed');
      if (!res.headersSent) {
        res.status(500).json({ error: message });
      }
    });
  };

export function createDashboardRouter(): Router {
  const router = express.Router();
  router.use(express.json({ limit: '4mb' }));

  router.get('/summary', summaryLimiter, dashboardSummaryHandler);

  const guard: RequestHandler[] = [protectedLimiter, requireDashboardAuth];

  router.get(
    '/contacts',
    ...guard,
    wrap(async (_req, res) => {
      const contacts = await getContacts();
      res.set('Cache-Control', 'no-store');
      res.json({ contacts });
    }),
  );

  router.get(
    '/review-queue',
    ...guard,
    wrap(async (_req, res) => {
      const entries = await getReviewQueue();
      res.set('Cache-Control', 'no-store');
      res.json({ entries });
    }),
  );

  router.get(
    '/intelligence',
    ...guard,
    wrap(async (_req, res) => {
      const rows = await getCompanyIntelligence();
      res.set('Cache-Control', 'no-store');
      res.json({ rows });
    }),
  );

  router.get(
    '/snapshot',
    ...guard,
    wrap(async (_req, res) => {
      const [contacts, intel, queue, profiles] = await Promise.all([
        getContacts(),
        getCompanyIntelligence(),
        getReviewQueue(),
        getCompanyProfiles(),
      ]);
      res.set('Cache-Control', 'no-store');
      res.json({
        summary: buildDashboardSummary(contacts, intel, queue, profiles),
        contacts,
        intelligence: intel,
        companyProfiles: profiles,
        reviewQueue: queue,
      });
    }),
  );

  const contactPatchSchema = z.object({
    email: z.string().email(),
    updates: z.record(z.unknown()),
  });

  router.patch(
    '/contacts',
    ...guard,
    wrap(async (req, res) => {
      const parsed = contactPatchSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
        return;
      }
      const email = parsed.data.email.trim().toLowerCase();
      const updates = parseContactUpdates(parsed.data.updates);
      if (Object.keys(updates).length === 0) {
        res.status(400).json({ error: 'No valid contact fields in updates' });
        return;
      }
      const contacts = await getContacts();
      const contact = contacts.find((c) => c.email === email);
      if (!contact) {
        res.status(404).json({ error: 'Contact not found' });
        return;
      }
      await updateContact(contact.email, contact._rowIndex, updates);
      res.json({ ok: true, email, updatedFields: Object.keys(updates) });
    }),
  );

  router.patch(
    '/intelligence/:rowIndex',
    ...guard,
    wrap(async (req, res) => {
      const rowIndex = parseSheetRow(req.params.rowIndex);
      const updates = parseIntelUpdates(req.body);
      if (Object.keys(updates).length === 0) {
        res.status(400).json({ error: 'No valid intelligence fields in body' });
        return;
      }
      const rows = await getCompanyIntelligence();
      const row = rows.find((r) => r._rowIndex === rowIndex);
      if (!row) {
        res.status(404).json({ error: 'Intelligence row not found' });
        return;
      }
      await updateCompanyIntelligence(row.contactEmail, rowIndex, updates);
      res.json({ ok: true, rowIndex, updatedFields: Object.keys(updates) });
    }),
  );

  router.patch(
    '/company-profiles/:rowIndex',
    ...guard,
    wrap(async (req, res) => {
      const rowIndex = parseSheetRow(req.params.rowIndex);
      const updates = parseCompanyProfileUpdates(req.body);
      if (Object.keys(updates).length === 0) {
        res.status(400).json({ error: 'No valid company profile fields in body' });
        return;
      }
      const profiles = await getCompanyProfiles();
      const row = profiles.find((p) => p._rowIndex === rowIndex);
      if (!row) {
        res.status(404).json({ error: 'Company profile row not found' });
        return;
      }
      await updateCompanyProfileRow(row.canonicalCompanyUrl, rowIndex, updates);
      res.json({ ok: true, rowIndex, updatedFields: Object.keys(updates) });
    }),
  );

  const reviewPatchSchema = z
    .object({
      status: z.string().optional(),
      reviewerNotes: z.string().optional(),
      approvedDate: z.string().optional(),
      campaignId: z.string().optional(),
      subject: z.string().optional(),
      body: z.string().optional(),
      daveNotes: z.string().optional(),
    })
    .strict();

  router.patch(
    '/review-queue/:rowIndex',
    ...guard,
    wrap(async (req, res) => {
      const rowIndex = parseSheetRow(req.params.rowIndex);
      const parsed = reviewPatchSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
        return;
      }
      const queue = await getReviewQueue();
      if (!queue.some((e) => e._rowIndex === rowIndex)) {
        res.status(404).json({ error: 'Review queue row not found' });
        return;
      }
      const updates = Object.fromEntries(
        Object.entries(parsed.data).filter(([, v]) => v !== undefined),
      ) as Record<string, string>;
      await updateReviewQueueEntry(rowIndex, updates);
      res.json({ ok: true, rowIndex, updatedFields: Object.keys(updates) });
    }),
  );

  const appendNotesSchema = z.object({ text: z.string().min(1) }).strict();

  router.post(
    '/review-queue/:rowIndex/notes/append',
    ...guard,
    wrap(async (req, res) => {
      const rowIndex = parseSheetRow(req.params.rowIndex);
      const parsed = appendNotesSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
        return;
      }
      const queue = await getReviewQueue();
      const entry = queue.find((e) => e._rowIndex === rowIndex);
      if (!entry) {
        res.status(404).json({ error: 'Review queue row not found' });
        return;
      }
      const suffix = parsed.data.text.startsWith('\n') ? parsed.data.text : `\n${parsed.data.text}`;
      const reviewerNotes = `${entry.reviewerNotes || ''}${suffix}`.slice(0, 4800);
      await updateReviewQueueEntry(rowIndex, { reviewerNotes });
      res.json({ ok: true, rowIndex });
    }),
  );

  const regenSchema = z.object({ daveNotes: z.string().optional() }).strict();

  router.post(
    '/review-queue/:rowIndex/regenerate',
    ...guard,
    wrap(async (req, res) => {
      const rowIndex = parseSheetRow(req.params.rowIndex);
      const parsed = regenSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
        return;
      }
      const result = await regenerateReviewQueueRow(rowIndex, {
        daveNotesOverride: parsed.data.daveNotes,
      });
      res.json({ ok: true, rowIndex, ...result });
    }),
  );

  router.delete(
    '/review-queue/:rowIndex',
    ...guard,
    wrap(async (req, res) => {
      const rowIndex = parseSheetRow(req.params.rowIndex);
      const queue = await getReviewQueue();
      if (!queue.some((e) => e._rowIndex === rowIndex)) {
        res.status(404).json({ error: 'Review queue row not found' });
        return;
      }
      await deleteReviewQueueRow(rowIndex);
      res.json({ ok: true, rowIndex });
    }),
  );

  const pipelineSchema = z
    .object({
      email: z.string().email(),
      reset: z.enum(['auto', 'new', 'alignment_complete']).optional(),
    })
    .strict();

  router.post(
    '/pipeline/run-contact',
    ...guard,
    wrap(async (req, res) => {
      const parsed = pipelineSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
        return;
      }
      const out = await runPipelineForContact(parsed.data.email, parsed.data.reset ?? 'auto');
      res.json({ ok: true, ...out });
    }),
  );

  router.post(
    '/pipeline/run-cycle',
    ...guard,
    wrap(async (_req, res) => {
      if (!config.pipeline.enabled) {
        res.status(400).json({ error: 'PIPELINE_ENABLED is false' });
        return;
      }
      await runPipelineCycle();
      await runApprovalWatcherCycle();
      logger.info({ module: 'web', route: 'dashboard' }, 'Manual full pipeline + approval cycle completed');
      res.json({ ok: true, message: 'runPipelineCycle + runApprovalWatcherCycle finished' });
    }),
  );

  return router;
}
