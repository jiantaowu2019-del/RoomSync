from contextlib import ExitStack, contextmanager
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from roomsync import ledger
from roomsync.db import connect, migrate
from roomsync.http import Amount, create_app, idempotent
from roomsync.setup import seed_member
from tests.support import MOCK_URL, PASSWORDS, isolated_settings, mock_settings, temporary_schema
from tests.test_slice_one import ORIGIN, detail, login, write


@contextmanager
def users(app):
    with ExitStack() as stack:
        clients = {}
        for username in PASSWORDS:
            client = stack.enter_context(TestClient(app, base_url=ORIGIN))
            login(client, username)
            clients[username] = client
        yield clients


@pytest.fixture(scope="module")
def settings():
    with isolated_settings(ORIGIN) as config:
        yield config


@pytest.fixture
def accounts(settings):
    with users(create_app(settings)) as clients:
        yield clients


def ids(accounts):
    return {name: client.get("/api/session").json()["viewer"]["id"] for name, client in accounts.items()}


def group(accounts, name, members, *, pending=()):
    created = write(accounts["alex"], "/api/groups", {"name": name})
    assert created.status_code == 201, created.text
    group_id = created.json()["id"]
    for username in (*members, *pending):
        invitation = accounts["alex"].post(
            f"/api/groups/{group_id}/invitations", json={"username": username}, headers={"Origin": ORIGIN},
        )
        assert invitation.status_code == 204, invitation.text
    for username in members:
        accept = accounts[username].post(f"/api/groups/{group_id}/join", headers={"Origin": ORIGIN})
        assert accept.status_code == 204, accept.text
    return group_id


def publish(client, group_id, participant_ids, total=12000, policy="PAYER", *, key=None):
    return write(client, f"/api/groups/{group_id}/expenses", {
        "description": "Shared expenses", "total_minor": total, "participant_ids": participant_ids,
        "remainder_policy": policy,
    }, key=key)


def report(client, share_id, amount=3000):
    return write(client, f"/api/shares/{share_id}/payments", {"amount_minor": amount})


def confirm(client, payment_id, amount=3000, *, key=None):
    return write(client, f"/api/payments/{payment_id}/confirm", {"amount_minor": amount}, key=key)


def test_each_share_settles_independently(accounts):
    alex, sam, casey, jordan = (accounts[name] for name in PASSWORDS)
    group_id = group(accounts, "Four-member settlement", ("sam", "casey", "jordan"))
    expense = publish(alex, group_id, list(ids(accounts).values()))
    assert expense.status_code == 201
    expense_id = expense.json()["id"]
    original = detail(sam, expense_id)
    assert original["outstanding_minor"] == 9000
    assert original["status"] == "OPEN"
    shares = {share["debtor"]: share for share in original["shares"]}
    assert {name: share["outstanding_minor"] for name, share in shares.items()} == {
        "Sam": 3000, "Casey": 3000, "Jordan": 3000,
    }
    assert [share["payment_url"] for share in shares.values()].count(MOCK_URL) == 1
    assert shares["Sam"]["payment_url"] == MOCK_URL

    reported = report(sam, shares["Sam"]["id"])
    assert reported.status_code == 201
    assert detail(alex, expense_id)["outstanding_minor"] == 9000
    payment_id = reported.json()["id"]
    key = uuid4().hex
    assert confirm(alex, payment_id, key=key).status_code == 200
    assert confirm(alex, payment_id, key=key).status_code == 200
    assert confirm(alex, payment_id).status_code == 409
    after_sam = detail(sam, expense_id)
    assert (after_sam["outstanding_minor"], after_sam["status"]) == (6000, "OPEN")
    assert {share["debtor"]: (share["status"], share["outstanding_minor"]) for share in after_sam["shares"]} == {
        "Sam": ("SETTLED", 0), "Casey": ("UNPAID", 3000), "Jordan": ("UNPAID", 3000),
    }
    for debtor, client, remaining in (("Casey", casey, 3000), ("Jordan", jordan, 0)):
        payment = report(client, shares[debtor]["id"])
        assert payment.status_code == 201
        assert confirm(alex, payment.json()["id"]).status_code == 200
        view = detail(sam, expense_id)
        assert view["outstanding_minor"] == remaining
        assert view["status"] == ("OPEN" if remaining else "SETTLED")
    assert [event["kind"] for event in view["audit"]].count("PAYMENT_CONFIRMED") == 3


