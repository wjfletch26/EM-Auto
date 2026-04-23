/**
 * Lightweight case study index from knowledge/case-studies/*.yml.
 * Used by hard QC to detect references to studies outside the alignment allowlist.
 */

import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logging/logger.js';

const CASE_STUDY_DIR = path.resolve('knowledge', 'case-studies');

export interface CaseStudyMeta {
  id: string;
  clientName: string;
}

let cache: CaseStudyMeta[] | null = null;

/** Reads `id:` and `client_name:` from a YAML file (single-line values). */
function parseCaseStudyFile(filePath: string): CaseStudyMeta | null {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const idMatch = raw.match(/^id:\s*(.+)$/m);
  const nameMatch = raw.match(/^client_name:\s*(.+)$/m);
  if (!idMatch || !nameMatch) {
    logger.warn({ module: 'case-study-metadata', filePath }, 'Missing id or client_name');
    return null;
  }
  return {
    id: idMatch[1].trim(),
    clientName: nameMatch[1].trim().replace(/^["']|["']$/g, ''),
  };
}

/** Returns all case studies (excluding underscore-prefixed templates). */
export function loadCaseStudyMetadataList(): CaseStudyMeta[] {
  if (cache) return cache;

  let files: string[];
  try {
    files = fs.readdirSync(CASE_STUDY_DIR).filter(
      (f) => f.endsWith('.yml') && !f.startsWith('_'),
    );
  } catch {
    logger.warn({ module: 'case-study-metadata' }, 'Case studies directory missing');
    cache = [];
    return cache;
  }

  const list: CaseStudyMeta[] = [];
  for (const f of files) {
    const meta = parseCaseStudyFile(path.join(CASE_STUDY_DIR, f));
    if (meta) list.push(meta);
  }
  cache = list;
  return list;
}

/** Clears the in-memory cache (for tests). */
export function clearCaseStudyMetadataCache(): void {
  cache = null;
}
