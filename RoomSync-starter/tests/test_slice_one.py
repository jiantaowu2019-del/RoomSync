import os
from subprocess import CompletedProcess
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import uuid4

import psycopg2
import pytest
from fastapi.testclient import TestClient
from psycopg2.extensions import parse_dsn

from roomsync import ledger
from roomsync.auth import COOKIE, session_token_hash
from roomsync.db import connect, migrate
from roomsync.http import create_app
from roomsync.setup import seed_member
from tests import run_browser_tests
from tests.support import BROWSER_DSN, MOCK_URL, PASSWORDS, isolated_settings

ORIGIN = "http://127.0.0.1"
AMOUNT = {"amount_minor": 3000}


@pytest.fixture(scope="module")
def settings():
    if not os.getenv("ROOMSYNC_TEST_DATABASE_URL"):
        pytest.fail("Set ROOMSYNC_TEST_DATABASE_URL to a disposable PostgreSQL database.")
    with isolated_settings(ORIGIN) as config:
        yield config


@pytest.fixture
def app(settings):
    return create_app(settings)


@pytest.fixture
def accounts(app):
    with TestClient(app, base_url=ORIGIN) as alex, TestClient(app, base_url=ORIGIN) as sam:
        login(alex, "alex")
        login(sam, "sam")
        yield alex, sam


def login(client, user):
    response = client.post("/api/session", json={"username": user, "password": PASSWORDS[user]},
                           headers={"Origin": ORIGIN})
    assert response.status_code == 204, response.text
    assert "HttpOnly" in response.headers["set-cookie"]


def write(client, path, body, *, key=None, origin=ORIGIN):
    return client.post(path, json=body, headers={
        "Origin": origin, "Idempotency-Key": key or uuid4().hex,
    })


def create(client, amount=6000):
    response = write(client, "/api/expenses", {"description": "Groceries", "total_minor": amount})
    assert response.status_code == 201, response.text
    return response.json()["id"]


def detail(client, expense_id):
    response = client.get(f"/api/expenses/{expense_id}")
    assert response.status_code == 200, response.text
    return response.json()


def report(client, share_id):
    response = write(client, f"/api/shares/{share_id}/payments", AMOUNT)
    assert response.status_code == 201, response.text
    return response.json()["id"]


def test_migration_is_repeatable(settings):
    with connect(settings.database_url) as db, db.cursor() as cur:
        migrate(db)
        cur.execute("SELECT count(*) AS count FROM schema_migrations")
        assert cur.fetchone()["count"] == 1


def test_setup_rejects_changed_password_without_overwriting_existing_account(settings, app):
    with connect(settings.database_url) as db, db.cursor() as cur:
        seed_member(cur, "alex", "Alex", PASSWORDS["alex"])
    with pytest.raises(SystemExit, match="Existing account 'alex'"):
        with connect(settings.database_url) as db, db.cursor() as cur:
            seed_member(cur, "alex", "Alex", "different-alex-test-password")
    with TestClient(app, base_url=ORIGIN) as client:
        login(client, "alex")


@pytest.mark.parametrize("exit_code", [0, 1])
def test_browser_runner_cleans_only_its_schema_on_success_and_failure(settings, monkeypatch, exit_code):
    def schemas():
        with connect(os.environ["ROOMSYNC_TEST_DATABASE_URL"]) as db, db.cursor() as cur:
            cur.execute("SELECT nspname FROM pg_namespace")
            return {row["nspname"] for row in cur}

    baseline = schemas()

    def playwright(command, *, cwd, env, check):
        test_dsn = env[BROWSER_DSN]
        schema = parse_dsn(test_dsn)["options"].split("=")[1]
        assert schemas() == baseline | {schema}
        with connect(test_dsn) as db, db.cursor() as cur:
            cur.execute("SELECT count(*) AS total FROM members")
            assert cur.fetchone()["total"] == 2
        return CompletedProcess(command, exit_code)

    monkeypatch.setattr(run_browser_tests.subprocess, "run", playwright)
    assert run_browser_tests.run_browser_tests([]) == exit_code
    assert schemas() == baseline


@pytest.mark.parametrize(("total", "payable", "remainder"), [(6000, 3000, 3000), (6001, 3000, 3001), (1, 0, 1)])
def test_split_and_status(accounts, total, payable, remainder):
    alex, sam = accounts
    expense = detail(sam, create(alex, total))
    assert expense["currency"] == "USD"
    assert expense["total_minor"] == total
    assert expense["outstanding_minor"] == payable
    assert total - payable == remainder
    assert expense["audit"][0]["details"]["payable_minor"] == payable
    if payable:
        assert expense["status"] == "OPEN"
        assert expense["shares"][0]["amount_minor"] == payable
        assert expense["shares"][0]["status"] == "UNPAID"
    else:
        assert expense["status"] == "SETTLED"
        assert expense["shares"] == []


