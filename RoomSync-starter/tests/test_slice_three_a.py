from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier, Event, local
from uuid import uuid4

import psycopg2
import pytest
from fastapi.testclient import TestClient

from roomsync import disputes, ledger
from roomsync.auth import COOKIE
from roomsync.db import connect, migrate
from roomsync.http import create_app
from roomsync.setup import seed_member
from tests.support import PASSWORDS, mock_settings, temporary_schema
from tests.test_slice_one import ORIGIN, detail, write
from tests.test_slice_two import accounts, settings, confirm, group, ids, publish, report, users


def expense_fixture(accounts):
    group_id = group(accounts, "Dispute walkthrough", ("sam", "casey"))
    members = ids(accounts)
    created = publish(accounts["alex"], group_id, [members["alex"], members["sam"]], total=6000)
    assert created.status_code == 201
    expense_id = created.json()["id"]
    return group_id, expense_id, detail(accounts["sam"], expense_id)["shares"][0]["id"]


def receipt(accounts, share_id, amount):
    payment = report(accounts["sam"], share_id, amount)
    assert payment.status_code == 201
    assert confirm(accounts["alex"], payment.json()["id"], amount).status_code == 200


def open_thread(client, share_id, amount=500, *, key=None):
    return write(client, f"/api/shares/{share_id}/disputes", {
        "amount_minor": amount, "reason": "Please explain this portion of the expense.",
    }, key=key)


def respond(client, dispute_id, body="Here is the explanation.", *, key=None):
    return write(client, f"/api/disputes/{dispute_id}/responses", {"body": body}, key=key)


def test_two_responses_do_not_multiply_receipts_and_claim_never_changes(accounts):
    _, expense_id, share_id = expense_fixture(accounts)
    alex, sam = accounts["alex"], accounts["sam"]
    receipt(accounts, share_id, 1000)
    key = uuid4().hex
    opened = open_thread(sam, share_id, key=key)
    assert opened.status_code == 201
    dispute_id = opened.json()["id"]
    for text in ("First explanation", "Second explanation"):
        assert respond(alex, dispute_id, text).status_code == 201

    expense = detail(sam, expense_id)
    share = expense["shares"][0]
    thread = share["dispute"]
    # One receipt and two responses must still count the receipt exactly once.
    assert (share["amount_minor"], share["confirmed_minor"], share["outstanding_minor"]) == (3000, 1000, 2000)
    assert share["status"] == "PARTIALLY_SETTLED" and expense["status"] == "OPEN"
    assert len(share["payments"]) == 1
    assert [response["body"] for response in thread["responses"]] == ["First explanation", "Second explanation"]
    assert (thread["claimed_minor"], thread["outstanding_at_open_minor"], thread["status"]) == (500, 2000, "OPEN")

    receipt(accounts, share_id, 1800)
    later = detail(sam, expense_id)["shares"][0]
    assert (later["confirmed_minor"], later["outstanding_minor"]) == (2800, 200)
    assert later["dispute"] == thread
    assert "active_disputed_minor" not in later and "covered_minor" not in thread
    receipt(accounts, share_id, 200)
    settled = detail(sam, expense_id)
    assert settled["status"] == settled["shares"][0]["status"] == "SETTLED"
    assert settled["shares"][0]["dispute"]["status"] == "OPEN"
    assert respond(sam, dispute_id, "My original statement remains on record.").status_code == 201
    assert open_thread(sam, share_id, key=key).json() == opened.json()
    assert open_thread(sam, share_id, 1).status_code == 409


