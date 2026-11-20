# RoomSync — Acceptance and Test Plan

## Slice 1 acceptance

Use separate sessions for Alex and Sam and a mock external payment link. Alex
creates a $60 expense. Sam owes $30 to Alex. Only Alex's manual confirmation
reduces the outstanding balance.

| ID | Scenario | Expected outcome |
| --- | --- | --- |
| T01 | Create a $60 expense with two members | Sam owes exactly 3000 cents. Also verify an odd-cent split, a one-cent expense settled with no share, and rejection of zero, negative, and fractional cents. |
| T02 | Sam opens the configured mock link and returns | Balance and payment status are unchanged. Verify that only the debtor sees the outstanding share's link. |
| T03 | Sam reports $30 | Report becomes REPORTED and Sam still owes $30. The link is hidden while pending and after settlement. Another full report is rejected in both states. |
| T04 | Sam tries to confirm or reject the report | Both actions are forbidden. Expense and audit history are unchanged. |
| T05 | Alex confirms $30 | Outstanding balance is zero. Share and Expense are SETTLED. Receipt and audit history persist. |
| T06 | Replay a financial POST with the same key and request | Original response is returned. Conflicting key reuse returns 409. No duplicate expenses, reports, decisions, or audit events. A lost create response followed by a browser reload and retry produces one Expense. A later intentional entry can use the same values. |
| T07 | Submit concurrent reports or confirmations | Independent transactions serialize. With distinct keys only one report or decision is accepted. With the same key both successes represent one operation. |
| T08 | Enter an invalid amount | Reject zero, negative, fractional, oversized, and mismatched confirmation amounts. Reject non-USD input. Positive partial reports are valid in Slice 2B. The ledger remains intact. |
| T09 | Read or write without permission | Test unauthenticated requests, outsider access, participant role mismatches, and cross-origin mutations. No financial data is exposed to outsiders or mutated. |
| T10 | Correct a previously recorded expense or settled payment | **Deferred.** The full correction workflow will preserve the original and append a linked record under a future owner-approved policy. Slice 1 tests that unsupported changes are rejected and existing facts persist. |
| T11 | Configure a malformed or untrusted link | Startup rejects schemes, hosts, authorities, and paths outside the mock allowlist. Changing the configured host and link together cannot enable an unapproved host or an IP alias. |
| T12 | Fail inside receipt confirmation | Receipt, audit event, and idempotency result roll back together. Retry succeeds after recovery. |
| T13 | Alex rejects a pending report with a reason | Rejection and reason are visible in history. Balance is unchanged, the original report persists, the link returns, Sam can re-report, and the rejected report cannot later be confirmed. |
| T14 | Validate local startup configuration | Reject example or duplicated demo passwords, detect a seeded account mismatch without overwriting it, and reject invalid or noncanonical Origin values. Verify the default and overridden local PostgreSQL port. |
| T15 | Run Playwright with Windows process teardown | Run against a dedicated test database on a nondefault web port. Verify its generated schema is cleaned on success and failure. Reject the development database as a test target. |

The browser flow uses a mock destination, never a live payment provider. API
tests use PostgreSQL and isolate their data. Verify the build with the frontend
type check and run the browser test against the built page with both sessions.

## Slice 2 first delivery acceptance

