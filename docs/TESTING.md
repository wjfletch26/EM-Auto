# Testing Guide

This file is a practical checklist for running tests later.
Use it when you want to quickly verify the system still works.

---

## 0) Local Test Spreadsheet Mode (Recommended)

Use this mode to test safely against a sandbox sheet before deploying to VPS.

Full env rules live in [`ENVIRONMENT_VARIABLES.md`](ENVIRONMENT_VARIABLES.md). The short version:

1. Create a test spreadsheet copy in Google Sheets.
2. Share it with the service account in `credentials/service-account.json`.
3. In **`.env`** (shared secrets): set `APP_ENV=local`, `GOOGLE_SPREADSHEET_ID` to your **test** sheet ID, and **`PRODUCTION_GOOGLE_SPREADSHEET_ID`** to the real production sheet ID (must differ from `GOOGLE_SPREADSHEET_ID` when `APP_ENV` is local).
4. Email safety on local/staging (validated at startup): either **`DRY_RUN=true`** (simulated send — no SMTP, Sheets still update), **or** **`DRY_RUN=false`** with a valid **`TEST_RECIPIENT`** (real SMTP only to that inbox).
5. Optionally create **`.env.local`** (gitignored) for overrides: the app loads **`.env`** then **`.env.${APP_ENV}`** when that file exists — so with `APP_ENV=local`, `.env.local` overrides `.env`.

Example overrides you might put only in `.env.local`:

```bash
GOOGLE_SPREADSHEET_ID=<TEST_SPREADSHEET_ID>
DRY_RUN=true
LOG_LEVEL=debug
```

How it works:

- Put `APP_ENV` in `.env` so the correct second file is chosen (see ENVIRONMENT_VARIABLES.md).
- VPS stays isolated unless you deploy `.env.local` there.

Suggested local flow:

```bash
npm run build
npm test
npm run dev:local
npx tsx scripts/test-send-cycle.ts
```

Verify that updates appear in the **test** spreadsheet, not production.
When finished, delete or rename `.env.local` to drop local-only overrides.

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
- Unsubscribe endpoint flow works (`/health` returns layered JSON — see `docs/RUN_AND_DEPLOY.md`, invalid token, expired token, valid token).

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

If you already queued an event manually and only want to process existing queued events (no extra enqueue), run:

```bash
npm run test:reply-forward-pause -- contact@example.com --process-only
```

Expected result:

- Forward email is sent to `REPLY_FORWARD_TO` from `.env`.
- Contact row is updated to `status=paused`.
- Contact `reply_status` is set to `forwarded`.

---

## 8) Admin API and UI (optional)

Requires `ADMIN_API_KEY` in `.env` and a successful `npm run build` (produces `dist/admin/` for the SPA).

1. Start the app (`npm run dev` or `npm start` after build).
2. **Health** (unchanged):

```bash
curl -s "http://127.0.0.1:3000/health"
```

3. **Admin without key** — expect `401` when the key is set, `503` when admin is disabled (empty key):

```bash
curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:3000/api/admin/contacts"
```

4. **Admin with key** — expect `200` and JSON with a `contacts` array (may be empty):

```bash
curl -s -H "Authorization: Bearer $ADMIN_API_KEY" "http://127.0.0.1:3000/api/admin/contacts" | head -c 500
```

(`X-Admin-Key: $ADMIN_API_KEY` is equivalent.)

5. **SPA**: when `ADMIN_UI_ENABLED` is true (default with a key), open `http://127.0.0.1:3000/admin/` in a browser. Paste the same value as `ADMIN_API_KEY` from `.env`, click **Save key** (stored in this browser as `localStorage`), then use **Refresh** and the action buttons.

Avoid running destructive admin actions (`send-cycle`, `pipeline-cycle`, etc.) against production unless intended; use a test spreadsheet and `APP_ENV=local` per section 0.
