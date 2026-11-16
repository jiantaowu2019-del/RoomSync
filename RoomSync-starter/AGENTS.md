# RoomSync — instructions for Codex

## Authority and reading order
- Read docs/PRD.md, docs/DESIGN.md and docs/TEST_PLAN.md before touching code.
- docs/PRD.md is the authority for agreed business behavior; DESIGN is a proposed implementation; TEST_PLAN defines independently expected outcomes.
- Treat `Confirmed`, `Proposed`, and `Open` distinctly. Do not turn `Proposed` or `Open` items into silently invented product policy.
- If a requirement conflicts, identify the contradiction with exact file/section names and propose options before changing the business rule.

## Work method
- Implement ONE requested vertical slice at a time; avoid unrelated features and premature architecture.
- Before implementation, provide: smallest schema, API contract, state transition table, security assumptions, new/updated tests, and a list of explicit product decisions required.
- Await owner approval for real money movement, payment-related changes, permissions, dispute resolution rules, historical edits, and any change in product scope.
- Keep code reviewable: modest patches, clear file responsibilities, migrations, and direct explanations of key choices.

## Nonnegotiable safety/correctness rules
- Never store, access, or transfer live P2P funds or payment credentials. External payment links only unless separately authorized after provider/compliance review.
- Never interpret a payment-link click, page return, or payer's self-report as verified receipt.
- Only authenticated intended payees can confirm receipt; validate resource ownership on server for every state change.
- Use integer minor units for money. Do not double-count payments, even under concurrency/retries.
- Original expense and settlement events must not be silently overwritten/deleted. Audit financial changes.
- Separate group voting results from individual dissent; do not erase someone else's objection.
- Do not introduce automatic global freezes, debt shaming, moral ratings, or collection penalties.
- Protect sensitive member data and don't expose post-exit unrelated group content.
- Never substitute frontend-only validation for authorization or amount integrity.

## Testing and reporting
- Write regression tests for each new behavior, particularly unauthorized confirmation, repeated requests, partial payments, incorrect amounts, immutable history, and atomic balance update.
- Run relevant unit/integration tests and lint/type checks when available. Report exact commands and results; never claim unrun tests passed.
- After changes provide: summary, changed files, test results, remaining risks/open decisions, and a brief explanation of one core engineering tradeoff.
- Do not silently add dependencies or use production credentials; use environment variables and example settings.

## Review priorities
Prioritize money calculation errors, privilege escalation, false confirmation, data loss, duplicate updates, broken auditability, misleading settlement UI and unsafe external redirects over styling.

## Communication and Language

- All source code, identifiers, comments, API definitions, technical documentation, tests, and Git commit messages must be written in English.
- Communicate with the product owner in Simplified Chinese by default, while preserving standard English technical terminology.
- Do not translate established domain terms such as Expense, Payable Share, Settlement, Dispute, or Audit Log into code identifiers.
- When explaining technical decisions, use clear Chinese and include English terminology where it improves understanding.
- Prioritize correctness, explicit requirements, and consistency over the language used in conversational prompts.
