import hashlib
import json
import secrets
from pathlib import Path
from typing import Annotated, Literal

from fastapi import FastAPI, Header, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from psycopg2.extras import Json
from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from . import disputes, groups, ledger
from .auth import COOKIE, SESSION_LIFETIME, authenticate, session_token_hash, viewer
from .config import Settings
from .db import connect

Money = Annotated[int, Field(strict=True, gt=0, le=9_007_199_254_740_991)]
ResourceId = Annotated[int, Field(gt=0, le=9_223_372_036_854_775_807)]
RequestKey = Annotated[str, Header(alias="Idempotency-Key", pattern=r"^[A-Za-z0-9_-]{1,128}$")]
NonBlankDescription = Annotated[str, StringConstraints(
    strip_whitespace=True, min_length=1, max_length=160, pattern=r"^[^\x00]+$",
)]
NonBlankReason = Annotated[str, StringConstraints(
    strip_whitespace=True, min_length=1, max_length=500, pattern=r"^[^\x00]+$",
)]
Statement = Annotated[str, StringConstraints(
    strip_whitespace=True, min_length=1, max_length=2000, pattern=r"^[^\x00]+$",
)]
DIST = Path(__file__).resolve().parents[1] / "frontend" / "dist"


class Payload(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Credentials(Payload):
    username: Annotated[str, Field(min_length=1, max_length=64, pattern=r"^[a-z0-9_-]+$")]
    password: Annotated[str, Field(min_length=1, max_length=256)]


class NewGroup(Payload):
    name: NonBlankDescription


class Invitation(Payload):
    username: Annotated[str, Field(min_length=1, max_length=64, pattern=r"^[a-z0-9_-]+$")]


class NewExpense(Payload):
    description: NonBlankDescription
    total_minor: Money
    currency: Literal["USD"] = "USD"


class NewGroupExpense(NewExpense):
    participant_ids: list[Annotated[ResourceId, Field(strict=True)]]
    remainder_policy: Literal["PAYER", "EVEN"] = "PAYER"


class Amount(Payload):
    amount_minor: Money


class Rejection(Payload):
    reason: NonBlankReason


class NewDispute(Payload):
    amount_minor: Money
    reason: Statement


class DisputeResponse(Payload):
    body: Statement


def idempotent(cur, actor_id, request_key, route, payload, operation):
    canonical = json.dumps([route, payload.model_dump()], sort_keys=True)
    fingerprint = hashlib.sha256(canonical.encode()).hexdigest()
    cur.execute("""
        INSERT INTO idempotency_records (actor_id, request_key, fingerprint)
        VALUES (%s, %s, %s) ON CONFLICT DO NOTHING
        RETURNING request_key
    """, (actor_id, request_key, fingerprint))
    if cur.fetchone() is None:
        cur.execute("""
            SELECT fingerprint, response FROM idempotency_records
            WHERE actor_id = %s AND request_key = %s
        """, (actor_id, request_key))
        prior = cur.fetchone()
        if prior["fingerprint"] != fingerprint:
            raise HTTPException(409, "This idempotency key is already used for another request.")
        return prior["response"]

    result = operation()
    cur.execute("""
        UPDATE idempotency_records SET response = %s WHERE actor_id = %s AND request_key = %s
    """, (Json(result), actor_id, request_key))
    return result


def create_app(settings: Settings | None = None):
    settings = settings or Settings.from_env()
    app = FastAPI(title="RoomSync", docs_url=None, redoc_url=None, openapi_url=None)

    @app.middleware("http")
    async def api_security(request, call_next):
        if request.url.path.startswith("/api/"):
            if request.method not in {"GET", "HEAD", "OPTIONS"}:
                if request.headers.get("origin") != settings.origin:
                    return JSONResponse(
                        {"detail": "Request origin is not allowed."}, status_code=403,
                        headers={"Cache-Control": "no-store"},
                    )
            response = await call_next(request)
            response.headers["Cache-Control"] = "no-store"
            return response
        return await call_next(request)

    @app.post("/api/session", status_code=204)
    def login(payload: Credentials, request: Request, response: Response):
        with connect(settings.database_url) as db, db.cursor() as cur:
            member_id = authenticate(cur, payload.username, payload.password)
            if prior := request.cookies.get(COOKIE):
                cur.execute("DELETE FROM sessions WHERE token_hash = %s", (session_token_hash(prior),))
            cur.execute("DELETE FROM sessions WHERE expires_at <= now()")
            token = secrets.token_urlsafe(32)
            cur.execute("""
                INSERT INTO sessions (token_hash, member_id, expires_at)
                VALUES (%s, %s, now() + %s)
            """, (session_token_hash(token), member_id, SESSION_LIFETIME))
        response.set_cookie(
            COOKIE, token, max_age=int(SESSION_LIFETIME.total_seconds()), httponly=True,
            secure=settings.origin.startswith("https://"), samesite="lax",
        )

    @app.get("/api/session")
    def get_session(request: Request):
        with connect(settings.database_url) as db, db.cursor() as cur:
            return {"viewer": viewer(cur, request)}

    @app.delete("/api/session", status_code=204)
    def logout(request: Request, response: Response):
        if token := request.cookies.get(COOKIE):
            with connect(settings.database_url) as db, db.cursor() as cur:
                cur.execute("DELETE FROM sessions WHERE token_hash = %s", (session_token_hash(token),))
        response.delete_cookie(COOKIE, httponly=True, secure=settings.origin.startswith("https://"))

    @app.get("/api/groups")
    def get_groups(request: Request):
        with connect(settings.database_url) as db, db.cursor() as cur:
            return groups.list_groups(cur, viewer(cur, request)["id"])

    @app.post("/api/groups", status_code=201)
    def add_group(payload: NewGroup, request: Request, key: RequestKey):
        with connect(settings.database_url) as db, db.cursor() as cur:
            actor = viewer(cur, request)["id"]
            return idempotent(cur, actor, key, "create-group", payload,
                              lambda: groups.create_group(cur, actor, payload.name))

    @app.get("/api/groups/{group_id}")
    def get_group(group_id: ResourceId, request: Request):
        with connect(settings.database_url) as db, db.cursor() as cur:
            return groups.group_detail(cur, group_id, viewer(cur, request)["id"])

    @app.post("/api/groups/{group_id}/invitations", status_code=204)
    def add_invitation(group_id: ResourceId, payload: Invitation, request: Request):
        with connect(settings.database_url) as db, db.cursor() as cur:
            groups.invite(cur, group_id, viewer(cur, request)["id"], payload.username)

    @app.post("/api/groups/{group_id}/join", status_code=204)
    def join_group(group_id: ResourceId, request: Request):
        with connect(settings.database_url) as db, db.cursor() as cur:
            groups.join(cur, group_id, viewer(cur, request)["id"])

    @app.get("/api/groups/{group_id}/expenses")
    def get_group_expenses(group_id: ResourceId, request: Request):
        with connect(settings.database_url) as db, db.cursor() as cur:
            actor = viewer(cur, request)["id"]
            groups.require_group(cur, group_id, actor)
            return ledger.list_expenses(cur, actor, group_id)

    @app.post("/api/groups/{group_id}/expenses", status_code=201)
    def add_group_expense(group_id: ResourceId, payload: NewGroupExpense, request: Request, key: RequestKey):
        with connect(settings.database_url) as db, db.cursor() as cur:
            actor = viewer(cur, request)["id"]
            groups.require_group(cur, group_id, actor)
            payload.participant_ids.sort()
            return idempotent(
                cur, actor, key, f"create-group-expense:{group_id}", payload,
                lambda: ledger.create_group_expense(
                    cur, group_id, actor, payload.description, payload.total_minor,
                    payload.participant_ids, payload.remainder_policy,
                ),
            )

    @app.get("/api/expenses")
    def get_expenses(request: Request):
        with connect(settings.database_url) as db, db.cursor() as cur:
            return ledger.list_expenses(cur, viewer(cur, request)["id"])

    @app.post("/api/expenses", status_code=201)
    def add_expense(payload: NewExpense, request: Request, key: RequestKey):
        with connect(settings.database_url) as db, db.cursor() as cur:
            actor = viewer(cur, request)["id"]
            return idempotent(cur, actor, key, "create-expense", payload,
                              lambda: ledger.create_expense(cur, actor, payload.description, payload.total_minor))

    @app.get("/api/expenses/{expense_id}")
    def get_expense(expense_id: ResourceId, request: Request):
        with connect(settings.database_url) as db, db.cursor() as cur:
            cur.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            actor = viewer(cur, request)["id"]
            expense = ledger.expense_detail(cur, expense_id, actor, settings.links)
            disputes.attach_threads(cur, expense["shares"])
            return expense

    @app.post("/api/shares/{share_id}/disputes", status_code=201)
    def open_dispute(share_id: ResourceId, payload: NewDispute, request: Request, key: RequestKey):
        with connect(settings.database_url) as db, db.cursor() as cur:
            actor = viewer(cur, request)["id"]
            share = disputes.authorize_creation(cur, share_id, actor)
            return idempotent(cur, actor, key, f"open-dispute:{share_id}", payload,
                              lambda: disputes.create_dispute(cur, share, actor, payload.amount_minor, payload.reason))

    @app.post("/api/disputes/{dispute_id}/responses", status_code=201)
    def respond_to_dispute(dispute_id: ResourceId, payload: DisputeResponse, request: Request, key: RequestKey):
        with connect(settings.database_url) as db, db.cursor() as cur:
            actor = viewer(cur, request)["id"]
            dispute = disputes.authorize_response(cur, dispute_id, actor)
            return idempotent(cur, actor, key, f"dispute-response:{dispute_id}", payload,
                              lambda: disputes.add_response(cur, dispute, actor, payload.body))

    @app.post("/api/shares/{share_id}/payments", status_code=201)
    def report(share_id: ResourceId, payload: Amount, request: Request, key: RequestKey):
        with connect(settings.database_url) as db, db.cursor() as cur:
            actor = viewer(cur, request)["id"]
            share = ledger.authorize_share(cur, share_id, actor)
            return idempotent(cur, actor, key, f"report:{share_id}", payload,
                              lambda: ledger.report_payment(cur, share, actor, payload.amount_minor))

    @app.post("/api/payments/{payment_id}/confirm")
    def confirm(payment_id: ResourceId, payload: Amount, request: Request, key: RequestKey):
        with connect(settings.database_url) as db, db.cursor() as cur:
            actor = viewer(cur, request)["id"]
            payment = ledger.authorize_payment(cur, payment_id, actor)
            return idempotent(cur, actor, key, f"confirm:{payment_id}", payload,
                              lambda: ledger.decide_payment(cur, payment, actor, amount_minor=payload.amount_minor))

    @app.post("/api/payments/{payment_id}/reject")
    def reject(payment_id: ResourceId, payload: Rejection, request: Request, key: RequestKey):
        with connect(settings.database_url) as db, db.cursor() as cur:
            actor = viewer(cur, request)["id"]
            payment = ledger.authorize_payment(cur, payment_id, actor)
            return idempotent(cur, actor, key, f"reject:{payment_id}", payload,
                              lambda: ledger.decide_payment(cur, payment, actor, reason=payload.reason))

    if (DIST / "assets").is_dir():
        app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/", include_in_schema=False)
    @app.get("/history", include_in_schema=False)
    @app.get("/groups/{group_id}", include_in_schema=False)
    def home():
        index = DIST / "index.html"
        if not index.is_file():
            raise HTTPException(503, "Build the frontend before starting RoomSync.")
        return FileResponse(index)

    return app
