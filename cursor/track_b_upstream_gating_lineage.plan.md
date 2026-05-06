---
name: Track B Upstream gating lineage
overview: "Stop expensive 12-email generation when company intelligence is weak: add an upstream gate using existing and new signals, block contacts with explicit reason codes (never polluting the shared company row), separate company health from contact status in the dashboard, and record lineage (versions) so failures are explainable—without requiring a database on day one."
todos:
  - id: b1-gate-config
    content: Add config thresholds; implement canProceedToSequenceGeneration with reason codes; wire processEmailGeneration early return + tests; hard criterion—no gen, no RQ, no merged QC when blocked
    status: pending
  - id: b2-optional-llm
    content: "Optional: pre-flight company_readiness LLM JSON + store summary (minimize sheet schema churn)"
    status: pending
  - id: b3-dashboard-split
    content: "Extend dashboard-summary + UI: company health (aggregated blockers) vs contact pipeline; use resolveCanonicalCompanyUrl from Track A"
    status: pending
  - id: b4-lineage
    content: Add prompt/qc version to config; log + stamp review/intel metadata with profile_version
    status: pending
  - id: b5-states-docs
    content: Document company_intelligence_blocked, reason codes, keep company row clean; align admin clear-block action
    status: pending
isProject: false
---

# Track B — Upstream confidence gating, lineage, and company health

## Goals

- **Do not call** [`generateEmailSequence`](../src/skills/email-generator.ts), **do not append Review Queue rows**, and **do not run** [`runFullMergedQC`](../src/engine/email-qc-runner.ts) when **company-level inputs** fail the upstream gate — avoid cost amplification (12 emails + regen loops) from weak upstream data.
- Give operators a **company-first** view: canonical health, freshness, confidence, **aggregated** blockers — distinct from **per-contact** sequence status.
- Record **minimum viable lineage** so “why did this run pass/fail?” is answerable when profiles refresh.

## Current behavior (anchor points)

- Alignment already writes **`confidenceScore`** (`high` | `medium` | `low`) to Company Profiles ([`pipeline-orchestrator` Phase A](../src/engine/pipeline-orchestrator.ts)); [`alignmentFromStored`](../src/engine/company-profile-helpers.ts) reads it. **`no_fit`** is honored; **`low` is not a hard gate** before [`processEmailGeneration`](../src/engine/pipeline-orchestrator.ts).
- Post-generation: `runFullMergedQC` + up to 3 auto regen rounds in the orchestrator.
- Partial lineage today: **`profile_version`** on Company Profiles, **`last_profile_version_used_for_generation`** on Contacts (column Y).

## Work packages

### B1 — Upstream gate (MVP)

- **Config:** Add env-driven thresholds in [`config/schema.ts`](../src/config/schema.ts), e.g. `GENERATION_MIN_ALIGNMENT_CONFIDENCE=medium` (ordered enum: low < medium < high) and optional `GENERATION_BLOCK_ON_EMPTY_CASE_STUDIES=true`.
- **Implement** `canProceedToSequenceGeneration(...): { ok, reasonCode?, details? }` (new small module under `src/engine/`) combining:
  - `pipelineStatus === alignment_complete` (and not `no_fit`),
  - `confidenceScore` vs threshold,
  - non-empty `caseStudiesSelected` / capabilities if flags require it,
  - cheap heuristics: non-empty `product_summary`, `signal_summary`, parseable `signals` JSON (optional, togglable),
  - **Track A integration:** if `resolveCanonicalCompanyUrl(contact.companyUrl)` is empty → `INVALID_CANONICAL_URL`; if duplicate Company Profile key detected for that canonical → `DUPLICATE_COMPANY_PROFILE_KEY` (when audit/hook supplies that signal).
- **Actionable reason codes** (stable string enum for logs, intel notes, and dashboard):

```
LOW_ALIGNMENT_CONFIDENCE
MISSING_CASE_STUDY_SELECTION
MISSING_PRODUCT_SUMMARY
MISSING_SIGNAL_SUMMARY
INVALID_CANONICAL_URL
DUPLICATE_COMPANY_PROFILE_KEY
NO_FIT
```

  Map gate failures to **one primary** `reasonCode` (plus `details` text). `NO_FIT` may already short-circuit in Phase A; keep it in the enum for consistency and dashboard rollups.

