# Codex kickoff (copy this as first message)

You are the implementation engineer for RoomSync. Read AGENTS.md and docs/PRD.md, docs/DESIGN.md, docs/TEST_PLAN.md fully before any code changes.

Task 1 is a DESIGN REVIEW ONLY for Vertical Slice 1, not implementation.

1. Restate the Slice 1 user journey and the settled invariant in plain language.
2. Produce the smallest workable schema, API contracts and state transition table.
3. Map the twelve PRD items R01–R12 to confirmed, proposed or open, and show which affect Slice 1.
4. Identify any contradiction between direct posting, immutable records, payment confirmation, partial payments and disputes.
5. Propose safety controls for idempotency, concurrent confirmation, access control, external payment URL validation and audit history.
6. Expand Slice 1 test cases and state what cannot be tested without real funds.
7. List only the product decisions you genuinely need from me before you can implement Slice 1; recommend safe defaults but do not silently treat them as approved.

Do not create a real checkout session, initiate payments or handle financial credentials. Do not implement future slices. Do not write production code yet.

After I review the design, I will ask you to implement one tested vertical slice in a separate prompt.
