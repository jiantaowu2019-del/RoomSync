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
| R01 | Payment and settlement status | Track unpaid, payment-reported, recipient-confirmed separately; an external link click or payer claim does not itself settle anything. An expense is Settled only when all currently valid payable shares have zero remaining balance after confirmed payments and any explicitly authorized adjustments. Dispute history remains. | Confirmed core; adjustment semantics open | Slice 1 |
| R02 | Partial payments | Permit partial payments and show remaining amount. Never treat a partial amount as full settlement. | Proposed (user has not explicitly approved) | Slice 1 |
| R03 | Amount changes | Preserve original expense and each amendment; notify affected members of changes before paying where possible. Once settled or disputed, don't mutate existing financial facts in place; correction is a linked adjustment/version. | Confirmed principle; approval rules open | Slice 1 design, later refinement |
| R04 | Multiple payers and splits | Scope Slice 1 to one original payer, two known authenticated users, equal split; design room for multi-payer and complex splits later. | Proposed scope | Slice 1 / 2 |
| R05 | Identity and authorization | Only the actual authenticated recipient can attest receipt. No participant may impersonate the other or modify another user's payment status. | Confirmed principle; auth mechanism open | Slice 1 |
| R06 | External payment links | Use a prevalidated receiver-configured third-party payment link (for example PayPal.Me, subject to allowed use). Opening it is not verification. No card/bank credentials stored. No merchant checkout used for consumer P2P by assumption. | Confirmed Level 2; provider/format open | Slice 1 |
| R07 | Duplicate/cancel/reversal | Don't double-count retries, duplicate confirmations or concurrent clicks. Preserve history of correction/reversal; resolve cancellation/refund semantics before implementation. | Confirmed invariants; edge behavior open | Slice 1 |
| R08 | Acceptance criteria | End-to-end functioning frontend, API and persistent database, with tests covering calculations, authentication/authorization, status transitions and duplicate requests. No live transfer required for test. | Proposed acceptance bar | Slice 1 |
| R09 | Disputed balances | Retain group ledger outcome and person's continuing dissent as independent concepts. Disputed share is visible as disputed and not subject to automated collection. | Confirmed principle; exact display/open-balance math open | Slice 3 |
| R10 | Appeal/voting | Allow appeals, explanation/rebuttal, then a stakeholder vote if needed. A vote expresses group preference but doesn't erase dissent or independently prove debt. Specific electorate, >50% threshold, ties, abstentions, timing are **not settled**. | Partially confirmed; details open | Slice 3 |
| R11 | Reminders | User-selectable reminders and request for extension; earlier candidate: default three-day period, optional explanation for extensions beyond three days, enhanced reminders after seven days. Disputed portions get no automated collection reminders. Notification channels/rate caps and escalation are still open; **no debt-shaming or global group lock as default**. | Confirmed goal; exact mechanics open | Slice 4 |
| R12 | Exit/history | Immediate exit; notify affected members of relevant membership changes; preserve relevant old records and enable export, but disallow access to unrelated post-exit activity. No automatic transfer of the departing person's unpaid amounts. | Confirmed principle; privacy/retention specifics open | Slice 5 |

## 4. Slices, in proposed order
1. Minimal expense-to-external-payment-to-confirmed-settlement flow: two authenticated test users, one original payer, equal split, persisted state and audit history.
2. Real groups and multiparty splitting, then partial/multi-expense balances.
3. Appeal, structured dialogue, group vote and permanent dissent record.
4. Optional reminders, extension requests and notification limits.
5. Exit, historical access and export.

These are incremental releases of an integrated product, not permission to defer foundational protections needed in Slice 1.

## 5. Explicitly excluded from initial release
- Holding, routing, initiating, or verifying real P2P money movement from private accounts.
- Reading private WhatsApp groups or phone contacts automatically; a normal share link is enough initially.
- Automatically adjudicating claims, scoring morality, publishing shaming messages, compulsory repayment or transferring an ex-member's obligation to others.
- AI agents, complex credit limits and group-wide locking by default.

## 6. Things requiring an explicit product decision before associated coding
- Whether a mutually approved waiver/adjustment may make a share settled without full cash payment, and how it is presented.
- Who may correct settled or disputed expense and what acknowledgment is required.
- Payment reversal, mistaken confirmation, partial-payment behavior, multi-payment allocation.
- First payment-link provider and exact validation/locale/currency behavior.
- Stakeholder vote eligibility, vote threshold, ties, abstentions, voting timeframe, effect on balances.
- Reminder delivery/consent, spam prevention, dispute privacy, retention and export.

## 7. Nonfunctional requirements
- Amounts represented in integer cents; preserve exact sums with deterministic remainder allocation.
- All money-state transitions server-side, authorized and atomic; append immutable audit events.
- Nonparticipants cannot read private group records. Access after exit limited to relevant history.
- No unbounded automated reminders; no unilateral changes to another person's claimed settlement status.
- Testable with synthetic data and mock payment links; initial version does not require live funds.
