/**
 * Company Research Skill — uses Perplexity to build a structured company profile.
 *
 * Takes a company URL, sends it to Perplexity's web-search-enabled API,
 * and returns a structured profile with signals.
 */

import { z } from 'zod';
import { logger } from '../logging/logger.js';
import { loadPrompt } from '../services/prompt-loader.js';
import { extractJSON, type LLMProvider } from '../services/llm-provider.js';

// ─── Output Schema ───────────────────────────────────────────────────────────

const SignalSchema = z.object({
  type: z.string(),
  description: z.string(),
  source: z.string().optional().default(''),
  confidence: z.enum(['high', 'medium', 'low']),
});

export const CompanyProfileSchema = z.object({
  company_name: z.string(),
  website: z.string(),
  industry: z.string(),
  sub_industry: z.string().nullable().optional(),
  product_summary: z.string(),
  company_size: z.string().nullable().optional().transform((v) => v ?? 'unknown'),
  founded_year: z.number().nullable().optional(),
  headquarters: z.string().nullable().optional(),
  signals: z.array(SignalSchema).optional().default([]),
  signal_summary: z.string().optional().default(''),
  technologies_mentioned: z.array(z.string()).optional().default([]),
  key_challenges_inferred: z.array(z.string()).optional().default([]),
});

export type CompanyProfile = z.infer<typeof CompanyProfileSchema>;

// ─── Skill Entry Point ───────────────────────────────────────────────────────

/**
 * Researches a company using Perplexity and returns a structured profile.
 *
 * @param provider    - The Perplexity LLM provider instance
 * @param companyUrl  - The target company's website URL
 * @returns Parsed and validated company profile
 */
export async function researchCompany(
  provider: LLMProvider,
  companyUrl: string,
): Promise<CompanyProfile> {
  logger.info({ module: 'company-research', companyUrl }, 'Starting company research');

  // Load and render the research prompt
  const { systemPrompt, userPrompt } = loadPrompt('company-research', {
    company_url: companyUrl,
  });

  // Call Perplexity (has built-in web search)
  const rawResponse = await provider.complete({
    systemPrompt,
    userPrompt,
    temperature: 0.1,
    maxTokens: 4096,
    responseFormat: 'json',
  });

  // Extract and parse JSON from the response
  const jsonStr = extractJSON(rawResponse);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    logger.error(
      { module: 'company-research', companyUrl, rawResponse: rawResponse.slice(0, 500) },
      'Failed to parse research response as JSON',
    );
    throw new Error(`Company research returned invalid JSON: ${err}`);
  }

  // Validate against schema
  const result = CompanyProfileSchema.safeParse(parsed);
  if (!result.success) {
    logger.error(
      { module: 'company-research', companyUrl, errors: result.error.issues },
      'Research response failed schema validation',
    );
    throw new Error(`Company research schema validation failed: ${result.error.message}`);
  }

  logger.info(
    {
      module: 'company-research',
      companyUrl,
      companyName: result.data.company_name,
      signalCount: result.data.signals.length,
    },
    'Company research complete',
  );

  return result.data;
}
