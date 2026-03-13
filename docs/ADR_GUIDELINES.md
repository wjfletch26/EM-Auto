# Architecture Decision Records (ADR) — Deaton Outreach Automation

## What Are ADRs?

Architecture Decision Records document significant technical decisions made during the project. Each ADR captures the context, decision, and consequences so future developers understand WHY a choice was made, not just what was built.

## When to Write an ADR

Write an ADR when:
- Choosing between two or more viable alternatives (e.g., "IMAP vs EWS for inbox reading").
- Making a decision that is hard to reverse later (e.g., "Google Sheets as the data store").
- Deviating from a common pattern or convention (e.g., "No database at MVP").
- A team member asks "why did we do it this way?"

Do NOT write an ADR for:
- Trivial decisions (variable naming, formatting).
- Decisions already covered by the existing architecture docs.

## ADR Template

```markdown
# ADR-NNN: Title of the Decision

## Status

[PROPOSED | ACCEPTED | DEPRECATED | SUPERSEDED by ADR-NNN]

## Date

YYYY-MM-DD

## Context

What is the issue? Why does a decision need to be made? What constraints apply?

## Decision

What was decided? State it clearly in one or two sentences.

## Alternatives Considered

### Alternative A: [Name]
- Pros: ...
- Cons: ...

### Alternative B: [Name]
- Pros: ...
- Cons: ...

## Consequences

What are the positive and negative outcomes of this decision?
What changes need to be made as a result?

## References

Links to relevant docs, issues, or external resources.
```

## ADR File Naming

ADRs are stored in the `docs/adr/` directory:

```
docs/adr/
├── ADR-001-google-sheets-as-data-store.md
├── ADR-002-node-typescript-stack.md
├── ADR-003-tiered-reply-processing.md
└── ...
```

## ADR Index

Maintain this list as new ADRs are created:

| # | Title | Status | Date |
|---|---|---|---|
| ADR-001 | Google Sheets as the primary data store | ACCEPTED | 2026-03-12 |
| ADR-002 | Node.js + TypeScript as the implementation stack | ACCEPTED | 2026-03-12 |
| ADR-003 | Tiered reply processing (IMAP → EWS → Manual) | ACCEPTED | 2026-03-12 |
| ADR-004 | HMAC-signed stateless unsubscribe tokens | ACCEPTED | 2026-03-12 |
| ADR-005 | Pino for structured logging | ACCEPTED | 2026-03-12 |
| ADR-006 | PM2 for process management | ACCEPTED | 2026-03-12 |
| ADR-007 | Caddy for reverse proxy with automatic TLS | ACCEPTED | 2026-03-12 |

---

## Pre-Populated ADRs

### ADR-001: Google Sheets as the Primary Data Store

**Status**: ACCEPTED
**Date**: 2026-03-12

**Context**: The system needs a data store for contacts, campaigns, and send logs. The operator wants a simple, free, accessible solution that doesn't require managing a database.

**Decision**: Use Google Sheets as the primary data store, accessed via the Sheets API v4 with a service account.

**Alternatives Considered**:
- **SQLite**: Simpler queries, but not accessible to the operator for manual edits without tooling.
- **PostgreSQL**: Production-grade, but overkill for <50 emails/day and adds operational complexity.
- **Airtable**: Better API, but free tier has limits and adds a dependency.

**Consequences**:
- (+) Free, no hosting costs.
- (+) Operator can view and edit data directly in a familiar interface.
- (+) Version history built in (Google Sheets revision history).
- (-) API rate limits (300 req/min) — acceptable at MVP volume.
- (-) No relational integrity — the application must enforce constraints.
- (-) Concurrent edits by operator and system could cause conflicts — mitigated by cell-level updates.

### ADR-003: Tiered Reply Processing

**Status**: ACCEPTED
**Date**: 2026-03-12

**Context**: The system needs to read inbound replies to classify them. The sending mailbox is Microsoft 365 via GoDaddy. The operator has login credentials but no admin access. Microsoft has been deprecating IMAP basic auth. The forwarding-destination mailbox (`dknieriem@deatonengineering.com`) is for human review only — no credentials available.

**Decision**: Implement a tiered fallback for reply processing:
1. Tier 1: IMAP on the sending mailbox (test in Phase 0).
2. Tier 2: EWS on the sending mailbox (test if Tier 1 fails).
3. Tier 3: Manual reply processing by the human operator (fallback if both fail).

**Consequences**:
- (+) The system is functional at every tier — no hard dependency on IMAP.
- (+) The MVP is fully viable even at Tier 3.
- (-) Tier 3 requires manual human effort for reply classification.
- (-) Architecture must support both automated and manual reply workflows.
