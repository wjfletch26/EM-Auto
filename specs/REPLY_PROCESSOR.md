# Spec: Reply Processor

**File**: `src/engine/reply-processor.ts`
**Dependencies**: `src/services/imap.ts`, `src/services/sheets.ts`, `src/classifiers/reply-rules.ts`, `src/engine/bounce-handler.ts`, `src/state/local-store.ts`, `src/logging/logger.ts`

---

## Purpose

The Reply Processor polls the sending mailbox for new inbound messages, classifies each reply, and updates the Google Sheet with the classification. This component is **conditional** — it only runs if IMAP (Tier 1) or EWS (Tier 2) access is available.

---

## Public Interface

```typescript
interface ReplyRunResult {
  runId: string;
  startedAt: string;
  completedAt: string;
  processed: number;
  qualified: number;
  notInterested: number;
  unsubscribed: number;
  outOfOffice: number;
  bounced: number;
  unclear: number;
  unmatched: number;     // Replies from addresses not in the Contacts tab
}

// Called by the scheduler on each cron tick.
async function executeReplyCycle(): Promise<ReplyRunResult>
```

---

## Algorithm

```
function executeReplyCycle():
  1. If IMAP is not enabled (config.imap.enabled === false):
     - Return immediately. Log nothing (this is expected in Tier 3).

  2. Acquire reply-cycle mutex lock.
     - If locked, skip and log "Reply cycle skipped: previous run in progress."

  3. Connect to IMAP (if not already connected).
     - On connection failure: log warning, release mutex, return.

  4. Load processed-messages.json from local state.

  5. Fetch UNSEEN messages from INBOX.
     - Use IMAP SEARCH: UNSEEN
     - Fetch: uid, envelope (from, subject, date), body (text/plain preferred, fallback to text/html stripped)

  6. Load all contacts from Sheets (for matching sender email).

  7. For each message:
     a. If message.uid is in processedMessages → skip.
     b. Extract sender email (from envelope.from[0].address, lowercased).
     c. Extract subject and body text.
     d. Match sender email against contacts list.
        - If no match → log as "unmatched reply", add to processedMessages, continue.
     e. Classify the reply:
        classification = classifyReply(subject, body)
     f. Update Sheets:
        - Contacts tab: set reply_status, reply_date, reply_snippet.
        - If UNSUBSCRIBE: also set unsubscribed=TRUE, unsubscribe_date, unsubscribe_source="reply".
        - If BOUNCE: delegate to bounce-handler.
     g. Append row to Reply Log tab: { timestamp, contact_email, classification, subject_snippet, body_snippet, source: "auto" }.
     h. Add message.uid to processedMessages.
     i. Mark message as SEEN in IMAP (set \Seen flag).
     j. Log: "Reply classified" with contact_email and classification.

  8. Save processedMessages to processed-messages.json.
     - Prune UIDs older than 30 days (based on associated timestamp).

  9. Release mutex lock.

  10. Log: "Reply cycle complete" with summary counts.
  11. Return ReplyRunResult.
```

---

## IMAP Service Interface

```typescript
interface ImapMessage {
  uid: number;
  date: Date;
  from: { address: string; name: string };
  subject: string;
  textBody: string;       // Plain text body (preferred)
  htmlBody: string;       // HTML body (fallback)
  messageId: string;
}

// imap.ts
async function connect(): Promise<void>
async function disconnect(): Promise<void>
async function fetchUnseenMessages(): Promise<ImapMessage[]>
async function markAsSeen(uid: number): Promise<void>
async function isConnected(): boolean
```

**imapflow configuration:**

```typescript
const client = new ImapFlow({
  host: config.imap.host,       // outlook.office365.com
  port: config.imap.port,       // 993
  secure: true,                 // TLS
  auth: {
    user: config.imap.user,     // dave@deatonengineering.us
    pass: config.imap.pass,
  },
  logger: false,                // Suppress imapflow internal logs
});
```

**Fetching unseen messages:**

```typescript
async function fetchUnseenMessages(): Promise<ImapMessage[]> {
  await client.mailboxOpen('INBOX');
  const messages: ImapMessage[] = [];

  for await (const msg of client.fetch(
    { seen: false },
    { envelope: true, source: true, uid: true }
  )) {
    // Parse the message source to extract text body
    // Use 'mailparser' package to parse raw email source
    messages.push(parseMessage(msg));
  }

  return messages;
}
```

---

## Reply Classifier

**File**: `src/classifiers/reply-rules.ts`

### Interface

```typescript
type ReplyClassification =
  | 'QUALIFIED'
  | 'NOT_INTERESTED'
  | 'UNSUBSCRIBE'
  | 'OUT_OF_OFFICE'
  | 'BOUNCE'
  | 'UNCLEAR';

function classifyReply(subject: string, body: string): ReplyClassification
```