def test_report_confirm_and_persist(app, accounts):
    alex, sam = accounts
    expense_id = create(alex)
    before = detail(sam, expense_id)
    share = before["shares"][0]
    assert share["payment_url"] == MOCK_URL
    assert detail(alex, expense_id)["shares"][0]["payment_url"] is None
    assert detail(sam, expense_id) == before
    payment_id = report(sam, share["id"])
    pending = detail(sam, expense_id)
    assert pending["outstanding_minor"] == 3000
    assert pending["shares"][0]["status"] == "PAYMENT_REPORTED"
    assert pending["shares"][0]["payment_url"] is None
    assert pending["shares"][0]["payments"][0]["status"] == "REPORTED"
    assert write(sam, f"/api/shares/{share['id']}/payments", AMOUNT).status_code == 409
    assert write(sam, f"/api/payments/{payment_id}/confirm", AMOUNT).status_code == 403
    assert write(sam, f"/api/payments/{payment_id}/reject", {"reason": "Spoof"}).status_code == 403
    assert detail(sam, expense_id) == pending
    assert write(alex, f"/api/payments/{payment_id}/confirm", AMOUNT).status_code == 200
    assert write(sam, f"/api/shares/{share['id']}/payments", AMOUNT).status_code == 409
    with TestClient(app, base_url=ORIGIN) as new_client:
        login(new_client, "sam")
        settled = detail(new_client, expense_id)
    assert settled["status"] == "SETTLED"
    assert settled["outstanding_minor"] == 0
    assert settled["shares"][0]["status"] == "SETTLED"
    assert settled["shares"][0]["payment_url"] is None
    assert settled["shares"][0]["payments"][0]["confirmed_minor"] == 3000
    assert [event["kind"] for event in settled["audit"]] == [
        "EXPENSE_CREATED", "PAYMENT_REPORTED", "PAYMENT_CONFIRMED",
    ]


def test_recipient_role_follows_original_payer(accounts):
    alex, sam = accounts
    expense_id = create(sam)
    share = detail(alex, expense_id)["shares"][0]
    assert share["debtor"] == "Alex" and share["recipient"] == "Sam"
    assert share["payment_url"] is None
    payment_id = report(alex, share["id"])
    assert write(alex, f"/api/payments/{payment_id}/confirm", AMOUNT).status_code == 403
    assert write(sam, f"/api/payments/{payment_id}/confirm", AMOUNT).status_code == 200
    assert detail(alex, expense_id)["status"] == "SETTLED"


def test_recipient_rejects_with_reason_then_debtor_can_report_again(accounts):
    alex, sam = accounts
    expense_id = create(alex)
    share_id = detail(sam, expense_id)["shares"][0]["id"]
    first = report(sam, share_id)
    reject_path = f"/api/payments/{first}/reject"
    assert write(alex, reject_path, {"reason": "  "}).status_code == 422
    reason = {"reason": "Receipt has not arrived."}
    rejected = write(alex, reject_path, reason, key="reject-" + uuid4().hex)
    assert rejected.json() == {"id": first, "status": "REJECTED"}
    after = detail(sam, expense_id)
    share = after["shares"][0]
    assert share["payment_url"] == MOCK_URL
    assert after["outstanding_minor"] == 3000 and share["status"] == "UNPAID"
    assert share["payments"][0]["amount_minor"] == 3000
    assert share["payments"][0]["reason"] == reason["reason"]
    assert after["audit"][-1]["kind"] == "PAYMENT_REJECTED"
    assert after["audit"][-1]["details"] == reason
    assert write(alex, f"/api/payments/{first}/confirm", AMOUNT).status_code == 409
    assert write(alex, reject_path, reason).status_code == 409
    second = report(sam, share_id)
    assert second != first
    assert write(alex, f"/api/payments/{second}/confirm", AMOUNT).status_code == 200
    assert [p["status"] for p in detail(sam, expense_id)["shares"][0]["payments"]] == ["CONFIRMED", "REJECTED"]


