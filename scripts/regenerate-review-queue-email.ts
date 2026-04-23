/**
 * Regenerates one Review Queue email using the `dave_notes` cell for that row,
 * runs cohesion review on the full 12-step set, runs hard QC, then writes
 * subject/body, clears `dave_notes`, and appends diagnostics to reviewer_notes.
 *
 * Usage:
 *   npx tsx scripts/regenerate-review-queue-email.ts <row_index> [user_notes]
 *
 * Row index is the Google Sheet row number (same value used in ai_review_queue:<row>).
 */

import dotenv from 'dotenv';
dotenv.config();

import { regenerateReviewQueueRow } from '../src/ops/regenerate-review-queue-row.js';

async function main(): Promise<void> {
  const rowArg = process.argv[2];
  if (!rowArg) {
    console.error('Usage: npx tsx scripts/regenerate-review-queue-email.ts <review_queue_row_index>');
    process.exit(1);
  }
  const rowIndex = parseInt(rowArg, 10);
  if (Number.isNaN(rowIndex) || rowIndex < 2) {
    console.error('row_index must be a sheet row number (header is row 1).');
    process.exit(1);
  }
  const userNotes = process.argv[3]?.trim() || undefined;

  const result = await regenerateReviewQueueRow(rowIndex, { userNotesOverride: userNotes });
  console.log('\nDone. Row updated; dave_notes cleared.');
  console.log('Diagnostics:', result.diagnosticsPreview);
  if (!result.cohesionPass || !result.hardPass) {
    process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