- **Wire:** At the start of [`processEmailGeneration`](../src/engine/pipeline-orchestrator.ts), after resolving `stored`, if `!ok`:
  - Set contact **`pipeline_status`** to **`company_intelligence_blocked`** (explicit name — not `pending_company_review`).
  - Write **human-readable text + `reasonCode`** to Company Intelligence (`error_log` or agreed field) so operators know what to fix.
  - **Return early** — see **hard acceptance criterion** below (no sequence, no RQ append, no merged QC).
- **Tests:** Unit tests for gate matrix (high/medium/low, missing case studies, wrong pipeline status, invalid canonical).

### B2 — Structured scoring (phase 1.5, optional LLM)

- If MVP rule-based gate is too blunt, add **one** lightweight LLM call **before** generation: prompt returns a small JSON `company_readiness` (e.g. genericity_risk 1–5, proof_quality 1–5) + boolean `proceed`. Cache result in Company Intelligence notes or a new column **only if** sheet schema is extended — prefer **append-only audit tab** or reuse `executive_brief` prefix for v1 to avoid sheet migration.

### B3 — Company vs contact dashboard separation

- Extend [`dashboard-summary.ts`](../src/web/dashboard-summary.ts) + [`public/dashboard`](../public/dashboard/index.html) (or API consumer) with sections:
  - **Company health:** per resolved canonical (use **`resolveCanonicalCompanyUrl`** from Track A): profile `pipeline_status`, `confidenceScore`, `profile_version`, `last_refreshed_at`, duplicate-key flag from Track A, **aggregated counts of contacts** in `company_intelligence_blocked` **by reasonCode** (not a mutated company row).
  - **Contact pipeline:** per-contact status including `company_intelligence_blocked` and primary reason.
- Goal: operators see **Nimble-style failures** as **company-level intel / gate** issues when appropriate, without blaming only the contact row UX.

### B4 — Lineage (incremental)

- **Stamp on Review Queue batch append** (or Company Intelligence `generated_date` payload): write **immutable metadata** as a JSON line or structured columns where practical:
  - `profile_version` (already on profile),
  - `prompt_version` / `qc_rubric_version`: from env or `package.json` version / git SHA at deploy (inject via config),
  - optional `alignment_confidence_snapshot` at generation time.
- **Logging:** structured log line on generation start `{ email, canonical, profileVersion, promptVersion }`.
- **Full immutable snapshots** (full profile JSON per run): defer to a later phase or optional `data/audit/` artifact if you want zero sheet churn.

### B5 — State model: keep the company row clean

- **Company Profiles** row holds **shared truth**: research, alignment, `pipeline_status` for **company** lifecycle (`alignment_complete`, `no_fit`, `research_failed`, etc.). **Do not** set company-level `pipeline_status` to a **per-contact gate outcome** (e.g. do not mark the shared profile “blocked” because one contact failed the gate).
- **Contacts** row holds **generation eligibility:** `pipeline_status = company_intelligence_blocked` when the upstream gate fails, with reason codes in Intel / logs.
- **Dashboard** rolls up **company-level blocker aggregates** (how many contacts blocked, for which reasons) keyed by **resolved canonical** — derived view, not a new column on Company Profiles for “blocked.”
- Align admin actions: “clear block and retry” sets contact to `alignment_complete` (or `pending_review` / your chosen handoff) **after** operator fixes profile or thresholds; **company** row stays semantically correct for all contacts sharing that profile.

## Acceptance criteria

- **Hard criterion (non-negotiable):** When a contact is blocked by the upstream gate, **no** sequence is generated, **no** Review Queue rows are appended for that run, and **no** merged QC call runs for that contact. Partial implementation (e.g. gen without RQ, or QC without append) is **not** acceptable.
- Contacts with **alignment below** the configured minimum **do not** enter generation until cleared (`LOW_ALIGNMENT_CONFIDENCE` or configured mapping).
- Dashboard distinguishes **company health** (aggregated) vs **contact** metrics.
- Every **successful** generation log includes **profile version + config prompt/QC version id**.
- Blocked state label is **`company_intelligence_blocked`** with actionable **`reasonCode`** from the enum above.

## Dependencies

- **Track A:** Use **`resolveCanonicalCompanyUrl`** everywhere; gate uses **`INVALID_CANONICAL_URL`** and can consume **duplicate key** signals from Track A audit.
- If adding new sheet columns for readiness JSON, coordinate with [`setup-sheets.ts`](../scripts/setup-sheets.ts) — prefer **no new columns in MVP** by using existing `error_log` / logs only.
