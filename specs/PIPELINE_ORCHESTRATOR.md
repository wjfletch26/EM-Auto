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
| Approval Watcher | `src/engine/approval-watcher.ts` | Incremental single-step sync: approved Review Queue steps → Campaigns row (append step 1, patch 2–12) |
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
1. Read Review Queue, Contacts, and Campaigns in parallel

2. Group review queue entries by contact email
   - Skip entries where status = 'superseded'

3. For each contact email group (at most ONE mutation per contact this run):
   a. Filter to approved entries; build deduplicated step map (collectApprovedStepsByStep)
   b. Determine max step already present on the Campaigns row (maxSyncedStepFromCampaign)
   c. nextStep = maxSynced + 1; if nextStep > 12 → skip
   d. validateContiguousApprovedPrefix(stepMap, nextStep): steps 1..nextStep must be approved with non-empty subject/body
   e. If the Review Queue row for nextStep already has contact.campaign_id → skip (already synced)
   f. No contact campaign_id and nextStep = 1:
      - If step‑1 row already carries a stray campaign_id → skip (orphan row)
      - Else append Campaigns row: campaign_id "ai_<slug>_<timestamp>", name "AI: <company>",
        total_steps=12, populate ONLY step 1 triplet (template=ai_review_queue:<row>, subject,
        delay 0); remaining triplets blank; active=TRUE, campaign_type=ai_generated
      - Update that step‑1 Review Queue row with campaign_id and approved_date
      - Update contact: pipeline_status=approved, campaign_id
   g. Else contact already has campaign_id:
      - Load campaign row (_rowIndex from getCampaigns); PATCH only nextStep triplet
        (same template pattern; delay 0 for step 1, 30 for steps 2–12 when patching)
      - Update that step’s Review Queue row with campaign_id and approved_date
      - Optionally set pipeline_status=approved if not already

Each cron invocation promotes at most one new step per contact (no “catch‑up drain” of
steps 5–10 in one pass). Further approved steps sync on subsequent runs.
validateApprovedSteps(full 12‑row checks) remains for tests / tooling.
```

**After approval watcher runs**, once step 1 is synced the contact has a `campaign_id` and is eligible when the sequence engine permits (first send still gated by delays / `lastSendDate`). Operators can approve later steps anytime; loading into Campaigns waits for contiguous approval plus prior steps on sheet.

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
| `Review Queue` | All columns (idempotency check, approval check) | Append 12 rows (Phase B); incremental `campaign_id` / `approved_date` only on steps synced by Approval Watcher |
| `Campaigns` | — | Approval Watcher: append row with step 1 only when first syncing; PATCH one triplet per later step |

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
export function collectApprovedStepsByStep(approved: ReviewQueueEntry[]): ApprovedStepsCollectionResult;
export function validateContiguousApprovedPrefix(
  stepMap: Map<number, ReviewQueueEntry>,
  upToInclusive: number,
): { ok: boolean; reason?: string };
export function maxSyncedStepFromCampaign(campaign: Campaign | undefined): number;
export function planIncrementalCampaignSync(
  contact: Contact | undefined,
  entries: ReviewQueueEntry[],
  campaign: Campaign | undefined,
): IncrementalCampaignSyncPlan;
/** Legacy — full 12 approved rows validation (tests / tooling). */
export function validateApprovedSteps(approved: ReviewQueueEntry[]): ApprovedValidationResult;
export function buildApprovalContactUpdate(): Partial<ContactUpdate>;
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
