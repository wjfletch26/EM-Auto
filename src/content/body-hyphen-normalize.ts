/**
 * Removes ASCII hyphens used as pauses or punctuation in plain outreach copy while
 * keeping hyphens that actually join word/number parts (compounds, ranges, URLs).
 *
 * Rationale: models often emit "word - word" (or we normalize em dashes to that shape).
 * Those read like awkward dashes; compounds like "co-op" and "well-known" should stay.
 */

/** Stash token: private-use chars so vault ids never appear in real copy. */
const VAULT_OPEN = '\uE000';
const VAULT_CLOSE = '\uE001';

/**
 * Collapses spaces/tabs on each line so hyphen removal does not leave double gaps.
 * Preserves newlines for paragraph structure.
 */
export function collapseHorizontalWhitespaceInPlainText(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

/**
 * Protects a substring and returns a placeholder; {@link unstashProtected} restores all.
 */
function stash(vault: string[], fragment: string): string {
  const id = vault.length;
  vault.push(fragment);
  return `${VAULT_OPEN}${id}${VAULT_CLOSE}`;
}

function unstashProtected(vault: string[], text: string): string {
  return text.replace(
    new RegExp(`${VAULT_OPEN}(\\d+)${VAULT_CLOSE}`, 'g'),
    (_, j) => vault[Number(j)] ?? '',
  );
}

/**
 * Drops non-compound hyphens in plain text (email body). Does not alter subjects.
 *
 * Protected patterns (left unchanged):
 * - http(s) URLs
 * - email addresses
 * - numeric hyphen groups (phone chunks, "12-34" ranges)
 * - alphanumeric compounds: at least one "wordPart-wordPart" segment with no spaces inside
 */
export function normalizePlainBodyHyphens(body: string): string {
  if (!body.includes('-')) {
    return body;
  }

  const vault: string[] = [];
  let s = body;

  // Longest / most structured first so inner hyphens are not stripped before the whole URL is stashed.
  s = s.replace(/\bhttps?:\/\/[^\s<>"'()[\]]+/gi, (m) => stash(vault, m));
  s = s.replace(
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gi,
    (m) => stash(vault, m),
  );
  // Pages 12-34, IDs like 555-0199-2211 — hyphen joins digit groups only (no letters in a segment).
  s = s.replace(/\b\d+(?:-\d+)+\b/g, (m) => stash(vault, m));
  // co-op, well-known, step-by-step, 3D-printed — tight alnum chunks only.
  s = s.replace(/\b[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+\b/g, (m) => stash(vault, m));

  s = s.replace(/-/g, ' ');
  s = unstashProtected(vault, s);

  return collapseHorizontalWhitespaceInPlainText(s);
}

/**
 * Same hyphen policy for HTML bodies: only text *between* tags is normalized so
 * attributes like href="..." and data-* names stay intact inside stashed markup.
 */
export function normalizeHtmlBodyHyphens(html: string): string {
  if (!html.includes('-')) {
    return html;
  }

  const segments: string[] = [];
  const tagRe = /<[^>]+>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    if (m.index > last) {
      segments.push(normalizePlainBodyHyphens(html.slice(last, m.index)));
    }
    segments.push(m[0]);
    last = m.index + m[0].length;
  }
  if (last < html.length) {
    segments.push(normalizePlainBodyHyphens(html.slice(last)));
  }
  return segments.join('');
}
