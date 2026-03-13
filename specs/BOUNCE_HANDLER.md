# Spec: Bounce Handler

**File**: `src/engine/bounce-handler.ts`
**Dependencies**: `src/services/sheets.ts`, `src/logging/logger.ts`

---

## Purpose

The Bounce Handler detects and records email bounces. It is called from two places:

1. **Send Engine** — when SMTP returns a rejection code at send time (immediate bounce).
2. **Reply Processor** — when an inbound message is classified as a bounce (NDR bounce).

---

## Public Interface

```typescript
type BounceType = 'hard' | 'soft';

interface BounceEvent {
  contactEmail: string;
  bounceType: BounceType;
  errorCode?: string;        // SMTP error code (e.g., "550")
  errorMessage?: string;     // Full error message
  source: 'smtp' | 'ndr';   // Where the bounce was detected
}

// Record a bounce event. Updates Sheets and logs.
async function recordBounce(event: BounceEvent): Promise<void>

// Classify an SMTP error code as hard or soft bounce.
function classifySmtpError(code: number, message: string): BounceType | null
```

---

## SMTP Error Classification

```
function classifySmtpError(code: number, message: string): BounceType | null

  Hard bounce codes (permanent failure — mailbox will never work):
    550 — Mailbox not found / does not exist
    551 — User not local
    552 — Mailbox full (treated as hard if persistent)
    553 — Mailbox name not allowed
    556 — Domain does not accept mail

  Soft bounce codes (temporary failure — may work later):
    421 — Service not available (try again later)
    450 — Mailbox temporarily unavailable
    451 — Local error in processing
    452 — Insufficient storage

  Not a bounce:
    Everything else (2xx = success, other 4xx/5xx = errors but not bounces)

  Return null if the code is not a recognized bounce code.
```

---

## Record Bounce Algorithm

```
async function recordBounce(event: BounceEvent):
  1. Log: "Bounce detected" with event details.

  2. Read the contact's row from the Contacts tab in Sheets.
     - If not found → log warning "Bounce for unknown contact", return.

  3. If event.bounceType === 'hard':
     a. Update the contact row:
        - Column P (bounced) = TRUE
        - Column Q (bounce_type) = "hard"
        - Column R (bounce_date) = new Date().toISOString()
        - Column G (status) = "bounced"
     b. Log: "Hard bounce recorded for {email}. Contact will not be emailed again."

  4. If event.bounceType === 'soft':
     a. Read current soft_bounce_count from column S.
     b. Increment: newCount = (currentCount || 0) + 1
     c. If newCount >= 3:
        - Treat as hard bounce: set bounced=TRUE, bounce_type="hard", status="bounced"
        - Log: "Soft bounce threshold reached for {email}. Converted to hard bounce."
     d. Else:
        - Update column S (soft_bounce_count) = newCount
        - Log: "Soft bounce #{newCount} for {email}. Will retry."
```

---

## Bounce Detection Points

### At Send Time (SMTP)

In `send-engine.ts`, after calling `smtp.sendEmail()`:

```typescript
// Inside the send loop:
try {
  const result = await smtp.sendEmail(message);

  // Check for rejected recipients
  if (result.rejected.length > 0) {
    const bounceType = classifySmtpError(/* extract code from rejection */);
    if (bounceType) {
      await recordBounce({
        contactEmail: contact.email,
        bounceType,
        errorCode: '550',
        errorMessage: 'Recipient rejected',
        source: 'smtp',
      });
    }
  }
} catch (err) {
  // Nodemailer throws on SMTP errors.
  // Extract the SMTP response code from the error.
  const code = extractSmtpCode(err);
  const bounceType = code ? classifySmtpError(code, err.message) : null;

  if (bounceType) {
    await recordBounce({
      contactEmail: contact.email,
      bounceType,
      errorCode: String(code),
      errorMessage: err.message,
      source: 'smtp',
    });
  }
  // Also write to Send Log with status: "failed" or "bounced"
}
```

### At Reply Processing Time (NDR)

In `reply-processor.ts`, when a reply is classified as `BOUNCE`:

```typescript
if (classification === 'BOUNCE') {
  await recordBounce({
    contactEmail: senderEmail,
    bounceType: 'hard',  // NDR bounces are treated as hard bounces
    errorMessage: bodySnippet,
    source: 'ndr',
  });
}
```

---

## Bounce Effects on the System

Once a contact is marked `bounced=TRUE`:

1. **Sequence Engine** skips the contact (halt condition).
2. **Send Engine** never attempts to send to them again.
3. The contact remains in the Sheets for reporting/auditing but is permanently inactive.

Soft bounces (below the threshold) do NOT halt the sequence. The contact is retried on the next eligible cycle.

---

## Helper: Extract SMTP Code

```typescript
function extractSmtpCode(error: Error & { responseCode?: number }): number | null {
  // Nodemailer includes responseCode on SMTP errors.
  if (error.responseCode) return error.responseCode;

  // Fallback: parse from error message.
  const match = error.message.match(/^(\d{3})\s/);
  return match ? parseInt(match[1], 10) : null;
}
```

---

## Error Handling

| Error | Action |
|---|---|
| Sheets API failure when recording bounce | Retry once. If still failing, log error. The bounce is still logged to disk even if Sheets update fails. The next send cycle will re-detect the bounce (SMTP will reject again). |
| Unknown SMTP error code | Log as a general send failure, not a bounce. The contact will be retried. |
