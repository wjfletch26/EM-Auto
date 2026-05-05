/**
 * Email Generator Skill — produces a 12-email outreach sequence.
 *
 * Takes the full context (company profile, signals, alignment, persona,
 * David's notes, email structure) and generates all 12 emails in one call.
 */

import { z } from 'zod';
import { logger } from '../logging/logger.js';
import { loadPrompt } from '../services/prompt-loader.js';
import { extractJSON, type LLMProvider } from '../services/llm-provider.js';
import {
  loadDeatonProfile, loadCaseStudies,
  loadPersona, loadEmailStructure,
} from './knowledge-loader.js';
import type { CompanyProfile } from './company-research.js';
import type { AlignmentResult } from './deaton-alignment.js';
import { replaceEmDashesWithPlainHyphen } from '../content/replace-em-dashes.js';
import { normalizePlainBodyHyphens } from '../content/body-hyphen-normalize.js';
import { visitLanguageGuidanceForPrompt } from '../content/texas-triangle-visit-policy.js';

// ─── Output Schema ───────────────────────────────────────────────────────────

const GeneratedEmailSchema = z.object({
  step: z.number(),
  purpose: z.string(),
  subject: z.string().default('(no subject)'),
  body: z.string().default(''),
});

export const EmailSequenceSchema = z.object({
  emails: z.array(GeneratedEmailSchema).min(12).max(12),
});

export type GeneratedEmail = z.infer<typeof GeneratedEmailSchema>;
export type EmailSequence = z.infer<typeof EmailSequenceSchema>;

// ─── Contact context passed to the generator ─────────────────────────────────

export interface ContactContext {
  firstName: string;
  lastName: string;
  title: string;
  company: string;
}

// ─── Skill Entry Point ───────────────────────────────────────────────────────

/**
 * Generates a full 12-email sequence for a contact.
 *
 * @param provider       - LLM provider for generation
 * @param companyProfile - Researched company profile
 * @param alignment      - Deaton alignment result
 * @param contact        - Contact info (name, title, company)
 * @param davidNotes     - Optional project notes from David (highest priority)
 * @returns 12 structured emails
 */
export async function generateEmailSequence(
  provider: LLMProvider,
  companyProfile: CompanyProfile,
  alignment: AlignmentResult,
  contact: ContactContext,
  davidNotes: string = '',
): Promise<EmailSequence> {
  logger.info(
    { module: 'email-generator', company: companyProfile.company_name, contact: contact.firstName },
    'Starting email sequence generation',
  );

  // Load all knowledge context
  const deatonProfile = loadDeatonProfile();
  const caseStudies = loadCaseStudies();
  const persona = loadPersona(contact.title);
  const emailStructure = loadEmailStructure();

  // Load and render the generation prompt
  const { systemPrompt, userPrompt } = loadPrompt('email-generation', {
    deaton_profile: deatonProfile,
    case_studies: caseStudies,
    persona,
    email_structure: emailStructure,
    geography_visit_policy: visitLanguageGuidanceForPrompt(companyProfile.headquarters),
    company_profile: JSON.stringify(companyProfile, null, 2),
    company_signals: JSON.stringify(companyProfile.signals, null, 2),
    alignment: JSON.stringify(alignment, null, 2),
    contact_first_name: contact.firstName,
    contact_last_name: contact.lastName,
    contact_title: contact.title,
    contact_company: contact.company,
    david_notes: davidNotes || '(No project notes provided)',
  });

  // Call the LLM — larger token budget for 12 emails
  const rawResponse = await provider.complete({
    systemPrompt,
    userPrompt,
    temperature: 0.4,
    maxTokens: 8192,
  });

  // Extract and parse JSON
  const jsonStr = extractJSON(rawResponse);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    logger.error(
      { module: 'email-generator', company: companyProfile.company_name },
      'Failed to parse email generation response as JSON',
    );
    throw new Error(`Email generation returned invalid JSON: ${err}`);
  }

  // Validate against schema
  const result = EmailSequenceSchema.safeParse(parsed);
  if (!result.success) {
    logger.error(
      { module: 'email-generator', errors: result.error.issues },
      'Email generation failed schema validation',
    );
    throw new Error(`Email sequence schema validation failed: ${result.error.message}`);
  }

  logger.info(
    {
      module: 'email-generator',
      company: companyProfile.company_name,
      emailCount: result.data.emails.length,
    },
    'Email sequence generation complete',
  );

  // Enforce no em dashes in subjects or bodies (see prompts/email-generation.md).
  return {
    emails: result.data.emails.map((e) => ({
      ...e,
      subject: replaceEmDashesWithPlainHyphen(e.subject),
      body: normalizePlainBodyHyphens(replaceEmDashesWithPlainHyphen(e.body)),
    })),
  };
}
