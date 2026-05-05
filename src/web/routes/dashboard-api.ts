/**
 * HTTP handler for dashboard JSON — reads Sheets via the existing service layer.
 *
 * The response contains only aggregate counts and short error previews (no email bodies).
 * Rate limiting is applied in `server.ts` because each call performs multiple Sheet reads.
 */

import type { RequestHandler } from 'express';
import { logger } from '../../logging/logger.js';
import {
  getCompanyIntelligence,
  getCompanyProfiles,
  getContacts,
  getReviewQueue,
} from '../../services/sheets.js';
import { buildDashboardSummary } from '../dashboard-summary.js';

export const dashboardSummaryHandler: RequestHandler = async (_req, res) => {
  try {
    const [contacts, intel, queue, profiles] = await Promise.all([
      getContacts(),
      getCompanyIntelligence(),
      getReviewQueue(),
      getCompanyProfiles(),
    ]);
    const body = buildDashboardSummary(contacts, intel, queue, profiles);
    res.status(200).json(body);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ module: 'web', route: 'dashboard-api', error: message }, 'Dashboard summary failed');
    res.status(503).json({
      error: 'Unable to load spreadsheet summary',
      detail: message,
    });
  }
};
