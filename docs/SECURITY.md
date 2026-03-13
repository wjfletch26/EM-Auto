# Security Model — Deaton Outreach Automation

## Threat Model

### Assets to Protect

| Asset | Sensitivity | Location |
|---|---|---|
| SMTP credentials (email + password) | **CRITICAL** — full mailbox access | `.env` file on VPS |
| Google service account JSON key | **HIGH** — read/write access to Sheets | File on VPS disk |
| Unsubscribe HMAC secret | **HIGH** — prevents forged unsubscribes | `.env` file on VPS |
| Contact data (emails, names, companies) | **MODERATE** — PII | Google Sheets |
| Send logs and reply logs | **MODERATE** — operational data | Google Sheets + local logs |
| Application source code | **LOW** — no secrets in code | VPS disk, git repo |

### Threat Actors

| Actor | Motivation | Capability |
|---|---|---|
| External attacker | Steal credentials, abuse mailbox for spam | Network-level attacks, brute force |
| Spam filter / email provider | Protect recipients from unwanted email | Block sending, blacklist domain |
| Recipient | Abuse unsubscribe endpoint | Forge unsubscribe requests for other contacts |
| Insider (accidental) | Misconfiguration | Access to VPS or Sheets |

### Attack Surfaces

| Surface | Exposure | Mitigation |
|---|---|---|
| VPS SSH | Internet-facing | SSH key auth only, no password auth, fail2ban |
| Unsubscribe HTTP endpoint | Internet-facing | Caddy reverse proxy with TLS, HMAC-signed tokens, rate limiting |
| SMTP connection | Outbound only | TLS required (STARTTLS on port 587) |
| IMAP connection | Outbound only | TLS required (port 993) |
| Google Sheets API | Outbound only | Service account auth, HTTPS |
| `.env` file | VPS filesystem | File permissions: 600 (owner read/write only) |
| Service account key | VPS filesystem | File permissions: 600 (owner read/write only) |

---

## Credential Management

### Storage

All credentials are stored in a single `.env` file on the VPS.

```
Location: /home/deaton/app/.env
Permissions: -rw------- (600) — only the deaton user can read/write
Owner: deaton:deaton
```

The `.env` file is **never committed to git**. The `.gitignore` must include:
```
.env
*.json  # except package.json and tsconfig.json
data/
```

The Google service account JSON key file:
```
Location: /home/deaton/app/credentials/service-account.json
Permissions: -rw------- (600)
Owner: deaton:deaton
```

The `credentials/` directory is also gitignored.

### Rotation

| Credential | Rotation Procedure |
|---|---|
| SMTP password | Change in GoDaddy/Outlook webmail → update `.env` → restart PM2 |
| Google service account key | Generate new key in Cloud Console → replace JSON file → restart PM2 → delete old key in Console |
| Unsubscribe HMAC secret | Generate new secret → update `.env` → restart PM2. Note: old unsubscribe links become invalid. |

### Access Control

- Only the `deaton` Linux user can read credentials.
- The application runs as the `deaton` user (not root).
- SSH access to the VPS is restricted to key-based auth.
- No credentials are stored in Google Sheets.
- No credentials are logged (the logger must redact `.env` values).

---

## Email Compliance

### CAN-SPAM Act (US)

The CAN-SPAM Act requires:

| Requirement | How the System Complies |
|---|---|
| Don't use false or misleading header information | Emails are sent from `dave@deatonengineering.us` — a real, valid address |
| Don't use deceptive subject lines | Subject lines are defined in templates, reviewed by the operator |
| Identify the message as an ad (if applicable) | The operator is responsible for template content |
| Tell recipients where you're located | Include a physical mailing address in the email footer template |
| Tell recipients how to opt out | Every email includes an unsubscribe link in the footer |
| Honor opt-out requests promptly | Unsubscribe is processed immediately; contact is skipped in the next send cycle |
| Monitor what others are doing on your behalf | N/A — single operator system |

### Implementation Requirements for Compliance

1. **Every email template MUST include**:
   - An unsubscribe link: `{{unsubscribe_url}}`
   - A physical mailing address (hardcoded in the template or a config variable)

2. **The unsubscribe link MUST work** — the web endpoint must be reachable 24/7.

