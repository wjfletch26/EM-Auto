# Data Model — Deaton Outreach Automation

## Overview

The system uses **Google Sheets** as the primary data store and **local JSON files** for crash-recovery state. There is no database at MVP.

The Google Spreadsheet contains four tabs (worksheets):
1. **Contacts** — Master contact list with status tracking
2. **Campaigns** — Campaign and sequence definitions
3. **Send Log** — Record of every email sent
4. **Reply Log** — Record of every reply classified

---

## Google Sheets Schema

### Tab 1: Contacts

This is the main operational tab. Each row is one contact.

| Column | Header | Type | Description | Example |
|---|---|---|---|---|
| A | `email` | string (required) | Contact's email address. Must be unique. | `john@example.com` |
| B | `first_name` | string (required) | Contact's first name. Used in templates. | `John` |
| C | `last_name` | string | Contact's last name. | `Smith` |
| D | `company` | string | Company name. Used in templates. | `Acme Corp` |
| E | `title` | string | Job title. Used in templates. | `VP of Operations` |
| F | `campaign_id` | string (required) | ID of the campaign this contact belongs to. Must match a row in the Campaigns tab. | `deaton_q1_2026` |
| G | `status` | string | Current contact status. One of: `new`, `active`, `sequence_complete`, `replied`, `bounced`, `unsubscribed`, `do_not_contact`, `send_failed`. Default: `new`. | `active` |
| H | `last_step_sent` | number | The most recent sequence step number sent to this contact. 0 or blank = no steps sent. | `2` |
| I | `last_send_date` | string (ISO 8601) | Timestamp of the most recent send. | `2026-03-12T14:30:00Z` |
| J | `reply_status` | string | Reply classification. One of: `QUALIFIED`, `NOT_INTERESTED`, `UNSUBSCRIBE`, `OUT_OF_OFFICE`, `BOUNCE`, `UNCLEAR`. Blank = no reply. | `QUALIFIED` |
| K | `reply_date` | string (ISO 8601) | Timestamp of the reply. | `2026-03-13T09:15:00Z` |
| L | `reply_snippet` | string | First 200 characters of the reply body. | `Hi Dave, sounds interesting...` |
| M | `unsubscribed` | boolean | TRUE if the contact has unsubscribed. | `TRUE` |
| N | `unsubscribe_date` | string (ISO 8601) | Timestamp of the unsubscribe. | `2026-03-13T10:00:00Z` |
| O | `unsubscribe_source` | string | How they unsubscribed: `link`, `reply`, `manual`. | `link` |
| P | `bounced` | boolean | TRUE if the contact's email bounced. | `FALSE` |
| Q | `bounce_type` | string | `hard` or `soft`. | `hard` |
| R | `bounce_date` | string (ISO 8601) | Timestamp of the bounce. | `2026-03-12T14:30:05Z` |
| S | `soft_bounce_count` | number | Number of soft bounces. 3+ = treated as hard bounce. Default: 0. | `0` |
| T | `custom_1` | string | Optional custom field for templates. | `(any value)` |
| U | `custom_2` | string | Optional custom field for templates. | `(any value)` |
| V | `notes` | string | Operator notes. Not used by the system. | `Met at trade show` |

**Key rules:**
- `email` is the primary key. Must be unique across all rows.
- The system reads columns A–V. Additional columns to the right are ignored.
- Row 1 is the header row. Data starts at row 2.
- The system NEVER deletes rows. It only updates existing cells.
- Blank `status` is treated as `new`.

---

### Tab 2: Campaigns

Each row defines a campaign and its email sequence.

| Column | Header | Type | Description | Example |
|---|---|---|---|---|
| A | `campaign_id` | string (required) | Unique campaign identifier. Referenced by the Contacts tab. | `deaton_q1_2026` |
| B | `campaign_name` | string | Human-readable campaign name. | `Q1 2026 Outreach` |
| C | `total_steps` | number (required) | Total number of steps in the sequence. | `3` |
| D | `step_1_template` | string (required) | Filename of the Handlebars template for step 1. | `q1_initial.hbs` |
| E | `step_1_subject` | string (required) | Subject line for step 1 (can contain `{{variables}}`). | `Quick question, {{first_name}}` |
| F | `step_1_delay_days` | number (required) | Days to wait before sending step 1 (0 = send immediately when eligible). | `0` |
| G | `step_2_template` | string | Template for step 2. | `q1_followup1.hbs` |
| H | `step_2_subject` | string | Subject for step 2. | `Following up, {{first_name}}` |
| I | `step_2_delay_days` | number | Days to wait after step 1 before sending step 2. | `3` |
| J | `step_3_template` | string | Template for step 3. | `q1_followup2.hbs` |
| K | `step_3_subject` | string | Subject for step 3. | `Last note, {{first_name}}` |
| L | `step_3_delay_days` | number | Days to wait after step 2 before sending step 3. | `5` |
| M | `active` | boolean | Whether the campaign is active. Only active campaigns are processed. | `TRUE` |

