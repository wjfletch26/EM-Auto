# Spec: Send Engine

**File**: `src/engine/send-engine.ts`
**Dependencies**: `src/services/smtp.ts`, `src/services/sheets.ts`, `src/engine/sequence-engine.ts`, `src/engine/unsubscribe.ts`, `src/state/local-store.ts`, `src/logging/logger.ts`

---

## Purpose

The Send Engine orchestrates a single send cycle. It reads eligible contacts, determines what to send, renders templates, sends via SMTP, and records results.

---

## Public Interface

```typescript
interface SendRunResult {
  runId: string;
  startedAt: string;       // ISO 8601
  completedAt: string;     // ISO 8601
  eligible: number;
  sent: number;
  failed: number;
  skipped: number;
  durationMs: number;
}

// Called by the scheduler on each cron tick.
async function executeSendCycle(): Promise<SendRunResult>
```

---

## Algorithm

```
function executeSendCycle():
  1. Generate a run_id: "run_YYYYMMDD_HHmmss"
  2. Log: "Send cycle starting" with run_id

  3. Read all contacts from Sheets (via Source Sync)
  4. Read all campaigns from Sheets (via Source Sync)
  5. Read the Send Log from Sheets

  6. Build a send-log map: { contactEmail -> { lastStep, lastSendDate } }

  7. Filter eligible contacts using Sequence Engine:
     eligible = contacts.filter(c => sequenceEngine.isEligible(c, campaigns, sendLogMap))

  8. If eligible.length == 0:
     - Log: "No eligible contacts this cycle"
     - Return early

  9. Cap eligible list to SEND_BATCH_SIZE

  10. Write pending-sends.json with all eligible contacts (status: "queued")

  11. For each eligible contact (sequentially, with delay):
      a. Look up the campaign and next step
      b. Load the Handlebars template file from templates/ directory
      c. Build the template context:
         {
           first_name, last_name, company, title,
           custom_1, custom_2,
           unsubscribe_url: generateUnsubscribeUrl(contact.email)
         }
      d. Render the template: html = Handlebars.compile(templateSource)(context)
      e. Render the subject line: subject = Handlebars.compile(stepSubject)(context)
      f. Generate a plain-text version by stripping HTML tags
      g. Update pending-sends.json: contact status = "sending"
      h. Call smtp.sendEmail({
           to: contact.email,
           from: { name: SMTP_FROM_NAME, address: SMTP_USER },
           subject: subject,
           html: html,
           text: plainText,
           headers: {
             'List-Unsubscribe': `<${unsubscribeUrl}>`,
             'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
           }
         })
      i. On success:
         - Append row to Send Log in Sheets: { timestamp, email, campaign_id, step, status: "sent", message_id, template }
         - Update contact row in Sheets: { last_step_sent: step, last_send_date: now, status: "active" }
         - If step == totalSteps: set status to "sequence_complete"
         - Update pending-sends.json: contact status = "sent"
         - Increment sent counter
      j. On SMTP error:
         - If hard bounce (550, 551, 552, 553):
           - Mark contact as bounced in Sheets
           - Append to Send Log with status: "bounced"
         - Else:
           - Append to Send Log with status: "failed", error_message
         - Update pending-sends.json: contact status = "failed"
         - Increment failed counter
         - Do NOT throw — continue to next contact
      k. Wait SEND_DELAY_MS milliseconds before the next send

  12. Clear pending-sends.json (all contacts processed)
  13. Write last-run.json with the run summary
  14. Log: "Send cycle complete" with summary stats
  15. Return SendRunResult
```

---

## SMTP Service Interface

The Send Engine calls `smtp.ts`, which wraps Nodemailer.

```typescript
interface EmailMessage {
  to: string;
  from: { name: string; address: string };
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
}

interface SendResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
}

// smtp.ts
async function sendEmail(message: EmailMessage): Promise<SendResult>
async function verifyConnection(): Promise<boolean>
async function disconnect(): Promise<void>
```

