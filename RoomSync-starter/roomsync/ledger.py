from fastapi import HTTPException
from psycopg2.extras import Json

from .allocation import equal_allocations


def audit(cur, expense_id, actor_id, kind, details, payment_id=None):
    cur.execute("""
        INSERT INTO audit_events (expense_id, actor_id, payment_id, kind, details)
        VALUES (%s, %s, %s, %s, %s)
    """, (expense_id, actor_id, payment_id, kind, Json(details)))


def other_member(cur, actor_id):
    cur.execute("""
        SELECT username FROM members WHERE id = %s AND demo_member AND username IN ('alex', 'sam')
    """, (actor_id,))
    actor = cur.fetchone()
    if actor is None:
        raise HTTPException(403, "Only the two demo members can create an expense.")
    other_username = "sam" if actor["username"] == "alex" else "alex"
    cur.execute("""
        SELECT id, display_name FROM members WHERE username = %s AND demo_member
    """, (other_username,))
    member = cur.fetchone()
    if member is None:
        raise HTTPException(409, "The other demo member has not been set up.")
    return member


def create_expense(cur, actor_id, description, total_minor):
    other = other_member(cur, actor_id)
    cur.execute("""
        INSERT INTO expenses (original_payer_id, other_member_id, description, total_minor, currency)
        VALUES (%s, %s, %s, %s, 'USD') RETURNING id
    """, (actor_id, other["id"], description, total_minor))
    expense_id = cur.fetchone()["id"]
    share_amount = total_minor // 2
    add_allocations(cur, expense_id, actor_id, {
        actor_id: total_minor - share_amount, other["id"]: share_amount,
    })
    audit(cur, expense_id, actor_id, "EXPENSE_CREATED", {
        "total_minor": total_minor, "payable_minor": share_amount, "currency": "USD",
    })
    return {"id": expense_id}


def validate_group_participants(cur, group_id, payer_id, participant_ids):
    if len(participant_ids) < 2 or len(set(participant_ids)) != len(participant_ids) or payer_id not in participant_ids:
        raise HTTPException(422, "Select at least two distinct members, including the original payer.")
    cur.execute("""
        SELECT member_id FROM group_memberships
        WHERE group_id = %s AND status = 'active' AND member_id = ANY(%s)
    """, (group_id, participant_ids))
    if len(cur.fetchall()) != len(participant_ids):
        raise HTTPException(422, "All selected participants must be active group members.")


def create_group_expense(cur, group_id, actor_id, description, total_minor, participant_ids, remainder_policy):
    validate_group_participants(cur, group_id, actor_id, participant_ids)
    allocations = equal_allocations(total_minor, actor_id, participant_ids, remainder_policy)
    cur.execute("""
        INSERT INTO expenses (original_payer_id, description, total_minor, currency, group_id, remainder_policy)
        VALUES (%s, %s, %s, 'USD', %s, %s) RETURNING id
    """, (actor_id, description, total_minor, group_id, remainder_policy))
    expense_id = cur.fetchone()["id"]
    add_allocations(cur, expense_id, actor_id, allocations)
    audit(cur, expense_id, actor_id, "EXPENSE_CREATED", {
        "total_minor": total_minor, "currency": "USD", "remainder_policy": remainder_policy,
        "allocations": allocations,
    })
    return {"id": expense_id}


def add_allocations(cur, expense_id, payer_id, allocations):
    cur.executemany("""
        INSERT INTO expense_allocations (expense_id, member_id, amount_minor) VALUES (%s, %s, %s)
    """, [(expense_id, member_id, amount) for member_id, amount in allocations.items()])
    obligations = [
        (expense_id, member_id, payer_id, amount)
        for member_id, amount in allocations.items()
        if member_id != payer_id and amount > 0
    ]
    if obligations:
        cur.executemany("""
            INSERT INTO payable_shares (expense_id, debtor_id, recipient_id, amount_minor)
            VALUES (%s, %s, %s, %s)
        """, obligations)


def list_expenses(cur, actor_id, group_id=None):
    cur.execute("""
        SELECT e.id, e.description, e.total_minor, e.created_at, e.currency,
               m.display_name AS original_payer,
               COALESCE((SELECT sum(s.outstanding_minor)
                         FROM share_balances s WHERE s.expense_id = e.id), 0)::bigint
                   AS outstanding_minor,
               CASE WHEN EXISTS (
                   SELECT 1 FROM share_balances s WHERE s.expense_id = e.id AND s.outstanding_minor <> 0
               ) THEN 'OPEN' ELSE 'SETTLED' END AS status
        FROM expenses e JOIN members m ON m.id = e.original_payer_id
        JOIN expense_viewers v ON v.expense_id = e.id
        WHERE v.member_id = %s AND e.group_id IS NOT DISTINCT FROM %s
        ORDER BY e.id DESC
    """, (actor_id, group_id))
    return cur.fetchall()