### Classification Rules

Rules are evaluated in priority order. First match wins.

```typescript
const rules: Array<{ classification: ReplyClassification; patterns: RegExp[] }> = [
  {
    classification: 'BOUNCE',
    patterns: [
      /delivery (failed|failure|status notification)/i,
      /undeliverable/i,
      /mailbox (not found|unavailable|full)/i,
      /user unknown/i,
      /550\s/i,
      /mailer-daemon/i,
      /permanent failure/i,
    ],
  },
  {
    classification: 'UNSUBSCRIBE',
    patterns: [
      /\bunsubscribe\b/i,
      /\bremove me\b/i,
      /\bstop email/i,
      /\bopt\s*out\b/i,
      /\btake me off\b/i,
      /\bdo not (contact|email)\b/i,
    ],
  },
  {
    classification: 'OUT_OF_OFFICE',
    patterns: [
      /out of (the )?office/i,
      /\bOOO\b/,
      /on vacation/i,
      /away from (the )?office/i,
      /auto[\s-]?reply/i,
      /automatic reply/i,
      /currently (out|away|unavailable)/i,
    ],
  },
  {
    classification: 'NOT_INTERESTED',
    patterns: [
      /not interested/i,
      /no thank(s| you)/i,
      /\bpass\b/i,
      /not a (good )?fit/i,
      /not at this time/i,
      /please don't/i,
      /we('re| are) (all )?set/i,
    ],
  },
  {
    classification: 'QUALIFIED',
    patterns: [
      /\binterested\b/i,
      /tell me more/i,
      /let('s|us) (talk|chat|connect|meet)/i,
      /schedule a (call|meeting|time)/i,
      /sounds (good|great|interesting)/i,
      /send (me )?(more )?info/i,
      /\byes\b/i,
      /love to (hear|learn|know)/i,
    ],
  },
];
```

**Default**: If no rule matches, or if the body is empty / under 5 characters, return `UNCLEAR`.

### Sender-Based Classification

Before checking patterns, check the sender address:
- If sender contains `mailer-daemon@` or `postmaster@` → return `BOUNCE`.
- If sender matches `noreply@` or `no-reply@` → check patterns (likely auto-reply or bounce).

---

## Processed Messages State

**File**: `data/state/processed-messages.json`

```json
{
  "last_check": "2026-03-13T09:20:00Z",
  "entries": [
    { "uid": 1001, "processed_at": "2026-03-12T10:00:00Z" },
    { "uid": 1002, "processed_at": "2026-03-12T10:00:00Z" },
    { "uid": 1003, "processed_at": "2026-03-13T09:20:00Z" }
  ]
}
```

**Pruning**: On each run, remove entries where `processed_at` is older than 30 days. This prevents the file from growing unbounded.

**Atomic writes**: Write to a temp file, then rename, to prevent corruption on crash.

---

## Error Handling

| Error | Action |
|---|---|
| IMAP connection failure | Log warning, skip this cycle, retry next cycle. After 3 consecutive failures, log critical warning. |
| IMAP fetch error (single message) | Log error with message UID, skip message, continue to next. |
| Message parse failure | Log error, classify as UNCLEAR, continue. |
| Contact not found in Sheets | Log as "unmatched reply" with sender email, skip Sheets update, continue. |
| Sheets API write failure | Retry once. If still failing, log error (classification is lost for this message but UID is still marked as processed). |

---

## Concurrency

Same mutex pattern as the Send Engine:

```typescript
let replyCycleRunning = false;

async function executeReplyCycle(): Promise<ReplyRunResult | null> {
  if (!config.imap.enabled) return null;
  if (replyCycleRunning) {
    logger.info({ module: 'reply-processor' }, 'Reply cycle skipped: previous run in progress');
    return null;
  }
  replyCycleRunning = true;
  try {
    // ... run the cycle ...
  } finally {
    replyCycleRunning = false;
  }
}
```

---

## EWS Fallback (Tier 2)

If IMAP fails but EWS works, replace the IMAP service with an EWS service that provides the same interface. The Reply Processor doesn't need to change — only the service layer differs.

**EWS service** (`src/services/ews.ts` — only built if needed):

```typescript
// Uses 'ews-javascript-api' package
// Same interface as imap.ts:
async function connect(): Promise<void>
async function fetchUnseenMessages(): Promise<ImapMessage[]>  // Same shape
async function markAsSeen(itemId: string): Promise<void>
```

The config module would have an `INBOX_PROTOCOL` setting: `imap` | `ews` | `none`.
