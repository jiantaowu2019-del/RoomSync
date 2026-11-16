# RoomSync — Product Requirements (working draft v0.1)

Status: Product baseline for technical design, **not** authorization to ship real payments.
Owner: Product owner (user). Updated: 2026-11-13.

## 1. Purpose and boundaries
RoomSync is a small-group shared-expense ledger and communication tool. It helps friends/roommates record expenses, calculate shares, discuss and vote on disputes, track voluntary settlement, and preserve trustworthy **operation history**. It aims to reduce awkwardness around asking for repayment. It does NOT adjudicate the truth of user claims, enforce debt collection, hold or transfer funds, or manage anyone's financial obligations. An unmodified record proves what was submitted to the service, **not** that an underlying real-world payment happened.

## 2. Product principles (agreed)
- Authorized participants may post expenses immediately, without every other person approving the post first.
- Affected people can contest an expense. Their dissent and the group's decision can coexist, with full relevant history preserved; group votes reflect group preference, not a judicial finding or personal admission of debt.
- Disputed shares do not receive automated collection reminders or penalties while their dissent remains unresolved.
- Users can exit immediately even with outstanding/disputed amounts. Exit doesn't erase historical participation, force debt reassignment or grant access to unrelated future group activity.
- Append corrections rather than silently overwriting original expense, dispute, vote or settlement history. Apply least-privilege access to sensitive information.
- External payment handoff only for the first production version (Level 2): RoomSync does not handle funds; opening or returning from a third-party link **never** proves payment.
- Users, not the platform, resolve real-world disagreement and choose whether to cooperate again.

## 3. Twelve tracked decisions (the source-of-truth checklist)
Each row is a requirement topic. 'Confirmed' means we discussed and chose the rule; 'Proposed' needs product-owner acceptance before implementation; 'Open' means do not invent an answer.

| ID | Topic | Decision / boundary | Status | Target |
|---|---|---|---|---|
| R01 | Payment and settlement status | Each payable share has its own outstanding balance and settlement status. Track unpaid, payment-reported, and recipient-confirmed payments separately; an external payment-link click or payer claim does not itself settle a share. A payable share is Settled only when its remaining balance reaches zero through confirmed payments and explicitly authorized adjustments. An Expense is Settled only when every currently valid payable share is Settled. Settlement does not erase dispute or payment history. | Confirmed core; adjustment semantics open | Slice 1 |
| R02 | Partial payments | The data model must support multiple payment records associated with a single payable share. Each confirmed payment reduces the share's remaining balance by the confirmed amount. Partial payments must never automatically mark a share as fully Settled. Slice 1 implements full-payment settlement only; partial-payment user interactions and related workflows are deferred to Slice 2. The initial data model must not assume a one-to-one relationship between payable shares and payments. | Confirmed design direction; partial-payment workflow deferred | Slice 1 data model / Slice 2 implementation |
| R03 | Amount changes | Preserve original expense and each amendment; notify affected members of changes before paying where possible. Once settled or disputed, don't mutate existing financial facts in place; correction is a linked adjustment/version. | Confirmed principle; approval rules open | Slice 1 design, later refinement |
| R04 | Multiple payers and splits | Slice 1 uses one payer and a two-person equal split. The first Slice 2 delivery supports one payer, group expenses, selected participants, and two equal-split remainder policies. Multiple original payers and additional split types remain open. | Confirmed through Slice 2 first delivery | Slice 1 / 2 |
| R05 | Identity and authorization | Only the actual authenticated recipient can attest receipt. No participant may impersonate the other or modify another user's payment status. | Confirmed principle; auth mechanism open | Slice 1 |
| R06 | External payment links | Use a prevalidated receiver-configured third-party payment link (for example PayPal.Me, subject to allowed use). Opening it is not verification. No card/bank credentials stored. No merchant checkout used for consumer P2P by assumption. | Confirmed Level 2; provider/format open | Slice 1 |
| R07 | Duplicate/cancel/reversal | Don't double-count retries, duplicate confirmations or concurrent clicks. Preserve history of correction/reversal; resolve cancellation/refund semantics before implementation. | Confirmed invariants; edge behavior open | Slice 1 |
| R08 | Acceptance criteria | End-to-end functioning frontend, API and persistent database, with tests covering calculations, authentication/authorization, status transitions and duplicate requests. No live transfer required for test. | Proposed acceptance bar | Slice 1 |
| R09 | Disputed balances | Filing a dispute does not automatically change the recorded outstanding balance. Disputed and undisputed amounts must remain distinguishable. Automatic collection reminders for disputed shares are suspended while individual dissent remains unresolved. Participants may discuss and propose a specific adjustment. If approved through the group's agreed voting procedure, the adjustment changes the current effective payable amount through an auditable adjustment record. If rejected, the effective amount remains unchanged. Original amounts, statements, voting outcomes, and continuing individual dissent must be preserved. A group decision does not imply personal admission of debt. | Confirmed core; voting procedures and adjustment authorization details open | Slice 3 |
| R10 | Appeal/voting | Allow appeals, explanation/rebuttal, then a stakeholder vote if needed. A vote expresses group preference but doesn't erase dissent or independently prove debt. Specific electorate, >50% threshold, ties, abstentions, timing are **not settled**. | Partially confirmed; details open | Slice 3 |
| R11 | Reminders | User-selectable reminders and request for extension; earlier candidate: default three-day period, optional explanation for extensions beyond three days, enhanced reminders after seven days. Disputed portions get no automated collection reminders. Notification channels/rate caps and escalation are still open; **no debt-shaming or global group lock as default**. | Confirmed goal; exact mechanics open | Slice 4 |
| R12 | Exit/history | Immediate exit; notify affected members of relevant membership changes; preserve relevant old records and enable export, but disallow access to unrelated post-exit activity. No automatic transfer of the departing person's unpaid amounts. | Confirmed principle; privacy/retention specifics open | Slice 5 |

