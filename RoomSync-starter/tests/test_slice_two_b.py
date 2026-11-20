from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from roomsync import ledger
from roomsync.auth import COOKIE
from roomsync.db import connect
from roomsync.http import create_app
from tests.test_slice_one import ORIGIN, detail, write
from tests.test_slice_two import accounts, settings, confirm, group, ids, publish, report


def expense_fixture(accounts):
    group_id = group(accounts, "Partial payment group", ("sam", "casey", "jordan"))
    result = publish(accounts["alex"], group_id, list(ids(accounts).values()))
    expense_id = result.json()["id"]
    expense = detail(accounts["sam"], expense_id)
    return expense_id, {share["debtor"]: share for share in expense["shares"]}


def test_partial_receipts_rejection_and_independent_settlement(accounts):
    alex, sam = accounts["alex"], accounts["sam"]
    expense_id, shares = expense_fixture(accounts)
    share = shares["Sam"]
    first = report(sam, share["id"], 1000)
    assert first.status_code == 201
    pending = detail(sam, expense_id)
    assert pending["outstanding_minor"] == 9000
    pending_share = next(s for s in pending["shares"] if s["id"] == share["id"])
    assert (pending_share["confirmed_minor"], pending_share["pending_minor"], pending_share["outstanding_minor"]) == (0, 1000, 3000)
    assert report(sam, share["id"], 500).status_code == 409
    assert confirm(alex, first.json()["id"], 999).status_code == 422
    assert confirm(alex, first.json()["id"], 1000).status_code == 200
    partial = detail(sam, expense_id)
    assert partial["outstanding_minor"] == 8000 and partial["status"] == "OPEN"
    sam_share = next(s for s in partial["shares"] if s["id"] == share["id"])
    assert (sam_share["confirmed_minor"], sam_share["outstanding_minor"], sam_share["status"]) == (1000, 2000, "PARTIALLY_SETTLED")
    assert sam_share["payment_url"]

    second = report(sam, share["id"], 500).json()["id"]
    assert write(alex, f"/api/payments/{second}/reject", {"reason": "The actual transfer amount differs."}).status_code == 200
    rejected = detail(sam, expense_id)
    assert rejected["outstanding_minor"] == 8000
    sam_share = next(s for s in rejected["shares"] if s["id"] == share["id"])
    assert sam_share["status"] == "PARTIALLY_SETTLED"
    assert sam_share["payments"][0]["reason"] == "The actual transfer amount differs."
    assert confirm(alex, second, 500).status_code == 409
    last = report(sam, share["id"], 2000).json()["id"]
    assert confirm(alex, last, 2000).status_code == 200
    settled = detail(sam, expense_id)
    assert (settled["status"], settled["outstanding_minor"]) == ("OPEN", 6000)
    assert {s["debtor"]: s["outstanding_minor"] for s in settled["shares"]} == {"Sam": 0, "Casey": 3000, "Jordan": 3000}
    assert report(sam, share["id"], 1).status_code == 409


def test_retry_and_later_identical_amount_are_distinct_payments(accounts):
    alex, sam = accounts["alex"], accounts["sam"]
    expense_id, shares = expense_fixture(accounts)
    path = f"/api/shares/{shares['Sam']['id']}/payments"
    key = uuid4().hex
    body = {"amount_minor": 1000}
    original = write(sam, path, body, key=key)
    retry = write(sam, path, body, key=key)
    assert retry.status_code == original.status_code == 201
    assert retry.json() == original.json()
    first_id = original.json()["id"]
    assert confirm(alex, first_id, 1000).status_code == 200
    assert write(sam, path, body, key=key).json() == original.json()
    assert write(sam, path, {"amount_minor": 500}, key=key).status_code == 409
    later = write(sam, path, body, key=uuid4().hex)
    assert later.status_code == 201 and later.json()["id"] != first_id
    assert confirm(alex, later.json()["id"], 1000).status_code == 200
    sam_share = next(s for s in detail(sam, expense_id)["shares"] if s["debtor"] == "Sam")
    assert (sam_share["outstanding_minor"], sam_share["confirmed_minor"]) == (1000, 2000)
    assert len(sam_share["payments"]) == 2


