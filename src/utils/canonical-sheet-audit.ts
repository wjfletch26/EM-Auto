/**
 * Pure helpers for Company Profiles / Company Intelligence canonical integrity (dashboard + CLI audits).
 */

import type { CompanyIntelligence, Contact, StoredCompanyProfile } from '../services/sheets-types.js';
import { resolveCanonicalCompanyUrl } from './resolve-canonical-company-url.js';

/** More than one Company Profiles row shares the same column A key. */
export type DuplicateProfileKeyReport = {
  canonicalUrl: string;
  rowIndices: number[];
};

/** Intel column B does not match resolve(contact.company_url). */
export type IntelDriftRow = {
  contactEmail: string;
  rowIndex: number;
  /** Raw or stale value from sheet column B. */
  intelCanonical: string;
  /** From Contacts `company_url` after resolveCanonicalCompanyUrl. */
  expectedFromContact: string;
};

export function findDuplicateCompanyProfileKeys(profiles: StoredCompanyProfile[]): DuplicateProfileKeyReport[] {
  const byKey = new Map<string, number[]>();
  for (const r of profiles) {
    const k = r.canonicalCompanyUrl.trim().toLowerCase();
    if (!k) continue;
    const arr = byKey.get(k) ?? [];
    arr.push(r._rowIndex);
    byKey.set(k, arr);
  }
  const out: DuplicateProfileKeyReport[] = [];
  for (const [canonicalUrl, rowIndices] of byKey) {
    if (rowIndices.length > 1) out.push({ canonicalUrl, rowIndices });
  }
  return out.sort((a, b) => a.canonicalUrl.localeCompare(b.canonicalUrl));
}

export function findIntelCanonicalDrift(contacts: Contact[], intel: CompanyIntelligence[]): IntelDriftRow[] {
  const byEmail = new Map(contacts.map((c) => [c.email, c] as const));
  const drift: IntelDriftRow[] = [];
  for (const row of intel) {
    const c = byEmail.get(row.contactEmail);
    if (!c) continue;
    const expected = resolveCanonicalCompanyUrl(c.companyUrl);
    const intelResolved = row.canonicalCompanyUrl.trim()
      ? resolveCanonicalCompanyUrl(row.canonicalCompanyUrl)
      : '';
    if (intelResolved !== expected) {
      drift.push({
        contactEmail: row.contactEmail,
        rowIndex: row._rowIndex,
        intelCanonical: row.canonicalCompanyUrl.trim(),
        expectedFromContact: expected,
      });
    }
  }
  return drift;
}