def test_idempotency_replays_original_responses_and_rejects_conflict(accounts):
    alex, sam = accounts
    expense_body = {"description": "House supplies", "total_minor": 6000}
    create_key, report_key, reject_key, confirm_key = [uuid4().hex for _ in range(4)]
    initial = write(alex, "/api/expenses", expense_body, key=create_key)
    expense_id = initial.json()["id"]
    replay = write(alex, "/api/expenses", expense_body, key=create_key)
    assert replay.status_code == initial.status_code == 201 and replay.json() == initial.json()
    assert write(alex, "/api/expenses", {**expense_body, "total_minor": 4000}, key=create_key).status_code == 409
    share_id = detail(sam, expense_id)["shares"][0]["id"]
    report_path = f"/api/shares/{share_id}/payments"
    first = write(sam, report_path, AMOUNT, key=report_key)
    reject_path = f"/api/payments/{first.json()['id']}/reject"
    reason = {"reason": "Wrong reference"}
    rejected = write(alex, reject_path, reason, key=reject_key)
    assert rejected.status_code == 200
    payment_id = report(sam, share_id)
    confirm_path = f"/api/payments/{payment_id}/confirm"
    confirmation = write(alex, confirm_path, AMOUNT, key=confirm_key)
    replay = write(alex, confirm_path, AMOUNT, key=confirm_key)
    assert replay.status_code == confirmation.status_code == 200
    assert replay.json() == confirmation.json()
    assert write(alex, confirm_path, {"amount_minor": 2999}, key=confirm_key).status_code == 409
    assert write(alex, confirm_path, AMOUNT, key=create_key).status_code == 409
    assert write(alex, reject_path, reason, key=reject_key).json() == rejected.json()
    replay_report = write(sam, report_path, AMOUNT, key=report_key)
    assert replay_report.status_code == first.status_code == 201
    assert replay_report.json() == first.json() == {"id": first.json()["id"], "status": "REPORTED"}
    assert [event["kind"] for event in detail(sam, expense_id)["audit"]] == [
        "EXPENSE_CREATED", "PAYMENT_REPORTED", "PAYMENT_REJECTED", "PAYMENT_REPORTED", "PAYMENT_CONFIRMED",
    ]


@pytest.mark.parametrize("same_key", [True, False])
def test_concurrent_reports_and_confirmations(app, accounts, same_key):
    alex, sam = accounts
    expense_id = create(alex)
    share_id = detail(sam, expense_id)["shares"][0]["id"]

    def race(user, path):
        first_key = uuid4().hex
        keys = [first_key, first_key if same_key else uuid4().hex]
        barrier = Barrier(2)

        def request(key):
            with TestClient(app, base_url=ORIGIN, cookies={COOKIE: user.cookies[COOKIE]}) as client:
                barrier.wait(timeout=10)
                return write(client, path, AMOUNT, key=key)

        with ThreadPoolExecutor(max_workers=2) as executor:
            return list(executor.map(request, keys))

    reports = race(sam, f"/api/shares/{share_id}/payments")
    assert sorted(r.status_code for r in reports) == [201, 201 if same_key else 409]
    payment_id = next(r.json()["id"] for r in reports if r.status_code == 201)
    confirmations = race(alex, f"/api/payments/{payment_id}/confirm")
    assert sorted(r.status_code for r in confirmations) == [200, 200 if same_key else 409]
    expense = detail(sam, expense_id)
    assert expense["outstanding_minor"] == 0
    assert len(expense["shares"][0]["payments"]) == 1
    assert [event["kind"] for event in expense["audit"]] == [
        "EXPENSE_CREATED", "PAYMENT_REPORTED", "PAYMENT_CONFIRMED",
    ]


def test_invalid_amounts_leave_ledger_intact(accounts):
    alex, sam = accounts
    baseline = alex.get("/api/expenses").json()
    for amount in (0, -1, 1.5, "6000", True, 2**53):
        assert write(alex, "/api/expenses", {"description": "Invalid", "total_minor": amount}).status_code == 422
    assert write(alex, "/api/expenses", {
        "description": "Foreign", "total_minor": 6000, "currency": "CAD",
    }).status_code == 422
    assert alex.get("/api/expenses").json() == baseline
    expense_id = create(alex)
    before = detail(sam, expense_id)
    share_id = before["shares"][0]["id"]
    path = f"/api/shares/{share_id}/payments"
    for amount in (0, -1, 3.5, 1000, 3001, "3000", True):
        assert write(sam, path, {"amount_minor": amount}).status_code == 422
    assert write(sam, path, {**AMOUNT, "currency": "CAD"}).status_code == 422
    assert detail(sam, expense_id) == before
    payment_id = report(sam, share_id)
    pending = detail(sam, expense_id)
    path = f"/api/payments/{payment_id}/confirm"
    for amount in (0, -1, 3.5, 1000, 3001):
        assert write(alex, path, {"amount_minor": amount}).status_code == 422
    assert detail(sam, expense_id) == pending


