/**
 * Quality Reviewer Skill — evaluates generated emails before they reach David.
 *
 * Checks for relevance, specificity, generic language, unsupported claims,
 * tone, and sequence progression. Returns a pass/flag decision.
 */

import { z } from 'zod';
import { logger } from '../logging/logger.js';
import { loadPrompt } from '../services/prompt-loader.js';
import { extractJSON, type LLMProvider } from '../services/llm-provider.js';
import type { CompanyProfile } from './company-research.js';
import type { EmailSequence } from './email-generator.js';

// ─── Output Schema ───────────────────────────────────────────────────────────

const EmailReviewSchema = z.object({
  step: z.number(),
  pass: z.boolean(),
  issues: z.array(z.string()),
  suggestion: z.string().nullable().optional(),
});

export const QualityReviewSchema = z.object({
  overall_pass: z.boolean(),
  overall_score: z.enum(['high', 'medium', 'low']),
  overall_notes: z.string(),
  email_reviews: z.array(EmailReviewSchema),
  flags: z.array(z.string()),
});

export type QualityReview = z.infer<typeof QualityReviewSchema>;

/** Extra context so the reviewer can check case-study fit and David's notes. */
export interface QualityReviewContext {
  alignmentJson: string;
  davidProjectNotes: string;
  emailStructure: string;
  /** From headquarters: Texas Triangle proximity rules for visits / step 9. */
  geographyVisitPolicy?: string;
}

// ─── Skill Entry Point ───────────────────────────────────────────────────────

/**
 * Reviews a generated email sequence for quality.
 *
 * @param provider       - LLM provider for the review
 * @param companyProfile - The company the emails are about
 * @param emails         - The generated 12-email sequence
 * @param personaStr     - The persona YAML used for generation
 * @param context        - Optional alignment, David's notes, and sequence structure
 * @returns Quality review with per-email assessments and flags
 */
export async function reviewEmailQuality(
  provider: LLMProvider,
  companyProfile: CompanyProfile,
  emails: EmailSequence,
  personaStr: string,
  context?: QualityReviewContext,
): Promise<QualityReview> {
  logger.info(
    { module: 'quality-reviewer', company: companyProfile.company_name },
    'Starting quality review',
  );

  // Load and render the review prompt
  const { systemPrompt, userPrompt } = loadPrompt('quality-review', {
    company_profile: JSON.stringify(companyProfile, null, 2),
    company_signals: JSON.stringify(companyProfile.signals, null, 2),
    emails_json: JSON.stringify(emails, null, 2),
    persona: personaStr,
    alignment_json: context?.alignmentJson ?? '{}',
    david_project_notes: context?.davidProjectNotes ?? '',
    email_structure: context?.emailStructure ?? '',
    geography_visit_policy: context?.geographyVisitPolicy ?? '',
  });

  const rawResponse = await provider.complete({
    systemPrompt,
    userPrompt,
    temperature: 0.1,
    maxTokens: 4096,
  });

  // Extract and parse JSON
  const jsonStr = extractJSON(rawResponse);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    logger.error(
      { module: 'quality-reviewer', company: companyProfile.company_name },
      'Failed to parse quality review response as JSON',
    );
    throw new Error(`Quality review returned invalid JSON: ${err}`);
  }

  // Validate
  const result = QualityReviewSchema.safeParse(parsed);
  if (!result.success) {
    // If QC itself fails to parse, treat the emails as needing manual review
    logger.warn(
      { module: 'quality-reviewer', errors: result.error.issues },
      'Quality review schema validation failed — flagging for manual review',
    );
    return {
      overall_pass: false,
      overall_score: 'low',
      overall_notes: 'Quality review could not be completed — manual review required.',
      email_reviews: [],
      flags: ['QC system error: review response did not match expected schema'],
    };
  }

  logger.info(
    {
      module: 'quality-reviewer',
      company: companyProfile.company_name,
      pass: result.data.overall_pass,
      score: result.data.overall_score,
      flagCount: result.data.flags.length,
    },
    'Quality review complete',
  );

  return result.data;
}