def test_visibility_and_role_checks_before_and_after_accepting(accounts):
    alex, sam, casey, jordan = (accounts[name] for name in PASSWORDS)
    member_ids = ids(accounts)
    group_id = group(accounts, "Visibility", ("sam", "casey"), pending=("jordan",))
    group_path = f"/api/groups/{group_id}"
    data = [member_ids[name] for name in ("alex", "sam", "casey")]
    expense_id = publish(alex, group_id, data, 9000).json()["id"]
    share = next(s for s in detail(sam, expense_id)["shares"] if s["debtor"] == "Sam")
    payment_id = report(sam, share["id"]).json()["id"]
    reason = {"reason": "The receipt amount was different."}
    reject_url = f"/api/payments/{payment_id}/reject"
    outsider_group = group(accounts, "Separate group", ("jordan",))

    assert jordan.get(f"/api/groups/{outsider_group}").status_code == 200
    assert casey.get(f"/api/groups/{outsider_group}/expenses").status_code == 404
    assert casey.post(f"/api/groups/{outsider_group}/join", headers={"Origin": ORIGIN}).status_code == 404
    for route in (group_path, group_path + "/expenses", f"/api/expenses/{expense_id}"):
        assert jordan.get(route).status_code == 404
    assert publish(jordan, group_id, data).status_code == 404
    assert report(jordan, share["id"]).status_code == 404
    assert confirm(jordan, payment_id).status_code == 404
    assert write(jordan, reject_url, reason).status_code == 404
    assert member_ids["jordan"] not in {m["id"] for m in alex.get(group_path).json()["members"]}
    assert {"id": group_id, "name": "Visibility", "creator_id": member_ids["alex"], "status": "invited"} in jordan.get("/api/groups").json()
    assert sam.post(group_path + "/invitations", json={"username": "jordan"}, headers={"Origin": ORIGIN}).status_code == 403

    assert jordan.post(group_path + "/join", headers={"Origin": ORIGIN}).status_code == 204
    assert jordan.post(group_path + "/join", headers={"Origin": ORIGIN}).status_code == 204
    visible = detail(jordan, expense_id)
    assert {row["member_id"] for row in visible["allocations"]} == set(data)
    assert all(share["debtor_id"] != member_ids["jordan"] and share["payment_url"] is None for share in visible["shares"])
    assert any(payment["status"] == "REPORTED" for share in visible["shares"] for payment in share["payments"])
    assert report(jordan, share["id"]).status_code == 403
    assert report(alex, share["id"]).status_code == 403
    assert confirm(jordan, payment_id).status_code == 403
    assert write(jordan, reject_url, reason).status_code == 403
    assert detail(jordan, expense_id) == visible
    assert write(alex, reject_url, reason).status_code == 200
    rejected = detail(jordan, expense_id)
    assert rejected["outstanding_minor"] == 6000
    assert any(payment["reason"] == reason["reason"] for share in rejected["shares"] for payment in share["payments"])
    assert rejected["audit"][-1]["details"]["reason"] == reason["reason"]


def test_group_creator_can_act_only_on_their_own_share(accounts):
    alex, sam, _, _ = (accounts[name] for name in PASSWORDS)
    group_id = group(accounts, "Sam paid", ("sam",))
    member_ids = ids(accounts)
    expense_id = publish(sam, group_id, [member_ids["alex"], member_ids["sam"]], 6000).json()["id"]
    share = detail(alex, expense_id)["shares"][0]
    assert share["recipient_id"] == member_ids["sam"]
    payment_id = report(alex, share["id"]).json()["id"]
    assert confirm(alex, payment_id).status_code == 403
    assert write(alex, f"/api/payments/{payment_id}/reject", {"reason": "Unauthorized"}).status_code == 403
    assert confirm(sam, payment_id).status_code == 200