def test_visibility_roles_origin_and_authorization_before_replay(accounts, settings):
    group_id, expense_id, share_id = expense_fixture(accounts)
    alex, sam, casey, jordan = (accounts[name] for name in PASSWORDS)
    for client in (alex, casey):
        assert open_thread(client, share_id).status_code == 403
    assert open_thread(jordan, share_id).status_code == 404
    open_key, reply_key = uuid4().hex, uuid4().hex
    opened = open_thread(sam, share_id, key=open_key)
    dispute_id = opened.json()["id"]
    reply = respond(sam, dispute_id, key=reply_key)
    assert reply.status_code == 201
    observer = detail(casey, expense_id)
    assert observer["shares"][0]["dispute"]["responses"][0]["body"] == "Here is the explanation."
    assert any(event["kind"] == "DISPUTE_RESPONSE_ADDED" for event in observer["audit"])
    assert respond(casey, dispute_id).status_code == 403
    assert respond(jordan, dispute_id).status_code == 404
    assert jordan.get(f"/api/expenses/{expense_id}").status_code == 404
    assert alex.post(f"/api/groups/{group_id}/invitations", json={"username": "jordan"}, headers={"Origin": ORIGIN}).status_code == 204
    assert jordan.get(f"/api/expenses/{expense_id}").status_code == 404
    assert respond(jordan, dispute_id).status_code == 404
    assert jordan.post(f"/api/groups/{group_id}/join", headers={"Origin": ORIGIN}).status_code == 204
    assert detail(jordan, expense_id)["shares"][0]["dispute"]["id"] == dispute_id
    assert respond(jordan, dispute_id).status_code == 403
    assert sam.post(f"/api/disputes/{dispute_id}/responses", json={"body": "No origin"},
                    headers={"Idempotency-Key": uuid4().hex}).status_code == 403
    with TestClient(create_app(settings), base_url=ORIGIN) as anonymous:
        assert respond(anonymous, dispute_id).status_code == 401
        assert open_thread(anonymous, share_id).status_code == 401
        assert anonymous.get(f"/api/expenses/{expense_id}").status_code == 401

    # Simulate loss of membership in this isolated schema, not a new exit feature.
    with connect(settings.database_url) as db, db.cursor() as cur:
        cur.execute("UPDATE group_memberships SET status = 'invited' WHERE group_id = %s AND member_id = %s",
                    (group_id, ids(accounts)["sam"]))
    assert open_thread(sam, share_id, key=open_key).status_code == 404
    assert respond(sam, dispute_id, key=reply_key).status_code == 404


def test_validation_pending_reports_and_settled_shares(accounts):
    _, expense_id, share_id = expense_fixture(accounts)
    sam, alex = accounts["sam"], accounts["alex"]
    before = detail(sam, expense_id)
    for value in (0, -1, 3001, 0.5, True, "500"):
        assert open_thread(sam, share_id, value).status_code == 422
    for reason in (" ", "\x00", "x" * 2001):
        assert write(sam, f"/api/shares/{share_id}/disputes", {"amount_minor": 500, "reason": reason}).status_code == 422
    assert write(sam, f"/api/shares/{share_id}/disputes", {
        "amount_minor": 500, "reason": "Valid", "opened_by": ids(accounts)["alex"],
    }).status_code == 422
    assert detail(sam, expense_id) == before
    pending = report(sam, share_id, 1000).json()["id"]
    thread = open_thread(sam, share_id, 1)
    assert thread.status_code == 201
    pending_share = detail(sam, expense_id)["shares"][0]
    assert pending_share["outstanding_minor"] == 3000 and pending_share["payment_pending"]
    dispute_id = thread.json()["id"]
    for body in (" ", "\x00", "x" * 2001):
        assert respond(alex, dispute_id, body).status_code == 422
    assert confirm(alex, pending, 1000).status_code == 200
    receipt(accounts, share_id, 2000)
    assert respond(alex, dispute_id).status_code == 201
    _, settled_id, settled_share = expense_fixture(accounts)
    receipt(accounts, settled_share, 3000)
    assert open_thread(sam, settled_share, 1).status_code == 409
    assert detail(sam, settled_id)["shares"][0]["dispute"] is None


def test_idempotency_for_threads_and_independent_responses(accounts):
    _, expense_id, share_id = expense_fixture(accounts)
    sam, alex = accounts["sam"], accounts["alex"]
    key = uuid4().hex
    first = open_thread(sam, share_id, key=key)
    assert first.status_code == 201
    assert open_thread(sam, share_id, key=key).json() == first.json()
    assert open_thread(sam, share_id, 600, key=key).status_code == 409
    assert open_thread(sam, share_id).status_code == 409
    dispute_id = first.json()["id"]
    response_key = uuid4().hex
    reply = respond(alex, dispute_id, key=response_key)
    assert respond(alex, dispute_id, key=response_key).json() == reply.json()
    assert respond(alex, dispute_id, "Changed text", key=response_key).status_code == 409
    later = respond(alex, dispute_id)
    assert later.status_code == 201 and later.json()["id"] != reply.json()["id"]
    expense = detail(sam, expense_id)
    assert len(expense["shares"][0]["dispute"]["responses"]) == 2
    assert [event["kind"] for event in expense["audit"]].count("DISPUTE_OPENED") == 1
    assert [event["kind"] for event in expense["audit"]].count("DISPUTE_RESPONSE_ADDED") == 2


