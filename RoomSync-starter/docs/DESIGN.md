# RoomSync — Slice 1 baseline, Slice 2A/2B and Slice 3A

Approved scope recorded in the owner’s Design Review. The PRD remains the product baseline.

The Slice 1 sections preserve the original baseline; the Slice 2B section below
supersedes its full-balance-only report restriction for all unsettled shares.

## Slice 1 workflow and storage

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

## Slice 2 first delivery

`groups` records the creator. `group_memberships` records one invitation or
active membership per group and account. Group creation adds the creator as an
active member in the same transaction. The creator invites existing accounts by
username. Only the invited account can activate its membership.

A new group expense has a group ID and a recorded remainder policy. It writes one
immutable `expense_allocations` row per participant, including the payer and
any zero-cent allocations. The server requires at least two distinct active
members and includes the authenticated payer. A strictly positive non-payer
allocation creates a Payable Share owed to the payer. The API returns the saved
allocations, shares, and derived balances. The client previews the same integer
division and remainder ordering before submitting. Only a nonzero remainder
shows policy controls. The default assigns the remainder to the payer.
Even distribution applies one cent to the payer and then to members in
ascending ID order until the remainder is exhausted.

Migration 002 backfills two allocation rows per Slice 1 expense from its
original recorded amount and Payable Share. Existing expenses have a null
group ID. Their identities, amounts, shares, reports, decisions, audit events
and idempotency records stay intact. The legacy list is scoped to the original
two participants. The existing payment routes handle legacy pending reports.

| Route | Slice 2 contract |
| --- | --- |
| GET /api/session | Resolve the signed-in viewer independently of any group. |
| GET/POST /api/groups | List the viewer's active groups and pending invitations, or create a group. |
| GET /api/groups/{id} | Read the group and its active member roster as an active member. |
| POST /api/groups/{id}/invitations | Invite an existing account by username as the creator. |
| POST /api/groups/{id}/join | Accept the invitation as its intended account. |
| GET/POST /api/groups/{id}/expenses | Read the group ledger or post an expense with participant IDs and a remainder policy. |
| GET /api/expenses | Show the viewer's legacy two-person expenses. |
| GET /api/expenses/{id} | Include allocations and the existing shares, reports, rejection reasons and activity for authorized viewers. |

Active group membership grants read access to the entire group ledger,
including previous group expenses and rejection reasons. Acceptance grants no
access to private two-person expenses. Pending invitees see their invitations.
The debtor can report only on their own obligation. The recipient can confirm or
reject only reports on shares payable to them. The group creator has the same
payment permissions as every other member. The rejection form says that group
members can read the reason. Share-level row locks and idempotency rules still
apply. Expense remains OPEN while any share has an outstanding balance.

## Page navigation

The home address `/` shows the group list, group creation, pending invitations,
and the Historical expenses link. Creating a group or accepting an invitation
opens `/groups/<groupId>`. That page owns the group title, invitations, expense
form, expense list, and details. Its Back to groups link opens the home page.
Historical expenses use `/history` and the existing private two-person APIs.

These are same-origin document links served by the FastAPI application shell.
Reloading or following a saved group address selects the group from the path.
Login retains that path. Browser back and forward use the browser's history.
Each page loads its own data. A group page reads and writes only its path's
group, and checks that a selected expense belongs to that ledger before display.
The server remains responsible for membership and payment authorization.
Unavailable group pages display a generic message and a link to the group list.
The shell contains no private group data.

After an authorized detail read, the ledger synchronizes the selected expense
ID to the query string with history.replaceState. The initial query is captured
once per document so this synchronization does not restart initial loading.
Selecting or creating an expense and then reloading stays on that exact ID,
including when several expenses have the same description. Replacing the
current history entry preserves Back to groups/browser-back behavior.

Home and ledger pages reuse the foreground refresh behavior, including the
12-second interval, focus and visibility changes, and page restoration. The
group form stays mounted during background refresh. Navigating to another
document creates fresh page state. Long group titles wrap above the shortcuts,
and mobile account controls use a separate row.

Partial payment can extend the existing share controls inside the group page.
Dispute views can likewise attach to a selected expense. A future reminder can
extend the group URL with an expense ID, validating both membership and the
expense's group before displaying it. Reminder delivery and consent remain in
Slice 4. Slice 5 must define and implement former-member historical access
before exit links are enabled. A saved URL alone never grants historical access.

## Slice 2B

The existing financial tables and share balance view support multiple receipts.
No historical rewrite or schema migration is needed. Report creation accepts
positive integer cents up to the current outstanding balance while holding the
share lock, and rejects a second pending report. Confirmation must equal the
report and must fit the current balance. Decisions, audit events and idempotency
results commit together using the existing routes.

Share responses add confirmed and pending totals. Settlement progress is
UNPAID, PARTIALLY_SETTLED or SETTLED. The existing PAYMENT_REPORTED status keeps
its pending meaning; the UI also shows partial progress when appropriate.
Only the debtor has a payment entry form and mock payment link. History shows
each report's amount, time, receipt amount or rejection reason.

