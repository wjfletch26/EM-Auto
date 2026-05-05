/**
 * Serializes async work that mutates a single company's profile row.
 * Prevents two pipeline contacts (or refresh + pipeline) from racing the same canonical URL.
 */
const tails = new Map<string, Promise<unknown>>();

export function withCanonicalCompanyLock<T>(canonicalCompanyUrl: string, fn: () => Promise<T>): Promise<T> {
  const key = canonicalCompanyUrl.trim().toLowerCase();
  const prev = tails.get(key) ?? Promise.resolve();

  const run = prev
    .catch(() => {
      /* earlier task failed — still run the next */
    })
    .then(fn);

  tails.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );

  return run;
}
