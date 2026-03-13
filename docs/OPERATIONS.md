# Operations Runbook — Deaton Outreach Automation

## Daily Operations

Under normal operation, the system requires **no daily human intervention**. The cron scheduler handles everything automatically.

The human operator at `dknieriem@deatonengineering.com` should:
1. Review forwarded replies in their inbox.
2. If running in Tier 3 (manual reply processing): update the Google Sheet with reply statuses.

---

## Checking System Health

### Is the application running?

```bash
ssh deaton@<vps-ip>
pm2 status
```

Expected output:
```
┌──────────────────┬────┬──────┬──────┬────────┬─────────┬────────┐
│ Name             │ id │ mode │ pid  │ status │ restart │ uptime │
├──────────────────┼────┼──────┼──────┼────────┼─────────┼────────┤
│ deaton-outreach  │ 0  │ fork │ 1234 │ online │ 0       │ 5D     │
└──────────────────┴────┴──────┴──────┴────────┴─────────┴────────┘
```

If status is `errored` or `stopped`:
```bash
pm2 logs deaton-outreach --lines 50   # Check why it stopped
pm2 restart deaton-outreach            # Restart it
```

### Is the unsubscribe endpoint reachable?

```bash
curl -s -o /dev/null -w "%{http_code}" https://unsub.deatonengineering.us/health
```

Expected: `200`. If not: check Caddy status (`sudo systemctl status caddy`).

### Are emails being sent?

Check the "Send Log" tab in Google Sheets. The most recent row should have today's date (if there are eligible contacts).

Alternatively, check application logs:
```bash
pm2 logs deaton-outreach --lines 50 | grep "Send cycle complete"
```

---

## Common Tasks

### Add New Contacts

1. Open the Google Sheet.
2. Go to the "Contacts" tab.
3. Add new rows with at minimum: `email`, `first_name`, `campaign_id`.
4. Leave `status` blank or set to `new`.
5. The system will pick them up on the next send cycle (within 5 minutes).

### Create a New Campaign

1. Open the Google Sheet.
2. Go to the "Campaigns" tab.
3. Add a new row with: `campaign_id`, `campaign_name`, `total_steps`, step definitions, `active=TRUE`.
4. Create the Handlebars template files on the VPS in `templates/`.
5. In the "Contacts" tab, set the new contacts' `campaign_id` to the new campaign.

### Pause All Sending

**Option 1**: Stop the application.
```bash
pm2 stop deaton-outreach
```

**Option 2**: Set all campaigns to inactive.
- In the "Campaigns" tab, set `active` to `FALSE` for all campaigns.
- The system will still run but won't send any emails.

### Resume Sending

```bash
pm2 restart deaton-outreach
```
Or set campaign `active` back to `TRUE`.

### Pause a Single Contact

In the "Contacts" tab, set the contact's `status` to `do_not_contact`. The system will skip them.

### Manually Unsubscribe a Contact

In the "Contacts" tab:
- Set `unsubscribed` to `TRUE`
- Set `unsubscribe_date` to the current date/time
- Set `unsubscribe_source` to `manual`

### Change a Template

1. SSH into the VPS.
2. Edit the template file in `templates/`.
3. The change takes effect immediately on the next send cycle (no restart needed — templates are loaded fresh each cycle).

### Change Send Timing

Edit the `.env` file on the VPS:
- `SEND_CRON` — change the cron schedule
- `SEND_DELAY_MS` — change the delay between individual sends
- `SEND_BATCH_SIZE` — change how many emails per cycle

Then restart:
```bash
pm2 restart deaton-outreach
```

---

## Manual Reply Processing (Tier 3 Workflow)

If IMAP/EWS is not available, the human at `dknieriem@deatonengineering.com` follows this process:

### Daily (or as replies come in):

1. Open the forwarded reply in your email.
2. Determine the classification:
   - **QUALIFIED**: The contact expressed interest or wants to talk.
   - **NOT_INTERESTED**: The contact declined.
   - **UNSUBSCRIBE**: The contact asked to be removed.
   - **OUT_OF_OFFICE**: Auto-reply / vacation message.
   - **BOUNCE**: Delivery failure notification.
   - **UNCLEAR**: Can't determine intent.