@pytest.mark.parametrize(("total", "policy", "expected"), [
    (12003, "PAYER", [3003, 3000, 3000, 3000]),
    (12003, "EVEN", [3001, 3001, 3001, 3000]),
    (1, "PAYER", [1, 0, 0, 0]),
    (1, "EVEN", [1, 0, 0, 0]),
    (2, "EVEN", [1, 1, 0, 0]),
])
def test_allocation_is_exact_and_retains_zero_participation(accounts, total, policy, expected):
    group_id = group(accounts, "Remainder", ("sam", "casey", "jordan"))
    alex = accounts["alex"]
    member_ids = ids(accounts)
    result = publish(alex, group_id, list(reversed(member_ids.values())), total, policy)
    expense = detail(alex, result.json()["id"])
    assert expense["remainder_policy"] == policy
    assert [allocation["amount_minor"] for allocation in expense["allocations"]] == expected
    assert sum(expected) == expense["total_minor"] == total
    assert sorted(share["amount_minor"] for share in expense["shares"]) == sorted(amount for amount in expected[1:] if amount)
    assert expense["status"] == ("SETTLED" if total == 1 else "OPEN")


def test_group_validation_retries_and_rollback(accounts, monkeypatch):
    alex = accounts["alex"]
    key = uuid4().hex
    created = write(alex, "/api/groups", {"name": "Group creation retry"}, key=key)
    assert write(alex, "/api/groups", {"name": "Group creation retry"}, key=key).json() == created.json()
    assert write(alex, "/api/groups", {"name": "Changed name"}, key=key).status_code == 409
    group_id = group(accounts, "Group expense retry", ("sam",), pending=("casey",))
    member_ids = ids(accounts)
    payer, member, invitee, outsider = member_ids.values()
    for selection in ([payer], [member, invitee], [payer, member, member], [payer, invitee], [payer, outsider]):
        assert publish(alex, group_id, selection).status_code == 422

    def fail(*args, **kwargs):
        raise RuntimeError("Injected audit failure")

    key = uuid4().hex
    with monkeypatch.context() as patch:
        patch.setattr(ledger, "audit", fail)
        # The real database transaction must roll back even if an exception reaches the caller.
        with pytest.raises(RuntimeError, match="Injected audit failure"):
            publish(alex, group_id, [payer, member], key=key)
    assert alex.get(f"/api/groups/{group_id}/expenses").json() == []
    result = publish(alex, group_id, [payer, member], key=key)
    assert result.status_code == 201
    assert publish(alex, group_id, [member, payer], key=key).json() == result.json()
    assert publish(alex, group_id, [payer, member], total=12001, key=key).status_code == 409
    assert len(detail(alex, result.json()["id"])["audit"]) == 1


