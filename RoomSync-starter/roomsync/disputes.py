from fastapi import HTTPException

from . import ledger


def authorize_creation(cur, share_id, actor_id):
    cur.execute("""
        SELECT s.id, s.expense_id, s.debtor_id
        FROM payable_shares s JOIN expense_viewers v ON v.expense_id = s.expense_id
        WHERE s.id = %s AND v.member_id = %s
    """, (share_id, actor_id))
    share = cur.fetchone()
    if share is None:
        raise HTTPException(404, "Payable share not found.")
    if share["debtor_id"] != actor_id:
        raise HTTPException(403, "Only the debtor for this share can open a dispute.")
    return share


def authorize_response(cur, dispute_id, actor_id):
    cur.execute("""
        SELECT d.id, d.share_id, s.expense_id, s.debtor_id, s.recipient_id
        FROM disputes d JOIN payable_shares s ON s.id = d.share_id
        JOIN expense_viewers v ON v.expense_id = s.expense_id
        WHERE d.id = %s AND v.member_id = %s
    """, (dispute_id, actor_id))
    dispute = cur.fetchone()
    if dispute is None:
        raise HTTPException(404, "Dispute not found.")
    if actor_id not in (dispute["debtor_id"], dispute["recipient_id"]):
        raise HTTPException(403, "Only this share's debtor and recipient can respond.")
    return dispute


def create_dispute(cur, share, actor_id, amount_minor, reason):
    # The same Share lock serializes creation with receipt confirmation.
    balance = ledger.locked_balance(cur, share["id"])
    cur.execute("SELECT 1 FROM disputes WHERE share_id = %s", (share["id"],))
    if cur.fetchone():
        raise HTTPException(409, "This share already has a dispute thread.")
    if balance["outstanding_minor"] == 0:
        raise HTTPException(409, "A settled share cannot accept a new dispute.")
    if amount_minor <= 0 or amount_minor > balance["outstanding_minor"]:
        raise HTTPException(422, "The dispute amount must fit the current outstanding balance.")
    cur.execute("""
        INSERT INTO disputes (share_id, opened_by, claimed_minor, outstanding_at_open_minor, reason)
        VALUES (%s, %s, %s, %s, %s) RETURNING id
    """, (share["id"], actor_id, amount_minor, balance["outstanding_minor"], reason))
    dispute_id = cur.fetchone()["id"]
    ledger.audit(cur, share["expense_id"], actor_id, "DISPUTE_OPENED", {
        "dispute_id": dispute_id, "share_id": share["id"], "claimed_minor": amount_minor,
        "outstanding_at_open_minor": balance["outstanding_minor"],
    })
    return {"id": dispute_id, "status": "OPEN"}


def add_response(cur, dispute, actor_id, body):
    cur.execute("""
        INSERT INTO dispute_responses (dispute_id, author_id, body)
        VALUES (%s, %s, %s) RETURNING id
    """, (dispute["id"], actor_id, body))
    response_id = cur.fetchone()["id"]
    ledger.audit(cur, dispute["expense_id"], actor_id, "DISPUTE_RESPONSE_ADDED", {
        "dispute_id": dispute["id"], "share_id": dispute["share_id"], "response_id": response_id,
    })
    return {"id": response_id}


def attach_threads(cur, shares):
    """Attach two independent batch reads to already-authorized, calculated shares."""
    shares_by_id = {share["id"]: share for share in shares}
    for share in shares:
        share["dispute"] = None
    if not shares_by_id:
        return

    # Never join responses into the payment SUM: one receipt could appear many times.
    cur.execute("""
        SELECT d.*, m.display_name AS opened_by_name
        FROM disputes d JOIN members m ON m.id = d.opened_by
        WHERE d.share_id = ANY(%s) ORDER BY d.id
    """, (list(shares_by_id),))
    threads_by_id = {}
    for thread in cur.fetchall():
        thread["status"] = "OPEN"
        thread["responses"] = []
        threads_by_id[thread["id"]] = thread
        shares_by_id[thread["share_id"]]["dispute"] = thread
    if not threads_by_id:
        return

    cur.execute("""
        SELECT r.*, m.display_name AS author
        FROM dispute_responses r JOIN members m ON m.id = r.author_id
        WHERE r.dispute_id = ANY(%s) ORDER BY r.id
    """, (list(threads_by_id),))
    for response in cur.fetchall():
        threads_by_id[response["dispute_id"]]["responses"].append(response)
