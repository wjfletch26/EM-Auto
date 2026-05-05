# Migration — Company Profiles + slim Company Intelligence

This note is for spreadsheets created **before** the company-scoped profile change (February 2026 codebase).

## What changed

| Tab | Before | After |
|---|---|---|
| _(new)_ **Company Profiles** | — | One row per canonical `company_url` with Perplexity + alignment payload. |
| **Company Intelligence** | One wide row per contact (duplicated research columns). | Slim per-contact row: `contact_email`, `canonical_company_url`, `company_url`, `david_project_notes`, `executive_brief`, `pipeline_status`, `generated_date`, `error_log`. |

Canonical URLs are computed the same way as production: `normalizeCanonicalCompanyUrl()` in code (HTTPS, strip `www.`, normalize path).

## Recommended migration steps

1. **Backup** the Google Sheet (File → Make a copy).
2. **Add tab** **Company Profiles** with headers exactly as in [`scripts/setup-sheets.ts`](../scripts/setup-sheets.ts) (`Company Profiles` key in `TABS`).
3. For each distinct `company_url` in the legacy Company Intelligence sheet:
   - Normalize the URL → `canonical_company_url`.
   - Create **one** Company Profiles row: copy columns that map to shared research (`company_name` … `confidence_score` in the old layout) into the new profile columns.
   - Set `researched_date`, `last_refreshed_at` from the old `researched_date` if present, `profile_version` = `1`.
4. **Reshape** Company Intelligence to **eight** columns (A–H) as in `setup-sheets.ts`. For each contact row:
   - Keep `contact_email`, `david_project_notes`, `executive_brief`, `pipeline_status`, `generated_date`, `error_log`.
   - Set `canonical_company_url` from the company’s normalized URL.
   - Set `company_url` from Contacts or the old display URL.
5. **Run** `npx tsx scripts/format-spreadsheet.ts --all-known-tabs` so column widths/filters match the new layout.
6. Smoke-test: set one contact to `pipeline_status=new` on a **new** company URL and confirm a single Company Profiles row is appended; add a second contact at the same URL and confirm Phase A skips Perplexity.

There is no automatic migration script in-repo — sheet shapes vary; operators should validate a copy first.
