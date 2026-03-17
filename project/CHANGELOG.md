# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
