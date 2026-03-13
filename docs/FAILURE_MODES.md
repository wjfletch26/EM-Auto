# Failure Modes — Deaton Outreach Automation

This document catalogs every known failure scenario, how the system detects it, and what happens when it occurs.

---

## Failure Severity Levels

| Level | Meaning | System Behavior |
|---|---|---|
| **CRITICAL** | The system cannot perform its primary function | Halt all operations, log error, alert operator |
| **HIGH** | A major feature is broken but others still work | Disable the broken feature, continue others, log warning |
| **MEDIUM** | A single operation failed but the system is healthy | Log error, skip the failed item, continue |
| **LOW** | Minor issue, no user impact | Log warning, continue normally |

---

## Failure Catalog

### F1: SMTP Authentication Failure

| Property | Value |
|---|---|
| Severity | **CRITICAL** |
| Cause | Password changed, SMTP AUTH disabled on tenant, account locked |
| Detection | Nodemailer throws auth error on connection or send attempt |
| System Response | Halt all sending. Log critical error with the error message. Do NOT retry until resolved. Reply processing and unsubscribe endpoint continue running. |
| Recovery | Operator verifies password, updates `.env`, restarts PM2. |
| Prevention | Test SMTP connection at application startup. |

### F2: SMTP Send Failure (Single Email)

| Property | Value |
|---|---|
| Severity | **MEDIUM** |
| Cause | Invalid recipient, mailbox full, temporary server error |
| Detection | Nodemailer returns rejected addresses or throws a send error |
| System Response | Log the error with contact email and error code. Write `status=failed` to Send Log. Mark hard bounces. Skip the contact and continue to the next. |
| Recovery | Automatic — the contact will be re-evaluated on the next cycle. Hard bounces are permanent. |
| Prevention | Validate email format before sending. |

### F3: SMTP Rate Limiting / Throttling

| Property | Value |
|---|---|
| Severity | **MEDIUM** |
| Cause | Too many sends in a short period (Microsoft throttling) |
| Detection | SMTP error code 421 or 451 with "too many connections" or "rate limit" message |
| System Response | Exponential backoff: wait 30s, 60s, 120s. Retry up to 3 times. If still failing, stop the current send cycle and log a warning. |
| Recovery | Automatic on next cycle. If persistent, increase `SEND_DELAY_MS` in `.env`. |
| Prevention | Default `SEND_DELAY_MS=15000` (15 seconds between sends). |

### F4: Google Sheets API Authentication Failure

| Property | Value |
|---|---|
| Severity | **CRITICAL** |
| Cause | Service account key revoked, permissions removed, key file missing |
| Detection | googleapis throws 401 or 403 error |
| System Response | Halt all operations (cannot read contacts or write status). Log critical error. |
| Recovery | Operator regenerates service account key, updates file, restarts PM2. |
| Prevention | Test Sheets API connection at application startup. |

### F5: Google Sheets API Rate Limit

| Property | Value |
|---|---|
| Severity | **MEDIUM** |
| Cause | More than 60 requests/minute to the Sheets API |
| Detection | googleapis returns HTTP 429 |
| System Response | Pause for 60 seconds. Retry the request. If it fails again, skip the current operation and log a warning. |
| Recovery | Automatic — next cycle will succeed. |
| Prevention | Batch read/write operations. At <50 emails/day, this should never occur. |

### F6: Google Sheets Data Validation Error

| Property | Value |
|---|---|
| Severity | **MEDIUM** |
| Cause | Contact row missing required fields, campaign_id references nonexistent campaign, malformed email |
| Detection | Zod validation or custom checks during Source Sync |
| System Response | Log a warning with the row number and issue. Skip the invalid row. Continue processing valid rows. |
| Recovery | Operator fixes the data in Google Sheets. |
| Prevention | Document the schema clearly. Consider adding a data validation script. |

### F7: Spreadsheet Not Found or Not Shared

| Property | Value |
|---|---|
| Severity | **CRITICAL** |
| Cause | Wrong `GOOGLE_SPREADSHEET_ID` in `.env`, or service account not shared on the sheet |
| Detection | googleapis returns HTTP 404 or 403 |
| System Response | Halt all operations. Log critical error. |
| Recovery | Operator verifies the spreadsheet ID and sharing permissions. |
| Prevention | Test Sheets access at application startup. |

### F8: IMAP Connection Failure

| Property | Value |
|---|---|
| Severity | **HIGH** (if IMAP is enabled) |
| Cause | IMAP basic auth disabled by Microsoft, network issue, credentials changed |
| Detection | imapflow throws connection or auth error |
| System Response | Log warning. Disable reply processing for this cycle. Retry on next cycle. After 3 consecutive failures, disable IMAP and log a critical warning ("Reply processing disabled — IMAP unavailable"). Sending and unsubscribe continue. |
| Recovery | If permanent: operator switches to Tier 3 (manual reply processing) by setting `IMAP_ENABLED=false`. |
| Prevention | Test IMAP connection at startup. If it fails, start in Tier 3 mode. |

### F9: Template File Not Found

| Property | Value |
|---|---|
| Severity | **MEDIUM** |
| Cause | Campaign references a template file that doesn't exist in `templates/` |
| Detection | Handlebars file read throws ENOENT |
| System Response | Log error with the campaign_id and template filename. Skip ALL contacts in that campaign for this cycle (cannot send without a template). |
| Recovery | Operator creates the missing template file. No restart needed. |
| Prevention | Validate template references during Source Sync. |

