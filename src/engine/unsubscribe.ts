/**
 * Unsubscribe token generation and validation.
 *
 * Tokens are stateless HMAC-signed payloads: base64url(email|expiry).base64url(signature).
 * The web endpoint (Phase 4) calls validateUnsubscribeToken() and processUnsubscribe().
 * The Send Engine calls generateUnsubscribeUrl() when building each email.
 *
 * Reference: specs/UNSUBSCRIBE_SYSTEM.md
 */

import { config } from '../config/index.js';
import { logger } from '../logging/logger.js';
import { hmacSha256, base64urlEncode, base64urlDecode, timingSafeCompare } from '../utils/crypto.js';
import * as sheets from '../services/sheets.js';

// ─── Error classes ───────────────────────────────────────────────────────────

/** Thrown when a token is structurally invalid or its signature doesn't match. */
export class InvalidTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTokenError';
  }
}

/** Thrown when a token's expiry timestamp is in the past. */
export class TokenExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenExpiredError';
  }
}

// ─── Token generation ────────────────────────────────────────────────────────

/**
 * Generates a signed, time-limited unsubscribe URL for the given email.
 * Called by the Send Engine for every outbound email.
 */
export function generateUnsubscribeUrl(email: string): string {
  const normalized = email.trim().toLowerCase();

  // Expiry: current time + configured days (converted to unix seconds)
  const expiry = Math.floor(Date.now() / 1000) + (config.unsub.expiryDays * 86400);

  // Payload: "email|expiry_unix"
  const payload = `${normalized}|${expiry}`;

  // Sign with HMAC-SHA256 using the secret from .env
  const signature = hmacSha256(payload, config.unsub.secret);

  // Token: base64url(payload).base64url(signature)
  const token = `${base64urlEncode(payload)}.${base64urlEncode(signature)}`;

  return `${config.unsub.baseUrl}/unsubscribe?token=${token}`;
}

// ─── Token validation ────────────────────────────────────────────────────────

/**
 * Validates an unsubscribe token. Returns the email and expiry if valid.
 * Throws InvalidTokenError or TokenExpiredError on failure.
 */
export function validateUnsubscribeToken(token: string): { email: string; expiresAt: Date } {
  // Step 1: Split into payload and signature parts
  const parts = token.split('.');
  if (parts.length !== 2) {
    throw new InvalidTokenError('Malformed token: expected two dot-separated parts');
  }

  const [encodedPayload, encodedSignature] = parts;

  // Step 2: Decode the payload
  let payload: string;
  try {
    payload = base64urlDecode(encodedPayload);
  } catch {
    throw new InvalidTokenError('Failed to decode token payload');
  }

  // Step 3: Recompute the expected signature
  const expectedSignature = hmacSha256(payload, config.unsub.secret);

  // Step 4: Decode the provided signature and compare (timing-safe)
  let providedSignature: Buffer;
  try {
    providedSignature = Buffer.from(encodedSignature, 'base64url');
  } catch {
    throw new InvalidTokenError('Failed to decode token signature');
  }

  if (!timingSafeCompare(expectedSignature, providedSignature)) {
    throw new InvalidTokenError('Signature mismatch — token may have been tampered with');
  }

  // Step 5: Parse the payload
  const pipeIndex = payload.lastIndexOf('|');
  if (pipeIndex === -1) {
    throw new InvalidTokenError('Malformed payload: missing separator');
  }

  const email = payload.slice(0, pipeIndex);
  const expiryStr = payload.slice(pipeIndex + 1);
  const expiryUnix = parseInt(expiryStr, 10);

  if (isNaN(expiryUnix)) {
    throw new InvalidTokenError('Invalid expiry timestamp in token');
  }

  // Step 6: Check expiry
  if (Date.now() / 1000 > expiryUnix) {
    throw new TokenExpiredError('Unsubscribe token has expired');
  }

  return { email, expiresAt: new Date(expiryUnix * 1000) };
}

// ─── Process unsubscribe (Sheets update) ─────────────────────────────────────

/**
 * Marks a contact as unsubscribed in Google Sheets.
 * Called by the web endpoint (link) or reply processor (reply keyword).
 */
export async function processUnsubscribe(email: string, source: 'link' | 'reply'): Promise<void> {
  const normalized = email.trim().toLowerCase();

  // Find the contact row in Sheets
  const contacts = await sheets.getContacts();
  const contact = contacts.find((c) => c.email === normalized);

  if (!contact) {
    logger.warn(
      { module: 'unsubscribe', email: normalized },
      'Unsubscribe request for unknown email — ignoring',
    );
    return;
  }

  // Already unsubscribed — no-op but log it
  if (contact.unsubscribed) {
    logger.info(
      { module: 'unsubscribe', email: normalized },
      'Contact already unsubscribed — no update needed',
    );
    return;
  }

  // Update the contact row with unsubscribe fields
  await sheets.updateContact(normalized, contact._rowIndex, {
    unsubscribed: true,
    unsubscribeDate: new Date().toISOString(),
    unsubscribeSource: source,
    status: 'unsubscribed',
  });

  logger.info(
    { module: 'unsubscribe', email: normalized, source },
    'Contact unsubscribed successfully',
  );
}
