# Spec: Sequence Engine

**File**: `src/engine/sequence-engine.ts`
**Dependencies**: `src/logging/logger.ts`

---

## Purpose

The Sequence Engine determines which contacts are eligible to receive the next email in their sequence. It is a pure logic module — it does not perform I/O. The Send Engine calls it with data and it returns decisions.

---

## Public Interface

```typescript
interface Contact {
  email: string;
  firstName: string;
  campaignId: string;
  status: string;
  lastStepSent: number;       // 0 if no steps sent
  lastSendDate: string | null; // ISO 8601 or null
  replyStatus: string | null;
  unsubscribed: boolean;
  bounced: boolean;
}

interface Campaign {
  campaignId: string;
  totalSteps: number;
  active: boolean;
  steps: CampaignStep[];
}

interface CampaignStep {
  stepNumber: number;
  templateFile: string;
  subject: string;
  delayDays: number;
}

interface EligibilityResult {
  eligible: boolean;
  reason: string;              // Why eligible or not (for logging)
  nextStep?: CampaignStep;     // The step to send (if eligible)
}

// Determine if a contact is eligible for the next step in their sequence.
function evaluateContact(
  contact: Contact,
  campaign: Campaign,
  now: Date
): EligibilityResult
```

---

## Eligibility Algorithm

```
function evaluateContact(contact, campaign, now):

  // --- HALT CONDITIONS (checked first, in priority order) ---

  1. If contact.unsubscribed === true:
     return { eligible: false, reason: "Contact is unsubscribed" }

  2. If contact.bounced === true:
     return { eligible: false, reason: "Contact has bounced" }

  3. If contact.status === "do_not_contact":
     return { eligible: false, reason: "Contact is marked do_not_contact" }

  4. If contact.replyStatus is not null and not empty:
     return { eligible: false, reason: `Contact has replied (${contact.replyStatus})` }
     // Any reply halts the sequence. The human decides next steps.

  5. If contact.status === "bounced" or contact.status === "unsubscribed":
     return { eligible: false, reason: `Contact status is ${contact.status}` }

  // --- CAMPAIGN CHECKS ---

  6. If campaign is not found:
     return { eligible: false, reason: `Campaign ${contact.campaignId} not found` }

  7. If campaign.active === false:
     return { eligible: false, reason: `Campaign ${contact.campaignId} is inactive` }

  // --- SEQUENCE POSITION ---

  8. Determine next step number:
     nextStepNumber = contact.lastStepSent + 1
     // If lastStepSent is 0 (or null/undefined), nextStepNumber = 1

  9. If nextStepNumber > campaign.totalSteps:
     return { eligible: false, reason: "Sequence complete" }
     // Also: the Send Engine should set status to "sequence_complete"

  10. Look up the step definition:
      step = campaign.steps.find(s => s.stepNumber === nextStepNumber)
      If step is not found:
        return { eligible: false, reason: `Step ${nextStepNumber} not defined in campaign` }

  // --- TIMING CHECK ---

  11. If nextStepNumber === 1 and step.delayDays === 0:
      // First step with no delay — send immediately
      return { eligible: true, reason: "First step, no delay", nextStep: step }

  12. If contact.lastSendDate is null and nextStepNumber === 1:
      // Never been sent to, first step
      return { eligible: true, reason: "New contact, first step", nextStep: step }

  13. Calculate eligible date:
      lastSend = new Date(contact.lastSendDate)
      eligibleDate = new Date(lastSend.getTime() + step.delayDays * 24 * 60 * 60 * 1000)

  14. If now < eligibleDate:
      daysRemaining = Math.ceil((eligibleDate.getTime() - now.getTime()) / 86400000)
      return { eligible: false, reason: `Delay not elapsed (${daysRemaining} days remaining)` }

  15. // All checks passed
      return { eligible: true, reason: `Eligible for step ${nextStepNumber}`, nextStep: step }
```

---

## Design Decisions

### Any Reply Halts the Sequence

If a contact has any `replyStatus` (QUALIFIED, NOT_INTERESTED, UNCLEAR, etc.), the sequence is halted. Rationale:
- Continuing to send automated follow-ups after someone replied feels spammy.
- The human operator decides how to proceed after a reply.
- The operator can clear `replyStatus` and reset the sequence if they want to continue.

### Soft Bounces Do NOT Halt

A soft bounce increments the counter but does not set `bounced=TRUE` (unless it hits the threshold of 3). The sequence continues, and the next send attempt may succeed.

### Status "send_failed" Does NOT Halt

If a previous send failed (e.g., temporary SMTP error), the contact remains eligible. The system will retry on the next cycle.

---

## Usage in the Send Engine

```typescript
// Inside executeSendCycle():
const now = new Date();

for (const contact of contacts) {
  const campaign = campaigns.find(c => c.campaignId === contact.campaignId);
  if (!campaign) {
    logger.warn({ email: contact.email }, `Campaign not found: ${contact.campaignId}`);
    continue;
  }

  const result = evaluateContact(contact, campaign, now);

  if (!result.eligible) {
    logger.debug({ email: contact.email, reason: result.reason }, 'Contact not eligible');
    continue;
  }

  // result.nextStep contains the template, subject, and step number
  // Proceed with rendering and sending...
}
```

---

## Edge Cases

| Scenario | Behavior |
|---|---|
| Contact has no `campaignId` | Skip with warning log |
| Campaign has `totalSteps=0` | Skip — no steps to send |
| `delayDays` is negative or NaN | Treat as 0 (send immediately) — log warning |
| `lastSendDate` is in the future | Treat as "delay not elapsed" — prevents issues from clock skew |
| Contact `status` is blank | Treat as "new" — eligible for step 1 |
| Two contacts with the same email | Only the first row is processed — log warning about duplicate |

---

## Testing Guidance

The Sequence Engine is pure logic — no I/O, no side effects. It is the easiest module to unit test.

Key test cases:
1. New contact, step 1, delay 0 → eligible.
2. Contact sent step 1 today, step 2 delay 3 days → not eligible.
3. Contact sent step 1 four days ago, step 2 delay 3 days → eligible.
4. Contact unsubscribed → not eligible.
5. Contact bounced → not eligible.
6. Contact replied (any classification) → not eligible.
7. Contact completed all steps → not eligible, status = sequence_complete.
8. Campaign inactive → not eligible.
9. Missing campaign → not eligible, warning logged.