3. **Unsubscribed contacts are NEVER emailed again** — the sequence engine checks `unsubscribed` before every send.

4. **Unsubscribe processing is immediate** — there is no delay or "within 10 days" period. The next send cycle (within 5 minutes) will skip the contact.

### GDPR Considerations

If any contacts are in the EU:

- Ensure you have a lawful basis for processing (legitimate interest for B2B outreach).
- The unsubscribe mechanism serves as the opt-out right.
- Contact data in Google Sheets should be deletable upon request (manual process at MVP).
- Logs containing email addresses should have a retention policy (e.g., 90 days).

---

## Unsubscribe Token Security

### Token Format

The unsubscribe token encodes the contact's email and an expiration timestamp, signed with HMAC-SHA256.

```
Payload: {email}|{expiry_timestamp_unix}
Signature: HMAC-SHA256(payload, UNSUBSCRIBE_SECRET)
Token: base64url(payload + "." + signature)
```

### Properties

- **Tamper-proof**: The HMAC signature prevents modification of the email or expiry.
- **Non-forgeable**: Without the secret, an attacker cannot generate valid tokens for other emails.
- **Expiring**: Tokens expire after 90 days. After that, the link returns "no longer valid."
- **Stateless**: No database lookup required — the token contains all information.

### What an attacker CANNOT do:

- Forge an unsubscribe link for an arbitrary email (no secret).
- Modify a token to change the email (HMAC breaks).
- Use an expired token.

### What an attacker CAN do:

- Use a valid, non-expired token to unsubscribe the intended email. This is by design — the link recipient should be able to unsubscribe.
- Share a valid link with someone else who could click it. Mitigation: tokens are tied to a specific email, and unsubscribing is not harmful (it's the desired outcome for recipients who don't want emails).

---

## Network Security

### VPS Firewall Rules (ufw)

```
Allow: TCP 22 (SSH) — from operator IP only, if possible
Allow: TCP 80 (HTTP) — Caddy (redirects to HTTPS)
Allow: TCP 443 (HTTPS) — Caddy (unsubscribe endpoint)
Deny: Everything else inbound
```

Outbound connections (all via TLS):
- `smtp.office365.com:587` — SMTP sending
- `outlook.office365.com:993` — IMAP reading (if available)
- `sheets.googleapis.com:443` — Google Sheets API
- `oauth2.googleapis.com:443` — Google auth token refresh

### TLS

- **SMTP**: STARTTLS on port 587 (required by Microsoft).
- **IMAP**: Implicit TLS on port 993.
- **Unsubscribe endpoint**: HTTPS via Caddy with automatic Let's Encrypt certificate.
- **Google API**: HTTPS (enforced by googleapis SDK).

### No Plaintext Credentials in Transit

All connections use TLS. There are no plaintext credential transmissions.

---

## Logging Security

### What IS Logged

- Email addresses of contacts (for auditability).
- Send status, reply classifications, bounce events.
- Error messages from SMTP, IMAP, and Sheets API.
- Timestamps, message IDs, campaign IDs.

### What is NEVER Logged

- SMTP password.
- Google service account private key.
- Unsubscribe HMAC secret.
- Full email body content (only snippets for reply classification).
- HTTP request bodies (only path and status code for unsubscribe requests).

### Log Retention

- Logs are rotated daily.
- Logs older than 30 days are automatically deleted.
- The operator can adjust retention in the logger config.

---

## Security Checklist for Deployment

Before going live, verify:

- [ ] `.env` file permissions are 600
- [ ] Service account JSON file permissions are 600
- [ ] `.env` and `credentials/` are in `.gitignore`
- [ ] VPS firewall (ufw) is enabled with only ports 22, 80, 443 open
- [ ] SSH password auth is disabled (key-only)
- [ ] The application does NOT run as root
- [ ] Caddy is configured with HTTPS
- [ ] Unsubscribe tokens validate correctly (test with a known token)
- [ ] SMTP connection uses STARTTLS (verify in logs)
- [ ] IMAP connection uses TLS (verify in logs)
- [ ] No secrets appear in application logs (grep logs for password, key, secret)
- [ ] Email templates include an unsubscribe link and physical address
- [ ] fail2ban is installed and configured for SSH
