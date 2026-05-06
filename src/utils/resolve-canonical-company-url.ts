/**
 * Public join key for Company Profiles / pipeline: normalization + explicit allowlisted aliases.
 *
 * All modules MUST use `resolveCanonicalCompanyUrl`, not `normalizeCanonicalCompanyUrl`, except
 * this file and normalize-company-url unit tests.
 */

import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { normalizeCanonicalCompanyUrl } from './normalize-company-url.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Path to optional JSON: { "pairs": [["https://a.com", "https://b.com"], ...] } */
const ALIASES_PATH = join(__dirname, '../../knowledge/company-domain-aliases.json');

type AliasFile = { pairs?: [string, string][] };

let aliasMap: Map<string, string> | undefined;

function loadAliasMap(): Map<string, string> {
  if (aliasMap) return aliasMap;
  aliasMap = new Map();
  if (!existsSync(ALIASES_PATH)) return aliasMap;
  try {
    const raw = JSON.parse(readFileSync(ALIASES_PATH, 'utf8')) as AliasFile;
    const pairs = raw.pairs ?? [];
    for (const pair of pairs) {
      if (!pair || pair.length < 2) continue;
      const from = normalizeCanonicalCompanyUrl(String(pair[0]));
      const to = normalizeCanonicalCompanyUrl(String(pair[1]));
      if (!from || !to) continue;
      aliasMap.set(from.toLowerCase(), to);
    }
  } catch {
    /* empty map — bad file should not crash runtime */
  }
  return aliasMap;
}

/**
 * Single mandatory resolver: normalize then apply explicit alias (allowlist) if present.
 */
export function resolveCanonicalCompanyUrl(raw: string): string {
  const normalized = normalizeCanonicalCompanyUrl(raw);
  if (!normalized) return '';
  const mapped = loadAliasMap().get(normalized.toLowerCase());
  return mapped ?? normalized;
}

/** Test-only: clear cache so the next resolve reloads `company-domain-aliases.json` from disk. */
export function __resetCanonicalAliasCacheForTests(): void {
  aliasMap = undefined;
}

/** Test-only: inject alias map (undefined = same as reset). */
export function __setCanonicalAliasMapForTests(map: Map<string, string> | undefined): void {
  aliasMap = map;
}