| ID | Scenario | Expected outcome |
| --- | --- | --- |
| S2-01 | Four users join a group and split $120 | Each of three non-payers owes $30. Sam's report leaves $90 outstanding. His confirmation leaves $60, settles only his share, and leaves the expense OPEN. All three confirmed receipts yield $0 and SETTLED. |
| S2-02 | Select three of four members | The fourth member sees allocations, reports, rejection reason and activity with no obligation. A different member cannot report, confirm, or reject a share. Pending invitees and outsiders cannot access private lists or records. Accepting an invitation grants access to previous group expenses without changing allocations. |
| S2-03 | Select members manually and via Select all, then preview both remainder policies | The payer stays selected. Only active members are selectable. $120.03 uses $30.03/$30.00/$30.00/$30.00 or $30.01/$30.01/$30.01/$30.00. Saved allocations match preview. A one-cent total retains zero allocations and creates no payable shares. |
| S2-04 | Upgrade Slice 1 records in an isolated database | Compare IDs, share balances, open and settled states, reports, decisions, and activity before and after migration. Only the original two participants have access. A pre-upgrade pending report remains confirmable. |
| S2-05 | Retry and race full-share writes | Re-run Slice 1 duplicate, concurrency and rollback regressions. Also check that group creation and grouped expense retries reuse the same IDs and audit records. |
| S2-06 | Sam posts $101.01 in a group created by Alex | The form requires two people including the payer. With all four selected and Payer covers remainder, Sam pays $101.01 and is allocated $25.26. Each other member is allocated and owes $25.25. Display payer, total paid, per-person allocation, and $75.75 outstanding separately. With Sam and Casey selected, posting succeeds and Alex can read the result without an obligation. |
| S2-07 | Update two open sessions | The acting session updates after accepting an invitation, reporting a payment, or confirming it. Other sessions update when the page regains focus or on the visible page's 12-second poll. A hidden page skips polling until visible again. The selected expense and the unsaved description, amount, participant choices, and remainder policy survive a background update. |
| S2-08 | Use group shortcuts at 390 × 844 | The New expense and View expenses buttons are reachable near the group name. Each scrolls to and moves focus to the matching heading. Desktop group and settlement flows remain covered. |
| S2-09 | Open and reload group pages | From the home list, open sss at /groups/<id>, reload, and confirm its title and expenses. Back to groups and browser back return to the home list. Opening ss shows only ss data, and expense posts and invitations target ss. Repeat direct navigation and login at a saved address. |
| S2-10 | Open a group as an outsider or pending invitee | The app shell loads, the API denies access, and the page displays no private content with a Back to groups link. After acceptance, the member can read the group at the same address. API failures remain JSON responses. |
| S2-11 | Inspect a long group name on desktop and 390 × 844 | The name wraps without overlapping shortcuts, account controls or the return link. Both shortcuts scroll and focus the corresponding group section. The home page has no group expense or invitation form. |

Run the browser scenarios with four independent sessions and mock links.
Retain the historical expense payment regression and the foreground update
regression when changing navigation.

## Slice 2B acceptance

| ID | Scenario | Expected outcome |
| --- | --- | --- |
| B01 | A $30 share reports $10, confirms it, rejects a subsequent $5, then confirms the remaining $20 | The report leaves $30 outstanding, confirmation leaves $20, rejection preserves $20 and its reason, and the last receipt settles only this share. Other unpaid shares keep the expense OPEN. |
| B02 | A $10 report commits but its response is lost; reload and retry; after confirmation submit a new $10 | Retry returns the original report. Cover both the direct form and the return dialog. An uncertain dialog submission resumes its saved operation in the original expense. The later payment has a new ID and key. After both receipts the $30 share has $10 remaining. |
| B03 | Open a mock link for $10 and return | Read the original expense and show the matching amount and recipient once. Later preserves the draft and creates no report. Explicit reporting creates one pending record. Further focus changes do not re-open the same jump prompt. |
| B04 | The share changes before returning | Show the latest pending, settled, or smaller-balance state. Do not submit a conflicting report. Keep the original expense and share identity even when the user was viewing another expense. |
| B05 | Retry, race, validate and authorize partial payments | Cover concurrent reports, repeated confirmation, confirm-versus-reject, overpayment, zero, fractions, 1-cent payments, actor mismatches and transaction rollback. |
| B06 | Open legacy records | Existing pending full reports remain confirmable. Legacy unsettled shares accept partial reports. Original allocations, expense IDs and history persist. |

Re-run Slice 1 and Slice 2A suites, including navigation, amount allocation,
automatic refresh and draft preservation, using isolated databases and mock links.

## Future slice acceptance

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
