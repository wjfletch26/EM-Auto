/**
 * Canonical company URL key for Google Sheets joins and Perplexity research.
 * - Lowercases hostname, strips leading "www."
 * - Normalizes path (drops trailing slash except root)
 * - Forces https so two contacts entering "http" vs "https" still match
 */

export function normalizeCanonicalCompanyUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';

  let href = trimmed;
  if (!/^https?:\/\//i.test(href)) {
    href = `https://${href}`;
  }

  let u: URL;
  try {
    u = new URL(href);
  } catch {
    // Do not return a non-URL string: it would never join to `https://…` profile rows (silent miss).
    return '';
  }

  let host = u.hostname.toLowerCase();
  if (host.startsWith('www.')) {
    host = host.slice(4);
  }

  let path = u.pathname || '/';
  if (path.length > 1 && path.endsWith('/')) {
    path = path.slice(0, -1);
  }
  if (path === '/') {
    path = '';
  }

  return `https://${host}${path}`;
}

/**
 * URL string safe to pass into web research (canonical form is valid for most sites).
 */
export function researchUrlFromCanonical(canonical: string): string {
  return canonical.trim() || '';
}