3. Open the Google Sheet "Contacts" tab.
4. Find the contact's row (search by email).
5. Update the following columns:
   - `reply_status`: Set to the classification.
   - `reply_date`: Set to the date of the reply.
   - `reply_snippet`: (Optional) Paste a brief excerpt.
6. If the classification is **UNSUBSCRIBE**:
   - Also set `unsubscribed` to `TRUE`.
   - Also set `unsubscribe_date`.
   - Also set `unsubscribe_source` to `manual`.
7. If the classification is **BOUNCE**:
   - Also set `bounced` to `TRUE`.
   - Also set `bounce_type` to `hard`.
   - Also set `bounce_date`.

The system reads these changes on the next send cycle and respects them.

---

## Troubleshooting

### Problem: "No emails are being sent"

1. **Check if the app is running**: `pm2 status`
2. **Check logs for errors**: `pm2 logs deaton-outreach --lines 100`
3. **Check if there are eligible contacts**: Open the Google Sheet. Are there contacts with `status=new` or `status=active` who haven't completed their sequence?
4. **Check if the campaign is active**: Is `active=TRUE` in the Campaigns tab?
5. **Check timing**: Has enough time elapsed since the last send for the next step's delay?
6. **Check SMTP connection**: Look for SMTP errors in the logs. If auth fails, verify the password in `.env`.

### Problem: "SMTP authentication failed"

1. Verify the password in `.env` is correct.
2. Check if the password was recently changed in GoDaddy/Outlook.
3. Verify SMTP AUTH is still enabled on the account (contact GoDaddy support if needed).
4. Update `.env` and restart: `pm2 restart deaton-outreach`

### Problem: "Google Sheets API errors"

1. Check that the service account JSON key file exists and has correct permissions (600).
2. Check that the spreadsheet is shared with the service account email.
3. Check that the `GOOGLE_SPREADSHEET_ID` in `.env` is correct.
4. Check Google Cloud Console for any API quota issues.

### Problem: "Unsubscribe link returns 502"

1. Check if the app is running: `pm2 status`
2. Check if Caddy is running: `sudo systemctl status caddy`
3. Check if the Express server is listening on the correct port: `pm2 logs deaton-outreach | grep "listening"`
4. Check the Caddyfile points to the correct port: `cat /etc/caddy/Caddyfile`

### Problem: "Application keeps restarting"

1. Check PM2 restart count: `pm2 status` (look at the `restart` column)
2. Check error logs: `pm2 logs deaton-outreach --err --lines 50`
3. Common causes: invalid `.env` (Zod validation fails), missing service account key, missing `data/` directories.

### Problem: "Duplicate emails sent"

1. This should not happen — the system checks the Send Log before sending.
2. If it does happen, check `data/state/pending-sends.json` for incomplete runs.
3. Check the Send Log tab for duplicate entries.
4. If the problem persists, stop the app, clear `data/state/pending-sends.json`, and restart.

---

## Emergency Procedures

### Stop All Sending Immediately

```bash
pm2 stop deaton-outreach
```

This stops everything: sending, reply processing, and the unsubscribe endpoint.

### The Unsubscribe Endpoint Must Stay Up

If you need to stop sending but keep the unsubscribe endpoint running, the simplest approach is to set all campaigns to `active=FALSE` in Google Sheets rather than stopping the application.

### VPS Is Unreachable

1. Log into your VPS provider's dashboard.
2. Use the provider's console access (web-based terminal).
3. Check if the server is running. Reboot if necessary.
4. After reboot, PM2 should auto-restart the application (if `pm2 startup` was configured).

### Credentials May Be Compromised

1. **Immediately** change the SMTP password via GoDaddy/Outlook webmail.
2. Rotate the Google service account key: generate a new key in Google Cloud Console, delete the old one.
3. Generate a new `UNSUB_SECRET`: `openssl rand -hex 32`
4. Update `.env` with all new values.
5. Restart the application: `pm2 restart deaton-outreach`
6. Note: old unsubscribe links will stop working after the `UNSUB_SECRET` changes. New links will be generated on the next send cycle.
