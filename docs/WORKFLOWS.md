# Workflows — Deaton Outreach Automation

This document describes every operational workflow in the system, step by step. Each workflow is written so an implementation engineer can build it without guesswork.

---

## Workflow 1: Send Cycle

**Trigger**: Cron scheduler, every 5 minutes.

**Preconditions**:
- Google Sheets contains contacts and campaign data.
- SMTP credentials are valid.
- No other send cycle is currently running (mutex).

**Steps**:

```
1. Acquire send-cycle mutex lock.
   - If lock is held, skip this cycle and log "Send cycle skipped: previous run in progress."

2. Read the "Contacts" tab from Google Sheets.
   - Parse all rows into Contact objects.
   - Validate required fields (email, first_name). Skip invalid rows and log warnings.

3. Read the "Campaigns" tab from Google Sheets.
   - Parse campaign definitions (campaign_id, sequence steps, delays, template names).

4. Read the "Send Log" tab from Google Sheets.
   - Build a map of {contact_email → last_step_sent, last_send_timestamp}.

5. For each contact, run the Sequence Engine:
   a. Is the contact unsubscribed? → Skip.
   b. Is the contact bounced? → Skip.
   c. Is the contact's status "do_not_contact"? → Skip.
   d. Has the contact completed all steps in the sequence? → Skip.
   e. Determine the next step number (last_step_sent + 1, or 1 if never sent).
   f. Has enough time elapsed since the last send (per the step's delay_days)? → If no, skip.
   g. If all checks pass → add to the "eligible to send" list.

6. For each eligible contact:
   a. Load the Handlebars template for the current step.
   b. Merge contact fields into the template (first_name, company, etc.).
   c. Generate an unsubscribe token (HMAC-signed, contains contact email).
   d. Inject the unsubscribe link into the email footer.
   e. Send the email via SMTP:
      - To: contact email
      - From: dave@deatonengineering.us
      - Subject: rendered subject line
      - Body: rendered HTML + plain text fallback
   f. On SMTP success:
      - Write a row to the "Send Log" tab: {contact_email, campaign_id, step, timestamp, message_id, status: "sent"}.
      - Update the contact's row in "Contacts" tab: {last_step_sent, last_send_date, status: "active"}.
      - Log: "Sent step {N} to {email} — messageId: {id}".
   g. On SMTP failure:
      - Log the error with full context.
      - Write to "Send Log": {status: "failed", error_message}.
      - Do NOT retry in this cycle. The contact will be retried in the next cycle.
   h. Wait for the configured delay between sends (e.g., 10–30 seconds) to avoid triggering spam filters.

7. Write run summary to local state: {run_timestamp, contacts_eligible, contacts_sent, contacts_failed}.

8. Release mutex lock.

9. Log: "Send cycle complete: {sent} sent, {failed} failed, {skipped} skipped."
```

---

## Workflow 2: Reply Processing (Conditional — requires IMAP/EWS access)

**Trigger**: Cron scheduler, every 5 minutes.

**Preconditions**:
- IMAP or EWS access to `dave@deatonengineering.us` inbox is verified.
- Processed message UIDs are tracked in `data/state/processed-messages.json`.

**Steps**:

```
1. Acquire reply-cycle mutex lock.

2. Connect to the inbox via IMAP (or EWS).

3. Fetch all UNSEEN messages from the INBOX folder.

4. For each message:
   a. Extract: sender email, subject, body (plain text), date, message-id.
   b. Check if message UID is in processed-messages.json → if yes, skip.
   c. Match sender email against the "Contacts" tab in Google Sheets.
      - If no match found → classify as UNCLEAR, log, and skip Sheets update.
   d. Run the reply classifier:
      - Check subject and body against keyword rules (see Workflow 2a below).
      - Return a classification: QUALIFIED, NOT_INTERESTED, UNSUBSCRIBE, OUT_OF_OFFICE, BOUNCE, UNCLEAR.
   e. Update the contact's row in "Contacts" tab:
      - Set reply_status to the classification.
      - Set reply_date to the message date.
      - Set reply_snippet to the first 200 characters of the body.
   f. If classification is UNSUBSCRIBE:
      - Also set unsubscribed = TRUE and unsubscribe_date.
   g. If classification is BOUNCE:
      - Also set bounced = TRUE and bounce_date.
   h. Write a row to the "Reply Log" tab: {contact_email, classification, message_date, subject_snippet}.
   i. Add message UID to processed-messages.json.
   j. Mark the message as SEEN in the mailbox.

5. Release mutex lock.

6. Log: "Reply cycle complete: {processed} processed, {qualified} qualified, {unsubscribed} unsub, {bounced} bounced."
```

### Workflow 2a: Reply Classification Rules

The classifier checks the **subject** and **body** of each reply against these patterns, in priority order (first match wins):

| Priority | Classification | Patterns (case-insensitive) |
|---|---|---|
| 1 | BOUNCE | "delivery failed", "undeliverable", "550", "mailbox not found", "user unknown", "mailer-daemon@" in sender |
| 2 | UNSUBSCRIBE | "unsubscribe", "remove me", "stop emailing", "opt out", "take me off" |
| 3 | OUT_OF_OFFICE | "out of office", "OOO", "on vacation", "away from", "auto-reply", "automatic reply" |
| 4 | NOT_INTERESTED | "not interested", "no thank you", "no thanks", "pass", "not a fit", "not at this time" |
| 5 | QUALIFIED | "interested", "tell me more", "let's talk", "schedule a call", "sounds good", "send me info", "yes" |
| 6 | UNCLEAR | (default — no pattern matched) |

**Rule**: If the body is empty or shorter than 5 characters, classify as UNCLEAR.

---

## Workflow 3: Unsubscribe via Web Link

