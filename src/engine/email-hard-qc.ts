/**
 * Deterministic email QC — enforces rules that should not depend on an LLM:
 * dash policy, Texas Triangle visit wording (when HQ not proximal), case-study allowlist,
 * David's project notes presence.
 * (Email signature is appended at send time, not validated here.)
 */

import type { QualityReview } from '../skills/quality-reviewer.js';
import { loadCaseStudyMetadataList } from '../skills/case-study-metadata.js';
import {
  describeNonTriangleVisitViolationIfAny,
  mayOfferInPersonTexasVisit,
} from '../content/texas-triangle-visit-policy.js';

export interface HardQcEmailSlice {
  step: number;
  subject: string;
  body: string;
}

export interface HardQcInput {
  emails: HardQcEmailSlice[];
  /** Case study IDs from Company Intelligence (comma-split upstream). */
  allowlistedCaseStudyIds: string[];
  /** When non-empty, at least one email must reflect this text (substring check). */
  davidProjectNotes: string;
  /**
   * Company research `headquarters` string. When Texas Triangle proximity is false,
   * Hard QC rejects wording that dispatches engineers to the prospect's site.
   */
  headquarters?: string | null;
}

export interface HardQcResult {
  /** True when there are zero blocking issues. */
  pass: boolean;
  /** Issues keyed by step number. */
  issuesByStep: Map<number, string[]>;
  /** Sequence-wide issues (e.g. David's notes missing everywhere). */
  globalFlags: string[];
}

/** Removes numeric ranges like 12–34 so en-dashes there are allowed. */
function stripNumericEnDashRanges(text: string): string {
  return text.replace(/\d\u2013\d/g, '###');
}

function checkDashes(text: string, step: number, issuesByStep: Map<number, string[]>): void {
  const push = (msg: string) => {
    const list = issuesByStep.get(step) ?? [];
    list.push(msg);
    issuesByStep.set(step, list);
  };
  // Block common "long dash" code points models emit; normalized by replaceEmDashesWithPlainHyphen before send.
  if (text.includes('\u2014') || text.includes('\u2015')) {
    push(
      'Body or subject contains an em dash (U+2014) or horizontal bar (U+2015); use comma, period, or spaced hyphen instead.',
    );
  }
  const enProbe = stripNumericEnDashRanges(text);
  if (enProbe.includes('\u2013')) {
    push('Body or subject contains an en dash (U+2013) outside numeric ranges; use a hyphen or rephrase.');
  }
}

/**
 * If David's notes are non-trivial, require a case-insensitive substring match
 * of a short anchor from the start of the notes across the combined sequence.
 */
function checkDavidNotesPresent(notes: string, combined: string): string | null {
  const trimmed = notes.trim();
  if (trimmed.length < 10) return null;

  const normalizedHaystack = combined.toLowerCase().replace(/\s+/g, ' ');
  const anchorLen = Math.min(40, trimmed.length);
  let anchor = trimmed.slice(0, anchorLen).toLowerCase().replace(/\s+/g, ' ').trim();
  if (anchor.length < 10) {
    anchor = trimmed.toLowerCase().replace(/\s+/g, ' ').trim();
  }
  if (anchor.length < 8) return null;

  if (!normalizedHaystack.includes(anchor)) {
    return 'David project notes are non-empty but no email appears to incorporate them (anchor text not found).';
  }
  return null;
}

function checkCaseStudyAllowlist(
  allowlistedIds: string[],
  combinedLower: string,
  issuesByStep: Map<number, string[]>,
  emails: HardQcEmailSlice[],
): void {
  if (allowlistedIds.length === 0) return;

  const allow = new Set(allowlistedIds.map((id) => id.trim().toLowerCase()).filter(Boolean));
  const allMeta = loadCaseStudyMetadataList();
  const forbidden = allMeta.filter((m) => !allow.has(m.id.toLowerCase()));
  if (forbidden.length === 0) return;

  for (const study of forbidden) {
    const name = study.clientName.trim();
    if (name.length < 8) continue;
    const needle = name.toLowerCase();
    if (!combinedLower.includes(needle)) continue;

    const msg = `References case study client not in allowlist (${study.id} / ${study.clientName}).`;
    for (const e of emails) {
      const blob = `${e.subject}\n${e.body}`.toLowerCase();
      if (blob.includes(needle)) {
        const list = issuesByStep.get(e.step) ?? [];
        list.push(msg);
        issuesByStep.set(e.step, list);
      }
    }
  }
}

