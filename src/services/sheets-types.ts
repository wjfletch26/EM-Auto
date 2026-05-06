/**
 * TypeScript types for Google Sheets data.
 * These types mirror the column structure defined in docs/DATA_MODEL.md.
 */

/** A single contact row from the Contacts tab. */
export interface Contact {
  email: string;
  firstName: string;
  lastName: string;
  company: string;
  title: string;
  campaignId: string;
  status: string;
  lastStepSent: number;
  lastSendDate: string | null;
  replyStatus: string | null;
  replyDate: string | null;
  replySnippet: string;
  unsubscribed: boolean;
  unsubscribeDate: string | null;
  unsubscribeSource: string | null;
  bounced: boolean;
  bounceType: string | null;
  bounceDate: string | null;
  softBounceCount: number;
  custom1: string;
  custom2: string;
  notes: string;
  /** Company website URL — used by the intelligence pipeline. */
  companyUrl: string;
  /** Pipeline status — tracks the contact through the intelligence pipeline. */
  pipelineStatus: string;
  /**
   * Last Company Profiles `profile_version` the contact’s generated Review Queue content
   * was produced against (column Y). Empty = never set / pre-migration.
   */
  lastProfileVersionUsedForGeneration: string;
  /** 1-indexed row number in the sheet — used for targeted cell updates. */
  _rowIndex: number;
}

/** Fields that the engine is allowed to update on a contact row. */
export interface ContactUpdate {
  firstName: string;
  lastName: string;
  company: string;
  title: string;
  campaignId: string;
  status: string;
  lastStepSent: number;
  lastSendDate: string;
  replyStatus: string;
  replyDate: string;
  replySnippet: string;
  unsubscribed: boolean;
  unsubscribeDate: string;
  unsubscribeSource: string;
  bounced: boolean;
  bounceType: string;
  bounceDate: string;
  softBounceCount: number;
  custom1: string;
  custom2: string;
  notes: string;
  companyUrl: string;
  pipelineStatus: string;
  lastProfileVersionUsedForGeneration: string;
}

/** A single step within a campaign sequence. */
export interface CampaignStep {
  stepNumber: number;
  templateFile: string;
  subject: string;
  delayDays: number;
}

/** A campaign row from the Campaigns tab. */
export interface Campaign {
  campaignId: string;
  campaignName: string;
  totalSteps: number;
  steps: CampaignStep[];
  active: boolean;
  /** 'template' for Handlebars campaigns, 'ai_generated' for pipeline-created ones. */
  campaignType: 'template' | 'ai_generated';
  /** Sheet row number (first data row = 2) — set by getCampaigns for mutations. */
  _rowIndex?: number;
}

/** A row from the Send Log tab (append-only). */
export interface SendLogEntry {
  timestamp: string;
  contactEmail: string;
  campaignId: string;
  step: number;
  status: string;
  messageId: string;
  errorMessage: string;
  templateUsed: string;
}

/** A row from the Reply Log tab (append-only). */
export interface ReplyLogEntry {
  timestamp: string;
  contactEmail: string;
  classification: string;
  subjectSnippet: string;
  bodySnippet: string;
  source: string;
}

/**
 * Maps ContactUpdate field names to their column letters in the Contacts tab.
 * Used by updateContact and batchUpdateContacts to target the right cells.
 */
export const FIELD_TO_COLUMN: Record<keyof ContactUpdate, string> = {
  firstName: 'B',
  lastName: 'C',
  company: 'D',
  title: 'E',
  campaignId: 'F',
  status: 'G',
  lastStepSent: 'H',
  lastSendDate: 'I',
  replyStatus: 'J',
  replyDate: 'K',
  replySnippet: 'L',
  unsubscribed: 'M',
  unsubscribeDate: 'N',
  unsubscribeSource: 'O',
  bounced: 'P',
  bounceType: 'Q',
  bounceDate: 'R',
  softBounceCount: 'S',
  custom1: 'T',
  custom2: 'U',
  notes: 'V',
  companyUrl: 'W',
  pipelineStatus: 'X',
  lastProfileVersionUsedForGeneration: 'Y',
};

/**
 * Operator-editable contact columns (names, company, URL, campaign, notes).
 * Email (column A) is not included — use append only; changing PK is unsupported here.
 */
export interface ContactProfileUpdate {
  firstName: string;
  lastName: string;
  company: string;
  title: string;
  campaignId: string;
  custom1: string;
  custom2: string;
  notes: string;
  companyUrl: string;
}

/** Maps ContactProfileUpdate fields to Contacts tab column letters (see getContacts). */
export const PROFILE_FIELD_TO_COLUMN: Record<keyof ContactProfileUpdate, string> = {
  firstName: 'B',
  lastName: 'C',
  company: 'D',
  title: 'E',
  campaignId: 'F',
  custom1: 'T',
  custom2: 'U',
  notes: 'V',
  companyUrl: 'W',
};

/** Payload for appending a new contact row (email + first name required). */
export interface ContactAppendPayload {
  email: string;
  firstName: string;
  lastName?: string;
  company?: string;
  title?: string;
  campaignId?: string;
  custom1?: string;
  custom2?: string;
  notes?: string;
  companyUrl?: string;
  /** Initial pipeline_status (column X). Default `new`. */
  pipelineStatus?: string;
}

// ─── Company Profiles Tab (one row per canonical company URL) ───────────────

