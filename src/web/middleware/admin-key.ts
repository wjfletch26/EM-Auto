/**
 * Parses admin API key from request headers (no config dependency — easy to unit test).
 */
import type { IncomingHttpHeaders } from 'node:http';

export function extractAdminKeyFromHeaders(headers: IncomingHttpHeaders): string {
  const auth = headers.authorization;
  const headerKey = headers['x-admin-key'];
  const bearer =
    typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')
      ? auth.slice(7).trim()
      : '';
  const raw = bearer || (typeof headerKey === 'string' ? headerKey : '');
  return raw.trim();
}