**Nodemailer configuration:**

```typescript
const transporter = nodemailer.createTransport({
  host: config.smtp.host,       // smtp.office365.com
  port: config.smtp.port,       // 587
  secure: config.smtp.secure,   // false (STARTTLS)
  auth: {
    user: config.smtp.user,     // dave@deatonengineering.us
    pass: config.smtp.pass,
  },
  tls: {
    ciphers: 'SSLv3',
    rejectUnauthorized: true,
  },
});
```

---

## Template Rendering

Templates are Handlebars `.hbs` files stored in the `templates/` directory at the project root.

**Example template** (`templates/q1_initial.hbs`):

```handlebars
<p>Hi {{first_name}},</p>

<p>I noticed {{company}} has been growing and wanted to reach out about how Deaton Engineering might be able to help.</p>

<p>Would you be open to a quick conversation this week?</p>

<p>Best,<br>Dave</p>

<hr>
<p style="font-size: 11px; color: #999;">
  {{physical_address}}<br>
  <a href="{{unsubscribe_url}}">Unsubscribe</a>
</p>
```

**Template loading:**
- Templates are loaded from disk on each send cycle (not cached).
- This allows template edits without restarting the application.
- If a template file is missing, the entire campaign is skipped for this cycle.

**Context variables available to templates:**

| Variable | Source |
|---|---|
| `{{first_name}}` | Contacts tab column B |
| `{{last_name}}` | Contacts tab column C |
| `{{company}}` | Contacts tab column D |
| `{{title}}` | Contacts tab column E |
| `{{custom_1}}` | Contacts tab column T |
| `{{custom_2}}` | Contacts tab column U |
| `{{unsubscribe_url}}` | Generated by the unsubscribe module |
| `{{physical_address}}` | From `PHYSICAL_ADDRESS` env var |

---

## List-Unsubscribe Header

Every outbound email includes RFC 8058 headers for one-click unsubscribe support by email clients:

```
List-Unsubscribe: <https://unsub.deatonengineering.us/unsubscribe?token=...>
List-Unsubscribe-Post: List-Unsubscribe=One-Click
```

This helps with deliverability — Gmail and other providers look for this header.

---

## Rate Limiting

The Send Engine enforces two levels of rate limiting:

1. **Per-email delay**: `SEND_DELAY_MS` (default 15 seconds) between individual sends.
2. **Per-cycle cap**: `SEND_BATCH_SIZE` (default 10) emails per cron cycle.

These are configurable in `.env`. The defaults are conservative for a Microsoft 365 mailbox sending <50/day.

---

## Error Handling

| Error | Action |
|---|---|
| SMTP auth failure | Throw — halts the entire cycle. Scheduler catches and logs. |
| SMTP connection timeout | Retry once after 10 seconds. If still failing, throw to halt cycle. |
| SMTP send rejection (hard bounce) | Record bounce, skip contact, continue. |
| SMTP send rejection (soft bounce) | Record failure, skip contact, continue. Will retry next cycle. |
| Template file not found | Log error, skip all contacts in that campaign, continue. |
| Template render error | Log error, skip contact, continue. |
| Sheets API error on read | Retry once. If still failing, throw to halt cycle. |
| Sheets API error on write | Retry once. If still failing, log error and continue (the send already happened). |

---

## Mutex / Concurrency

The Send Engine uses a simple in-memory mutex to prevent overlapping send cycles:

```typescript
let sendCycleRunning = false;

async function executeSendCycle(): Promise<SendRunResult | null> {
  if (sendCycleRunning) {
    logger.info({ module: 'send-engine' }, 'Send cycle skipped: previous run in progress');
    return null;
  }
  sendCycleRunning = true;
  try {
    // ... run the cycle ...
  } finally {
    sendCycleRunning = false;
  }
}
```
