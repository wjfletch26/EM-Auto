/**
 * Regenerates a single Review Queue email from David's per-step notes,
 * then checks cohesion against the other 11 emails.
 */

import { z } from 'zod';
import { logger } from '../logging/logger.js';
import { loadPrompt } from '../services/prompt-loader.js';
import { extractJSON, type LLMProvider } from '../services/llm-provider.js';
import {
  loadDeatonProfile,
  loadCaseStudies,
  loadPersona,
  loadEmailStructure,
} from './knowledge-loader.js';
import type { CompanyProfile } from './company-research.js';
import type { AlignmentResult } from './deaton-alignment.js';
import type { ContactContext, EmailSequence } from './email-generator.js';

const SingleEmailSchema = z.object({
  subject: z.string(),
  body: z.string(),
});

const CohesionSchema = z.object({
  pass: z.boolean(),
  summary: z.string(),
  issues: z.array(z.string()),
});

export type OtherEmailSlice = { step: number; subject: string; body: string };

/**
 * Regenerates one email body+subject using David's notes and full context.
 */
export async function regenerateSingleReviewEmail(
  provider: LLMProvider,
  params: {
    companyProfile: CompanyProfile;
    alignment: AlignmentResult;
    contact: ContactContext;
    personaTitle: string;
    stepNumber: number;
    stepPurpose: string;
    daveNotes: string;
    otherEmails: OtherEmailSlice[];
  },
): Promise<{ subject: string; body: string }> {
  const persona = loadPersona(params.personaTitle);
  const { systemPrompt, userPrompt } = loadPrompt('review-queue-single-email', {
    deaton_profile: loadDeatonProfile(),
    case_studies: loadCaseStudies(),
    persona,
    email_structure: loadEmailStructure(),
    company_profile: JSON.stringify(params.companyProfile, null, 2),
    alignment: JSON.stringify(params.alignment, null, 2),
    contact_first_name: params.contact.firstName,
    contact_last_name: params.contact.lastName,
    contact_title: params.contact.title,
    contact_company: params.contact.company,
    step_number: String(params.stepNumber),
    step_purpose: params.stepPurpose,
    other_emails_json: JSON.stringify(params.otherEmails, null, 2),
    dave_notes: params.daveNotes.trim(),
  });

  const raw = await provider.complete({
    systemPrompt,
    userPrompt,
    temperature: 0.35,
    maxTokens: 2048,
  });

  const parsed = SingleEmailSchema.safeParse(JSON.parse(extractJSON(raw)));
  if (!parsed.success) {
    logger.error({ module: 'regenerate-review-email', errors: parsed.error.issues }, 'Invalid single-email JSON');
    throw new Error('Regeneration returned invalid JSON for subject/body');
  }
  return parsed.data;
}

/**
 * LLM pass: checks the full 12-email sequence after one step was rewritten.
 */
export async function reviewRegeneratedEmailCohesion(
  provider: LLMProvider,
  sequence: EmailSequence,
  rewrittenStep: number,
): Promise<{ pass: boolean; summary: string; issues: string[] }> {
  const { systemPrompt, userPrompt } = loadPrompt('review-queue-cohesion', {
    email_structure: loadEmailStructure(),
    emails_json: JSON.stringify(sequence, null, 2),
    rewritten_step: String(rewrittenStep),
  });

  const raw = await provider.complete({
    systemPrompt,
    userPrompt,
    temperature: 0.1,
    maxTokens: 1024,
  });

  const parsed = CohesionSchema.safeParse(JSON.parse(extractJSON(raw)));
  if (!parsed.success) {
    return {
      pass: false,
      summary: 'Cohesion review could not be parsed.',
      issues: ['Cohesion JSON invalid — manual review recommended.'],
    };
  }
  return {
    pass: parsed.data.pass,
    summary: parsed.data.summary,
    issues: parsed.data.issues,
  };
}
