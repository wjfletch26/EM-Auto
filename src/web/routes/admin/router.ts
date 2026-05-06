/**
 * Admin REST API — CRUD on Sheets-backed contacts, company intelligence, review queue,
 * and actions to run send cycle, pipeline, and approval watcher.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { config } from '../../../config/index.js';
import { logger } from '../../../logging/logger.js';
import * as sheets from '../../../services/sheets.js';
import type {
  ContactUpdate,
  ContactProfileUpdate,
  CompanyIntelUpdate,
  ReviewQueueUpdate,
} from '../../../services/sheets-types.js';
import { executeSendCycle } from '../../../engine/send-engine.js';
import { runPipelineCycle } from '../../../engine/pipeline-orchestrator.js';
import { runApprovalWatcherCycle } from '../../../engine/approval-watcher.js';

const ENGINE_FIELDS = new Set<string>([
  'status',
  'lastStepSent',
  'lastSendDate',
  'replyStatus',
  'replyDate',
  'replySnippet',
  'unsubscribed',
  'unsubscribeDate',
  'unsubscribeSource',
  'bounced',
  'bounceType',
  'bounceDate',
  'softBounceCount',
  'pipelineStatus',
]);

const PROFILE_FIELDS = new Set<string>([
  'firstName',
  'lastName',
  'company',
  'title',
  'campaignId',
  'custom1',
  'custom2',
  'notes',
  'companyUrl',
]);

function adminLog(req: Request, extra: Record<string, unknown>): void {
  logger.info({ module: 'admin-api', method: req.method, path: req.path, ...extra }, 'admin request');
}

function parseEmailParam(req: Request): string {
  return decodeURIComponent(String(req.params.email || '')).trim().toLowerCase();
}

function partitionContactPatch(body: Record<string, unknown>): {
  engine: Partial<ContactUpdate>;
  profile: Partial<ContactProfileUpdate>;
} {
  const engine: Partial<ContactUpdate> = {};
  const profile: Partial<ContactProfileUpdate> = {};

  for (const [key, value] of Object.entries(body)) {
    if (key === 'email' || key === '_rowIndex') continue;
    if (ENGINE_FIELDS.has(key)) {
      (engine as Record<string, unknown>)[key] = coerceEngineValue(key, value);
    } else if (PROFILE_FIELDS.has(key)) {
      (profile as Record<string, unknown>)[key] = value === null || value === undefined ? '' : String(value);
    }
  }

  return { engine, profile };
}

function coerceEngineValue(key: string, value: unknown): unknown {
  if (value === null || value === undefined) {
    if (key === 'lastStepSent' || key === 'softBounceCount') return 0;
    if (
      key === 'unsubscribed' ||
      key === 'bounced'
    ) {
      return false;
    }
    return '';
  }
  if (key === 'lastStepSent' || key === 'softBounceCount') {
    return typeof value === 'number' ? value : parseInt(String(value), 10) || 0;
  }
  if (key === 'unsubscribed' || key === 'bounced') {
    if (typeof value === 'boolean') return value;
    return String(value).toUpperCase() === 'TRUE';
  }
  return value;
}

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    void fn(req, res, next).catch(next);
  };
}

export function createAdminRouter(): Router {
  const r = Router();

  // SAFE_MODE: inspection (GET) only — no sheet mutations or automation triggers.
  r.use((req, res, next) => {
    if (req.method === 'GET') {
      next();
      return;
    }
    if (config.app.safeMode) {
      res.status(503).json({
        error:
          'SAFE_MODE is enabled: POST/PATCH and automation actions are disabled. Use GET for inspection only.',
      });
      return;
    }
    next();
  });

  r.get(
    '/contacts',
    asyncHandler(async (req, res, _next) => {
      const limit = Math.min(parseInt(String(req.query.limit || '500'), 10) || 500, 2000);
      const contacts = await sheets.getContacts();
      adminLog(req, { action: 'list_contacts', count: contacts.length });
      res.json({ contacts: contacts.slice(0, limit) });
    }),
  );

  r.post(
    '/contacts',
    asyncHandler(async (req, res, _next) => {
      const body = req.body as Record<string, unknown>;
      adminLog(req, { action: 'create_contact', email: body.email });
      await sheets.appendContact({
        email: String(body.email || ''),
        firstName: String(body.firstName || ''),
        lastName: body.lastName !== undefined ? String(body.lastName) : undefined,
        company: body.company !== undefined ? String(body.company) : undefined,
        title: body.title !== undefined ? String(body.title) : undefined,
        campaignId: body.campaignId !== undefined ? String(body.campaignId) : undefined,
        custom1: body.custom1 !== undefined ? String(body.custom1) : undefined,
        custom2: body.custom2 !== undefined ? String(body.custom2) : undefined,
        notes: body.notes !== undefined ? String(body.notes) : undefined,
        companyUrl: body.companyUrl !== undefined ? String(body.companyUrl) : undefined,
        pipelineStatus: body.pipelineStatus !== undefined ? String(body.pipelineStatus) : undefined,
      });
      res.status(201).json({ ok: true });
    }),
  );

  r.post(
    '/contacts/import',
    asyncHandler(async (req, res, _next) => {
      const rows = (req.body as { rows?: unknown }).rows;
      if (!Array.isArray(rows)) {
        res.status(400).json({ error: 'Body must be { rows: [...] }' });
        return;
      }
      const errors: string[] = [];
      let ok = 0;
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i] as Record<string, unknown>;
        try {
          await sheets.appendContact({
            email: String(row.email || ''),
            firstName: String(row.firstName || ''),
            lastName: row.lastName !== undefined ? String(row.lastName) : undefined,
            company: row.company !== undefined ? String(row.company) : undefined,
            title: row.title !== undefined ? String(row.title) : undefined,
            campaignId: row.campaignId !== undefined ? String(row.campaignId) : undefined,
            custom1: row.custom1 !== undefined ? String(row.custom1) : undefined,
            custom2: row.custom2 !== undefined ? String(row.custom2) : undefined,
            notes: row.notes !== undefined ? String(row.notes) : undefined,
            companyUrl: row.companyUrl !== undefined ? String(row.companyUrl) : undefined,
            pipelineStatus: row.pipelineStatus !== undefined ? String(row.pipelineStatus) : undefined,
          });
          ok += 1;
        } catch (e) {
          errors.push(`Row ${i + 1}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      adminLog(req, { action: 'import_contacts', ok, failed: errors.length });
      res.json({ imported: ok, failed: errors.length, errors });
    }),
  );

  r.patch(
    '/contacts/:email',
    asyncHandler(async (req, res, _next) => {
      const email = parseEmailParam(req);
      const contacts = await sheets.getContacts();
      const contact = contacts.find((c) => c.email === email);
      if (!contact) {
        res.status(404).json({ error: 'Contact not found' });
        return;
      }
      const body = req.body as Record<string, unknown>;
      const { engine, profile } = partitionContactPatch(body);
      adminLog(req, { action: 'patch_contact', email, engineKeys: Object.keys(engine), profileKeys: Object.keys(profile) });

      if (Object.keys(engine).length > 0) {
        await sheets.updateContact(email, contact._rowIndex, engine);
      }
      if (Object.keys(profile).length > 0) {
        await sheets.updateContactProfile(email, contact._rowIndex, profile);
      }

      res.json({ ok: true });
    }),
  );

  r.post(
    '/contacts/:email/archive',
    asyncHandler(async (req, res, _next) => {
      const email = parseEmailParam(req);
      const contacts = await sheets.getContacts();
      const contact = contacts.find((c) => c.email === email);
      if (!contact) {
        res.status(404).json({ error: 'Contact not found' });
        return;
      }
      adminLog(req, { action: 'archive_contact', email });
      await sheets.softDeleteContact(email, contact._rowIndex);
      res.json({ ok: true });
    }),
  );

  r.get(
    '/company-intelligence',
    asyncHandler(async (req, res, _next) => {
      const rows = await sheets.getCompanyIntelligence();
      adminLog(req, { action: 'list_intel', count: rows.length });
      res.json({ companyIntelligence: rows });
    }),
  );

  r.patch(
    '/company-intelligence/:email',
    asyncHandler(async (req, res, _next) => {
      const email = parseEmailParam(req);
      const rows = await sheets.getCompanyIntelligence();
      const row = rows.find((r) => r.contactEmail === email);
      if (!row) {
        res.status(404).json({ error: 'Company intelligence row not found' });
        return;
      }
      const body = req.body as Partial<Record<keyof CompanyIntelUpdate, unknown>>;
      const updates: Partial<CompanyIntelUpdate> = {};
      for (const key of Object.keys(body) as (keyof CompanyIntelUpdate)[]) {
        if (body[key] === undefined) continue;
        (updates as Record<string, string>)[key] =
          body[key] === null ? '' : String(body[key]);
      }
      if (Object.keys(updates).length === 0) {
        res.status(400).json({ error: 'No valid fields to update' });
        return;
      }
      adminLog(req, { action: 'patch_intel', email, fields: Object.keys(updates) });
      await sheets.updateCompanyIntelligence(email, row._rowIndex, updates);
      res.json({ ok: true });
    }),
  );

  r.get(
    '/review-queue',
    asyncHandler(async (req, res, _next) => {
      const email = String(req.query.email || '')
        .trim()
        .toLowerCase();
      const all = await sheets.getReviewQueue();
      const filtered = email ? all.filter((e) => e.contactEmail === email) : all;
      adminLog(req, { action: 'list_review_queue', email: email || '(all)', count: filtered.length });
      res.json({ reviewQueue: filtered });
    }),
  );

  r.patch(
    '/review-queue/:rowIndex',
    asyncHandler(async (req, res, _next) => {
      const rowIndex = parseInt(String(req.params.rowIndex), 10);
      if (!Number.isFinite(rowIndex) || rowIndex < 2) {
        res.status(400).json({ error: 'Invalid rowIndex' });
        return;
      }
      const body = req.body as Partial<{ status: string; reviewerNotes: string; approvedDate: string; campaignId: string }>;
      const updates: Partial<ReviewQueueUpdate> = {};
      if (body.status !== undefined) updates.status = String(body.status);
      if (body.reviewerNotes !== undefined) updates.reviewerNotes = String(body.reviewerNotes);
      if (body.approvedDate !== undefined) updates.approvedDate = String(body.approvedDate);
      if (body.campaignId !== undefined) updates.campaignId = String(body.campaignId);
      if (Object.keys(updates).length === 0) {
        res.status(400).json({ error: 'No fields to update' });
        return;
      }
      adminLog(req, { action: 'patch_review_queue', rowIndex, fields: Object.keys(updates) });
      await sheets.updateReviewQueueEntry(rowIndex, updates);
      res.json({ ok: true });
    }),
  );

  r.post(
    '/actions/send-cycle',
    asyncHandler(async (req, res, _next) => {
      adminLog(req, { action: 'send_cycle' });
      const result = await executeSendCycle();
      if (result === null) {
        res.status(409).json({ error: 'Send cycle already running' });
        return;
      }
      res.json({ ok: true, result });
    }),
  );

  r.post(
    '/actions/pipeline-cycle',
    asyncHandler(async (req, res, _next) => {
      adminLog(req, { action: 'pipeline_cycle' });
      await runPipelineCycle();
      res.json({ ok: true });
    }),
  );

  r.post(
    '/actions/approval-watcher',
    asyncHandler(async (req, res, _next) => {
      adminLog(req, { action: 'approval_watcher' });
      await runApprovalWatcherCycle();
      res.json({ ok: true });
    }),
  );

  r.post(
    '/actions/contacts/:email/research-again',
    asyncHandler(async (req, res, _next) => {
      const email = parseEmailParam(req);
      const contacts = await sheets.getContacts();
      const contact = contacts.find((c) => c.email === email);
      if (!contact) {
        res.status(404).json({ error: 'Contact not found' });
        return;
      }
      if (!contact.companyUrl?.trim()) {
        res.status(400).json({ error: 'Contact has no company_url' });
        return;
      }
      adminLog(req, { action: 'research_again', email });
      await sheets.updateContact(email, contact._rowIndex, { pipelineStatus: 'new' });
      const intelRows = await sheets.getCompanyIntelligence();
      const intel = intelRows.find((r) => r.contactEmail === email);
      if (intel) {
        await sheets.updateCompanyIntelligence(email, intel._rowIndex, { errorLog: '' });
      }
      await runPipelineCycle();
      res.json({ ok: true });
    }),
  );

  r.post(
    '/actions/contacts/:email/regenerate-sequence',
    asyncHandler(async (req, res, _next) => {
      const email = parseEmailParam(req);
      const contacts = await sheets.getContacts();
      const contact = contacts.find((c) => c.email === email);
      if (!contact) {
        res.status(404).json({ error: 'Contact not found' });
        return;
      }

      const queue = await sheets.getReviewQueue();
      const bound = queue.some((e) => e.contactEmail === email && e.campaignId?.trim());
      if (bound) {
        res.status(409).json({
          error:
            'Review queue rows already have campaign_id for this contact; cannot regenerate safely from the API.',
        });
        return;
      }

      adminLog(req, { action: 'regenerate_sequence', email });
      const n = await sheets.markReviewQueueSupersededForContact(email);
      await sheets.updateContact(email, contact._rowIndex, { pipelineStatus: 'alignment_complete' });
      await runPipelineCycle();
      res.json({ ok: true, supersededReviewRows: n });
    }),
  );

  return r;
}
