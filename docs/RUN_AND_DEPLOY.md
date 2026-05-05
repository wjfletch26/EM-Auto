# Run & Deploy — Quick Reference

A single-page cheat sheet for the three things you do most:

1. **Run in TEST mode** (local machine, test spreadsheet).
2. **Run in PRODUCTION mode** (VPS, real spreadsheet).
3. **Push code from this repo to production** (deploy).

Deeper docs live in [`DEPLOYMENT.md`](DEPLOYMENT.md), [`OPERATIONS.md`](OPERATIONS.md),
[`TESTING.md`](TESTING.md), and [`ENVIRONMENT_VARIABLES.md`](ENVIRONMENT_VARIABLES.md).
This file is the "what do I actually type" view.

---

## TL;DR — The two modes at a glance

The whole safety model is driven by **three env vars**: `APP_ENV`,
`GOOGLE_SPREADSHEET_ID`, and `PRODUCTION_GOOGLE_SPREADSHEET_ID`.
The startup validator refuses to boot if these don't line up correctly.

| Setting                            | TEST (local)                          | PRODUCTION (VPS)                       |
| ---------------------------------- | ------------------------------------- | -------------------------------------- |
| `APP_ENV`                          | `local`                               | `production`                           |
| `GOOGLE_SPREADSHEET_ID`            | **test** sheet ID                     | **same** as the prod ID below          |
| `PRODUCTION_GOOGLE_SPREADSHEET_ID` | the real prod ID (used as a guardrail) | the real prod ID                       |
| `DRY_RUN`                          | `true` (simulated) **or** unset       | must be **unset** or `false`           |
| `TEST_RECIPIENT`                   | a real inbox you control              | must be **empty / unset**              |
| `SCHEDULER_ENABLED`                | `false` (you trigger jobs by hand)    | `true` (cron runs send + reply cycles) |
| Where it runs                      | your laptop, `npm run dev`            | VPS, PM2 (`pm2 start ...`)             |

If you mis-configure any of those, the app fails fast at startup with a clear
`CONFIG VALIDATION FAILED:` message — that is the safety net working as designed.

---

## 1) Run in TEST mode (local)

Goal: drive the app against a sandbox sheet from your laptop, with **no risk** of
touching the production sheet or sending mail to real contacts.

### One-time setup

1. Make a copy of the production spreadsheet in Google Sheets — this is your
   **test sheet**. Share it (Editor) with the service account email in
   `credentials/service-account.json`.
2. Confirm `.env` has these values (your current setup already does):
   ```env
   APP_ENV=local
   GOOGLE_SPREADSHEET_ID=<your TEST sheet ID>
   PRODUCTION_GOOGLE_SPREADSHEET_ID=<the REAL prod sheet ID>
   TEST_RECIPIENT=josh@thesmod.com   # or DRY_RUN=true to skip SMTP entirely
   SCHEDULER_ENABLED=false
   ```

### Daily run

```bash
npm install        # only if dependencies changed
npm run dev        # tsx watch — restarts on file save
```

What you should see in the startup log: `appEnv: local`,
`emailMode: test_recipient` (or `simulated_send` if `DRY_RUN=true`), and the
**redacted test sheet ID** — never the production one.

### Driving jobs by hand

Because `SCHEDULER_ENABLED=false`, no cron fires. You trigger work from the
**Admin UI** at `http://127.0.0.1:3000/admin/` (paste `ADMIN_API_KEY` once),
or from scripts:

```bash
npm test                                 # unit tests
npx tsx scripts/test-send-cycle.ts       # send one cycle against the test sheet
npm run pipeline:run                     # run the LLM intelligence pipeline once
```

Full local checklist: [`TESTING.md`](TESTING.md).

---

## 2) Run in PRODUCTION mode (on the VPS)

The app already lives on the VPS as a PM2 process. You almost never start
it from scratch — you just check on it or restart it after a deploy.

### Health check (do this first, always)

