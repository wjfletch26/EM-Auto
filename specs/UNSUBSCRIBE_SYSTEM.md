# Spec: Unsubscribe System

**Files**:
- `src/engine/unsubscribe.ts` — Token generation and validation logic
- `src/web/server.ts` — Express.js app setup
- `src/web/routes/unsubscribe.ts` — HTTP route handler
- `src/utils/crypto.ts` — HMAC signing utilities

**Dependencies**: `src/services/sheets.ts`, `src/logging/logger.ts`, `src/config/index.ts`

---

## Purpose

The Unsubscribe System provides two mechanisms for contacts to opt out:

1. **Link-based**: A unique URL in every email footer. Clicking it triggers an immediate unsubscribe.
2. **Reply-based**: The Reply Processor detects unsubscribe keywords in replies (handled in `reply-processor.ts`, not this module).

This spec covers the link-based mechanism and the web endpoint.

---

## Token Design

### Requirements

- Stateless: no database lookup required to validate a token.
- Tamper-proof: cannot be modified to target a different email.
- Expiring: tokens become invalid after a configurable period.
- URL-safe: can be embedded in a query string without encoding issues.

### Token Structure

```
Payload:  {email}|{expiry_unix_timestamp}
Signature: HMAC-SHA256(payload, UNSUB_SECRET)
Token:    base64url(payload) + "." + base64url(signature)
```

**Example:**
```
Payload:   john@example.com|1718000000
Base64url: am9obkBleGFtcGxlLmNvbXwxNzE4MDAwMDAw
Signature: HMAC-SHA256("john@example.com|1718000000", secret) → (32 bytes)
Token:     am9obkBleGFtcGxlLmNvbXwxNzE4MDAwMDAw.dGhpcyBpcyBhIHNpZ25hdHVyZQ
```

### URL Format

```
https://unsub.deatonengineering.us/unsubscribe?token=am9obkBleGFtcGxlLmNvbXwxNzE4MDAwMDAw.dGhpcyBpcyBhIHNpZ25hdHVyZQ
```

---

## Public Interface — Token Module

**File**: `src/engine/unsubscribe.ts`

```typescript
// Generate a signed unsubscribe URL for a contact email.
function generateUnsubscribeUrl(email: string): string

// Validate a token. Returns the email if valid, or throws if invalid/expired.
function validateUnsubscribeToken(token: string): { email: string; expiresAt: Date }

// Process an unsubscribe: update Sheets, log the event.
async function processUnsubscribe(email: string, source: 'link' | 'reply'): Promise<void>
```

---

## Token Generation Algorithm

```
function generateUnsubscribeUrl(email: string): string
  1. Normalize email: email.trim().toLowerCase()
  2. Calculate expiry: Math.floor(Date.now() / 1000) + (UNSUB_EXPIRY_DAYS * 86400)
  3. Build payload string: `${email}|${expiry}`
  4. Sign: signature = hmacSha256(payload, UNSUB_SECRET)
  5. Encode: token = base64url(payload) + "." + base64url(signature)
  6. Return: `${UNSUB_BASE_URL}/unsubscribe?token=${token}`
```

---

## Token Validation Algorithm

```
function validateUnsubscribeToken(token: string): { email, expiresAt }
  1. Split token on ".": [encodedPayload, encodedSignature]
     - If not exactly 2 parts → throw InvalidTokenError("malformed token")

  2. Decode: payload = base64urlDecode(encodedPayload)
     - If decode fails → throw InvalidTokenError("decode failed")

  3. Recompute signature: expected = hmacSha256(payload, UNSUB_SECRET)

  4. Compare signatures using timing-safe comparison:
     - If not equal → throw InvalidTokenError("signature mismatch")

  5. Split payload on "|": [email, expiryStr]
     - If not exactly 2 parts → throw InvalidTokenError("malformed payload")

  6. Parse expiry: expiryUnix = parseInt(expiryStr, 10)
     - If NaN → throw InvalidTokenError("invalid expiry")

  7. Check expiry: if (Date.now() / 1000 > expiryUnix) → throw TokenExpiredError("token expired")

  8. Return { email, expiresAt: new Date(expiryUnix * 1000) }
```

