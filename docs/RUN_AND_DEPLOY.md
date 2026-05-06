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
| `SAFE_MODE`                        | optional (see below)                  | optional; when `true`, **cron off**, **Admin POST/PATCH disabled**, `/health` + unsubscribe + GET Admin still work |
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
curl -sS "https://unsub.deatonengineering.us/health"   # layered JSON: status, checks, deploy, safeMode
```

`/health` returns **JSON** (not a bare `"ok"`). **`200`** usually; **`503`** when `status` is **`failed`** (e.g. Sheets or SMTP probe failed in production). Inspect `checks.googleSheets`, `checks.smtp`, `checks.scheduler`, and `deploy.sha`.

### Production `.env` invariants

The VPS `/home/deaton/app/.env` **must** have:

```env
APP_ENV=production
GOOGLE_SPREADSHEET_ID=<the REAL prod sheet ID>
PRODUCTION_GOOGLE_SPREADSHEET_ID=<the SAME REAL prod sheet ID>
# DRY_RUN unset (or false)
# TEST_RECIPIENT unset (or empty)
SCHEDULER_ENABLED=true
# SAFE_MODE=true   # optional: stops cron + Admin mutations; use while debugging (see OPERATIONS.md)
```

When **`SAFE_MODE=true`**, the process **does not start cron**, and the **Admin API** rejects **POST/PATCH** (read-only **GET** still works). Unsubscribe and **`/health`** keep running.

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

## 3) Ship `main` to the VPS (semi-automatic)

**Trunk:** work on **`feat/...`**, validate locally against a **test sheet**, merge to **`main`**, push. The **production VPS** should run **`main` only** (no separate `production` Git branch).

### Default path — GitHub Actions + manual approval

1. **GitHub repository** → Settings → **Environments** → create **`production`** → enable **Required reviewers** (you / David).
2. **Secrets** on the repo (or environment): `SSH_HOST`, `SSH_USER`, `SSH_PRIVATE_KEY` (private half for deploy), **`DEPLOY_PATH`** (absolute app dir on the VPS, e.g. `/home/deaton/app`).
3. Push to **`main`**: workflow **CI and Deploy** (`.github/workflows/ci-deploy.yml`) runs **`npm ci`**, **`npm run build`**, **`npm test`**.
4. After tests pass, open the **deploy** job in the Actions UI and **approve** the **`production`** environment gate.
5. The deploy job **SSHs** to the VPS and runs **`bash scripts/vps-deploy.sh`** from `DEPLOY_PATH`, which:
   - **Preflight:** `package.json`, `credentials/service-account.json`, disk headroom, **`pm2 describe`** (set `SKIP_PM2_CHECK=1` once for first-time PM2 if needed).
   - **Lock:** **`.deploy.lock`** + **`flock`** — a second overlapping deploy **exits immediately**.
   - **`git pull origin $DEPLOY_GIT_REF`** (default **`main`**), **`npm install`**, **`npm run build`**, **`node scripts/write-deploy-manifest.mjs`** when the file exists (writes `deploy-manifest.json` with **`GIT_SHA` / `GIT_REF` / `DEPLOYER`** from GitHub), **`pm2 reload deaton-outreach`**, **`curl` /health**.

**Rollback:** revert `main` (or check out a known-good SHA), redeploy with the same script or manual steps → [`DEPLOYMENT.md` → Rollback Procedure](DEPLOYMENT.md#rollback-procedure).

### Manual / emergency deploy (no Actions)

On the laptop (after local checklist in `project/CONTRIBUTING.md`):

```bash
git checkout main
git pull origin main
npm run build
npm test
git push origin main
```

On the VPS:

```bash
ssh deaton@<vps-ip>
cd /home/deaton/app   # or your DEPLOY_PATH
export GIT_SHA="$(git rev-parse HEAD)"
export GIT_REF="$(git rev-parse --abbrev-ref HEAD)"
export DEPLOYER="$(whoami)"
bash scripts/vps-deploy.sh
```

Or follow the same commands as in `scripts/vps-deploy.sh` by hand, respecting **`.deploy.lock`**.

### Verify after deploy

```bash
pm2 status
curl -sS "https://unsub.deatonengineering.us/health" | head -c 800
```

Then open **Admin** (`/admin/`). **Env banners** (PRODUCTION, SAFE MODE, DRY RUN, etc.) pull from **`/health`** on the same origin.

---

## Staging (recommended)

Local + a test sheet cannot fully match **PM2 reload behavior, long-running cron, or Sheets timing**. When you are ready, add a **second VPS**, **staging spreadsheet**, **`APP_ENV=staging`**, **`DRY_RUN=true`**, **`SAFE_MODE=false`** so automation and scheduler **actually run** without delivering mail to real contacts. Use the **same deploy script** as production.

**Future (canary):** deploy with automation **off** first (**`SAFE_MODE` or scheduler disabled**), validate **`/health`**, then enable the scheduler in a **second deliberate step** — avoids a bad release immediately hitting the whole contact base on `pm2 reload`.

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
- **`SAFE_MODE=true`** in production: **no cron**, **Admin** allows **GET only** (no POST/PATCH). Prefer this over killing PM2 or editing cron by hand. See [`OPERATIONS.md`](OPERATIONS.md).
