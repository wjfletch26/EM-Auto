# Intelligence Pipeline — Spec

## Purpose

The intelligence pipeline enriches each contact before sending. It:

1. Researches the contact's company using Perplexity (web-enabled search).
2. Evaluates how well Deaton Engineering's capabilities match the company.
3. Generates a 12-email outreach sequence using an LLM.
4. Runs a quality review pass and writes all drafts to the **Review Queue** tab.
5. Waits for a human operator to approve all 12 drafts in Sheets.
6. When approved, materialises a campaign row and makes the contact eligible to send.

The pipeline is **opt-in**: it only runs when `PIPELINE_ENABLED=true`. When disabled, no pipeline code executes and no LLM calls are made.

---

## Modules

| Module | File | Responsibility |
|---|---|---|
| Pipeline Orchestrator | `src/engine/pipeline-orchestrator.ts` | Runs Phase A (research/alignment) and Phase B (generation/QC) in a cron cycle |
| Approval Watcher | `src/engine/approval-watcher.ts` | Scans Review Queue for fully approved sequences and creates campaigns |
| Company Research | `src/skills/company-research.ts` | Calls Perplexity; returns structured `CompanyProfile` |
| Deaton Alignment | `src/skills/deaton-alignment.ts` | Calls LLM with knowledge base; returns alignment + case study selection |
| Email Generator | `src/skills/email-generator.ts` | Calls LLM; returns 12 `EmailDraft` objects |
| Quality Reviewer | `src/skills/quality-reviewer.ts` | Calls LLM; returns `QCResult` with per-email flags |
| Knowledge Loader | `src/skills/knowledge-loader.ts` | Loads YAML files from `knowledge/` for prompts |
| LLM Provider | `src/services/llm-provider.ts` | Wraps OpenAI-compatible API (Perplexity/custom) |
| Prompt Loader | `src/services/prompt-loader.ts` | Loads prompt Markdown files from `prompts/` |

---

## Configuration

| Env Var | Default | Description |
|---|---|---|
| `PIPELINE_ENABLED` | `false` | Must be `true` to run any pipeline code |
| `PIPELINE_CRON` | `*/5 * * * *` | Cron schedule for `runPipelineCycle` |
| `PERPLEXITY_API_KEY` | `""` | API key for the Perplexity research step |
| `PERPLEXITY_MODEL` | `sonar` | Perplexity model for company research |
| `LLM_API_KEY` | `""` | API key for alignment, generation, and QC steps |
| `LLM_PROVIDER` | `perplexity` | LLM provider name (Perplexity or OpenAI-compatible) |
| `LLM_MODEL` | `sonar` | Model for alignment, generation, QC |
| `LLM_BASE_URL` | `https://api.perplexity.ai` | Base URL for the LLM API |

---

## Pipeline State Machine

The `pipeline_status` field on the `Contacts` tab drives all routing decisions.

```
new
  └─(Phase A)─→ researching
                    └─(alignment ok)─→ alignment_complete
                    └─(no fit)───────→ no_fit              [terminal]
                    └─(error)────────→ research_failed     [retryable: reset to 'new']

alignment_complete  (also accepts: ready_for_generation)
  └─(Phase B)─→ generating
                    └─(success)──────→ pending_review
                    └─(error)────────→ generation_failed   [retryable: reset to 'alignment_complete']

pending_review
  └─(operator approves all 12 in Sheets)

[Approval Watcher]
  all 12 approved → approved                               [contact enters send pipeline]
```

**`no_fit` contacts** are skipped permanently and never sent to. The operator can manually override `pipeline_status` in Sheets.

**`research_failed` / `generation_failed` contacts** are retried in the next cycle. Errors accumulate in `Company Intelligence.error_log` (capped at 5,000 characters). After `MAX_RETRIES = 3`, the stage continues to fail until the operator inspects and resets the status manually.

---

## Phase A — Research and Alignment

**Trigger:** `pipeline_status = 'new'` AND `company_url` is not blank.

**Steps:**

