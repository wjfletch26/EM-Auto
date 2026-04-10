/**
 * Knowledge Loader — reads Deaton profile, case studies, and persona files.
 *
 * All knowledge files live in the `knowledge/` directory as YAML files.
 * This module loads them at pipeline run time and provides them as strings
 * that can be injected into LLM prompts.
 */

import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logging/logger.js';

const KNOWLEDGE_DIR = path.resolve('knowledge');

/** Reads a file from the knowledge directory. Returns empty string if missing. */
function readKnowledgeFile(relativePath: string): string {
  const filePath = path.join(KNOWLEDGE_DIR, relativePath);
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    logger.warn({ module: 'knowledge-loader', path: filePath }, 'Knowledge file not found');
    return '';
  }
}

/** Loads the Deaton company profile as a raw YAML string. */
export function loadDeatonProfile(): string {
  return readKnowledgeFile('deaton-profile.yml');
}

/** Loads all case study files and concatenates them with separators. */
export function loadCaseStudies(): string {
  const caseStudyDir = path.join(KNOWLEDGE_DIR, 'case-studies');

  let files: string[];
  try {
    files = fs.readdirSync(caseStudyDir).filter(
      (f) => f.endsWith('.yml') && !f.startsWith('_'),
    );
  } catch {
    logger.warn({ module: 'knowledge-loader' }, 'Case studies directory not found');
    return '(No case studies available)';
  }

  if (files.length === 0) {
    return '(No case studies available)';
  }

  const studies = files.map((f) => {
    const content = fs.readFileSync(path.join(caseStudyDir, f), 'utf-8');
    return `--- Case Study: ${f.replace('.yml', '')} ---\n${content}`;
  });

  logger.info({ module: 'knowledge-loader', count: studies.length }, 'Case studies loaded');
  return studies.join('\n\n');
}

/**
 * Loads the appropriate persona file based on a contact's title.
 * Falls back to default.yml if no title pattern matches.
 */
export function loadPersona(contactTitle: string): string {
  const personaDir = path.join(KNOWLEDGE_DIR, 'personas');

  let files: string[];
  try {
    files = fs.readdirSync(personaDir).filter((f) => f.endsWith('.yml'));
  } catch {
    logger.warn({ module: 'knowledge-loader' }, 'Personas directory not found');
    return readKnowledgeFile('personas/default.yml');
  }

  // Check each persona's title_patterns against the contact's title
  const titleLower = contactTitle.toLowerCase();

  for (const file of files) {
    if (file === 'default.yml') continue;

    const content = fs.readFileSync(path.join(personaDir, file), 'utf-8');

    // Parse title_patterns from the YAML (simple regex — avoids YAML dependency)
    const patternsMatch = content.match(/title_patterns:\s*\n((?:\s+-\s+.+\n?)+)/);
    if (!patternsMatch) continue;

    const patterns = patternsMatch[1]
      .split('\n')
      .map((line) => line.replace(/^\s+-\s+/, '').trim().toLowerCase())
      .filter(Boolean);

    if (patterns.some((p) => titleLower.includes(p))) {
      logger.info({ module: 'knowledge-loader', persona: file, title: contactTitle }, 'Persona matched');
      return content;
    }
  }

  // No match — use default
  logger.info({ module: 'knowledge-loader', title: contactTitle }, 'No persona match, using default');
  return readKnowledgeFile('personas/default.yml');
}

/** Loads the email structure definition. */
export function loadEmailStructure(): string {
  return readKnowledgeFile('email-structure.yml');
}
