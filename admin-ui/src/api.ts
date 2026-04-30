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

async function parseJson(res: Response): Promise<Json> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as Json;
  } catch {
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
  const res = await fetch(`/api/admin${path}`, { ...init, headers, body });
  const data = await parseJson(res);
  if (!res.ok) {
    const err = typeof data.error === 'string' ? data.error : res.statusText;
    throw new Error(err);
  }
  return data as T;
}