function checkNonTriangleVisitLanguage(
  blob: string,
  step: number,
  issuesByStep: Map<number, string[]>,
  headquarters: string | null | undefined,
): void {
  if (mayOfferInPersonTexasVisit(headquarters)) return;
  const msg = describeNonTriangleVisitViolationIfAny(blob);
  if (!msg) return;
  const push = (m: string) => {
    const list = issuesByStep.get(step) ?? [];
    list.push(m);
    issuesByStep.set(step, list);
  };
  push(msg);
}

/**
 * Runs deterministic checks on a generated or regenerated sequence.
 */
export function runHardEmailQC(input: HardQcInput): HardQcResult {
  const issuesByStep = new Map<number, string[]>();
  const globalFlags: string[] = [];

  const combinedPieces: string[] = [];
  for (const e of input.emails) {
    const blob = `${e.subject}\n${e.body}`;
    combinedPieces.push(blob);
    checkDashes(blob, e.step, issuesByStep);
    checkNonTriangleVisitLanguage(blob, e.step, issuesByStep, input.headquarters);
  }
  const combined = combinedPieces.join('\n');
  const combinedLower = combined.toLowerCase();

  checkCaseStudyAllowlist(input.allowlistedCaseStudyIds, combinedLower, issuesByStep, input.emails);

  const davidIssue = checkDavidNotesPresent(input.davidProjectNotes, combined);
  if (davidIssue) globalFlags.push(davidIssue);

  let pass = globalFlags.length === 0;
  for (const issues of issuesByStep.values()) {
    if (issues.length > 0) {
      pass = false;
      break;
    }
  }

  return { pass, issuesByStep, globalFlags };
}

/** Merges hard QC findings into the LLM quality review (mutates-style copy). */
export function mergeHardQCIntoReview(qc: QualityReview, hard: HardQcResult): QualityReview {
  const flags = [...qc.flags, ...hard.globalFlags];

  const byStep = new Map(
    qc.email_reviews.map((r) => [r.step, { ...r, issues: [...r.issues] }]),
  );
  for (const [step, issues] of hard.issuesByStep) {
    if (issues.length === 0) continue;
    const existing = byStep.get(step);
    if (existing) {
      existing.pass = false;
      existing.issues = [...existing.issues, ...issues.map((i) => `[Hard QC] ${i}`)];
    } else {
      byStep.set(step, {
        step,
        pass: false,
        issues: issues.map((i) => `[Hard QC] ${i}`),
        suggestion: null,
      });
    }
  }

  const email_reviews = mergeEmailReviewsFromMap(byStep, qc.email_reviews);

  return {
    ...qc,
    overall_pass: qc.overall_pass && hard.pass,
    flags,
    email_reviews,
  };
}

type EmailReviewRow = QualityReview['email_reviews'][number];

/** Preserve LLM review order when steps exist; append any synthetic rows sorted by step. */
function mergeEmailReviewsFromMap(
  byStep: Map<number, EmailReviewRow>,
  original: QualityReview['email_reviews'],
): QualityReview['email_reviews'] {
  if (original.length === 0) {
    return [...byStep.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => v);
  }

  const steps = new Set<number>();
  const out: QualityReview['email_reviews'] = [];
  for (const r of original) {
    const merged = byStep.get(r.step) ?? r;
    out.push(merged);
    steps.add(r.step);
  }
  const extras = [...byStep.entries()]
    .filter(([s]) => !steps.has(s))
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v);
  return [...out, ...extras];
}