def expense_detail(cur, expense_id, actor_id, links):
    cur.execute("""
        SELECT e.*, p.display_name AS original_payer, m.display_name AS other_member
        FROM expenses e
        JOIN members p ON p.id = e.original_payer_id
        LEFT JOIN members m ON m.id = e.other_member_id
        JOIN expense_viewers v ON v.expense_id = e.id
        WHERE e.id = %s AND v.member_id = %s
    """, (expense_id, actor_id))
    expense = cur.fetchone()
    if not expense:
        raise HTTPException(404, "Expense not found.")

    cur.execute("""
        SELECT a.member_id, m.display_name, a.amount_minor
        FROM expense_allocations a JOIN members m ON m.id = a.member_id
        WHERE a.expense_id = %s ORDER BY (a.member_id = %s) DESC, a.member_id
    """, (expense_id, expense["original_payer_id"]))
    expense["allocations"] = cur.fetchall()

    cur.execute("""
        SELECT s.*, d.display_name AS debtor, r.display_name AS recipient,
               r.username AS recipient_username
        FROM share_balances s
        JOIN members d ON d.id = s.debtor_id JOIN members r ON r.id = s.recipient_id
        WHERE s.expense_id = %s ORDER BY s.id
    """, (expense_id,))
    shares = cur.fetchall()
    for share in shares:
        recipient = share.pop("recipient_username")
        share["status"] = share_status(share)
        share["payment_url"] = (
            links.recipients.get(recipient)
            if actor_id == share["debtor_id"] and share["outstanding_minor"] > 0 and not share["payment_pending"] else None
        )
        cur.execute("""
            SELECT p.id, p.amount_minor, p.reported_by, p.created_at,
                   COALESCE(d.kind, 'REPORTED') AS status,
                   d.amount_minor AS confirmed_minor, d.reason, d.created_at AS decided_at
            FROM payments p LEFT JOIN payment_decisions d ON d.payment_id = p.id
            WHERE p.share_id = %s ORDER BY p.id DESC
        """, (share["id"],))
        share["payments"] = cur.fetchall()
        share["confirmed_minor"] = share["amount_minor"] - share["outstanding_minor"]
        share["pending_minor"] = sum(p["amount_minor"] for p in share["payments"] if p["status"] == "REPORTED")
    expense["shares"] = shares
    expense["outstanding_minor"] = sum(share["outstanding_minor"] for share in shares)
    expense["status"] = "OPEN" if any(share["outstanding_minor"] for share in shares) else "SETTLED"
    cur.execute("""
        SELECT a.id, a.kind, a.details, a.payment_id, a.created_at, m.display_name AS actor
        FROM audit_events a JOIN members m ON m.id = a.actor_id
        WHERE a.expense_id = %s ORDER BY a.id
    """, (expense_id,))
    expense["audit"] = cur.fetchall()
    return expense


def share_status(share):
    if not share["outstanding_minor"]:
        return "SETTLED"
    if share["payment_pending"]:
        return "PAYMENT_REPORTED"
    return "PARTIALLY_SETTLED" if share["outstanding_minor"] < share["amount_minor"] else "UNPAID"


def authorize_share(cur, share_id, actor_id):
    cur.execute("""
        SELECT s.id, s.expense_id, s.debtor_id, s.recipient_id
        FROM payable_shares s JOIN expense_viewers v ON v.expense_id = s.expense_id
        WHERE s.id = %s AND v.member_id = %s
    """, (share_id, actor_id))
    share = cur.fetchone()
    if share is None:
        raise HTTPException(404, "Payable share not found.")
    if share["debtor_id"] != actor_id:
        raise HTTPException(403, "Only the payer for this share can report a payment.")
    return share


def authorize_payment(cur, payment_id, actor_id):
    cur.execute("""
        SELECT p.id, p.share_id, p.amount_minor, s.expense_id, s.recipient_id
        FROM payments p JOIN payable_shares s ON s.id = p.share_id
        JOIN expense_viewers v ON v.expense_id = s.expense_id
        WHERE p.id = %s AND v.member_id = %s
    """, (payment_id, actor_id))
    payment = cur.fetchone()
    if payment is None:
        raise HTTPException(404, "Payment report not found.")
    if payment["recipient_id"] != actor_id:
        raise HTTPException(403, "Only the designated recipient can decide this report.")
    return payment


def locked_balance(cur, share_id):
    cur.execute("SELECT id FROM payable_shares WHERE id = %s FOR UPDATE", (share_id,))
    cur.execute("SELECT * FROM share_balances WHERE id = %s", (share_id,))
    return cur.fetchone()


def report_payment(cur, share, actor_id, amount_minor):
    balance = locked_balance(cur, share["id"])
    if not balance["outstanding_minor"] or balance["payment_pending"]:
        raise HTTPException(409, "This share is settled or already has a pending report.")
    if amount_minor <= 0 or amount_minor > balance["outstanding_minor"]:
        raise HTTPException(422, "Report a positive amount no greater than the outstanding balance.")
    cur.execute("""
        INSERT INTO payments (share_id, reported_by, amount_minor)
        VALUES (%s, %s, %s) RETURNING id
    """, (share["id"], actor_id, amount_minor))
    payment_id = cur.fetchone()["id"]
    audit(cur, share["expense_id"], actor_id, "PAYMENT_REPORTED",
          {"amount_minor": amount_minor}, payment_id)
    return {"id": payment_id, "status": "REPORTED"}


def decide_payment(cur, payment, actor_id, *, amount_minor=None, reason=None):
    balance = locked_balance(cur, payment["share_id"])
    cur.execute("SELECT 1 FROM payment_decisions WHERE payment_id = %s", (payment["id"],))
    if cur.fetchone():
        raise HTTPException(409, "This payment report already has a decision.")

    if reason is None:
        if amount_minor != payment["amount_minor"] or amount_minor > balance["outstanding_minor"]:
            raise HTTPException(422, "Confirmation must match the report and fit the outstanding balance.")
        kind = "CONFIRMED"
        details = {"amount_minor": amount_minor}
    else:
        kind = "REJECTED"
        details = {"reason": reason}
    cur.execute("""
        INSERT INTO payment_decisions (payment_id, recipient_id, kind, amount_minor, reason)
        VALUES (%s, %s, %s, %s, %s)
    """, (payment["id"], actor_id, kind, amount_minor, reason))
    audit(cur, payment["expense_id"], actor_id, f"PAYMENT_{kind}", details, payment["id"])
    return {"id": payment["id"], "status": kind}
