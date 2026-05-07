/** Browser localStorage key for the admin API token. */
const STORAGE_KEY = 'deaton_admin_api_key';

export function getStoredApiKey(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setStoredApiKey(key: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, key);
  } catch {
    /* ignore */
  }
}

type Json = Record<string, unknown>;

/**
 * Parses JSON responses. Admin routes should always return JSON; when you see Express's HTML
 * "Cannot GET ..." page instead, surfacing it as JSON.parse failure is misleading.
 */
async function parseJson(res: Response, apiUrlForErrors: string): Promise<Json> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as Json;
  } catch {
    if (/\bCannot GET\b/i.test(text)) {
      throw new Error(
        `Nothing handled GET ${apiUrlForErrors} (server returned HTML, not JSON). Typical causes: the Admin SPA is hitting a wrong port (run the backend on UNSUB_PORT from the repo-root .env — Vite dev reads that for its /api proxy), or production is serving an outdated Node bundle (deploy after npm run build and restart PM2).`,
      );
    }
    throw new Error(text.slice(0, 200));
  }
}

/** Calls the admin REST API (same origin in production; Vite proxies /api in dev). */
export async function adminFetch<T = Json>(
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<T> {
  const key = getStoredApiKey().trim();
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string> | undefined),
  };
  if (key) {
    headers.Authorization = `Bearer ${key}`;
  }
  let body = init.body;
  if (init.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.json);
  }
  const apiUrl = `/api/admin${path}`;
  const res = await fetch(apiUrl, { ...init, headers, body });
  const data = await parseJson(res, apiUrl);
  if (!res.ok) {
    const err = typeof data.error === 'string' ? data.error : res.statusText;
    throw new Error(err);
  }
  return data as T;
}
