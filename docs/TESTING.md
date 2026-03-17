# Testing Guide

This file is a practical checklist for running tests later.
Use it when you want to quickly verify the system still works.

---

## 1) Fast Validation (Most Common)

Run these commands from the project root:

```bash
npm run build
npm test
npm run test:unsub-web
```

What this validates:

- TypeScript build is clean.
- Unit tests pass.
- Unsubscribe endpoint flow works (`/health`, invalid token, expired token, valid token).

---

## 2) Send Pipeline Test Email

This sends one real email using current Google Sheets data.

```bash
npx tsx scripts/test-send-cycle.ts
```

Expected result in output:

- `eligible` is greater than `0` when a contact is eligible.
- `sent` increments for successful sends.
- `failed` stays `0` for a clean run.

Also verify manually:

- Email arrives in inbox.
- "Send Log" sheet gets a new row.
- Contact row updates (`last_step_sent`, `last_send_date`, `status`).

---

## 3) Make One Contact Eligible (If Needed)

If test send shows `eligible: 0`, reset the contact fields first.

In Google Sheets `Contacts` tab, set:

- `status` = `new`
- `last_step_sent` = `0`
- `last_send_date` = blank
- `unsubscribed` = `FALSE`
- `unsubscribe_date` = blank
- `unsubscribe_source` = blank

Then rerun:

```bash
npx tsx scripts/test-send-cycle.ts
```

---

## 4) Local Unsubscribe Click Test

Use this when public DNS is not set yet.

1. In `.env`, set:
   - `UNSUB_BASE_URL=http://127.0.0.1:3000`
2. Start server:

```bash
npx tsx src/web/server.ts
```

3. Send a test email:

```bash
npx tsx scripts/test-send-cycle.ts
```

4. Open received email and click unsubscribe link.
5. Verify the page says "Unsubscribed".
6. Verify in Sheets:
   - `status = unsubscribed`
   - `unsubscribed = TRUE`
   - `unsubscribe_date` is filled
   - `unsubscribe_source = link`

---

## 5) Local HTTP Checks (Optional)

Quick endpoint checks:

```bash
curl -i "http://127.0.0.1:3000/health"
curl -i "http://127.0.0.1:3000/unsubscribe?token=bad.token"
```

Expected:

- `/health` returns `200`.
- Invalid token returns `400`.

---

## 6) Known Notes

- `npm run lint` may fail due to ESLint v9 config migration (`.eslintrc.json` vs `eslint.config.js`).
- This lint issue is separate from unsubscribe/send runtime behavior.
- For deployment testing later, switch `UNSUB_BASE_URL` back to public HTTPS URL after DNS and Caddy are configured.

---

## 7) Pause-On-Forward + Monthly Cadence Checks

### Unit-level checks

These run in `npm test` and now include:

- Reply-forward processor: successful forward pauses the contact and failed forward retries.
- Sequence engine: paused contacts are ineligible.
- Sequence engine: follow-up sends require monthly cadence (minimum 30 days).
- Sequence engine: campaign `total_steps` still controls sequence length (5 or 6).

### Smoke test for reply-forward pause

Queue one forwarded-reply event:

```bash
npm run queue:reply-forward -- contact@example.com "Re: Outreach" "Please follow up next month."
```

Run one processor pass and verify pause behavior:

```bash
npm run test:reply-forward-pause -- contact@example.com
```

Expected result:

- Forward email is sent to `REPLY_FORWARD_TO` from `.env`.
- Contact row is updated to `status=paused`.
- Contact `reply_status` is set to `forwarded`.
