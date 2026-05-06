/**
 * Generated outreach copy must not contain Unicode em dashes (U+2014) or the
 * horizontal bar (U+2015), which models often substitute and which also renders poorly in email.
 * Each occurrence is normalized to a single spaced ASCII hyphen; surrounding whitespace is collapsed
 * so we never double spaces.
 */

/** Matches optional whitespace, em dash / horizontal bar, optional whitespace (one punctuation unit). */
const LONG_DASH_UNIT = /\s*[\u2014\u2015]\s*/g;

/** Punctuation marks that should be followed by a space before a letter. */
const MISSING_SENTENCE_SPACE = /([.!?])([A-Za-z])/g;

/** Colons should also have a separator when followed by a letter (e.g. "track record:iFLY"). */
const MISSING_COLON_SPACE = /(:)([A-Za-z])/g;

/**
 * Sometimes generated text merges with de-/re-/co- prefixes after cleanup
 * (e.g. "commissioningde-risk"). Insert a word boundary before the prefix token.
 */
const MERGED_PREFIXED_WORD = /([a-z])((?:de|re|co)-[a-z]+)/g;

/** Replaces every em dash and repairs common spacing artifacts from model output. */
export function replaceEmDashesWithPlainHyphen(text: string): string {
  return text
    .replace(LONG_DASH_UNIT, ' - ')
    .replace(MISSING_SENTENCE_SPACE, '$1 $2')
    .replace(MISSING_COLON_SPACE, '$1 $2')
    .replace(MERGED_PREFIXED_WORD, '$1 $2');
}
