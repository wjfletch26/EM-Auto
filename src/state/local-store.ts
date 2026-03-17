/**
 * Local JSON state store with atomic writes.
 *
 * Writes go to a temp file first, then rename — so a crash mid-write
 * never leaves a corrupted JSON file on disk.
 *
 * State files live in data/state/ and provide crash-recovery data.
 * Google Sheets is the source of truth; these are supplements.
 *
 * Reference: docs/DATA_MODEL.md (Local State Files section)
 */

import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import { logger } from '../logging/logger.js';

// State files live next to log files, under data/
const STATE_DIR = path.resolve(config.logging.dir, '..', 'state');

// Ensure the directory exists at module load time
fs.mkdirSync(STATE_DIR, { recursive: true });

/**
 * Reads a JSON file from the state directory.
 * Returns the parsed object, or the provided default if the file doesn't exist.
 */
export function readState<T>(filename: string, defaultValue: T): T {
  const filePath = path.join(STATE_DIR, filename);

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;

    // File not found is normal on first run — return the default silently
    if (code === 'ENOENT') return defaultValue;

    // Corrupted JSON or other read errors — log and return default
    logger.warn(
      { module: 'local-store', filename, error: (err as Error).message },
      'Failed to read state file, using default',
    );
    return defaultValue;
  }
}

/**
 * Writes data to a JSON state file atomically.
 * Uses write-to-temp-then-rename to prevent corruption on crash.
 */
export function writeState<T>(filename: string, data: T): void {
  const filePath = path.join(STATE_DIR, filename);
  const tempPath = filePath + '.tmp';

  try {
    // Write to a temporary file first
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf-8');

    // Atomic rename — either the old file or the new file exists, never a partial write
    fs.renameSync(tempPath, filePath);

    logger.debug({ module: 'local-store', filename }, 'State file written');
  } catch (err: unknown) {
    logger.error(
      { module: 'local-store', filename, error: (err as Error).message },
      'Failed to write state file',
    );

    // Clean up temp file if rename failed
    try { fs.unlinkSync(tempPath); } catch { /* ignore */ }

    throw err;
  }
}

/**
 * Deletes a state file. Used to clear pending-sends.json after a cycle completes.
 * Does nothing if the file doesn't exist.
 */
export function deleteState(filename: string): void {
  const filePath = path.join(STATE_DIR, filename);

  try {
    fs.unlinkSync(filePath);
    logger.debug({ module: 'local-store', filename }, 'State file deleted');
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code !== 'ENOENT') {
      logger.warn(
        { module: 'local-store', filename, error: (err as Error).message },
        'Failed to delete state file',
      );
    }
  }
}

// ─── Typed helpers for the three state files defined in the data model ────────

/** Shape of data/state/last-run.json */
export interface LastRunState {
  timestamp: string;
  contacts_eligible: number;
  contacts_sent: number;
  contacts_failed: number;
  contacts_skipped: number;
  duration_ms: number;
}

/** Shape of a single pending contact in pending-sends.json */
export interface PendingContact {
  email: string;
  step: number;
  status: 'queued' | 'sending' | 'sent' | 'failed';
}

/** Shape of data/state/pending-sends.json */
export interface PendingSendsState {
  run_id: string;
  started_at: string;
  contacts: PendingContact[];
}

/** Shape of data/state/processed-messages.json (for IMAP, future use) */
export interface ProcessedMessagesState {
  last_check: string;
  processed_uids: number[];
}

/** Shape of one queued manual-forward reply event. */
export interface ForwardedReplyEvent {
  contactEmail: string;
  fromEmail: string;
  subject: string;
  body: string;
  receivedAt: string;
}

/** Read the last-run state, defaulting to null if no run has happened yet. */
export function getLastRun(): LastRunState | null {
  return readState<LastRunState | null>('last-run.json', null);
}

/** Write the last-run state after a send cycle completes. */
export function saveLastRun(state: LastRunState): void {
  writeState('last-run.json', state);
}

/** Read pending sends — returns null if no pending cycle. */
export function getPendingSends(): PendingSendsState | null {
  return readState<PendingSendsState | null>('pending-sends.json', null);
}

/** Write pending sends at the start of a cycle. */
export function savePendingSends(state: PendingSendsState): void {
  writeState('pending-sends.json', state);
}

/** Clear pending sends after a cycle completes successfully. */
export function clearPendingSends(): void {
  deleteState('pending-sends.json');
}

/** Read queued forwarded reply events (Tier 3 bridge). */
export function getForwardedReplyQueue(): ForwardedReplyEvent[] {
  return readState<ForwardedReplyEvent[]>('forwarded-replies.json', []);
}

/** Persist queued forwarded reply events. */
export function saveForwardedReplyQueue(events: ForwardedReplyEvent[]): void {
  writeState('forwarded-replies.json', events);
}

/** Append a single forwarded reply event to the queue. */
export function enqueueForwardedReply(event: ForwardedReplyEvent): void {
  const queue = getForwardedReplyQueue();
  queue.push(event);
  saveForwardedReplyQueue(queue);
}
