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
  /** 1-indexed row number in the sheet — used for targeted cell updates. */
  _rowIndex: number;
}

/** Fields that the engine is allowed to update on a contact row. */
export interface ContactUpdate {
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
};
