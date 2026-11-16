CREATE TABLE groups (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name text NOT NULL,
    creator_id bigint NOT NULL REFERENCES members
);

CREATE TABLE group_memberships (
    group_id bigint NOT NULL REFERENCES groups,
    member_id bigint NOT NULL REFERENCES members,
    status text NOT NULL CHECK (status IN ('invited', 'active')),
    PRIMARY KEY (group_id, member_id)
);
CREATE INDEX group_memberships_member_idx ON group_memberships (member_id, group_id);

ALTER TABLE expenses
    ALTER COLUMN other_member_id DROP NOT NULL,
    ADD COLUMN group_id bigint REFERENCES groups,
    ADD COLUMN remainder_policy text,
    ADD CONSTRAINT expense_scope_check CHECK (
        (group_id IS NULL AND other_member_id IS NOT NULL AND remainder_policy IS NULL)
        OR (group_id IS NOT NULL AND other_member_id IS NULL AND remainder_policy IS NOT NULL
            AND remainder_policy IN ('PAYER', 'EVEN'))
    );
CREATE INDEX expenses_group_idx ON expenses (group_id, id);

CREATE TABLE expense_allocations (
    expense_id bigint NOT NULL REFERENCES expenses,
    member_id bigint NOT NULL REFERENCES members,
    amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
    PRIMARY KEY (expense_id, member_id)
);

-- Read the original obligation, including the zero-share one-cent case.
INSERT INTO expense_allocations (expense_id, member_id, amount_minor)
SELECT e.id, participant.member_id, participant.amount_minor
FROM expenses e
LEFT JOIN payable_shares s ON s.expense_id = e.id
CROSS JOIN LATERAL (
    VALUES (e.original_payer_id, e.total_minor - COALESCE(s.amount_minor, 0)),
           (e.other_member_id, COALESCE(s.amount_minor, 0))
) AS participant(member_id, amount_minor);

CREATE TRIGGER immutable_allocations BEFORE UPDATE OR DELETE OR TRUNCATE ON expense_allocations
FOR EACH STATEMENT EXECUTE FUNCTION protect_financial_history();

CREATE VIEW expense_viewers AS
SELECT e.id AS expense_id, m.member_id
FROM expenses e JOIN group_memberships m ON m.group_id = e.group_id
WHERE m.status = 'active'
UNION ALL
SELECT e.id AS expense_id, a.member_id
FROM expenses e JOIN expense_allocations a ON a.expense_id = e.id
WHERE e.group_id IS NULL;
