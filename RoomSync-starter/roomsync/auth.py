import hashlib
import hmac
import secrets
from datetime import timedelta

from fastapi import HTTPException
from starlette.requests import Request

COOKIE = "roomsync_session"
SESSION_LIFETIME = timedelta(hours=8)
PASSWORD_ITERATIONS = 600_000


def password_hash(password: str, salt: bytes | None = None) -> str:
    salt = salt if salt is not None else secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PASSWORD_ITERATIONS)
    return f"{salt.hex()}:{digest.hex()}"


def authenticate(cur, username: str, password: str):
    cur.execute("SELECT id, password_hash FROM members WHERE username = %s AND demo_member", (username,))
    member = cur.fetchone()
    stored_hash = member["password_hash"] if member else ("00" * 16 + ":" + "00" * 32)
    salt = bytes.fromhex(stored_hash.split(":")[0])
    if not hmac.compare_digest(stored_hash, password_hash(password, salt)) or not member:
        raise HTTPException(401, "Invalid username or password.")
    return member["id"]


def session_token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def viewer(cur, request: Request):
    token = request.cookies.get(COOKIE)
    if token:
        cur.execute("""
            SELECT m.id, m.username, m.display_name
            FROM sessions s JOIN members m ON m.id = s.member_id
            WHERE s.token_hash = %s AND s.expires_at > now()
        """, (session_token_hash(token),))
        member = cur.fetchone()
        if member:
            return member
    raise HTTPException(401, "Sign in to continue.")