```bash
ssh deaton@<vps-ip>
pm2 status                                              # is it online?
pm2 logs deaton-outreach --lines 30                     # any recent errors?
curl -s -o /dev/null -w "%{http_code}\n" \
  https://unsub.deatonengineering.us/health             # expect 200
```

### Production `.env` invariants

The VPS `/home/deaton/app/.env` **must** have:

```env
APP_ENV=production
GOOGLE_SPREADSHEET_ID=<the REAL prod sheet ID>
PRODUCTION_GOOGLE_SPREADSHEET_ID=<the SAME REAL prod sheet ID>
# DRY_RUN unset (or false)
# TEST_RECIPIENT unset (or empty)
SCHEDULER_ENABLED=true
```

Anything else and the app refuses to start. That is **on purpose** — it is the
last line of defense against a test config leaking onto prod.

### Stop / start / restart

```bash
pm2 stop    deaton-outreach   # halt all sending immediately
pm2 start   deaton-outreach   # bring it back up
pm2 restart deaton-outreach   # apply a new .env
pm2 reload  deaton-outreach   # graceful restart after a deploy
```

Full runbook (troubleshooting, common tasks, emergency procedures):
[`OPERATIONS.md`](OPERATIONS.md).

---

## 3) Push code from this repo to production

This is the standard "I changed something in `main`, get it onto the VPS" loop.
It assumes the VPS already has the repo cloned in `/home/deaton/app` and a
working `.env`.

### Step A — On your laptop (this repo)

```bash
git checkout main
git pull origin main                       # sync with remote
# (do your work, test locally per section 1)
npm run build                              # confirm it compiles
npm test                                   # confirm unit tests pass
git add -A
git commit -m "short description of change"
git push origin main
```

### Step B — On the VPS (deploy)

```bash
ssh deaton@<vps-ip>
cd /home/deaton/app

git pull origin main                       # pull the new commits
npm install --production                   # only installs new deps if any
npm run build                              # rebuild dist/ and admin SPA
pm2 reload deaton-outreach                 # graceful restart, picks up new code
pm2 logs deaton-outreach --lines 20        # eyeball the startup log
```

### Step C — Verify

```bash
pm2 status                                                       # online, low restart count
curl -s -o /dev/null -w "%{http_code}\n" \
  https://unsub.deatonengineering.us/health                      # 200
```

Then open the Admin UI in a browser and confirm it loads. Watch the next
send-cycle tick (within ~5 min) in `pm2 logs` and in the **Send Log** tab
of the production sheet.

### If something is wrong — rollback

Reverting is just checking out the previous commit and rebuilding. Full
procedure (with the exact commands) is in
[`DEPLOYMENT.md` → Rollback Procedure](DEPLOYMENT.md#rollback-procedure).

---

## Common pitfalls (read once, save yourself an hour)

- **`.env` is gitignored on purpose.** Editing it locally never reaches the VPS,
  and editing it on the VPS never reaches this repo. Each side is configured
  independently. After a `git pull` on the VPS, you do **not** need to touch
  `.env` unless a code change added a new required variable
  ([`ENVIRONMENT_VARIABLES.md`](ENVIRONMENT_VARIABLES.md) is the source of truth).
- **Never set `APP_ENV=production` on your laptop.** The schema will then demand
  the production sheet ID as the active sheet, which means your laptop would
  read and write the real production data. The whole point of `local` mode is
  to make that impossible.
- **`DRY_RUN=true` still updates the (test) Sheet.** It only suppresses SMTP.
  That is intentional so you can test the full Sheets ↔ state ↔ admin loop
  without sending mail.
- **Always `pm2 reload` after a deploy, not `pm2 restart`.** `reload` is graceful
  (lets in-flight work finish); `restart` kills the process immediately.
- **Caddy + the unsubscribe endpoint must stay up even when sending is paused.**
  Old unsubscribe links in already-delivered mail still need to work. To pause
  sending without dropping `/unsubscribe`, set every campaign's `active=FALSE`
  in the Sheet instead of stopping PM2.
