# Admin API — Spec

## Purpose

The Admin REST API (`/api/admin/*`) gives operators programmatic access to Sheets-backed data and manual control over background jobs. It is served by the same Express process as the unsubscribe endpoint. The SPA admin UI (`/admin`) consumes this API.

**Disabled by default.** If `ADMIN_API_KEY` is empty or unset:
- Every `/api/admin/*` route returns **503 Service Unavailable**.
- The static SPA at `/admin` is not mounted.

---

## Authentication

Send the key on every request using either header:

```
Authorization: Bearer <ADMIN_API_KEY>
```

or

```
X-Admin-Key: <ADMIN_API_KEY>
```

Responses:
- **401 Unauthorized** — key is set but the request did not provide it or provided the wrong value.
- **503 Service Unavailable** — `ADMIN_API_KEY` is not configured on the server.

---

## Request Format

- All request bodies must be `Content-Type: application/json`.
- JSON body limit: **10 MB** (covers bulk contact imports).
- URL-encoded email parameters (`:email` segments) are decoded with `decodeURIComponent` and lowercased.

---

## Contact Routes

### `GET /api/admin/contacts`

Returns all contacts from the `Contacts` Sheets tab.

**Query parameters:**

| Param | Default | Description |
|---|---|---|
| `limit` | `500` | Max rows returned. Capped at **2000**. |

**Response 200:**
```json
{
  "contacts": [ { "email": "...", "firstName": "...", "pipelineStatus": "...", ... } ]
}
```

---

### `POST /api/admin/contacts`

Appends a single new contact row to the `Contacts` tab.

**Request body:**

| Field | Required | Notes |
|---|---|---|
| `email` | Yes | Primary key; must be non-empty |
| `firstName` | Yes | |
| `lastName` | No | |
| `company` | No | |
| `title` | No | |
| `campaignId` | No | |
| `custom1` | No | |
| `custom2` | No | |
| `notes` | No | |
| `companyUrl` | No | Used as pipeline research URL |
| `pipelineStatus` | No | Defaults to blank (pipeline skips it until set to `new`) |

**Response 201:** `{ "ok": true }`

---

### `POST /api/admin/contacts/import`

Bulk-appends contacts. Processes rows sequentially; partial failures are reported but do not stop the import.

**Request body:**
```json
{ "rows": [ { "email": "...", "firstName": "...", ... }, ... ] }
```

Each row accepts the same fields as the single-contact create. If `rows` is not an array, returns **400**.

**Response 200:**
```json
{ "imported": 5, "failed": 1, "errors": ["Row 3: ..."] }
```

---

### `PATCH /api/admin/contacts/:email`

Updates one or more fields on an existing contact. Returns **404** if the contact is not found.

Fields are split into two groups and written to separate column ranges:

**Engine fields** (write to engine columns):

`status`, `lastStepSent`, `lastSendDate`, `replyStatus`, `replyDate`, `replySnippet`, `unsubscribed`, `unsubscribeDate`, `unsubscribeSource`, `bounced`, `bounceType`, `bounceDate`, `softBounceCount`, `pipelineStatus`

Type coercion applies: numeric fields (`lastStepSent`, `softBounceCount`) are parsed as integers; boolean fields (`unsubscribed`, `bounced`) accept `true`/`false` or `"TRUE"`/`"FALSE"`.

**Profile fields** (write to profile columns):

`firstName`, `lastName`, `company`, `title`, `campaignId`, `custom1`, `custom2`, `notes`, `companyUrl`

All profile values are written as strings. Pass `null` to clear a field.

**Request body:** Any mix of engine and profile fields.

**Response 200:** `{ "ok": true }`

---

### `POST /api/admin/contacts/:email/archive`

Soft-deletes a contact (sets a deleted flag in Sheets; does not remove the row). Returns **404** if not found.

**Response 200:** `{ "ok": true }`

---

## Company Intelligence Routes

### `GET /api/admin/company-intelligence`

Returns all rows from the `Company Intelligence` tab.

**Response 200:**
```json
{ "companyIntelligence": [ { "contactEmail": "...", "companyName": "...", ... } ] }
```

---

### `PATCH /api/admin/company-intelligence/:email`

Updates fields on an existing company intelligence row. Returns **404** if not found. Returns **400** if no valid fields are provided.

All values are written as strings (`null` clears to empty). The full list of updatable fields matches the `CompanyIntelUpdate` type in `src/services/sheets-types.ts`.

**Response 200:** `{ "ok": true }`

