CREATE TABLE members (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username text NOT NULL UNIQUE,
    display_name text NOT NULL,
    password_hash text NOT NULL,
    demo_member boolean NOT NULL DEFAULT false
);

CREATE TABLE sessions (
    token_hash text PRIMARY KEY,
    member_id bigint NOT NULL REFERENCES members,
    expires_at timestamptz NOT NULL
);

CREATE TABLE expenses (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    original_payer_id bigint NOT NULL REFERENCES members,
    other_member_id bigint NOT NULL REFERENCES members,
    description text NOT NULL,
    total_minor bigint NOT NULL CHECK (total_minor > 0),
    currency char(3) NOT NULL CHECK (currency = 'USD'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (original_payer_id <> other_member_id)
);

CREATE TABLE payable_shares (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    expense_id bigint NOT NULL REFERENCES expenses,
    debtor_id bigint NOT NULL REFERENCES members,
    recipient_id bigint NOT NULL REFERENCES members,
    amount_minor bigint NOT NULL CHECK (amount_minor > 0),
    CHECK (debtor_id <> recipient_id)
);
CREATE INDEX payable_shares_expense_idx ON payable_shares (expense_id);

CREATE TABLE payments (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    share_id bigint NOT NULL REFERENCES payable_shares,
    reported_by bigint NOT NULL REFERENCES members,
    amount_minor bigint NOT NULL CHECK (amount_minor > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX payments_share_idx ON payments (share_id);

CREATE TABLE payment_decisions (
    payment_id bigint PRIMARY KEY REFERENCES payments,
    recipient_id bigint NOT NULL REFERENCES members,
    kind text NOT NULL,
    amount_minor bigint,
    reason text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (
        (kind = 'CONFIRMED' AND amount_minor IS NOT NULL AND amount_minor > 0 AND reason IS NULL)
        OR (kind = 'REJECTED' AND amount_minor IS NULL AND reason IS NOT NULL AND btrim(reason) <> '')
    )
);

CREATE TABLE audit_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    expense_id bigint NOT NULL REFERENCES expenses,
    actor_id bigint NOT NULL REFERENCES members,
    payment_id bigint REFERENCES payments,
    kind text NOT NULL,
    details jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX audit_events_expense_idx ON audit_events (expense_id, id);

CREATE TABLE idempotency_records (
    actor_id bigint NOT NULL REFERENCES members,
    request_key text NOT NULL,
    fingerprint text NOT NULL,
    response jsonb,
    PRIMARY KEY (actor_id, request_key)
);

CREATE VIEW share_balances AS
SELECT s.id,
       s.expense_id,
       s.debtor_id,
       s.recipient_id,
       s.amount_minor,
       s.amount_minor - COALESCE(sum(d.amount_minor) FILTER (WHERE d.kind = 'CONFIRMED'), 0)::bigint
           AS outstanding_minor,
       COALESCE(bool_or(d.payment_id IS NULL) FILTER (WHERE p.id IS NOT NULL), false)
           AS payment_pending
FROM payable_shares s
LEFT JOIN payments p ON p.share_id = s.id
LEFT JOIN payment_decisions d ON d.payment_id = p.id
GROUP BY s.id;

CREATE FUNCTION protect_financial_history() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Financial history is append-only' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER immutable_expenses BEFORE UPDATE OR DELETE OR TRUNCATE ON expenses
FOR EACH STATEMENT EXECUTE FUNCTION protect_financial_history();
CREATE TRIGGER immutable_shares BEFORE UPDATE OR DELETE OR TRUNCATE ON payable_shares
FOR EACH STATEMENT EXECUTE FUNCTION protect_financial_history();
CREATE TRIGGER immutable_payments BEFORE UPDATE OR DELETE OR TRUNCATE ON payments
FOR EACH STATEMENT EXECUTE FUNCTION protect_financial_history();
CREATE TRIGGER immutable_decisions BEFORE UPDATE OR DELETE OR TRUNCATE ON payment_decisions
FOR EACH STATEMENT EXECUTE FUNCTION protect_financial_history();
CREATE TRIGGER immutable_audit BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_events
FOR EACH STATEMENT EXECUTE FUNCTION protect_financial_history();
