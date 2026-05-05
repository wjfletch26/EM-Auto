# Intelligence Pipeline — Spec

## Purpose

The intelligence pipeline prepares contacts for AI-generated sequences. It:

1. Researches each **company once** (canonical `company_url`), stores shared context on **Company Profiles**, and evaluates Deaton alignment at company scope.
2. Links each **contact** to that profile via **Company Intelligence** and personalizes sequences from contact fields + notes.
3. Generates a 12-email outreach sequence using an LLM.
4. Runs a quality review pass and writes all drafts to the **Review Queue** tab.
5. Waits for a human operator to approve all 12 drafts in Sheets.
6. When approved, materialises a campaign row and makes the contact eligible to send.

The pipeline is **opt-in**: it only runs when `PIPELINE_ENABLED=true`. When disabled, no pipeline code executes and no LLM calls are made.

---

## Modules

| Module | File | Responsibility |
|---|---|---|
| Pipeline Orchestrator | `src/engine/pipeline-orchestrator.ts` | Phase A/B; company URL lock; shared intelligence mutex |
| Company profile refresh | `src/engine/company-profile-refresh.ts` | Monthly cron re-research for stale Company Profiles |
| Intelligence mutex | `src/engine/intelligence-job-mutex.ts` | Excludes pipeline vs refresh overlap |
| Canonical URL lock | `src/utils/company-url-lock.ts` | Queues concurrent work for the same company |
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
| `PIPELINE_COMPANY_REFRESH_CRON` | `0 3 1 * *` | Cron for `runCompanyProfileRefreshCycle` (default monthly, 03:00 1st) |
| `PIPELINE_COMPANY_REFRESH_ENABLED` | `true` | When `false`, skips scheduled profile refresh |
| `PIPELINE_COMPANY_STALE_AFTER_DAYS` | `28` | Minimum age of `last_refreshed_at` before a profile is eligible |
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

**`research_failed` / `generation_failed` contacts** — contact-level errors accumulate in `Company Intelligence.error_log`; company-level research failures also write to **`Company Profiles.error_log`**. Operators reset `pipeline_status` after inspection.

---

## Phase A — Research and Alignment (company-scoped)

**Trigger:** `pipeline_status = 'new'` AND `company_url` is not blank.

Canonical company key: `normalizeCanonicalCompanyUrl(contact.company_url)` (HTTPS, no `www.` prefix, normalized path).

**Concurrency:** `withCanonicalCompanyLock(canonicalUrl)` serializes research for the same firm. The pipeline and **monthly refresh** share `intelligence-job-mutex.ts` so two jobs never mutate profiles at once.

**Steps (per contact, but research runs once per canonical URL):**

```
1. pipeline_status = 'researching' on the contact

2. Under per-URL lock, load Company Profiles row for canonical URL

3. If profile exists with usable alignment (alignment_complete, or refresh_failed with prior case studies):
     - Ensure Company Intelligence row exists for this contact_email (canonical_company_url, briefing fields)
     - Set contact + intel to 'alignment_complete' (or 'no_fit' if company row is no_fit)
     - RETURN (no Perplexity call)

4. If profile row exists with pipeline_status = 'researched' only (crash after research, before alignment):
     - Run Deaton Alignment from stored profile JSON
     - Update Company Profiles alignment columns → alignment_complete | no_fit
     - Ensure intel row, advance contact → done

5. Otherwise run full path:
     a. Perplexity research → write/update Company Profiles (pipeline_status researched, signals, summaries)
     b. Alignment LLM → update Company Profiles (capabilities, case studies, rationale, alignment_complete | no_fit)
     c. Append/update Company Intelligence for this contact (linkage columns)
     d. Advance contact.pipeline_status to match company outcome

6. no_fit stops additional outreach for contacts sharing that canonical URL until an operator resets the profile
```

---

## Phase B — Email Generation and Quality Review

**Trigger:** `pipeline_status = 'alignment_complete'` or `'ready_for_generation'`.

**Idempotency guard:** if the Review Queue already contains an unassigned, unsuperseded 12-step sequence for this contact, Phase B is skipped and `pipeline_status` is set to `pending_review`.

**Steps:**

```
1. pipeline_status = 'generating'

2. Load Company Profiles row joined by intel.canonical_company_url (fallback: normalize contact.company_url)

3. Reconstruct CompanyProfile + AlignmentResult from the profile row (`company-profile-helpers.ts`)

4. Build briefing string:
     mergeContactBriefing(contact, intel) — includes David notes + Contacts notes/custom columns

5. Email Generator inputs: CompanyProfile, AlignmentResult, contact names/title/company, briefing

6–8. Persona load, QC, Review Queue append, ExecutiveBrief on Company Intelligence — unchanged semantics

9. pending_review on contact; intel.pipeline_status mirrors generation completion states
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
| `Company Profiles` | All columns (join on canonical URL) | Append + update (research, alignment, refresh, company errors) |
| `Company Intelligence` | All columns (per-contact briefing, join key) | Append + update (intel + contact-scoped errors, executive brief) |
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
| Research API call fails | Updates `Company Profiles` with `research_failed` + `error_log`; contact → `research_failed` |
| Alignment LLM fails | Same as research failure path |
| Intel row not found after research write | Throws inside Phase A handler; caught and written as `research_failed` |
| Generation LLM fails | Sets `pipeline_status = 'generation_failed'`; error appended to **Company Intelligence** |
| Review Queue write fails | Propagates as `generation_failed` |
| Approval Watcher — invalid step set | Logs warning and skips that contact for this cycle |
| Approval Watcher — Sheets append fails | Caught at top-level; logged; watcher continues to next contact |

Errors accumulate in **`Company Intelligence.error_log`** (per contact), capped at 5,000 characters. Company-scoped failures also append to **`Company Profiles.error_log`**.

---

## Concurrency

- `runPipelineCycle` and `runCompanyProfileRefreshCycle` share **`intelligence-job-mutex.ts`** — only one intelligence job runs at a time (skipped with a debug log otherwise).
- Canonical URL updates are additionally serialized with **`withCanonicalCompanyLock`** inside Phase A / refresh so two writers never race the same company row.
- `runApprovalWatcherCycle`: protected by `approvalWatcherRunning` flag.
- Admin API and scheduler can both trigger jobs; mutexes prevent overlapping execution.

---

## Testing Guidance

- **Unit tests**: `src/engine/pipeline-orchestrator.test.ts` and `src/engine/approval-watcher.test.ts`.
- **Smoke test**: `npm run pipeline:run` (calls `runPipelineCycle` then `runApprovalWatcherCycle`).
- **Status check**: `npm run pipeline:status` (prints Sheets pipeline counts).
- **LLM smoke test**: `npm run pipeline:test-llm` (calls the LLM provider and logs the response).
- To re-run a failed contact: in Sheets, set `pipeline_status = 'new'` (research re-runs) or `'alignment_complete'` (generation re-runs only).
