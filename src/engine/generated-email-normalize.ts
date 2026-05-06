/**
 * Shared normalization for AI-generated email subjects/bodies (pipeline + future-tail regen).
 */

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Normalizes generated subject and provides a safe fallback when models return empty subjects.
 */
export function normalizeGeneratedSubject(
  subject: string,
  purpose: string,
  step: number,
  company: string,
): string {
  const trimmed = (subject || '').trim();
  if (trimmed && !/^\(no subject\)$/i.test(trimmed)) return trimmed;

  const purposeTrimmed = (purpose || '').trim();
  if (purposeTrimmed) {
    return `${purposeTrimmed} - ${company}`.slice(0, 90);
  }
  return `Quick question about ${company} (step ${step})`.slice(0, 90);
}

/**
 * Ensures greeting names are on their own line in queued drafts:
 * "Simon, scaling..." -> "Simon,\n\nscaling..."
 */
export function normalizeGreetingBody(body: string, firstName: string): string {
  const trimmedBody = (body || '').trimStart();
  const name = (firstName || '').trim();

  if (name) {
    const exactPattern = new RegExp(`^(${escapeRegex(name)}),\\s*([\\s\\S]+)$`, 'i');
    const exactMatch = trimmedBody.match(exactPattern);
    if (exactMatch) {
      return `${exactMatch[1]},\n\n${exactMatch[2].trim()}`;
    }
  }

  const genericMatch = trimmedBody.match(
    /^([A-Za-z][A-Za-z.'-]{1,30}(?:\s+[A-Za-z][A-Za-z.'-]{1,30}){0,2}),\s*([\s\S]+)$/,
  );
  if (genericMatch) {
    return `${genericMatch[1]},\n\n${genericMatch[2].trim()}`;
  }

  return body;
}
