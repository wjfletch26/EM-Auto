/**
 * Merges per-contact sheet fields with David / project notes for email generation and QC.
 * Keeps labels so the model can tell operator notes apart from LinkedIn/custom fields.
 */

import type { Contact, CompanyIntelligence } from '../services/sheets-types.js';

export function mergeContactBriefing(contact: Contact, intel: CompanyIntelligence): string {
  const blocks: string[] = [];

  const david = (intel.davidProjectNotes || '').trim();
  if (david) {
    blocks.push(`David / project notes (from Company Intelligence):\n${david}`);
  }

  const notes = (contact.notes || '').trim();
  if (notes) {
    blocks.push(`Operator notes (Contacts.notes):\n${notes}`);
  }

  const c1 = (contact.custom1 || '').trim();
  if (c1) {
    blocks.push(`Custom field 1 (e.g. LinkedIn):\n${c1}`);
  }

  const c2 = (contact.custom2 || '').trim();
  if (c2) {
    blocks.push(`Custom field 2:\n${c2}`);
  }

  return blocks.join('\n\n');
}