**Important**: Step 4 MUST use a timing-safe comparison (`crypto.timingSafeEqual`) to prevent timing attacks.

---

## Crypto Utilities

**File**: `src/utils/crypto.ts`

```typescript
import { createHmac, timingSafeEqual } from 'node:crypto';

function hmacSha256(data: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(data).digest();
}

function base64urlEncode(data: string | Buffer): string {
  const buf = typeof data === 'string' ? Buffer.from(data) : data;
  return buf.toString('base64url');
}

function base64urlDecode(encoded: string): string {
  return Buffer.from(encoded, 'base64url').toString('utf8');
}

function timingSafeCompare(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
```

---

## Web Endpoint

**File**: `src/web/server.ts`

```typescript
import express from 'express';

const app = express();

// Health check
app.get('/health', healthHandler);

// Unsubscribe
app.get('/unsubscribe', unsubscribeHandler);

app.listen(config.unsub.port, () => {
  logger.info({ module: 'web', port: config.unsub.port }, 'Unsubscribe server listening');
});
```

**File**: `src/web/routes/unsubscribe.ts`

### GET /unsubscribe?token=...

```
function unsubscribeHandler(req, res):
  1. Extract token from query string: req.query.token
     - If missing → return 400 with error page

  2. Try: validateUnsubscribeToken(token)
     - On InvalidTokenError → return 400 with "This link is invalid" page
     - On TokenExpiredError → return 400 with "This link has expired" page

  3. Call processUnsubscribe(email, 'link')
     - This updates the Sheets

  4. Return 200 with "You have been unsubscribed" confirmation page

  5. Log: "Contact unsubscribed via link" with email
```

### Response Pages

The endpoint returns minimal HTML pages (no external dependencies, inline CSS).

**Success page:**
```html
<!DOCTYPE html>
<html>
<head><title>Unsubscribed</title></head>
<body style="font-family: sans-serif; max-width: 500px; margin: 80px auto; text-align: center;">
  <h1>Unsubscribed</h1>
  <p>You have been successfully removed from our mailing list.</p>
  <p>You will no longer receive emails from us.</p>
</body>
</html>
```

**Error page (invalid/expired):**
```html
<!DOCTYPE html>
<html>
<head><title>Unsubscribe</title></head>
<body style="font-family: sans-serif; max-width: 500px; margin: 80px auto; text-align: center;">
  <h1>Link Not Valid</h1>
  <p>This unsubscribe link is no longer valid.</p>
  <p>If you'd like to unsubscribe, please reply to any of our emails with the word "unsubscribe".</p>
</body>
</html>
```

---

## Process Unsubscribe (Sheets Update)

```
async function processUnsubscribe(email: string, source: 'link' | 'reply'):
  1. Read the Contacts tab from Sheets.
  2. Find the row where column A (email) matches.
     - If not found → log warning "Unsubscribe for unknown email", return.
  3. Update the row:
     - Column M (unsubscribed) = TRUE
     - Column N (unsubscribe_date) = new Date().toISOString()
     - Column O (unsubscribe_source) = source
     - Column G (status) = "unsubscribed"
  4. Log: "Unsubscribe processed" with email and source.
```

---

## Rate Limiting the Endpoint

To prevent abuse, apply basic rate limiting to the unsubscribe endpoint:

```typescript
// Simple in-memory rate limiter: max 10 requests per IP per minute.
const rateLimit = new Map<string, { count: number; resetAt: number }>();

function rateLimitMiddleware(req, res, next) {
  const ip = req.ip;
  const now = Date.now();
  const entry = rateLimit.get(ip);

  if (!entry || now > entry.resetAt) {
    rateLimit.set(ip, { count: 1, resetAt: now + 60000 });
    return next();
  }

  entry.count++;
  if (entry.count > 10) {
    return res.status(429).send('Too many requests');
  }
  return next();
}
```

---

## Security Considerations

- Tokens are HMAC-signed — cannot be forged without the secret.
- Timing-safe comparison prevents timing attacks on the signature.
- Tokens expire after `UNSUB_EXPIRY_DAYS` (default 90 days).
- Rate limiting prevents endpoint abuse.
- No contact data is exposed in the response (just "unsubscribed" or "not valid").
- The token contains only the email and expiry — no other PII.