def test_partial_amount_boundaries_and_roles(accounts):
    alex, sam, casey = accounts["alex"], accounts["sam"], accounts["casey"]
    expense_id, shares = expense_fixture(accounts)
    share_id = shares["Sam"]["id"]
    before = detail(sam, expense_id)
    for invalid in (0, -1, 1.5, "1000", True, 3001):
        assert write(sam, f"/api/shares/{share_id}/payments", {"amount_minor": invalid}).status_code == 422
    assert report(casey, share_id, 1000).status_code == 403
    assert detail(sam, expense_id) == before
    first_id = report(sam, share_id, 1).json()["id"]
    assert confirm(sam, first_id, 1).status_code == 403
    assert confirm(casey, first_id, 1).status_code == 403
    assert write(casey, f"/api/payments/{first_id}/reject", {"reason": "Not the recipient"}).status_code == 403
    assert confirm(alex, first_id, 1).status_code == 200
    assert report(sam, share_id, 3000).status_code == 422
    assert report(sam, share_id, 2999).status_code == 201


def race(settings, clients, requests):
    barrier = Barrier(len(requests))
    app = create_app(settings)

    def send(item):
        username, path, body = item
        with TestClient(app, base_url=ORIGIN, cookies={COOKIE: clients[username].cookies[COOKIE]}) as client:
            barrier.wait(timeout=10)
            return write(client, path, body)

    with ThreadPoolExecutor(max_workers=len(requests)) as executor:
        return list(executor.map(send, requests))


def test_concurrent_partial_reports_and_competing_decisions(accounts, settings):
    expense_id, shares = expense_fixture(accounts)
    share_id = shares["Sam"]["id"]
    reports = race(settings, accounts, [
        ("sam", f"/api/shares/{share_id}/payments", {"amount_minor": 1000}),
        ("sam", f"/api/shares/{share_id}/payments", {"amount_minor": 1000}),
    ])
    assert sorted(response.status_code for response in reports) == [201, 409]
    payment_id = next(r.json()["id"] for r in reports if r.status_code == 201)
    decisions = race(settings, accounts, [
        ("alex", f"/api/payments/{payment_id}/confirm", {"amount_minor": 1000}),
        ("alex", f"/api/payments/{payment_id}/reject", {"reason": "Concurrent decision"}),
    ])
    assert sorted(response.status_code for response in decisions) == [200, 409]
    winner = next(r.json()["status"] for r in decisions if r.status_code == 200)
    sam_share = next(s for s in detail(accounts["sam"], expense_id)["shares"] if s["debtor"] == "Sam")
    assert sam_share["outstanding_minor"] == (2000 if winner == "CONFIRMED" else 3000)
    assert not sam_share["payment_pending"]


def test_parallel_receipts_on_different_shares(accounts, settings):
    expense_id, shares = expense_fixture(accounts)
    first = report(accounts["sam"], shares["Sam"]["id"], 1000).json()["id"]
    second = report(accounts["casey"], shares["Casey"]["id"], 2000).json()["id"]
    decisions = race(settings, accounts, [
        ("alex", f"/api/payments/{first}/confirm", {"amount_minor": 1000}),
        ("alex", f"/api/payments/{second}/confirm", {"amount_minor": 2000}),
    ])
    assert [response.status_code for response in decisions] == [200, 200]
    expense = detail(accounts["alex"], expense_id)
    assert expense["outstanding_minor"] == 6000 and expense["status"] == "OPEN"


def test_partial_confirmation_rolls_back_and_can_retry(accounts, settings, monkeypatch):
    alex, sam = accounts["alex"], accounts["sam"]
    expense_id, shares = expense_fixture(accounts)
    payment_id = report(sam, shares["Sam"]["id"], 1000).json()["id"]
    before = detail(sam, expense_id)
    append_audit = ledger.audit

    def fail(*args):
        append_audit(*args)
        raise RuntimeError("Injected partial receipt failure")

    key = uuid4().hex
    with monkeypatch.context() as failure:
        failure.setattr(ledger, "audit", fail)
        with pytest.raises(RuntimeError, match="Injected partial receipt failure"):
            confirm(alex, payment_id, 1000, key=key)
    assert detail(sam, expense_id) == before
    with connect(settings.database_url) as db, db.cursor() as cur:
        cur.execute("SELECT 1 FROM idempotency_records WHERE request_key = %s", (key,))
        assert cur.fetchone() is None
    assert confirm(alex, payment_id, 1000, key=key).status_code == 200
    assert detail(sam, expense_id)["outstanding_minor"] == 8000