Tab session storage scopes payment drafts to the account, expense and share.
It retains an operation key during an uncertain response, including reloads.
An unresolved submission is retried with that key before starting another
payment. Once the response is known to have succeeded, clear the operation so
a later intentional payment of the same amount gets a different key.

Opening a mock link records an immutable snapshot for that jump. A foreground
return reads the original expense before displaying a modal. Mark the jump as
prompted before showing it. The modal identifies the original expense and
recipient, preserves the selected amount, and offers Report or Later.
Pending, settled, unauthorized or excessive-amount drafts cannot create a new
report from the modal. A failed read leaves the jump available for retry.
The original ledger is addressed by /groups/<id>?expense=<id>, or by
/history?expense=<id> for private two-person expenses. The ledger validates the
expense's scope before display. No provider callback or link return attests
that money moved. Rejections explain that already-sent money need not be sent
again.

## Slice 3A: share disputes and responses

Migration 003 adds `disputes` and `dispute_responses`, preserving all earlier
financial facts and views. A unique share ID allows one thread per Payable Share.
The immutable opening records author, positive claimed cents, reason, timestamp
and the current outstanding balance under the Share lock. Responses are
immutable additions with an author and timestamp. Thread status is always OPEN
in 3A; no closure or disputed-coverage calculation is implemented.

The debtor opens a thread. Only that debtor and the designated recipient may
respond, including after financial settlement. Every write first checks Session,
Origin and expense visibility/role, then replays an existing idempotency result.
Only a new operation checks business state. A new opening uses
`ledger.locked_balance`, rejects a settled share or duplicate thread, and checks
the amount against the latest balance. A pending payment report does not stop
creation or reduce this balance. The statement, audit event and idempotency
response commit together. Unsupported edits, deletion and closure have no API.

| Route | Operation |
| --- | --- |
| POST /api/shares/{id}/disputes | Open as the debtor with amount_minor and reason. |
| POST /api/disputes/{id}/responses | Append a body as the debtor or recipient. |
| GET /api/expenses/{id} | Include each share's thread and ordered responses. |

Both POSTs require Idempotency-Key. Same-key retries return the original result;
conflicting reuse is 409. A different key cannot open a second thread. Each
intentional response gets a new key even if its text matches an earlier response.
Statement drafts and uncertain keys are scoped to the account and resource in
tab session storage. Confirmed success clears the draft before the next read;
uncertain results retain the exact operation for retry after reload. Background
refresh retains unsent statement text and amount.

All existing expense viewers can read the full thread and its related Activity.
The form warns that active group members can see the full text. Legacy two-person
expenses retain their original two-person visibility. Responses use separate
role checks; a group creator or an uninvolved observer cannot respond for others.
Text is rendered as plain text. Reason and response limits are 1-2000 trimmed
characters, with NUL rejected.

### Query walkthrough: separate financial aggregation from discussion

1. `http.get_expense` opens the existing REPEATABLE READ READ ONLY transaction.
2. `ledger.expense_detail` checks `expense_viewers`, reads `share_balances`, and
   derives confirmed totals and financial status exactly as before.
3. `disputes.attach_threads` batch-reads disputes for the authorized Share IDs,
   then responses for the resulting Dispute IDs. It uses `shares_by_id` and
   `threads_by_id` to attach data without changing financial fields. This is at
   most two extra queries regardless of the number of shares or responses.
4. `ShareView` and `DisputePanel` display the financial totals and opening claim
   separately. No discussion row participates in a payment SUM.

For one confirmed receipt of 1000 cents and two responses, a direct join of
payments -> payment_decisions -> disputes -> dispute_responses produces two
rows containing that same receipt. Summing after that join yields 2000 cents,
incorrectly showing only 1000 of an original 3000 cents remaining. The existing
balance view correctly returns 1000 confirmed and 2000 remaining; the separate
batch read attaches both responses without multiplying that receipt.
SUM(DISTINCT amount) is not a fix: two independent 1000-cent receipts must both
count. The API regression `test_two_responses_do_not_multiply_receipts_and_claim_never_changes`
and the browser walkthrough cover the correct result.

A $5 dispute submitted concurrently with an $18 confirmation against a $20
balance follows lock order. Opening first saves a $20 snapshot and a $5 claim;
the receipt then leaves $2. Receipt first leaves $2 and the new $5 claim is
rejected. Neither result overwrites an original claim. Financial settlement
does not close an existing thread.

Browser regression also covers a four-member expense paid by Sam: Alex owes
$25, claims $5, and Sam confirms $18 then $7. After the last receipt and a full
reload in both sessions, Alex's share is Settled while the expense stays Open
with Casey and Jordan each owing $25. The original thread and all responses
remain visible, and both parties can append responses. The test selects this
expense from another same-named expense first, guarding against stale URLs
making a different record appear after reload.

Later proposals and votes can reference the stable Dispute ID. Any authorized
adjustment needs a separate, audited financial record and future balance-view
design. Individual dissent must remain separate from a group decision. Reminder
pause granularity and consent remain Slice 4 work.

## Deferred

T10's full correction workflow, amendments, cancellation, confirmed payment
reversal, dispute proposals and closure, voting, reminder policies,
multi-expense balance aggregation, and additional split types remain outside
Slice 3A.