**Trigger**: HTTP GET request to the unsubscribe endpoint.

**URL format**: `https://unsub.deatonengineering.us/unsubscribe?token=<signed-token>`

**Steps**:

```
1. Extract the token from the query string.

2. Validate the token:
   a. Decode the token (base64url).
   b. Verify the HMAC signature using the UNSUBSCRIBE_SECRET from .env.
   c. Extract the contact email from the token payload.
   d. Check that the token has not expired (tokens are valid for 90 days).

3. If token is invalid or expired:
   - Return HTTP 400 with a simple "This link is no longer valid" page.
   - Log: "Invalid unsubscribe attempt: {reason}".

4. If token is valid:
   a. Update the contact's row in "Contacts" tab:
      - Set unsubscribed = TRUE.
      - Set unsubscribe_date = now.
      - Set unsubscribe_source = "link".
   b. Return HTTP 200 with a simple "You have been unsubscribed" confirmation page.
   c. Log: "Unsubscribed via link: {email}".

5. The unsubscribe is immediate. The next send cycle will skip this contact.
```

---

## Workflow 4: Bounce Detection

Bounces are detected at two levels:

### Level 1: SMTP-Level Bounce (at send time)

```
1. During the send cycle, if SMTP returns a rejection:
   - 550, 551, 552, 553 → Hard bounce (mailbox doesn't exist).
   - 450, 451, 452 → Soft bounce (temporary failure).

2. For hard bounces:
   - Mark contact as bounced = TRUE in "Contacts" tab.
   - Set bounce_type = "hard", bounce_date = now.
   - Log: "Hard bounce for {email}: {error_code} {error_message}".
   - Contact will be permanently skipped in future send cycles.

3. For soft bounces:
   - Increment soft_bounce_count in "Contacts" tab.
   - Log: "Soft bounce for {email}: {error_code}".
   - If soft_bounce_count >= 3 → treat as hard bounce.
   - Otherwise, contact will be retried in the next eligible send cycle.
```

### Level 2: NDR Bounce (via reply processing)

```
1. During reply processing, if a message is classified as BOUNCE:
   - Same handling as hard bounce above.
   - Additionally: record the NDR message content in reply_snippet for debugging.
```

---

## Workflow 5: Sequence Advancement

**Context**: Each campaign has a sequence of steps. Each step has a template and a delay (in days) from the previous step.

**Example sequence**:
- Step 1: Initial outreach (delay: 0 days — send immediately when contact is added)
- Step 2: Follow-up #1 (delay: 3 days after Step 1)
- Step 3: Follow-up #2 (delay: 5 days after Step 2)

**Logic** (runs inside the send cycle for each contact):

```
1. Look up the contact's last_step_sent from the "Send Log".
   - If no sends found → next_step = 1.
   - If last_step_sent = N → next_step = N + 1.

2. Check if next_step exceeds the campaign's total steps.
   - If yes → contact has completed the sequence. Set status = "sequence_complete". Skip.

3. Look up the delay_days for next_step in the campaign definition.

4. Calculate: eligible_date = last_send_date + delay_days.

5. If today < eligible_date → not yet time. Skip.

6. If today >= eligible_date → contact is eligible for next_step.

7. HALT conditions (checked before sending):
   - Contact replied (reply_status is set) → Halt. Do not send more steps.
   - Contact unsubscribed → Halt.
   - Contact bounced → Halt.
   - Contact status is "do_not_contact" → Halt.
```

---

## Workflow 6: Manual Reply Processing (Tier 3 Fallback)

**Context**: If IMAP and EWS are not available, the human at `REPLY_FORWARD_TO` handles reply processing manually.

**Steps**:

```
1. The human reviews forwarded replies in their inbox.

2. For each reply, the human opens the Google Sheet "Contacts" tab.

3. The human finds the contact's row and updates:
   - reply_status: one of QUALIFIED, NOT_INTERESTED, UNSUBSCRIBE, OUT_OF_OFFICE, BOUNCE, UNCLEAR.
   - reply_date: the date of the reply.
   - reply_snippet: (optional) brief note about the reply.

4. If the reply is an unsubscribe request:
   - Set unsubscribed = TRUE.
   - Set unsubscribe_date.

5. The system reads these updates on the next send cycle and respects them:
   - Contacts with reply_status set are halted from further sequence steps.
   - Contacts with unsubscribed = TRUE are never emailed again.
```

---

## Workflow 7: System Startup

```
1. PM2 starts the Node.js process.

2. main.ts runs:
   a. Load and validate config from .env (Zod). If invalid → exit with error.
   b. Initialize logger.
   c. Initialize Google Sheets service (authenticate with service account).
   d. Initialize SMTP service (verify connection with a NOOP command).
   e. Initialize IMAP service (if enabled — test connection). If IMAP fails → log warning, disable reply processing.
   f. Initialize local state store (create data/state/ directory if missing).
   g. Start the Express.js unsubscribe web server on the configured port.
   h. Register cron jobs with the scheduler.
   i. Log: "Deaton Outreach Automation started. Send interval: {N}min. Reply processing: {enabled|disabled}."

3. The system is now running. Cron jobs fire on their intervals.
```

---

## Workflow 8: System Shutdown

```
1. PM2 sends SIGTERM to the process.

2. main.ts handles SIGTERM:
   a. Stop accepting new cron job executions.
   b. Wait for any in-progress send or reply cycle to complete (up to 60 seconds).
   c. Close SMTP connection.
   d. Close IMAP connection.
   e. Close Express.js server.
   f. Flush any pending log writes.
   g. Log: "Deaton Outreach Automation shut down gracefully."
   h. Exit process.

3. If the process does not exit within 60 seconds, PM2 sends SIGKILL.
```
