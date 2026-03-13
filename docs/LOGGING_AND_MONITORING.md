# Logging and Monitoring — Deaton Outreach Automation

## Logging Overview

The system uses **Pino** for structured JSON logging. All logs are written to both stdout (captured by PM2) and daily-rotated log files on disk.

---

## Log Levels

| Level | When to Use | Example |
|---|---|---|
| `error` | Something failed and requires attention | SMTP auth failure, Google Sheets API 500, unhandled exception |
| `warn` | Something unexpected but recoverable | IMAP connection failed (falling back to Tier 3), soft bounce, template variable missing |
| `info` | Normal operational events | Send cycle complete, reply classified, unsubscribe processed |
| `debug` | Verbose detail for troubleshooting | SMTP response codes, template render output, Sheets API request/response |

Default level: `info` (set via `LOG_LEVEL` in `.env`).

---

## Log Format

All logs are structured JSON, one object per line. This makes them parseable by log analysis tools.

### Standard Fields

Every log entry includes:

```json
{
  "level": "info",
  "time": "2026-03-12T14:30:05.123Z",
  "msg": "Email sent successfully",
  "module": "send-engine",
  "run_id": "run_20260312_143000"
}
```

| Field | Description |
|---|---|
| `level` | Log level (error, warn, info, debug) |
| `time` | ISO 8601 timestamp |
| `msg` | Human-readable message |
| `module` | Which source module generated the log |
| `run_id` | Identifies the current send/reply cycle (for grouping related logs) |

### Contextual Fields

Additional fields depend on the event:

**Send events:**
```json
{
  "msg": "Email sent successfully",
  "module": "send-engine",
  "contact_email": "john@example.com",
  "campaign_id": "deaton_q1_2026",
  "step": 2,
  "message_id": "<abc123@office365.com>",
  "duration_ms": 1250
}
```

**Send failure:**
```json
{
  "level": "error",
  "msg": "SMTP send failed",
  "module": "send-engine",
  "contact_email": "john@example.com",
  "error_code": "550",
  "error_message": "5.1.1 User unknown",
  "will_retry": false
}
```

**Reply classification:**
```json
{
  "msg": "Reply classified",
  "module": "reply-processor",
  "contact_email": "john@example.com",
  "classification": "QUALIFIED",
  "subject_snippet": "Re: Quick question"
}
```

**Unsubscribe:**
```json
{
  "msg": "Contact unsubscribed",
  "module": "unsubscribe",
  "contact_email": "john@example.com",
  "source": "link"
}
```

**Cycle summary:**
```json
{
  "msg": "Send cycle complete",
  "module": "send-engine",
  "run_id": "run_20260312_143000",
  "eligible": 12,
  "sent": 10,
  "failed": 1,
  "skipped": 1,
  "duration_ms": 152000
}
```

---

## Log Files

### Location

```
data/logs/
├── app-2026-03-12.log      # Today's log
├── app-2026-03-11.log      # Yesterday's log
├── app-2026-03-10.log      # 2 days ago
└── ...
```

### Rotation

- Logs rotate **daily** at midnight UTC.
- Files are named `app-YYYY-MM-DD.log`.
- Files older than `LOG_RETENTION_DAYS` (default: 30) are automatically deleted.

### Rotation Implementation

Use `pino-roll` or implement a simple file rotation:

```typescript
// Rotate logic: on each log write, check if date has changed.
// If it has, close the current file stream and open a new one.
// On startup, delete files older than LOG_RETENTION_DAYS.
```

---

## PM2 Logs

PM2 also captures stdout/stderr. These are useful for crash diagnostics.

```bash
# View recent PM2 logs
pm2 logs deaton-outreach --lines 50

# View only error logs
pm2 logs deaton-outreach --err --lines 50

# Clear PM2 logs (if they get too large)
pm2 flush deaton-outreach
```

PM2 log files (configured in `ecosystem.config.js`):
- `data/logs/pm2-out.log` — stdout
- `data/logs/pm2-error.log` — stderr

---

## Monitoring

### Health Check Endpoint

The Express.js server exposes:

```
GET /health
```

Response (HTTP 200):
```json
{
  "status": "ok",
  "uptime_seconds": 86400,
  "last_send_run": "2026-03-12T14:30:00Z",
  "last_reply_run": "2026-03-12T14:35:00Z",
  "imap_enabled": false,
  "version": "1.0.0"
}
```

Response (HTTP 503 — unhealthy):
```json
{
  "status": "unhealthy",
  "reason": "Last send run was over 30 minutes ago",
  "last_send_run": "2026-03-12T13:00:00Z"
}
```

Unhealthy conditions:
- Last send run was more than 30 minutes ago (suggests the scheduler stopped).
- SMTP connection test fails.
- Google Sheets API is unreachable.

### Heartbeat File

The health job writes a heartbeat to `data/state/heartbeat.json` every minute:

```json
{
  "timestamp": "2026-03-12T14:31:00Z",
  "pid": 1234,
  "memory_mb": 85,
  "uptime_seconds": 86400
}
```

An external monitoring script can check this file's age. If it's older than 5 minutes, the application has stopped.

### External Uptime Monitoring (Recommended)

Use a free external uptime monitor to check the `/health` endpoint every 5 minutes. If it goes down, you get an alert.

**Free options:**
- UptimeRobot (free tier: 50 monitors, 5-min interval)
- Better Uptime (free tier: 10 monitors)
- Cronitor (free tier: limited monitors)

**Setup:**
1. Create an account on UptimeRobot.
2. Add a new HTTP(s) monitor.
3. URL: `https://unsub.deatonengineering.us/health`
4. Interval: 5 minutes.
5. Alert contact: your email or phone number.

---

## Key Metrics to Watch

| Metric | Where to Find It | Healthy Range | Action If Abnormal |
|---|---|---|---|
| Emails sent per day | Send Log tab (count today's rows) | 10–50 (depends on contacts) | Check if contacts are available, campaign is active |
| Send failures per day | Send Log tab (count `status=failed`) | 0–2 | Check SMTP errors in logs |
| Bounce rate | Contacts tab (count `bounced=TRUE`) | < 5% of total | Clean contact list, check data quality |
| Unsubscribe rate | Contacts tab (count `unsubscribed=TRUE`) | < 10% of total | Review email content and targeting |
| PM2 restart count | `pm2 status` (restart column) | 0 | Check error logs for crash cause |
| Memory usage | `pm2 monit` | < 200 MB | Check for memory leaks |
| Disk usage | `df -h` | < 80% | Clean old logs, archive Send Log |

---

## Log Search Examples

### Find all errors in today's log:
```bash
cat data/logs/app-$(date +%Y-%m-%d).log | grep '"level":"error"'
```

### Find all sends to a specific contact:
```bash
grep "john@example.com" data/logs/app-*.log | grep "sent"
```

### Find all bounces:
```bash
grep '"bounce"' data/logs/app-$(date +%Y-%m-%d).log
```

### Count sends per day over the last week:
```bash
for f in data/logs/app-*.log; do
  echo -n "$(basename $f .log): "
  grep '"msg":"Email sent successfully"' $f | wc -l
done
```

---

## Alerting Strategy (MVP)

At MVP, alerting is simple:

1. **UptimeRobot** monitors the `/health` endpoint. If it returns non-200 for 5+ minutes → email alert.
2. **PM2** restarts the app on crash. Check `pm2 status` restart count periodically.
3. **Manual log review**: SSH in and check logs weekly, or when alerted.

Future enhancements:
- Send alerts via email or Slack webhook from within the application when critical errors occur.
- Ship logs to a centralized service (e.g., Logtail, Datadog) for dashboards.
