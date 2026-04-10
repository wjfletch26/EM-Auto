/**
 * Prompt Loader — reads prompt templates from disk and renders variables.
 *
 * Prompt files live in the `prompts/` directory as Markdown files.
 * Variables use double-brace syntax: {{variable_name}}
 *
 * Each prompt file contains two sections separated by "---":
 *   - Everything before the first "---" is the system prompt
 *   - Everything after is the user prompt
 *
 * Usage:
 *   import { loadPrompt } from './prompt-loader.js';
 *   const { systemPrompt, userPrompt } = loadPrompt('company-research', {
 *     company_url: 'https://example.com',
 *   });
 */

import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logging/logger.js';

export interface LoadedPrompt {
  systemPrompt: string;
  userPrompt: string;
}

/** Root directory for prompt template files. */
const PROMPTS_DIR = path.resolve('prompts');

/**
 * Loads a prompt template and renders all {{variable}} placeholders.
 *
 * @param promptName - Filename without extension (e.g., 'company-research')
 * @param variables  - Key-value pairs to inject into the template
 * @returns The rendered system and user prompts
 */
export function loadPrompt(
  promptName: string,
  variables: Record<string, string> = {},
): LoadedPrompt {
  const filePath = path.join(PROMPTS_DIR, `${promptName}.md`);

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    logger.error({ module: 'prompt-loader', promptName, path: filePath }, 'Prompt file not found');
    throw new Error(`Prompt file not found: ${filePath}`);
  }

  // Normalize line endings to \n (handles Windows \r\n)
  raw = raw.replace(/\r\n/g, '\n');

  // Split on the first "---" divider to separate system and user prompts
  const dividerIndex = raw.indexOf('\n---\n');

  let systemPrompt: string;
  let userPrompt: string;

  if (dividerIndex === -1) {
    // No divider — treat entire file as the user prompt with empty system prompt
    logger.warn({ module: 'prompt-loader', promptName }, 'No --- divider found, using full file as user prompt');
    systemPrompt = '';
    userPrompt = raw.trim();
  } else {
    systemPrompt = raw.slice(0, dividerIndex).trim();
    userPrompt = raw.slice(dividerIndex + 5).trim();
  }

  // Render variables — replace all {{key}} with values
  systemPrompt = renderVariables(systemPrompt, variables);
  userPrompt = renderVariables(userPrompt, variables);

  return { systemPrompt, userPrompt };
}

/**
 * Replaces all {{key}} placeholders in a string with values from the map.
 * Unmatched placeholders are left in place (the LLM may still handle them).
 */
function renderVariables(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    if (key in variables) {
      return variables[key];
    }
    logger.warn({ module: 'prompt-loader', variable: key }, 'Unresolved prompt variable');
    return match;
  });
}