### F10: Template Render Error

| Property | Value |
|---|---|
| Severity | **MEDIUM** |
| Cause | Template uses a variable not present in the contact data, Handlebars syntax error |
| Detection | Handlebars.compile or template() throws an error |
| System Response | Log error with the contact email and template name. Skip this contact. Continue to next. |
| Recovery | Operator fixes the template or adds the missing data. |
| Prevention | Handlebars ignores missing variables by default (renders blank). Syntax errors are caught at startup if templates are pre-compiled. |

### F11: Unsubscribe Endpoint Unreachable

| Property | Value |
|---|---|
| Severity | **HIGH** |
| Cause | Application crashed, Caddy down, DNS misconfigured, VPS network issue |
| Detection | External uptime monitor (UptimeRobot) reports the `/health` endpoint is down |
| System Response | N/A — this is detected externally. Recipients clicking unsubscribe links see an error page. |
| Recovery | Operator restores the application. Reply-based unsubscribe still works if IMAP is enabled. |
| Prevention | PM2 auto-restart. UptimeRobot alerting. |

### F12: Invalid Unsubscribe Token

| Property | Value |
|---|---|
| Severity | **LOW** |
| Cause | Token tampered with, expired, or `UNSUB_SECRET` was rotated |
| Detection | HMAC verification fails or expiry check fails |
| System Response | Return HTTP 400 with "This link is no longer valid." message. Log the attempt. |
| Recovery | No recovery needed for individual tokens. If caused by secret rotation, new emails will have new valid tokens. |
| Prevention | Set `UNSUB_EXPIRY_DAYS` to a reasonable value (90 days). |

### F13: Application Crash Mid-Send-Cycle

| Property | Value |
|---|---|
| Severity | **HIGH** |
| Cause | Unhandled exception, out-of-memory, OS kill |
| Detection | PM2 detects the process exited. `pending-sends.json` contains in-progress contacts. |
| System Response | PM2 automatically restarts the process. On startup, the system checks `pending-sends.json` and reconciles with the Send Log in Google Sheets to determine what was actually sent. |
| Recovery | Automatic. No duplicates because the system checks the Send Log before sending. |
| Prevention | Proper error handling. Memory limit in PM2 config (`max_memory_restart`). |

### F14: Local State File Corruption

| Property | Value |
|---|---|
| Severity | **LOW** |
| Cause | Disk error, partial write during crash |
| Detection | JSON.parse throws a syntax error when reading a state file |
| System Response | Log warning. Delete the corrupted file and rebuild from Google Sheets. The local state files are NOT the source of truth. |
| Recovery | Automatic on next cycle. |
| Prevention | Write state files atomically (write to temp file, then rename). |

### F15: Disk Full

| Property | Value |
|---|---|
| Severity | **CRITICAL** |
| Cause | Logs not rotated, state files growing unbounded |
| Detection | File write operations throw ENOSPC error |
| System Response | Log rotation deletes old files. If still full, the application may crash. PM2 restarts it. |
| Recovery | Operator clears old log files: `rm data/logs/app-2026-01-*.log` |
| Prevention | Log retention policy (default 30 days). Periodic disk usage checks. |

### F16: Duplicate Email Prevention Failure

| Property | Value |
|---|---|
| Severity | **HIGH** |
| Cause | Bug in the Send Log check, race condition between overlapping cycles |
| Detection | Multiple Send Log entries for the same contact + step + campaign |
| System Response | The mutex lock prevents overlapping send cycles. If duplicates are detected in the Send Log, log a critical warning. |
| Recovery | Manual review. Identify the bug. The mutex should prevent this. |
| Prevention | Mutex lock on send cycles. Check Send Log before every send. |

---

## Failure Response Summary

| # | Failure | Severity | Sends Stop? | Replies Stop? | Unsub Stop? | Auto-Recover? |
|---|---|---|---|---|---|---|
| F1 | SMTP auth failure | CRITICAL | YES | No | No | No — manual fix |
| F2 | Single send failure | MEDIUM | No | No | No | Yes |
| F3 | SMTP rate limit | MEDIUM | Temporarily | No | No | Yes |
| F4 | Sheets auth failure | CRITICAL | YES | YES | YES | No — manual fix |
| F5 | Sheets rate limit | MEDIUM | Temporarily | Temporarily | No | Yes |
| F6 | Data validation error | MEDIUM | Skip row | No | No | Manual fix |
| F7 | Sheet not found | CRITICAL | YES | YES | YES | No — manual fix |
| F8 | IMAP failure | HIGH | No | YES | No | Tier 3 fallback |
| F9 | Template missing | MEDIUM | Skip campaign | No | No | Manual fix |
| F10 | Template render error | MEDIUM | Skip contact | No | No | Manual fix |
| F11 | Unsub endpoint down | HIGH | No | No | YES | PM2 restart |
| F12 | Invalid unsub token | LOW | No | No | No | N/A |
| F13 | Crash mid-cycle | HIGH | Temporarily | Temporarily | Temporarily | PM2 restart |
| F14 | State file corrupt | LOW | No | No | No | Auto-rebuild |
| F15 | Disk full | CRITICAL | YES | YES | Depends | Manual cleanup |
| F16 | Duplicate send | HIGH | No | No | No | Manual review |
