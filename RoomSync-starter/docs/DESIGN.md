# RoomSync — Vertical Slice 1 design

Approved scope recorded in the owner’s Design Review. The PRD remains the product baseline.

## Workflow and storage

Two seeded users share a USD expense equally. The original payer creates it and
covers the extra cent if the total is odd. The other member owes floor(total / 2).
A one-cent expense is recorded as settled with no Payable Share. A zero or
negative expense is invalid. Amounts in the API and PostgreSQL are integer cents.

- **Expense** records the submitted total, description, original payer, and other
  participant. Both participants can read its history even when no share exists.
- **PayableShare** records a settlement obligation from debtor to recipient. It
  covers only an amount owed to another member. Future slices can model
  **Expense Allocation**, each participant’s portion of the original consumption,
  separately from **Settlement Obligation**, the amount owed between members.
- **Payment** records the debtor’s external payment report. A separate immutable
  decision records either receipt confirmation with an amount or rejection with
  a reason. A share can reference multiple reports over its lifetime. The schema
  permits multiple confirmed payments on a share for future partial payments.
- **AuditEvent** records actor, resource, action, timestamp, and relevant facts.
  The financial records and audit events are append-only in Slice 1.

| Record | State and transitions |
| --- | --- |
| Expense | OPEN while any valid Payable Share has a positive balance. SETTLED when none does, including a one-cent expense with no obligation. |
| PayableShare | UNPAID on creation, PAYMENT_REPORTED while a report is pending, UNPAID again after rejection, SETTLED after full confirmation. |
| Payment | REPORTED, then CONFIRMED or REJECTED by the designated recipient. Both outcomes are final for that report. |

Outstanding balance equals the share amount minus confirmed receipts. Link
visits, return navigation, reports, and rejections leave the balance as it was.
Rejection retains the original report and permits a new full-amount report.
Slice 1 accepts a report only for the entire positive outstanding balance and
permits at most one pending report per share. Confirmations must match the
reported amount and current full outstanding balance.

## API and access

The React and TypeScript page uses the same origin as the FastAPI JSON API.
PostgreSQL stores financial records, idempotency responses, and server-side
sessions. Passwords for demo users come from local configuration. Sessions use
opaque tokens in HttpOnly cookies. Mutating requests require the configured
canonical browser Origin. HTTPS deployments use Secure cookies. Setup requires
distinct demo passwords and rejects the example values. It detects existing
account mismatches without overwriting passwords. Login also rejects the
example values for any legacy seeded account.

| Route | Access and operation |
| --- | --- |
| POST /api/session | Log in as a seeded user. |
| GET /api/session | Get the viewer and the other seeded member. |
| DELETE /api/session | End the viewer's session. |
| GET /api/expenses | List the viewer's expenses. |
| POST /api/expenses | Create an equal split with the other seeded member. The viewer is the original payer. |
| GET /api/expenses/{id} | Read expense, share, payment history, and audit events as a participant. |
| POST /api/shares/{id}/payments | Report the full amount as the debtor. |
| POST /api/payments/{id}/confirm | Confirm receipt as the specified recipient. |
| POST /api/payments/{id}/reject | Reject a pending report as the specified recipient, with a nonblank reason. |

Authorization comes from the session and stored resource relationships. Private
resources return 404 to outsiders. A participant attempting the other role's
action receives 403. Invalid amounts receive 422 and state conflicts receive 409.
Update, delete, reversal, and cancellation operations are rejected by the API.

Every financial POST requires an Idempotency-Key. An actor's key identifies the
method's route, resource ID, and validated body. Identical retries return the
original status and body; reusing a key for a different operation returns 409.
Authorization is checked before replay. A share row lock serializes reports and
decisions, and a database unique constraint allows only one decision per report.
Financial facts, audit events, and the idempotency result commit together.
The expense form stores the unresolved request key in tab session storage,
scoped to the actor and a digest of the submitted body. Re-entering the same
values after a reload can safely recover a lost response. The key is cleared
after the page reflects a successful result, so identical later expenses can
be submitted as separate operations.

## Level 2 payment link

Each recipient has an optional configured external link. The application returns
it only to the debtor for an unpaid share without a pending report. Rejection
restores the link. The browser navigates directly to the configured URL.
The runtime allowlist currently accepts only the reserved mock host
`pay.example.test` and `/u/<handle>` over HTTPS. A live provider and its exact URL
rules require owner approval and an explicit allowlist entry. The supported URL
shape has no credentials, port, query, or fragment. RoomSync performs no network
request to the provider, stores no payment credentials, and has no payment
callback. A recipient manually attests to the amount received outside RoomSync.

## Local database and browser tests

Compose and the application share `ROOMSYNC_DB_PORT` and `ROOMSYNC_DB_PASSWORD`.
A complete `ROOMSYNC_DATABASE_URL` remains available for explicit overrides.
Tests require a separate database with a `_test` suffix. The browser test runner
owns the lifecycle of its random schema and supplies the server with the
isolated connection. Playwright passes its configured loopback port to the server.

## Deferred

T10's full correction workflow, amendments, cancellation, confirmed payment
reversal, partial payment UI and operations, disputes, voting, reminders, and
more complex expense allocation remain outside Slice 1.
