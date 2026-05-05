/**
 * Runs the complete email QC pipeline and returns the merged result.
 *
 * This helper is the single source of truth for QC pass/fail:
 * hard deterministic checks + LLM review merged into one QualityReview object.
 */

import { loadEmailStructure, loadPersona } from '../skills/knowledge-loader.js';
import { reviewEmailQuality, type QualityReview } from '../skills/quality-reviewer.js';
import { mergeHardQCIntoReview, runHardEmailQC } from './email-hard-qc.js';
import { visitLanguageGuidanceForPrompt } from '../content/texas-triangle-visit-policy.js';
import type { CompanyProfile } from '../skills/company-research.js';
import type { EmailSequence } from '../skills/email-generator.js';
import type { AlignmentResult } from '../skills/deaton-alignment.js';
import type { LLMProvider } from '../services/llm-provider.js';

export interface FullQcInput {
  provider: LLMProvider;
  companyProfile: CompanyProfile;
  sequence: EmailSequence;
  alignment: AlignmentResult;
  contactTitle: string;
  allowlistedCaseStudyIds: string[];
  davidProjectNotes: string;
}

/**
 * Runs hard QC + LLM QC and merges both into a single review object.
 */
export async function runFullMergedQC(input: FullQcInput): Promise<QualityReview> {
  const hard = runHardEmailQC({
    emails: input.sequence.emails.map((e) => ({
      step: e.step,
      subject: e.subject,
      body: e.body,
    })),
    allowlistedCaseStudyIds: input.allowlistedCaseStudyIds,
    davidProjectNotes: input.davidProjectNotes,
    headquarters: input.companyProfile.headquarters,
  });

  const persona = loadPersona(input.contactTitle);
  const llmQc = await reviewEmailQuality(
    input.provider,
    input.companyProfile,
    input.sequence,
    persona,
    {
      alignmentJson: JSON.stringify(input.alignment, null, 2),
      davidProjectNotes: input.davidProjectNotes || '(none)',
      emailStructure: loadEmailStructure(),
      geographyVisitPolicy: visitLanguageGuidanceForPrompt(input.companyProfile.headquarters),
    },
  );

  return mergeHardQCIntoReview(llmQc, hard);
}