---

## Review Queue Routes

### `GET /api/admin/review-queue`

Returns review queue entries. Optionally filter by contact email.

**Query parameters:**

| Param | Notes |
|---|---|
| `email` | When set, returns only entries for that contact email (lowercased). |

**Response 200:**
```json
{ "reviewQueue": [ { "contactEmail": "...", "stepNumber": 1, "subject": "...", "status": "pending_review", ... } ] }
```

---

### `PATCH /api/admin/review-queue/:rowIndex`

Updates an existing review queue entry by its Sheets row index (integer, must be ≥ 2).

**Updatable fields:**

| Field | Notes |
|---|---|
| `status` | `pending_review`, `approved`, `superseded`, etc. |
| `reviewerNotes` | Operator notes |
| `approvedDate` | ISO timestamp |
| `campaignId` | Set by Approval Watcher; rarely set manually |

Returns **400** if `rowIndex` is invalid or if no valid fields are present.

**Response 200:** `{ "ok": true }`

---

## Action Routes

All action routes trigger a synchronous run of the named job and return when the run completes (or errors).

### `POST /api/admin/actions/send-cycle`

Manually triggers one send engine cycle (`executeSendCycle`).

Returns **409 Conflict** if a send cycle is already running (mutex held).

**Response 200:**
```json
{ "ok": true, "result": { "sent": 2, "failed": 0, "skipped": 8 } }
```

---

### `POST /api/admin/actions/pipeline-cycle`

Manually triggers one intelligence pipeline cycle (`runPipelineCycle`).

Runs Phase A (research/alignment) and Phase B (generation) for eligible contacts. Returns immediately if `PIPELINE_ENABLED=false` (no-op).

**Response 200:** `{ "ok": true }`

---

### `POST /api/admin/actions/approval-watcher`

Manually triggers one approval watcher cycle (`runApprovalWatcherCycle`).

Checks for fully approved 12-step sequences and creates campaigns.

**Response 200:** `{ "ok": true }`

---

### `POST /api/admin/actions/contacts/:email/research-again`

Resets a single contact's pipeline status back to `new` (triggering research from scratch) and immediately runs `runPipelineCycle`.

Returns **404** if the contact is not found. Returns **400** if the contact has no `company_url`.

**Response 200:** `{ "ok": true }`

---

### `POST /api/admin/actions/contacts/:email/regenerate-sequence`

Supersedes the existing unloaded review queue sequence for a contact and re-runs the pipeline from `alignment_complete` (email generation only — does not re-research).

Returns **404** if contact not found. Returns **409** if review queue rows already have a `campaign_id` assigned (already loaded into a campaign; regeneration would be unsafe).

**Response 200:**
```json
{ "ok": true, "supersededReviewRows": 12 }
```

---

## Admin SPA (`/admin`)

Served as static files from `dist/admin/` when `ADMIN_API_KEY` is set and `ADMIN_UI_ENABLED=true` (default).

- Built by `npm run build:admin` (Vite, outputs to `dist/admin/`).
- Base path: `/admin/`. Any sub-path under `/admin` falls back to `dist/admin/index.html` (SPA routing).
- `GET /` on the server root redirects `302` to `/admin/`.
- The SPA stores the API key in `localStorage` under `deaton_admin_api_key`. It attaches the key as `Authorization: Bearer <key>` on every API call.
- **Local SPA development**: run `npm run dev:local` (backend on port 3000) alongside `npm --prefix admin-ui run dev` (Vite dev server on port 5173, proxies `/api` to `localhost:3000`). There is no separate dev-only auth bypass; the backend enforces the key in all modes.

---

## Logging

Every admin request is logged via `adminLog` at `info` level:

```json
{
  "module": "admin-api",
  "method": "PATCH",
  "path": "/contacts/user@example.com",
  "action": "patch_contact",
  "email": "user@example.com",
  "engineKeys": ["status"],
  "profileKeys": ["firstName"]
}
```

Full request bodies are **not** logged. Only metadata (action type, email, field names, counts) is written to the log.

---

## Error Responses

| Code | Cause |
|---|---|
| 400 | Invalid input (bad rowIndex, empty rows array, no updatable fields) |
| 401 | Wrong or missing API key (when key is configured) |
| 404 | Contact or intel row not found |
| 409 | Conflict (send cycle already running, or review rows already have campaign_id) |
| 500 | Unexpected server error (details in response body and application log) |
| 503 | Admin API disabled (`ADMIN_API_KEY` not configured) |
