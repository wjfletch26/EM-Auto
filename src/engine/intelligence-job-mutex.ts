/**
 * Mutual exclusion between the intelligence pipeline cycle and monthly company-profile refresh.
 * Avoids concurrent Perplexity/LLM mutations for the same canonical company URL.
 */

let intelligenceJobBusy = false;

export function intelligenceJobTryEnter(): boolean {
  if (intelligenceJobBusy) return false;
  intelligenceJobBusy = true;
  return true;
}

export function intelligenceJobExit(): void {
  intelligenceJobBusy = false;
}