def test_migrate_real_slice_one_schema_and_confirm_pending_record():
    with temporary_schema() as dsn:
        with connect(dsn) as db, db.cursor() as cur:
            migration = Path(__file__).resolve().parents[1] / "roomsync/migrations/001_slice_one.sql"
            cur.execute(migration.read_text(encoding="utf-8"))
            cur.execute("CREATE TABLE schema_migrations (name text PRIMARY KEY)")
            cur.execute("INSERT INTO schema_migrations VALUES (%s)", (migration.name,))
            for username in ("alex", "sam"):
                seed_member(cur, username, username.capitalize(), PASSWORDS[username])
            cur.execute("SELECT username, id FROM members")
            legacy_members = {row["username"]: row["id"] for row in cur.fetchall()}
            alex_id, sam_id = legacy_members["alex"], legacy_members["sam"]
            records = {}
            for state, total in (("unpaid", 6001), ("pending", 6000), ("rejected", 6000), ("settled", 6000), ("one cent", 1)):
                cur.execute("""
                    INSERT INTO expenses (original_payer_id, other_member_id, description, total_minor, currency)
                    VALUES (%s, %s, %s, %s, 'USD') RETURNING id
                """, (alex_id, sam_id, state, total))
                expense_id = cur.fetchone()["id"]
                ledger.audit(cur, expense_id, alex_id, "EXPENSE_CREATED", {"total_minor": total})
                records[state] = {"expense": expense_id}
                if total == 1:
                    continue
                cur.execute("""
                    INSERT INTO payable_shares (expense_id, debtor_id, recipient_id, amount_minor)
                    VALUES (%s, %s, %s, %s) RETURNING id
                """, (expense_id, sam_id, alex_id, total // 2))
                share = {"id": cur.fetchone()["id"], "expense_id": expense_id}
                if state == "unpaid":
                    continue
                saved = idempotent(
                    cur, sam_id, f"legacy-{state}", f"report:{share['id']}", Amount(amount_minor=total // 2),
                    lambda: ledger.report_payment(cur, share, sam_id, total // 2),
                )
                payment_id = saved["id"]
                records[state]["share"] = share["id"]
                records[state]["payment"] = payment_id
                payment = {"id": payment_id, "share_id": share["id"], "amount_minor": total // 2, "expense_id": expense_id}
                if state == "rejected":
                    ledger.decide_payment(cur, payment, alex_id, reason="Legacy rejection")
                elif state == "settled":
                    ledger.decide_payment(cur, payment, alex_id, amount_minor=total // 2)
            snapshot_queries = (
                "SELECT id, original_payer_id, other_member_id, description, total_minor, currency, created_at FROM expenses ORDER BY id",
                "SELECT * FROM share_balances ORDER BY id", "SELECT * FROM payments ORDER BY id",
                "SELECT * FROM payment_decisions ORDER BY payment_id", "SELECT * FROM audit_events ORDER BY id",
                "SELECT * FROM idempotency_records ORDER BY actor_id, request_key",
            )
            before = []
            for query in snapshot_queries:
                cur.execute(query)
                before.append(cur.fetchall())

        with connect(dsn) as db, db.cursor() as cur:
            migrate(db)
            for snapshot, query in zip(before, snapshot_queries):
                cur.execute(query)
                assert cur.fetchall() == snapshot
            for username in ("casey", "jordan"):
                seed_member(cur, username, username.capitalize(), PASSWORDS[username])

        with users(create_app(mock_settings(dsn, ORIGIN))) as clients:
            alex, sam, casey, _ = (clients[name] for name in PASSWORDS)
            group(clients, "Legacy remains private", ("sam", "casey"))
            listed = sam.get("/api/expenses").json()
            assert {row["id"] for row in listed} == {record["expense"] for record in records.values()}
            assert casey.get("/api/expenses").json() == []
            for state, record in records.items():
                expense_id = record["expense"]
                expense = detail(sam, expense_id)
                assert casey.get(f"/api/expenses/{expense_id}").status_code == 404
                assert expense["group_id"] is None
                assert expense["outstanding_minor"] == (0 if state in {"settled", "one cent"} else 3000)
                assert expense["status"] == ("SETTLED" if state in {"settled", "one cent"} else "OPEN")
                assert len(expense["allocations"]) == 2
                assert sum(allocation["amount_minor"] for allocation in expense["allocations"]) == expense["total_minor"]
                if state == "rejected":
                    assert expense["shares"][0]["payments"][0]["reason"] == "Legacy rejection"
                if state == "pending":
                    assert expense["shares"][0]["payments"][0]["status"] == "REPORTED"

            pending = records["pending"]
            retry = write(sam, f"/api/shares/{pending['share']}/payments", {"amount_minor": 3000}, key="legacy-pending")
            assert retry.status_code == 201
            assert retry.json() == {"id": pending["payment"], "status": "REPORTED"}
            assert confirm(casey, pending["payment"]).status_code == 404
            assert confirm(alex, pending["payment"]).status_code == 200
            assert detail(sam, pending["expense"])["status"] == "SETTLED"
