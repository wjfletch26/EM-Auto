/**
 * Deaton Alignment Skill — compares a company profile to Deaton's capabilities.
 *
 * Loads the Deaton profile and all case studies, then asks the LLM to
 * determine which capabilities are relevant, select 1-2 case studies,
 * and assess fit confidence.
 */

import { z } from 'zod';
import { logger } from '../logging/logger.js';
import { loadPrompt } from '../services/prompt-loader.js';
import { extractJSON, type LLMProvider } from '../services/llm-provider.js';
import { loadDeatonProfile, loadCaseStudies } from './knowledge-loader.js';
import type { CompanyProfile } from './company-research.js';

// ─── Output Schema ───────────────────────────────────────────────────────────

const CapabilityMatchSchema = z.object({
  capability_key: z.string(),
  capability_name: z.string(),
  relevance_explanation: z.string(),
});

const CaseStudyMatchSchema = z.object({
  case_study_id: z.string(),
  relevance_rationale: z.string(),
});

export const AlignmentResultSchema = z.object({
  relevant_capabilities: z.array(CapabilityMatchSchema),
  selected_case_studies: z.array(CaseStudyMatchSchema),
  connection_bridge: z.string(),
  confidence: z.enum(['high', 'medium', 'low']),
  confidence_reasoning: z.string(),
  no_fit_flag: z.boolean(),
  no_fit_reason: z.string().nullable().optional(),
});

export type AlignmentResult = z.infer<typeof AlignmentResultSchema>;

// ─── Skill Entry Point ───────────────────────────────────────────────────────

/**
 * Evaluates alignment between a target company and Deaton's capabilities.
 *
 * @param provider       - The LLM provider to use for analysis
 * @param companyProfile - The researched company profile
 * @returns Structured alignment result with confidence scoring
 */
export async function evaluateAlignment(
  provider: LLMProvider,
  companyProfile: CompanyProfile,
): Promise<AlignmentResult> {
  logger.info(
    { module: 'deaton-alignment', company: companyProfile.company_name },
    'Starting alignment evaluation',
  );

  // Load knowledge base
  const deatonProfile = loadDeatonProfile();
  const caseStudies = loadCaseStudies();

  // Format the company profile and signals as strings for the prompt
  const profileStr = JSON.stringify(companyProfile, null, 2);
  const signalsStr = JSON.stringify(companyProfile.signals, null, 2);

  // Load and render the alignment prompt
  const { systemPrompt, userPrompt } = loadPrompt('deaton-alignment', {
    deaton_profile: deatonProfile,
    case_studies: caseStudies,
    company_profile: profileStr,
    company_signals: signalsStr,
  });

  // Call the LLM
  const rawResponse = await provider.complete({
    systemPrompt,
    userPrompt,
    temperature: 0.2,
    maxTokens: 4096,
  });

  // Extract and parse JSON
  const jsonStr = extractJSON(rawResponse);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    logger.error(
      { module: 'deaton-alignment', company: companyProfile.company_name },
      'Failed to parse alignment response as JSON',
    );
    throw new Error(`Alignment response invalid JSON: ${err}`);
  }

  // Validate against schema
  const result = AlignmentResultSchema.safeParse(parsed);
  if (!result.success) {
    logger.error(
      { module: 'deaton-alignment', errors: result.error.issues },
      'Alignment response failed schema validation',
    );
    throw new Error(`Alignment schema validation failed: ${result.error.message}`);
  }

  logger.info(
    {
      module: 'deaton-alignment',
      company: companyProfile.company_name,
      confidence: result.data.confidence,
      noFit: result.data.no_fit_flag,
      capabilitiesMatched: result.data.relevant_capabilities.length,
      caseStudiesSelected: result.data.selected_case_studies.length,
    },
    'Alignment evaluation complete',
  );

  return result.data;
}