**Key rules:**
- Supports up to 5 steps at MVP. Each step adds 3 columns (template, subject, delay_days).
- To add steps 4 and 5, extend the column pattern: `step_4_template`, `step_4_subject`, `step_4_delay_days`, etc.
- `campaign_id` must be unique.
- Template filenames reference `.hbs` files in the `templates/` directory.

---

### Tab 3: Send Log

Append-only log of every email sent. The system writes new rows; it never edits existing rows.

| Column | Header | Type | Description | Example |
|---|---|---|---|---|
| A | `timestamp` | string (ISO 8601) | When the email was sent. | `2026-03-12T14:30:00Z` |
| B | `contact_email` | string | Recipient email address. | `john@example.com` |
| C | `campaign_id` | string | Campaign identifier. | `deaton_q1_2026` |
| D | `step` | number | Sequence step number. | `1` |
| E | `status` | string | `sent` or `failed`. | `sent` |
| F | `message_id` | string | SMTP message ID (for tracking). | `<abc123@office365.com>` |
| G | `error_message` | string | Error details if status is `failed`. Blank if success. | `550 Mailbox not found` |
| H | `template_used` | string | Template filename that was rendered. | `q1_initial.hbs` |

**Key rules:**
- This tab is append-only. Rows are never edited or deleted.
- The system reads this tab to determine what has already been sent (to avoid duplicates).
- Expected growth: ~50 rows/day at target volume.

---

### Tab 4: Reply Log

Append-only log of every classified reply. Written by the reply processor (automated) or can be populated manually (Tier 3).

| Column | Header | Type | Description | Example |
|---|---|---|---|---|
| A | `timestamp` | string (ISO 8601) | When the reply was processed. | `2026-03-13T09:20:00Z` |
| B | `contact_email` | string | Sender of the reply. | `john@example.com` |
| C | `classification` | string | Reply category. | `QUALIFIED` |
| D | `subject_snippet` | string | First 100 characters of the reply subject. | `Re: Quick question, John` |
| E | `body_snippet` | string | First 200 characters of the reply body. | `Hi Dave, yes I'm interested in...` |
| F | `source` | string | How this was classified: `auto` (system) or `manual` (human). | `auto` |

---

## Local State Files

These JSON files live in `data/state/` on the VPS. They are NOT the source of truth — Google Sheets is. These files provide crash recovery and deduplication.

### `data/state/last-run.json`

Records the outcome of the most recent send cycle.

```json
{
  "timestamp": "2026-03-12T14:35:00Z",
  "contacts_eligible": 12,
  "contacts_sent": 10,
  "contacts_failed": 1,
  "contacts_skipped": 1,
  "duration_ms": 152000
}
```

### `data/state/pending-sends.json`

Tracks contacts currently being processed in a send cycle. Cleared after the cycle completes. Used to detect incomplete runs after a crash.

```json
{
  "run_id": "run_20260312_143000",
  "started_at": "2026-03-12T14:30:00Z",
  "contacts": [
    { "email": "john@example.com", "step": 2, "status": "sending" },
    { "email": "jane@example.com", "step": 1, "status": "queued" }
  ]
}
```

**On startup**: If `pending-sends.json` exists and has contacts with status `sending`, the system:
1. Checks the Send Log in Google Sheets to see if the send actually completed.
2. If it did → marks as complete locally.
3. If it didn't → leaves the contact for the next send cycle (it will be re-evaluated).

### `data/state/processed-messages.json`

Tracks IMAP message UIDs that have already been classified. Prevents duplicate processing.

```json
{
  "last_check": "2026-03-13T09:20:00Z",
  "processed_uids": [1001, 1002, 1003, 1004, 1005]
}
```

**Cleanup**: UIDs older than 30 days are pruned on each run to prevent unbounded growth.

---

## Data Flow Diagram

```
                    ┌──────────────────────────────────┐
                    │         Google Sheets             │
                    │                                   │
                    │  ┌───────────┐  ┌─────────────┐  │
  Source Sync ────▶ │  │ Contacts  │  │ Campaigns   │  │ ◀──── Operator (manual edits)
                    │  └───────────┘  └─────────────┘  │
                    │                                   │
                    │  ┌───────────┐  ┌─────────────┐  │
  Send Engine ────▶ │  │ Send Log  │  │ Reply Log   │  │ ◀──── Reply Processor
  (writes status)   │  └───────────┘  └─────────────┘  │       (writes classifications)
                    │                                   │
                    └──────────────────────────────────┘
                                    │
                                    ▼
                    ┌──────────────────────────────────┐
                    │       Local State (JSON)          │
                    │  last-run.json                    │
                    │  pending-sends.json               │
                    │  processed-messages.json          │
                    └──────────────────────────────────┘
```

## Sheet Sizing Estimates

| Tab | Rows at 50/day | Rows at 1 Year | Notes |
|---|---|---|---|
| Contacts | ~50 new/week | ~2,500 | Rows are updated, not appended |
| Campaigns | ~5 | ~20 | Rarely changes |
| Send Log | ~50/day | ~18,000 | Append-only; may need archival after 1 year |
| Reply Log | ~5/day | ~1,800 | Append-only |

Google Sheets supports up to 10 million cells per spreadsheet. At these volumes, the sheet will not hit limits for years.
