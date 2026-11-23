CREATE TABLE disputes (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    share_id bigint NOT NULL UNIQUE REFERENCES payable_shares,
    opened_by bigint NOT NULL REFERENCES members,
    claimed_minor bigint NOT NULL CHECK (claimed_minor > 0),
    outstanding_at_open_minor bigint NOT NULL CHECK (outstanding_at_open_minor > 0),
    reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 2000),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (claimed_minor <= outstanding_at_open_minor)
);

CREATE TABLE dispute_responses (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    dispute_id bigint NOT NULL REFERENCES disputes,
    author_id bigint NOT NULL REFERENCES members,
    body text NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 2000),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX dispute_responses_thread_idx ON dispute_responses (dispute_id, id);

CREATE TRIGGER immutable_disputes BEFORE UPDATE OR DELETE OR TRUNCATE ON disputes
FOR EACH STATEMENT EXECUTE FUNCTION protect_financial_history();
CREATE TRIGGER immutable_dispute_responses BEFORE UPDATE OR DELETE OR TRUNCATE ON dispute_responses
FOR EACH STATEMENT EXECUTE FUNCTION protect_financial_history();
