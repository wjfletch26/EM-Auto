/**
 * Removes informal closing blocks from plain-text email bodies.
 * The send engine appends the real HTML signature (David Knieriem card), so lines like
 * "Best,", "[Your Name]", or a lone "Deaton Engineering" at the end are redundant.
 */

function isBlankLine(line: string): boolean {
  return line.trim() === '';
}

/**
 * Lines to peel from the end of the body before the formal signature is injected.
 */
function isTrailingSignoffLine(trimmed: string): boolean {
  if (!trimmed) return true;
  if (/^\[Your Name\]$/i.test(trimmed)) return true;
  if (/^Deaton Engineering(, Inc\.)?\s*\.?\s*$/i.test(trimmed)) return true;
  if (/^(Best regards?|Best|Sincerely|Thanks|Thank you|Regards|Cheers|Warm regards?),?\s*$/i.test(trimmed)) {
    return true;
  }
  return false;
}

/**
 * Drops trailing blank lines and generic sign-off / placeholder / company-only lines.
 */
export function stripTrailingInformalSignoff(body: string): string {
  const normalized = body.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');

  while (lines.length > 0) {
    const last = lines[lines.length - 1];
    if (isBlankLine(last)) {
      lines.pop();
      continue;
    }
    if (isTrailingSignoffLine(last.trim())) {
      lines.pop();
      continue;
    }
    break;
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}
