# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.3.0] - 2026-04-29

### Added

- **Intelligence pipeline** — LLM-powered contact enrichment before sending:
  - `src/engine/pipeline-orchestrator.ts` — two-phase cycle: company research + alignment (Phase A), email generation + quality review (Phase B)
  - `src/engine/approval-watcher.ts` — scans Review Queue for fully approved 12-step sequences and auto-creates campaign rows
  - `src/skills/` — four skills (`company-research`, `deaton-alignment`, `email-generator`, `quality-reviewer`) and `knowledge-loader`
  - `src/services/llm-provider.ts`, `src/services/prompt-loader.ts` — LLM abstraction and prompt file loader
  - `knowledge/` — Deaton profile YAML, email-structure YAML, 4 persona files, 14 case-study files
  - `prompts/` — 4 Markdown prompt files (company research, alignment, email generation, quality review)
- **Admin UI and API** — optional operator interface:
  - `src/web/routes/admin/router.ts` — REST CRUD for contacts, company intelligence, review queue; action routes for send cycle, pipeline cycle, approval watcher, and per-contact helpers
  - `src/web/middleware/admin-auth.ts`, `admin-key.ts` — `ADMIN_API_KEY` gate (Bearer / X-Admin-Key headers)
  - `admin-ui/` — Vite + React SPA served at `/admin` when `ADMIN_API_KEY` and `ADMIN_UI_ENABLED` are set
  - `src/config/schema.ts` — `adminSchema` (`ADMIN_API_KEY`, `ADMIN_UI_ENABLED`) and `pipelineSchema` / `perplexitySchema` / `llmSchema`
- **Content normalisation utilities** — `src/content/body-signoff-strip.ts`, `email-signature.ts`, `replace-em-dashes.ts`
- **Test infrastructure** — `test-env-bootstrap.mjs`, expanded unit tests for config schema, send engine, pipeline orchestrator, approval watcher, content helpers, admin middleware
- **New docs/specs** — `specs/PIPELINE_ORCHESTRATOR.md`, `specs/ADMIN_API.md`; updates to `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/DEPLOYMENT.md`, `docs/OPERATIONS.md`, `docs/TESTING.md`, `docs/ENVIRONMENT_VARIABLES.md`, `docs/WORKFLOWS.md`

### Changed

- `npm run build` now also builds the admin SPA (`build:admin` runs `npm --prefix admin-ui install && vite build` → `dist/admin/`)
- `src/web/server.ts` — Express mounts `/api/admin` (admin API) and `/admin` (static SPA) in addition to `/health` and `/unsubscribe`
- `src/engine/send-engine.ts` — template field now supports `ai_review_queue:<rowIndex>` references (AI-generated campaigns load email body from Review Queue tab)
- `src/config/index.ts` — expanded startup environment summary includes pipeline, LLM, and admin config blocks
- Old `public/dashboard/` static files removed; replaced by `admin-ui` (React SPA)
- Old review-queue scripts (`regenerate-review-queue-email.ts`, `migrate-*.ts`, `rerun-full-sequence.ts`) removed; superseded by admin API actions

### Removed

- `src/engine/email-hard-qc.ts`, `src/engine/email-qc-runner.ts` — replaced by `quality-reviewer.ts` skill
- `src/ops/regenerate-review-queue-row.ts`, `src/ops/pipeline-contact-run.ts` — logic moved into admin API router
- `src/skills/regenerate-review-email.ts` — superseded by `regenerate-sequence` admin action
- `src/constants/email-signature.ts` — replaced by `src/content/email-signature.ts`
- `src/web/dashboard-summary.ts`, `dashboard-auth.ts`, `routes/dashboard-router.ts`, `routes/dashboard-api.ts` — replaced by admin router and SPA

## [0.2.0] - 2026-03-13

### Added
- **Phase 2 — Send Pipeline**: SMTP service (`src/services/smtp.ts`), crypto utilities (`src/utils/crypto.ts`), unsubscribe token generation (`src/engine/unsubscribe.ts`), sequence engine (`src/engine/sequence-engine.ts`), bounce handler (`src/engine/bounce-handler.ts`), send engine (`src/engine/send-engine.ts`)
- Sample Handlebars template (`templates/test_step1.hbs`) with unsubscribe footer
- 9/9 unit tests for sequence engine
- End-to-end verified: real email sent, Send Log updated, Contacts tab updated

### Changed
- **Phase 3 — Tier 3 confirmed**: IMAP disabled, manual reply workflow documented in `docs/OPERATIONS.md`

## [0.1.0] - 2026-03-12

### Added
- **Phase 0 — Credential Validation**: SMTP verified working, IMAP/EWS failed (basic auth blocked by Microsoft), Tier 3 decided
- **Phase 1 — Foundation**: Project scaffold (`package.json`, `tsconfig.json`, `.eslintrc.json`), Zod config validation (`src/config/`), Pino logger with daily JSON rotation (`src/logging/`), Google Sheets CRUD with retry (`src/services/sheets.ts`), atomic JSON state store (`src/state/local-store.ts`)
- Build kit documentation (22 docs across `docs/`, `specs/`, `cursor/`)
- 11/11 integration tests passing

## Version History

Versions follow the format `MAJOR.MINOR.PATCH`:
- **MAJOR**: Breaking changes to config, data model, or external interfaces
- **MINOR**: New features or capabilities
- **PATCH**: Bug fixes and minor improvements

<!-- Template for new entries:

## [X.Y.Z] - YYYY-MM-DD

### Added
- New features

### Changed
- Changes to existing functionality

### Fixed
- Bug fixes

### Removed
- Removed features

-->
