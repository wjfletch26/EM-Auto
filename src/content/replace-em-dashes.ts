/**
 * Generated outreach copy must not contain Unicode em dashes (U+2014).
 * They render inconsistently across clients and read as overly formatted.
 * Each em dash is normalized to a single spaced hyphen; surrounding whitespace is collapsed so we never double spaces.
 */

/** Matches optional whitespace, em dash, optional whitespace (one punctuation unit). */
const EM_DASH_UNIT = /\s*\u2014\s*/g;

/** Replaces every em dash with a plain " - " separator without duplicating spaces. */
export function replaceEmDashesWithPlainHyphen(text: string): string {
  return text.replace(EM_DASH_UNIT, ' - ');
}