```
1. Set pipeline_status = 'researching'

2. Call Company Research skill (Perplexity):
   - Prompt: prompts/company-research.md
   - Input: company_url
   - Output: CompanyProfile (company_name, industry, product_summary,
             company_size, signals[], signal_summary, technologies, challenges)
   - Write results to Company Intelligence tab (append or update)

3. Set pipeline_status = 'aligning'

4. Call Deaton Alignment skill (LLM):
   - Prompt: prompts/deaton-alignment.md
   - Inputs: CompanyProfile, knowledge/deaton-profile.yml, knowledge/case-studies/
   - Output: AlignmentResult (relevant_capabilities, selected_case_studies,
             connection_bridge, confidence, no_fit_flag)

5. Write alignment result to Company Intelligence tab

6. If no_fit_flag = true → set pipeline_status = 'no_fit' (stop)
   Otherwise           → set pipeline_status = 'alignment_complete'
```

---

## Phase B — Email Generation and Quality Review

**Trigger:** `pipeline_status = 'alignment_complete'` or `'ready_for_generation'`.

**Idempotency guard:** if the Review Queue already contains an unassigned, unsuperseded 12-step sequence for this contact, Phase B is skipped and `pipeline_status` is set to `pending_review`. This prevents duplicate generation on retries.

**Steps:**

```
1. Set pipeline_status = 'generating'

2. Reconstruct CompanyProfile and AlignmentResult from Company Intelligence tab

3. Call Email Generator skill (LLM):
   - Prompt: prompts/email-generation.md
   - Inputs: CompanyProfile, AlignmentResult, contact metadata, davidProjectNotes
   - Output: EmailSequence (12 × {step, purpose, subject, body})
   - Subject normalisation: ensure non-empty; strip "(no subject)" defaults
   - Greeting normalisation: ensure name + comma is on its own line

4. Load persona via Knowledge Loader (based on contact.title):
   - Maps title keywords → persona YAML (knowledge/personas/)

5. Call Quality Reviewer skill (LLM):
   - Prompt: prompts/quality-review.md
   - Inputs: CompanyProfile, EmailSequence, Persona
   - Output: QCResult (overall_pass, overall_score, flags[], per-email issues)

6. Append 12 rows to Review Queue tab:
   - status = 'pending_review'
   - reviewer_notes = "FLAGGED BY QC: ..." if QC failed for that step

7. Write ExecutiveBrief to Company Intelligence tab

8. Set pipeline_status = 'pending_review' on both Contact and Company Intelligence
```

---

## Approval Watcher

**Trigger:** Called by scheduler (shares `PIPELINE_CRON`) or `POST /api/admin/actions/approval-watcher`.

**Mutex:** `approvalWatcherRunning` flag; overlapping runs are skipped.

**Algorithm:**

```
1. Read Review Queue and Contacts tabs in parallel

2. Group review queue entries by contact email
   - Skip entries where status = 'superseded'

3. For each contact email group:
   a. Filter to approved entries
   b. Skip if any entry already has a campaign_id (already loaded)
   c. Run validateApprovedSteps():
      - Requires exactly 12 entries, one per step 1–12
      - No duplicate step numbers
      - Each entry must have non-blank subject and body
   d. If validation fails → log warning and skip

4. For each validated set:
   a. Generate campaign_id: "ai_<company_slug>_<timestamp>"
   b. Build Campaigns tab row:
      - campaign_id, name ("AI: <company>"), total_steps=12
      - For each step: template=ai_review_queue:<rowIndex>, subject, delay_days
        (step 1 delay = 0; steps 2–12 delay = 30 days)
      - active=TRUE, campaign_type=ai_generated
   c. Append campaign row to Campaigns tab
   d. Update all 12 review queue rows with campaign_id and approved_date
   e. Update contact: pipeline_status = 'approved', campaign_id = <new campaign>
```

**After approval watcher runs**, the contact is eligible for the send engine on its next cron cycle. The send engine detects the contact has `pipeline_status = 'approved'` and a valid `campaign_id` and treats it as a normal sequence contact.

