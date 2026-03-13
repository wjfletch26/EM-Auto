# Phase 0 Results — Credential Validation

**Date**: 2026-03-12
**Status**: COMPLETE

---

## SMTP Test — PASSED

- **Command**: `npm run test:smtp`
- **Host**: `smtp.office365.com:587` (STARTTLS)
- **User**: `dave@deatonengineering.us`
- **Result**: Connection verified, test email sent successfully.
- **Message ID**: `108d2c2d-64b5-bcda-4b81-04bf52f021e9@deatonengineering.us`
- **Server**: `LV8PR18MB5806.namprd18.prod.outlook.com`

**Conclusion**: SMTP AUTH works. Outbound email sending is confirmed.

---

## IMAP Test — FAILED

- **Command**: `npm run test:imap`
- **Host**: `outlook.office365.com:993` (TLS)
- **Error**: `AUTHENTICATE failed` — `3 NO AUTHENTICATE failed.`
- **Cause**: Microsoft 365 (via GoDaddy) has basic auth disabled for IMAP. This is standard — Microsoft deprecated basic auth for IMAP in 2022+.

**Conclusion**: IMAP is not available with basic auth.

---

## EWS Test — FAILED

- **Command**: `npm run test:ews`
- **Endpoint**: `https://outlook.office365.com/EWS/Exchange.asmx`
- **Error**: `HTTP 401 Unauthorized`
- **Cause**: Basic auth is also disabled for EWS. Security Defaults (Azure AD) blocks it.

**Conclusion**: EWS is not available with basic auth.

---

## Decision: Tier 3 — Manual Reply Processing

Since neither IMAP nor EWS works with the available credentials, the system will operate in **Tier 3** mode:

- **Outbound email**: Fully automated via SMTP (confirmed working).
- **Inbound replies**: Handled manually by the operator.
  - Operator checks the inbox periodically.
  - Operator updates the Contacts tab in Google Sheets (status, notes).
  - See `docs/OPERATIONS.md` for the manual reply workflow.
- **Config**: `IMAP_ENABLED=false` in `.env`.
- **Code impact**: No `src/services/imap.ts` or `src/services/ews.ts` needed. Phase 3 will follow the Tier 3 path (skip automated reply code, document manual workflow).

### Future upgrade path

If the operator later gets OAuth2 / Modern Auth configured for the M365 tenant, IMAP could be re-enabled. The system architecture supports adding it without major refactoring — just build `src/services/imap.ts` and set `IMAP_ENABLED=true`.

---

## Exit Criteria Checklist

- [x] SMTP test sends an email successfully.
- [x] IMAP/EWS test result is documented (both fail — basic auth blocked).
- [x] Decision recorded: **Tier 3** for reply processing.