## 4. Slices, in proposed order
1. Minimal expense-to-external-payment-to-confirmed-settlement flow: two authenticated test users, one original payer, equal split, persisted state and audit history.
2. Real groups and multiparty splitting, partial-payment workflows, and multi-expense balance management.
3. Appeal, structured dialogue, group vote and permanent dissent record.
4. Optional reminders, extension requests and notification limits.
5. Exit, historical access and export.

### Slice 2 first delivery (approved)

- Any signed-in user can create a group. Only the creator invites existing accounts by username. Invitees become active members after accepting.
- An active member can post an expense as its sole original payer. The payer is selected by default and always participates. The payer can select active members individually or select all and deselect individual members. At least two people are required. The form previews the participant count and each allocation before posting. Posting fixes the participant list and allocations.
- Active members can read all expenses in their group, including those posted before they joined. They can see allocations, balances, settlement status, payment reports, rejection reasons, and activity. Pending invitees and outsiders have no group ledger access. Existing two-person expenses remain private to their original participants.
- Only the debtor reports a payment for a Payable Share. Only its designated recipient confirms or rejects it. Rejecting a report requires a reason visible to the group. Only the debtor gets the mock payment link. Reports cover the full outstanding share balance in this delivery.
- When an equal split leaves a remainder, the payer selects a policy. The default assigns all leftover cents to the original payer. The even distribution policy assigns at most one extra cent per person, starting with the original payer and then by ascending member ID. The server calculates and saves the policy and allocations. Zero-cent allocations create no Payable Share.
- The next Slice 2 delivery covers partial payments. Multi-expense balance aggregation is scheduled separately.

These are incremental releases of an integrated product, not permission to defer foundational protections needed in Slice 1.

## 5. Explicitly excluded from initial release
- Holding, routing, initiating, or verifying real P2P money movement from private accounts.
- Reading private WhatsApp groups or phone contacts automatically; a normal share link is enough initially.
- Automatically adjudicating claims, scoring morality, publishing shaming messages, compulsory repayment or transferring an ex-member's obligation to others.
- AI agents, complex credit limits and group-wide locking by default.

## 6. Things requiring an explicit product decision before associated coding
- Whether a mutually approved waiver/adjustment may make a share settled without full cash payment, and how it is presented.
- Who may correct settled or disputed expense and what acknowledgment is required.
- Payment reversal, mistaken confirmation, partial-payment workflow details, and allocation of payments across multiple payable shares or expenses.
- First payment-link provider and exact validation/locale/currency behavior.
- Stakeholder vote eligibility, vote threshold, ties, abstentions, voting timeframe, effect on balances.
- Reminder delivery/consent, spam prevention, dispute privacy, retention and export.

## 7. Nonfunctional requirements
- Amounts represented in integer cents; preserve exact sums with deterministic remainder allocation.
- All money-state transitions server-side, authorized and atomic; append immutable audit events.
- Private group records require active group membership in the first Slice 2 delivery. Legacy two-person expenses require original participation. Access after exit is limited to relevant history.
- No unbounded automated reminders; no unilateral changes to another person's claimed settlement status.
- Testable with synthetic data and mock payment links; initial version does not require live funds.
