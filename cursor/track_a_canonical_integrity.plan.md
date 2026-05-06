---
name: Track A Canonical integrity
overview: Harden canonical company URL identity with a single mandatory resolveCanonicalCompanyUrl() used everywhere, detect duplicate or split Company Profiles rows and Intel drift, and surface guardrails so joins are deterministic—without changing QC or generation strategy yet.
todos:
  - id: a1-audit
    content: Implement duplicate profile key + intel drift audit (dashboard section and/or scripts/audit-canonical-profiles.ts); audits must use resolveCanonicalCompanyUrl()
    status: pending
  - id: a2-normalize
    content: Harden normalizeCanonicalCompanyUrl invalid-URL behavior + tests (used inside resolver only)
    status: pending
  - id: a3-resolver-mandatory
    content: "Implement resolveCanonicalCompanyUrl() (normalize + explicit alias allowlist); wire every consumer—no optional path"
    status: pending
  - id: a4-logs-guards
    content: Log duplicate canonical on profile load; document explicit merge/relink runbook
    status: pending
isProject: false
---

# Track A — Canonical company identity and sheet integrity

## Goals

- Ensure **one authoritative Company Profiles row per canonical key** and **consistent joins** from Contacts → Company Intelligence → Company Profiles.
- Make malformed URLs and **accidental profile duplication** visible and fixable, not silent.
- **Single mandatory resolver:** `resolveCanonicalCompanyUrl(raw: string): string` is the **only** public entry point for “what key do we use for this URL?” Alias handling applies **inside** it (after base normalization). **Do not** call `normalizeCanonicalCompanyUrl` directly from pipeline, refresh, admin, or UI except **inside** the resolver implementation—otherwise different code paths will quietly diverge (“spreadsheet goblin” keys).
- **Out of scope for this track:** upstream confidence gating before generation, duplicate contact emails, MongoDB.

## Current behavior (anchor points)

- Canonical key today: [`normalizeCanonicalCompanyUrl`](../src/utils/normalize-company-url.ts) scattered across Phase A [`processResearchAndAlignment`](../src/engine/pipeline-orchestrator.ts) and other modules—**to be replaced by mandatory** `resolveCanonicalCompanyUrl`.
- Profile lookup: first `.find()` match on [`getCompanyProfiles()`](../src/services/sheets.ts) — **undefined behavior if duplicate column A values exist**.
- Intel relink: [`ensureContactIntelRow`](../src/engine/pipeline-orchestrator.ts) writes `canonicalCompanyUrl` + `companyUrl` when Phase A runs; **stale intel can persist** if contact URL changes and that contact never re-enters Phase A.

## Mandatory resolver — use everywhere

Implement `resolveCanonicalCompanyUrl(raw: string): string`:

1. Run `normalizeCanonicalCompanyUrl(raw)` (after A2 hardening).
2. Apply an **explicit allowlist** map (e.g. `knowledge/company-domain-aliases.yml` or config): `https://nimble.ai` → `https://nimble.com` **only** when listed — **never** infer aliases.

**Required call sites (non-exhaustive checklist — grep for any other `normalizeCanonical` usage and replace):**

- Phase A ([`pipeline-orchestrator.ts`](../src/engine/pipeline-orchestrator.ts))
- [`company-profile-refresh.ts`](../src/engine/company-profile-refresh.ts)
- [`future-tail-regeneration.ts`](../src/engine/future-tail-regeneration.ts)
- Admin routes that compute or compare canonicals ([`admin/router.ts`](../src/web/routes/admin/router.ts))
- [`dashboard-summary.ts`](../src/web/dashboard-summary.ts) / audit paths
- `scripts/audit-canonical-profiles.ts` (or equivalent)
- [`sequence-funnel-state.ts`](../src/engine/sequence-funnel-state.ts) and any other engine helpers that derive canonical from `contact.companyUrl`
- [`regenerate-review-queue-row.ts`](../src/ops/regenerate-review-queue-row.ts) if it resolves URL from contact/intel

## Work packages

### A1 — Read-only audit

- **Duplicate profile keys:** After loading profiles, group by `canonicalCompanyUrl.toLowerCase()`; if count > 1, emit structured **warn/error** with **all `_rowIndex` values** (and same for [`buildDashboardSummary`](../src/web/dashboard-summary.ts) / `scripts/audit-canonical-profiles.ts`).
- **Intel drift:** For each Company Intelligence row, compare column B to **`resolveCanonicalCompanyUrl(contact.companyUrl)`** for that `contact_email`; list mismatches.
- **Split-company heuristic (optional):** Flag contacts whose **email domain** matches but **resolved canonical** differs (operator review only; no auto-merge).

### A2 — Normalize URL hardening

- Tighten [`normalizeCanonicalCompanyUrl`](../src/utils/normalize-company-url.ts): the **`catch`** path currently returns `trimmed.toLowerCase()` without `https://`, which can **break joins** against real rows. Prefer **empty string** (invalid) or a single documented fallback; extend [`normalize-company-url.test.ts`](../src/utils/normalize-company-url.test.ts). **Callers outside the resolver file should not exist** after Track A ships.

### A3 — Resolver module (mandatory, not optional)

- Add **`resolveCanonicalCompanyUrl`** in a dedicated module (e.g. `src/utils/resolve-canonical-company-url.ts`) that composes normalization + **explicit** alias map. Empty input → empty string.
- **Enforcement:** code review / lint habit: no direct `normalizeCanonicalCompanyUrl` imports outside that module and its tests.

### A4 — Runtime guardrails

- On every `getCompanyProfiles()` load (or periodic): if duplicate keys detected, log at **warn minimum** (or **error** in production config) so operators see it in logs/dashboard.
- Tighten docs: **identity repair is explicit** (merge script + relink), not “wait for the next pipeline pass” as the only story — align [`DATA_MODEL.md`](../docs/DATA_MODEL.md) / [`MIGRATION_COMPANY_PROFILES.md`](../specs/MIGRATION_COMPANY_PROFILES.md) with an operator runbook bullet.

### A5 — Merge / relink runbook (operator)

- Document steps: backup sheet, pick winning canonical, update or delete duplicate Company Profiles row, repoint Company Intelligence column B and Contacts `company_url` as needed, optionally bump `profile_version` / run refresh. Optional **one-off script** that only **validates** post-merge (no auto-delete).

## Acceptance criteria

- Duplicate canonical keys in Company Profiles are **detected and visible** (log + dashboard or script output).
- Invalid URLs do not produce **silent non-joining** keys without tests covering the behavior.
- **`resolveCanonicalCompanyUrl()` is mandatory:** every path that produces or compares a company join key uses it; no stray `normalizeCanonicalCompanyUrl` calls remain outside the resolver implementation (verify by grep in CI or review checklist).

## Dependencies

- None for Track B; this track is safe to ship first. Track B gate reason `INVALID_CANONICAL_URL` assumes resolved output may be empty.
