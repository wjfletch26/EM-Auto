/**
 * Cryptographic utilities for the unsubscribe token system.
 *
 * Provides HMAC-SHA256 signing, base64url encoding/decoding,
 * and timing-safe comparison.
 *
 * Reference: specs/UNSUBSCRIBE_SYSTEM.md (Crypto section)
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Computes HMAC-SHA256 of the data using the given secret.
 * Returns the raw 32-byte digest as a Buffer.
 */
export function hmacSha256(data: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(data).digest();
}

/**
 * Encodes a string or Buffer to base64url (URL-safe, no padding).
 * Used to build unsubscribe tokens that are safe for query strings.
 */
export function base64urlEncode(data: string | Buffer): string {
  const buf = typeof data === 'string' ? Buffer.from(data) : data;
  return buf.toString('base64url');
}

/**
 * Decodes a base64url string back to a UTF-8 string.
 * Throws if the input is not valid base64url.
 */
export function base64urlDecode(encoded: string): string {
  return Buffer.from(encoded, 'base64url').toString('utf8');
}

/**
 * Compares two Buffers in constant time to prevent timing attacks.
 * Returns false if lengths differ (not a valid comparison target).
 */
export function timingSafeCompare(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