---

## Knowledge and Prompts Structure

```
knowledge/
  deaton-profile.yml          — Deaton Engineering capabilities, core value props
  email-structure.yml         — Structural rules for generated emails
  personas/
    default.yml               — Fallback persona
    engineering-leader.yml    — Matched when title contains "engineer"
    executive.yml             — Matched when title contains "CEO", "President", etc.
    operations-leader.yml     — Matched when title contains "operations", "COO", etc.
  case-studies/
    _template.yml             — Schema reference
    <name>.yml                — One file per case study; each has id, title, industry, summary

prompts/
  company-research.md         — Perplexity system+user prompt for company profiling
  deaton-alignment.md         — LLM prompt for capability matching + case study selection
  email-generation.md         — LLM prompt for 12-step sequence generation
  quality-review.md           — LLM prompt for per-email QC
```

---

## Sheets Tabs Used

| Tab | Read | Write |
|---|---|---|
| `Contacts` | `pipeline_status`, `company_url`, `email`, metadata | `pipeline_status`, `campaign_id` |
| `Company Intelligence` | All columns | All columns (append + update) |
| `Review Queue` | All columns (idempotency check, approval check) | Append 12 rows (Phase B), `campaign_id` / `approved_date` (Approval Watcher) |
| `Campaigns` | — | Append one row per approved sequence (Approval Watcher) |

---

## Public Interface

```typescript
// pipeline-orchestrator.ts
export async function runPipelineCycle(): Promise<void>;
export function hasExistingUnloadedSequence(contactEmail: string, reviewQueue: ReviewQueueEntry[]): boolean;
export function normalizeGeneratedSubject(subject: string, purpose: string, step: number, company: string): string;
export function normalizeGreetingBody(body: string, firstName: string): string;

// approval-watcher.ts
export async function runApprovalWatcherCycle(): Promise<void>;
export function validateApprovedSteps(approved: ReviewQueueEntry[]): ApprovedValidationResult;
export function buildApprovalContactUpdate(): Partial<ContactUpdate>;

export interface ApprovedValidationResult {
  ok: boolean;
  reason?: string;
  stepMap: Map<number, ReviewQueueEntry>;
}
```

---

## Error Handling

| Error | Behaviour |
|---|---|
| Research API call fails | Caught; writes error to `Company Intelligence.error_log`; sets `pipeline_status = 'research_failed'` |
| Alignment LLM fails | Same: `research_failed` |
| Intel row not found after research write | Throws inside Phase A handler; caught and written as `research_failed` |
| Generation LLM fails | Sets `pipeline_status = 'generation_failed'`; error appended to intel |
| Review Queue write fails | Propagates as `generation_failed` |
| Approval Watcher — invalid step set | Logs warning and skips that contact for this cycle |
| Approval Watcher — Sheets append fails | Caught at top-level; logged; watcher continues to next contact |

Errors accumulate in `Company Intelligence.error_log`, capped at 5,000 characters per contact. The field is preserved across retries (new errors are appended).

---

## Concurrency

- `runPipelineCycle`: protected by `pipelineRunning` mutex flag. Overlapping cron calls are silently skipped (debug log only).
- `runApprovalWatcherCycle`: protected by `approvalWatcherRunning` flag. Same behaviour.
- Both can be triggered concurrently from the admin API and the scheduler. The flags prevent double-execution.

---

## Testing Guidance

- **Unit tests**: `src/engine/pipeline-orchestrator.test.ts` and `src/engine/approval-watcher.test.ts`.
- **Smoke test**: `npm run pipeline:run` (calls `runPipelineCycle` then `runApprovalWatcherCycle`).
- **Status check**: `npm run pipeline:status` (prints Sheets pipeline counts).
- **LLM smoke test**: `npm run pipeline:test-llm` (calls the LLM provider and logs the response).
- To re-run a failed contact: in Sheets, set `pipeline_status = 'new'` (research re-runs) or `'alignment_complete'` (generation re-runs only).
