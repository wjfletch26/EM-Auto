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
import { replaceEmDashesWithPlainHyphen } from '../content/replace-em-dashes.js';
import { normalizePlainBodyHyphens } from '../content/body-hyphen-normalize.js';
import { visitLanguageGuidanceForPrompt } from '../content/texas-triangle-visit-policy.js';

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

export type RegenMode = 'auto_qc' | 'user_directed';

interface RegenerateBaseParams {
  companyProfile: CompanyProfile;
  alignment: AlignmentResult;
  contact: ContactContext;
  personaTitle: string;
  stepNumber: number;
  stepPurpose: string;
  originalEmail: { subject: string; body: string };
  otherEmails: OtherEmailSlice[];
  davidProjectNotes: string;
  qcRemediation: string;
}

type RegenerateAutoQcParams = RegenerateBaseParams & {
  regenMode: 'auto_qc';
};

type RegenerateUserDirectedParams = RegenerateBaseParams & {
  regenMode: 'user_directed';
  userNotes: string;
};

export type RegenerateSingleEmailParams =
  | RegenerateAutoQcParams
  | RegenerateUserDirectedParams;

/** Runtime guardrail: auto_qc mode must never receive user notes. */
export function validateRegenParams(params: RegenerateSingleEmailParams): void {
  if (params.regenMode === 'auto_qc' && 'userNotes' in params) {
    throw new Error('auto_qc regeneration cannot accept user notes');
  }
}

/**
 * Builds a concise remediation block from QC issues and optional suggestion.
 * Keeps prompts focused on repair for the target step only.
 */
export function buildQcRemediation(
  issues: string[],
  suggestion?: string | null,
): string {
  // Keep enough text for merged LLM + Hard QC issues (geography rules can be long).
  const cappedIssues = issues.slice(0, 10).map((i) => i.trim()).filter(Boolean);
  const issueText = cappedIssues
    .map((i, idx) => `${idx + 1}. ${i}`)
    .join('\n')
    .slice(0, 2200);
  const suggestionText = (suggestion ?? '').trim().slice(0, 600);
  const parts = [
    issueText ? `Issues:\n${issueText}` : 'Issues: (none provided)',
    suggestionText ? `Suggested direction: ${suggestionText}` : '',
  ].filter(Boolean);
  return parts.join('\n\n');
}

/**
 * Regenerates one email body+subject using David's notes and full context.
 */
export async function regenerateSingleReviewEmail(
  provider: LLMProvider,
  params: RegenerateSingleEmailParams,
): Promise<{ subject: string; body: string }> {
  validateRegenParams(params);
  const persona = loadPersona(params.personaTitle);
  const promptName = params.regenMode === 'auto_qc'
    ? 'review-queue-regen-auto-qc'
    : 'review-queue-regen-user-directed';
  const userNotes = params.regenMode === 'user_directed' ? params.userNotes : '';

  const { systemPrompt, userPrompt } = loadPrompt(promptName, {
    deaton_profile: loadDeatonProfile(),
    case_studies: loadCaseStudies(),
    persona,
    email_structure: loadEmailStructure(),
    geography_visit_policy: visitLanguageGuidanceForPrompt(params.companyProfile.headquarters),
    company_profile: JSON.stringify(params.companyProfile, null, 2),
    alignment: JSON.stringify(params.alignment, null, 2),
    contact_first_name: params.contact.firstName,
    contact_last_name: params.contact.lastName,
    contact_title: params.contact.title,
    contact_company: params.contact.company,
    step_number: String(params.stepNumber),
    step_purpose: params.stepPurpose,
    original_email_json: JSON.stringify(params.originalEmail, null, 2),
    other_emails_json: JSON.stringify(params.otherEmails, null, 2),
    david_project_notes: params.davidProjectNotes.trim(),
    qc_remediation: params.qcRemediation.trim(),
    user_notes: userNotes.trim(),
  });

  const raw = await provider.complete({
    systemPrompt,
    userPrompt,
    temperature: params.regenMode === 'auto_qc' ? 0.2 : 0.35,
    maxTokens: 2048,
  });

  const parsed = SingleEmailSchema.safeParse(JSON.parse(extractJSON(raw)));
  if (!parsed.success) {
    logger.error({ module: 'regenerate-review-email', errors: parsed.error.issues }, 'Invalid single-email JSON');
    throw new Error('Regeneration returned invalid JSON for subject/body');
  }
  // Same typography policy as generateEmailSequence: no long dashes in stored or sent copy.
  return {
    subject: replaceEmDashesWithPlainHyphen(parsed.data.subject),
    body: normalizePlainBodyHyphens(replaceEmDashesWithPlainHyphen(parsed.data.body)),
  };
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