@pytest.mark.parametrize("kind", ["open", "response"])
def test_statement_audit_and_idempotency_roll_back_together(accounts, settings, monkeypatch, kind):
    _, expense_id, share_id = expense_fixture(accounts)
    key = uuid4().hex
    if kind == "response":
        dispute_id = open_thread(accounts["sam"], share_id).json()["id"]
    before = detail(accounts["sam"], expense_id)
    original_audit = ledger.audit

    def fail(*args, **kwargs):
        original_audit(*args, **kwargs)
        raise RuntimeError("Injected statement failure")

    def request():
        return open_thread(accounts["sam"], share_id, key=key) if kind == "open" else respond(accounts["alex"], dispute_id, key=key)

    with monkeypatch.context() as failure:
        failure.setattr(ledger, "audit", fail)
        with pytest.raises(RuntimeError, match="Injected statement failure"):
            request()
    assert detail(accounts["sam"], expense_id) == before
    with connect(settings.database_url) as db, db.cursor() as cur:
        cur.execute("SELECT 1 FROM idempotency_records WHERE request_key = %s", (key,))
        assert cur.fetchone() is None
    assert request().status_code == 201


@pytest.mark.parametrize("first_kind", ["dispute", "receipt"])
def test_dispute_and_receipt_observe_both_share_lock_orders(accounts, settings, monkeypatch, first_kind):
    _, expense_id, share_id = expense_fixture(accounts)
    receipt(accounts, share_id, 1000)
    payment_id = report(accounts["sam"], share_id, 1800).json()["id"]
    first_locked, second_attempted, release = Event(), Event(), Event()
    context = local()
    original_lock = ledger.locked_balance
    original_open = disputes.create_dispute
    original_decide = ledger.decide_payment

    # FastAPI executes sync handlers in its own worker threads. Mark the
    # operation there, rather than in the test client's calling thread.
    def marked_open(*args):
        context.position = "first" if first_kind == "dispute" else "second"
        return original_open(*args)

    def marked_decide(*args, **kwargs):
        context.position = "first" if first_kind == "receipt" else "second"
        return original_decide(*args, **kwargs)

    def gated_lock(cur, target_id):
        if context.position == "second":
            second_attempted.set()
        balance = original_lock(cur, target_id)
        if context.position == "first":
            first_locked.set()
            assert release.wait(10), "The test did not release the first Share lock"
        return balance

    monkeypatch.setattr(ledger, "locked_balance", gated_lock)
    monkeypatch.setattr(disputes, "create_dispute", marked_open)
    monkeypatch.setattr(ledger, "decide_payment", marked_decide)
    app = create_app(settings)

    def run(kind):
        username = "sam" if kind == "dispute" else "alex"
        with TestClient(app, base_url=ORIGIN, cookies={COOKIE: accounts[username].cookies[COOKIE]}) as client:
            return open_thread(client, share_id) if kind == "dispute" else confirm(client, payment_id, 1800)

    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(run, first_kind)
        try:
            assert first_locked.wait(10)
            second = pool.submit(run, "receipt" if first_kind == "dispute" else "dispute")
            assert second_attempted.wait(10)
        finally:
            release.set()
        results = {first_kind: first.result(timeout=15),
                   ("receipt" if first_kind == "dispute" else "dispute"): second.result(timeout=15)}
    assert results["receipt"].status_code == 200
    assert results["dispute"].status_code == (201 if first_kind == "dispute" else 422)
    share = detail(accounts["sam"], expense_id)["shares"][0]
    assert (share["confirmed_minor"], share["outstanding_minor"]) == (2800, 200)
    if first_kind == "dispute":
        assert (share["dispute"]["claimed_minor"], share["dispute"]["outstanding_at_open_minor"]) == (500, 2000)
    else:
        assert share["dispute"] is None


@pytest.mark.parametrize("operation", ["open", "response"])
def test_concurrent_duplicate_threads_and_same_key_responses(accounts, settings, operation):
    _, expense_id, share_id = expense_fixture(accounts)
    if operation == "response":
        dispute_id = open_thread(accounts["sam"], share_id).json()["id"]
    barrier = Barrier(2)
    key = uuid4().hex
    app = create_app(settings)

    def send(_):
        username = "sam" if operation == "open" else "alex"
        with TestClient(app, base_url=ORIGIN, cookies={COOKIE: accounts[username].cookies[COOKIE]}) as client:
            barrier.wait(timeout=10)
            return open_thread(client, share_id) if operation == "open" else respond(client, dispute_id, key=key)

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(send, range(2)))
    assert sorted(result.status_code for result in results) == ([201, 409] if operation == "open" else [201, 201])
    thread = detail(accounts["sam"], expense_id)["shares"][0]["dispute"]
    assert len(thread["responses"]) == (0 if operation == "open" else 1)
    if operation == "response":
        assert results[0].json() == results[1].json()


