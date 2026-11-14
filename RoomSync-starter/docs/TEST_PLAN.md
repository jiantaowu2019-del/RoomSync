# RoomSync — Acceptance and Test Plan

## Slice 1 acceptance

Use separate sessions for Alex and Sam and a mock external payment link. Alex
creates a $60 expense. Sam owes $30 to Alex. Only Alex's manual confirmation
reduces the outstanding balance.

| ID | Scenario | Expected outcome |
| --- | --- | --- |
| T01 | Create a $60 expense with two members | Sam owes exactly 3000 cents. Also verify an odd-cent split, a one-cent expense settled with no share, and rejection of zero, negative, and fractional cents. |
| T02 | Sam opens the configured mock link and returns | Balance and payment status are unchanged. Verify that only the debtor sees the outstanding share's link. |
| T03 | Sam reports $30 | Report becomes REPORTED and Sam still owes $30. Another full report is rejected while pending and after settlement. |
| T04 | Sam tries to confirm or reject the report | Both actions are forbidden. Expense and audit history are unchanged. |
| T05 | Alex confirms $30 | Outstanding balance is zero. Share and Expense are SETTLED. Receipt and audit history persist. |
| T06 | Replay a financial POST with the same key and request | Original response is returned. Conflicting key reuse returns 409. No duplicate expenses, reports, decisions, or audit events. |
| T07 | Submit concurrent reports or confirmations | Independent transactions serialize. With distinct keys only one report or decision is accepted. With the same key both successes represent one operation. |
| T08 | Enter an invalid amount | Reject zero, negative, fractional, oversized, partial, and mismatched amounts. Reject non-USD input. The ledger remains intact. |
| T09 | Read or write without permission | Test unauthenticated requests, outsider access, participant role mismatches, and cross-origin mutations. No financial data is exposed to outsiders or mutated. |
| T10 | Correct a previously recorded expense or settled payment | **Deferred.** The full correction workflow will preserve the original and append a linked record under a future owner-approved policy. Slice 1 tests that unsupported changes are rejected and existing facts persist. |
| T11 | Configure a malformed or untrusted link | Configuration fails, and the application does not redirect. Test both accepted mock URLs and rejected schemes, hosts, authorities, and paths. |
| T12 | Fail inside receipt confirmation | Receipt, audit event, and idempotency result roll back together. Retry succeeds after recovery. |
| T13 | Alex rejects a pending report with a reason | Rejection and reason are visible in history. Balance is unchanged, original report persists, Sam can re-report, and the rejected report cannot later be confirmed. |

The browser flow uses a mock destination, never a live payment provider. API
tests use PostgreSQL and isolate their data. Verify the build with the frontend
type check and run the browser test against the built page with both sessions.

## Future slice acceptance

- Partial payment, when added, can confirm $10 of $30 and leaves $20 outstanding.
- Any approved correction or reversal preserves originals and adds linked history.
- Dispute and voting preserve individual dissent, restrict sensitive reads, and
  apply approved eligibility, timing, and balance rules.
- Reminders require consent and avoid duplicate notices.
- Exit is immediate and protects relevant history without exposing unrelated
  future activity.

## Definition of Done

A working frontend, FastAPI API, PostgreSQL persistence, session authentication,
audit history, migration, local startup and example configuration. Run applicable
tests, report deferred scenarios, and keep design and acceptance docs current.
The live payment provider and final URL policy require owner confirmation before
any live links are configured.
