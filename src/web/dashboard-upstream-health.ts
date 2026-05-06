/**
 * Company-level upstream gate health for the operator dashboard (Track B).
 *
 * Rolls up `company_intelligence_blocked` contacts by resolved canonical URL and parsed
 * `[UPSTREAM_GATE] code=` reason — without mutating shared Company Profiles rows.
 */

import { parseUpstreamGateReasonCode } from '../engine/sequence-generation-gate.js';
import type { CompanyIntelligence, Contact, StoredCompanyProfile } from '../services/sheets-types.js';
import { duplicateCanonicalUrlsLowercased } from '../utils/canonical-sheet-audit.js';
import { resolveCanonicalCompanyUrl } from '../utils/resolve-canonical-company-url.js';

/** Histogram (pipeline status, reason codes, etc.). */
export type LabelCounts = Record<string, number>;

/** One canonical company bucket: shared profile snapshot + blocked-contact rollup. */
export type CompanyHealthRow = {
  /** Normalized canonical for display (or a sentinel when the contact URL resolves empty). */
  canonicalUrl: string;
  /** Primary Company Profiles row for this key, if any. */
  profile: null | {
    pipelineStatus: string;
    confidenceScore: string;
    profileVersion: string;
    lastRefreshedAt: string;
    profileRowIndex: number;
  };
  /** True when more than one Company Profiles row shares this lowercase canonical key. */
  duplicateProfileKey: boolean;
  /** Blocked contacts at this canonical, grouped by primary gate reason (or UNPARSED). */
  blockedByReason: LabelCounts;
  /** Total contacts in `company_intelligence_blocked` for this canonical. */
  blockedContactsTotal: number;
};

export type UpstreamBlockedSample = {
  contactEmail: string;
  canonicalUrl: string;
  /** Parsed gate code, or `UNPARSED` when Intel `error_log` has no `[UPSTREAM_GATE]` line. */
  reasonCode: string;
  errorPreview: string;
};

export type UpstreamHealthSnapshot = {
  blockedContactCount: number;
  blockedByReason: LabelCounts;
  samples: UpstreamBlockedSample[];
  companyRows: CompanyHealthRow[];
  companyRowsTruncated: boolean;
};

const MAX_HEALTH_ROWS = 100;
const MAX_BLOCKED_SAMPLES = 16;
const PREVIEW_LEN = 140;

function bump(map: LabelCounts, key: string): void {
  const label = key.trim() === '' ? '(empty)' : key;
  map[label] = (map[label] || 0) + 1;
}

function blockedReasonFromIntel(errorLog: string | undefined): string {
  const raw = errorLog ?? '';
  const parsed = parseUpstreamGateReasonCode(raw);
  return parsed ?? 'UNPARSED';
}

/**
 * Builds dashboard rollups from live sheet rows (pure — no I/O).
 */
export function buildUpstreamHealthSnapshot(
  contacts: Contact[],
  intel: CompanyIntelligence[],
  profiles: StoredCompanyProfile[],
): UpstreamHealthSnapshot {
  const duplicateKeysLower = duplicateCanonicalUrlsLowercased(profiles);

  const profileByKey = new Map<string, StoredCompanyProfile>();
  for (const p of profiles) {
    const k = resolveCanonicalCompanyUrl(p.canonicalCompanyUrl).trim().toLowerCase();
    if (!k) continue;
    if (!profileByKey.has(k)) profileByKey.set(k, p);
  }

  const intelByEmail = new Map(intel.map((row) => [row.contactEmail, row] as const));

  const blockedByReasonTotal: LabelCounts = {};
  /** Lowercase canonical → reason histogram + display URL from the first blocked contact at that key. */
  const perCanonical = new Map<string, { reasons: LabelCounts; displayUrl: string }>();
  const samples: UpstreamBlockedSample[] = [];

  for (const c of contacts) {
    const ps = (c.pipelineStatus || '').trim().toLowerCase();
    if (ps !== 'company_intelligence_blocked') continue;

    const intelRow = intelByEmail.get(c.email);
    const reason = blockedReasonFromIntel(intelRow?.errorLog);
    bump(blockedByReasonTotal, reason);

    const canonDisplay = resolveCanonicalCompanyUrl(c.companyUrl || '').trim();
    const canonKey = canonDisplay.toLowerCase();
    const bucket = perCanonical.get(canonKey) ?? { reasons: {}, displayUrl: '' };
    bump(bucket.reasons, reason);
    if (!bucket.displayUrl) bucket.displayUrl = canonDisplay || '(empty canonical)';
    perCanonical.set(canonKey, bucket);

    if (samples.length < MAX_BLOCKED_SAMPLES) {
      const prev = intelRow?.errorLog ?? '';
      const preview = prev.length > PREVIEW_LEN ? `${prev.slice(0, PREVIEW_LEN)}…` : prev;
      samples.push({
        contactEmail: c.email,
        canonicalUrl: bucket.displayUrl,
        reasonCode: reason,
        errorPreview: preview || '—',
      });
    }
  }

  const blockedContactCount = Object.values(blockedByReasonTotal).reduce((a, n) => a + n, 0);

  const unionKeys = new Set<string>();
  for (const k of profileByKey.keys()) unionKeys.add(k);
  for (const k of perCanonical.keys()) unionKeys.add(k);

  const companyRows: CompanyHealthRow[] = [];

  for (const key of unionKeys) {
    const prof = profileByKey.get(key) ?? null;
    const bucket = perCanonical.get(key);
    const blockedMap = bucket?.reasons ?? {};
    let blockedTotal = 0;
    for (const n of Object.values(blockedMap)) blockedTotal += n;

    const canonicalUrl = prof
      ? resolveCanonicalCompanyUrl(prof.canonicalCompanyUrl)
      : bucket?.displayUrl || (key === '' ? '(empty canonical)' : key);

    const duplicateProfileKey = key !== '' && duplicateKeysLower.has(key);

    companyRows.push({
      canonicalUrl,
      profile: prof
        ? {
            pipelineStatus: prof.pipelineStatus,
            confidenceScore: prof.confidenceScore,
            profileVersion: prof.profileVersion,
            lastRefreshedAt: prof.lastRefreshedAt,
            profileRowIndex: prof._rowIndex,
          }
        : null,
      duplicateProfileKey,
      blockedByReason: { ...blockedMap },
      blockedContactsTotal: blockedTotal,
    });
  }

  companyRows.sort((a, b) => {
    if (b.blockedContactsTotal !== a.blockedContactsTotal) return b.blockedContactsTotal - a.blockedContactsTotal;
    return a.canonicalUrl.localeCompare(b.canonicalUrl);
  });

  const truncated = companyRows.length > MAX_HEALTH_ROWS;
  const trimmedRows = truncated ? companyRows.slice(0, MAX_HEALTH_ROWS) : companyRows;

  return {
    blockedContactCount,
    blockedByReason: blockedByReasonTotal,
    samples,
    companyRows: trimmedRows,
    companyRowsTruncated: truncated,
  };
}