def test_detail_reads_multiple_threads_in_two_batches(accounts, settings):
    group_id = group(accounts, "Batch thread reads", ("sam", "casey", "jordan"))
    expense_id = publish(accounts["alex"], group_id, list(ids(accounts).values())).json()["id"]
    shares = detail(accounts["alex"], expense_id)["shares"]
    for share, username in zip(shares[:2], ("sam", "casey")):
        opened = open_thread(accounts[username], share["id"])
        assert opened.status_code == 201
        for text in ("First", "Second"):
            assert respond(accounts["alex"], opened.json()["id"], text).status_code == 201
    queries = []

    class RecordingCursor:
        def __init__(self, cur):
            self.cur = cur

        def execute(self, query, args):
            queries.append(query)
            self.cur.execute(query, args)

        def fetchall(self):
            return self.cur.fetchall()

    with connect(settings.database_url) as db, db.cursor() as cur:
        disputes.attach_threads(RecordingCursor(cur), shares)
    assert len(queries) == 2
    assert [len(share["dispute"]["responses"]) if share["dispute"] else 0 for share in shares] == [2, 2, 0]
    assert all(share["outstanding_minor"] == 3000 for share in shares)


@pytest.mark.parametrize("table,column", [("disputes", "reason"), ("dispute_responses", "body")])
def test_original_statements_are_immutable(accounts, settings, table, column):
    _, expense_id, share_id = expense_fixture(accounts)
    dispute_id = open_thread(accounts["sam"], share_id).json()["id"]
    response_id = respond(accounts["alex"], dispute_id).json()["id"]
    target_id = dispute_id if table == "disputes" else response_id
    before = detail(accounts["sam"], expense_id)
    for statement in (f"UPDATE {table} SET {column} = 'Overwritten' WHERE id = %s", f"DELETE FROM {table} WHERE id = %s"):
        with pytest.raises(psycopg2.Error) as error, connect(settings.database_url) as db, db.cursor() as cur:
            cur.execute(statement, (target_id,))
        assert error.value.pgcode == "55000"
    for method in ("put", "delete"):
        result = getattr(accounts["sam"], method)(f"/api/disputes/{dispute_id}", headers={"Origin": ORIGIN})
        assert result.status_code in (404, 405)
    assert detail(accounts["sam"], expense_id) == before


def test_slice_two_b_upgrade_preserves_financial_history_and_legacy_access():
    with temporary_schema() as dsn:
        with connect(dsn) as db, db.cursor() as cur:
            cur.execute("CREATE TABLE schema_migrations (name text PRIMARY KEY)")
            folder = Path(__file__).resolve().parents[1] / "roomsync/migrations"
            for name in ("001_slice_one.sql", "002_group_expenses.sql"):
                cur.execute((folder / name).read_text(encoding="utf-8"))
                cur.execute("INSERT INTO schema_migrations VALUES (%s)", (name,))
            for username, password in PASSWORDS.items():
                seed_member(cur, username, username.capitalize(), password)
            cur.execute("SELECT username, id FROM members")
            members = {row["username"]: row["id"] for row in cur.fetchall()}
            expense_id = ledger.create_expense(cur, members["alex"], "Legacy partial and pending", 6000)["id"]
            cur.execute("SELECT * FROM payable_shares WHERE expense_id = %s", (expense_id,))
            share = cur.fetchone()
            first = ledger.report_payment(cur, share, members["sam"], 1000)
            ledger.decide_payment(cur, {**first, "share_id": share["id"], "expense_id": expense_id, "amount_minor": 1000},
                                  members["alex"], amount_minor=1000)
            pending_id = ledger.report_payment(cur, share, members["sam"], 500)["id"]
            tables = ("expenses", "expense_allocations", "payable_shares", "payments", "payment_decisions", "audit_events", "idempotency_records")
            before = {}
            for table in tables:
                cur.execute(f"SELECT * FROM {table} ORDER BY 1, 2")
                before[table] = cur.fetchall()
        with connect(dsn) as db, db.cursor() as cur:
            migrate(db)
            migrate(db)
            for table in tables:
                cur.execute(f"SELECT * FROM {table} ORDER BY 1, 2")
                assert cur.fetchall() == before[table]
        with users(create_app(mock_settings(dsn, ORIGIN))) as clients:
            alex, sam = clients["alex"], clients["sam"]
            opened = open_thread(sam, share["id"])
            assert opened.status_code == 201
            assert respond(alex, opened.json()["id"]).status_code == 201
            assert detail(sam, expense_id)["shares"][0]["outstanding_minor"] == 2000
            assert confirm(alex, pending_id, 500).status_code == 200
            assert detail(sam, expense_id)["shares"][0]["outstanding_minor"] == 1500
            for username in ("casey", "jordan"):
                assert clients[username].get(f"/api/expenses/{expense_id}").status_code == 404
                assert respond(clients[username], opened.json()["id"]).status_code == 404