def test_authorization_and_session_lifecycle(app, accounts, settings):
    alex, sam = accounts
    expense_id = create(alex)
    expense_url = f"/api/expenses/{expense_id}"
    share_id = detail(sam, expense_id)["shares"][0]["id"]
    report_url = f"/api/shares/{share_id}/payments"
    payment_id = report(sam, share_id)
    confirm_url = f"/api/payments/{payment_id}/confirm"
    reject_url = f"/api/payments/{payment_id}/reject"
    before = detail(sam, expense_id)
    with TestClient(app, base_url=ORIGIN) as stranger:
        assert stranger.get(expense_url).status_code == 401
        assert write(stranger, confirm_url, AMOUNT).status_code == 401
        token = uuid4().hex
        with connect(settings.database_url) as db, db.cursor() as cur:
            cur.execute("""
                INSERT INTO members (username, display_name, password_hash)
                VALUES (%s, 'Outsider', 'unused') RETURNING id
            """, ("outsider-" + token,))
            cur.execute("""
                INSERT INTO sessions (token_hash, member_id, expires_at) VALUES (%s, %s, now() + interval '1 hour')
            """, (session_token_hash(token), cur.fetchone()["id"]))
        stranger.cookies.set(COOKIE, token)
        assert stranger.get("/api/expenses").json() == []
        assert write(stranger, "/api/expenses", {"description": "Outsider", "total_minor": 6000}).status_code == 403
        assert stranger.get(expense_url).status_code == 404
        assert write(stranger, report_url, AMOUNT).status_code == 404
        assert write(stranger, confirm_url, AMOUNT).status_code == 404
        assert write(stranger, reject_url, {"reason": "Intrusion"}).status_code == 404
    assert write(alex, report_url, AMOUNT).status_code == 403
    assert write(sam, confirm_url, {**AMOUNT, "recipient_id": 1}).status_code == 422
    assert write(alex, confirm_url, AMOUNT, origin="https://alien.example.test").status_code == 403
    assert write(alex, "/api/payments/9223372036854775808/confirm", AMOUNT).status_code == 422
    assert detail(sam, expense_id) == before

    token = alex.cookies[COOKIE]
    assert alex.delete("/api/session", headers={"Origin": ORIGIN}).status_code == 204
    with TestClient(app, base_url=ORIGIN, cookies={COOKIE: token}) as logged_out:
        assert logged_out.get(expense_url).status_code == 401


def test_unsupported_edits_leave_financial_facts_immutable(accounts, settings):
    alex, sam = accounts
    expense_id = create(alex)
    share_id = detail(sam, expense_id)["shares"][0]["id"]
    payment_id = report(sam, share_id)
    assert write(alex, f"/api/payments/{payment_id}/confirm", AMOUNT).status_code == 200
    before = detail(alex, expense_id)
    for method in ("PATCH", "PUT", "DELETE"):
        response = alex.request(method, f"/api/expenses/{expense_id}", headers={"Origin": ORIGIN})
        assert response.status_code == 405
    for path in (f"/api/payments/{payment_id}/reverse", f"/api/payments/{payment_id}/cancel"):
        assert write(alex, path, {}).status_code == 404

    for statement, record_id in (
        ("UPDATE expenses SET total_minor = 1 WHERE id = %s", expense_id),
        ("DELETE FROM payments WHERE id = %s", payment_id),
        ("DELETE FROM payment_decisions WHERE payment_id = %s", payment_id),
        ("DELETE FROM audit_events WHERE expense_id = %s", expense_id),
    ):
        with pytest.raises(psycopg2.errors.ObjectNotInPrerequisiteState):
            with connect(settings.database_url) as db, db.cursor() as cur:
                cur.execute(statement, (record_id,))
    assert detail(alex, expense_id) == before


def test_confirmation_rollback_and_retry(app, accounts, settings, monkeypatch):
    alex, sam = accounts
    expense_id = create(alex)
    share_id = detail(sam, expense_id)["shares"][0]["id"]
    payment_id = report(sam, share_id)
    before = detail(sam, expense_id)
    append_audit = ledger.audit

    def fail_after_audit(*args):
        append_audit(*args)
        raise RuntimeError("Injected failure after confirmation and audit writes")

    key = uuid4().hex
    path = f"/api/payments/{payment_id}/confirm"
    with monkeypatch.context() as failure, TestClient(
        app, base_url=ORIGIN, cookies={COOKIE: alex.cookies[COOKIE]}, raise_server_exceptions=False,
    ) as client:
        failure.setattr(ledger, "audit", fail_after_audit)
        assert write(client, path, AMOUNT, key=key).status_code == 500
    assert detail(sam, expense_id) == before
    with connect(settings.database_url) as db, db.cursor() as cur:
        cur.execute("SELECT 1 FROM idempotency_records WHERE request_key = %s", (key,))
        assert cur.fetchone() is None
    assert write(alex, path, AMOUNT, key=key).status_code == 200
    assert detail(sam, expense_id)["outstanding_minor"] == 0