/** Shared research + alignment for all contacts at a company — see docs/DATA_MODEL.md. */
export interface StoredCompanyProfile {
  canonicalCompanyUrl: string;
  /** Display URL as entered by operators (research uses canonical). */
  companyUrl: string;
  companyName: string;
  industry: string;
  productSummary: string;
  companySize: string;
  signals: string;
  signalSummary: string;
  deatonCapabilitiesMatched: string;
  caseStudiesSelected: string;
  alignmentRationale: string;
  confidenceScore: string;
  /** Company-level pipeline: researched, aligning, alignment_complete, no_fit, research_failed, refresh_failed */
  pipelineStatus: string;
  researchedDate: string;
  /** ISO timestamp of last successful refresh (initial research counts as first refresh). */
  lastRefreshedAt: string;
  profileVersion: string;
  errorLog: string;
  /** 1-indexed row number in the sheet. */
  _rowIndex: number;
}

/** Maps StoredCompanyProfile field names → column letters (row 2+). */
export const COMPANY_PROFILE_FIELD_TO_COLUMN: Record<
  keyof Omit<StoredCompanyProfile, '_rowIndex'>,
  string
> = {
  canonicalCompanyUrl: 'A',
  companyUrl: 'B',
  companyName: 'C',
  industry: 'D',
  productSummary: 'E',
  companySize: 'F',
  signals: 'G',
  signalSummary: 'H',
  deatonCapabilitiesMatched: 'I',
  caseStudiesSelected: 'J',
  alignmentRationale: 'K',
  confidenceScore: 'L',
  pipelineStatus: 'M',
  researchedDate: 'N',
  lastRefreshedAt: 'O',
  profileVersion: 'P',
  errorLog: 'Q',
};

// ─── Company Intelligence Tab (per contact — briefing + linkage) ─────────────

/** A row from the Company Intelligence tab — joins contact_email ↔ canonical_company_url. */
export interface CompanyIntelligence {
  contactEmail: string;
  canonicalCompanyUrl: string;
  /** Copy of Contacts.company_url for display; may differ slightly from canonical. */
  companyUrl: string;
  davidProjectNotes: string;
  executiveBrief: string;
  /** Mirrors contact pipeline milestones for operator visibility (generation phase). */
  pipelineStatus: string;
  generatedDate: string;
  errorLog: string;
  /** 1-indexed row number in the sheet. */
  _rowIndex: number;
}

/** Fields the pipeline (and admin UI) can update on a Company Intelligence row. */
export interface CompanyIntelUpdate {
  canonicalCompanyUrl: string;
  companyUrl: string;
  davidProjectNotes: string;
  executiveBrief: string;
  pipelineStatus: string;
  generatedDate: string;
  errorLog: string;
}

/** Maps CompanyIntelUpdate fields to column letters in Company Intelligence tab (A–H). */
export const INTEL_FIELD_TO_COLUMN: Record<keyof CompanyIntelUpdate, string> = {
  canonicalCompanyUrl: 'B',
  companyUrl: 'C',
  davidProjectNotes: 'D',
  executiveBrief: 'E',
  pipelineStatus: 'F',
  generatedDate: 'G',
  errorLog: 'H',
};

// ─── Review Queue Tab Types ──────────────────────────────────────────────────

/** A row from the Review Queue tab. */
export interface ReviewQueueEntry {
  contactEmail: string;
  companyName: string;
  stepNumber: number;
  emailPurpose: string;
  subject: string;
  body: string;
  status: string;
  reviewerNotes: string;
  generatedDate: string;
  approvedDate: string;
  campaignId: string;
  /** Per-step instructions from David; non-empty triggers regeneration via script. */
  daveNotes: string;
  /** Machine-readable gate: true means automatic QC exhausted and manual review is required. */
  manualReviewRequired: boolean;
  /** Machine-readable automatic QC state. */
  qcAutoStatus: 'ok' | 'flagged' | 'auto_exhausted';
  /** Machine-readable next action for operator workflows. */
  nextAction: string;
  /** Last regeneration source mode that touched this row. */
  regenMode: '' | 'auto_qc' | 'user_notes' | 'david_notes' | 'mixed_manual';
  /** 1-indexed row number in the sheet. */
  _rowIndex: number;
}

/** Fields that can be updated on a Review Queue row. */
export interface ReviewQueueUpdate {
  status?: string;
  reviewerNotes?: string;
  approvedDate?: string;
  campaignId?: string;
  subject?: string;
  body?: string;
  daveNotes?: string;
  manualReviewRequired?: boolean;
  qcAutoStatus?: 'ok' | 'flagged' | 'auto_exhausted';
  nextAction?: string;
  regenMode?: '' | 'auto_qc' | 'user_notes' | 'david_notes' | 'mixed_manual';
}

/** Maps ReviewQueueUpdate fields to column letters in Review Queue tab. */
export const REVIEW_FIELD_TO_COLUMN: Record<keyof ReviewQueueUpdate, string> = {
  status: 'G',
  reviewerNotes: 'H',
  approvedDate: 'J',
  campaignId: 'K',
  subject: 'E',
  body: 'F',
  daveNotes: 'L',
  manualReviewRequired: 'M',
  qcAutoStatus: 'N',
  nextAction: 'O',
  regenMode: 'P',
};

// ─── QC Regen Audit Tab ──────────────────────────────────────────────────────

/** An append-only audit row explaining one regeneration attempt. */
export interface QcRegenAuditEntry {
  timestamp: string;
  contactEmail: string;
  stepNumber: number;
  attemptNumber: number;
  regenMode: 'auto_qc' | 'user_notes' | 'david_notes' | 'mixed_manual';
  inputSourcesUsed: string;
  triggerReason: string;
  qcIssuesJson: string;
  suggestionUsed: string;
  subjectBefore: string;
  bodyBefore: string;
  subjectAfter: string;
  bodyAfter: string;
}
