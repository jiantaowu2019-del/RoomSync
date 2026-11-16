import os

from .auth import EXAMPLE_PASSWORDS, password_hash, password_matches
from .config import Settings
from .db import connect, migrate

DEMO_USERS = {"alex": "Alex", "sam": "Sam"}


def seed_member(cur, username: str, name: str, password: str):
    cur.execute("""
        INSERT INTO members (username, display_name, password_hash, demo_member)
        VALUES (%s, %s, %s, true)
        ON CONFLICT (username) DO NOTHING RETURNING id
    """, (username, name, password_hash(password)))
    if cur.fetchone() is not None:
        return

    cur.execute("SELECT demo_member, password_hash FROM members WHERE username = %s", (username,))
    existing = cur.fetchone()
    if not existing["demo_member"] or not password_matches(password, existing["password_hash"]):
        raise SystemExit(f"Existing account '{username}' does not match the configured demo credentials.")


def demo_passwords():
    passwords = {
        username: os.getenv(f"ROOMSYNC_{username.upper()}_PASSWORD", "")
        for username in DEMO_USERS
    }
    if any(not 12 <= len(password) <= 256 or password in EXAMPLE_PASSWORDS for password in passwords.values()):
        raise SystemExit("Set each demo password to a non-example value between 12 and 256 characters.")
    if len(set(passwords.values())) != len(DEMO_USERS):
        raise SystemExit("Alex and Sam must have different demo passwords.")
    return passwords


def main():
    settings = Settings.from_env()
    passwords = demo_passwords()
    with connect(settings.database_url) as db:
        migrate(db)
        with db.cursor() as cur:
            for username, name in DEMO_USERS.items():
                seed_member(cur, username, name, passwords[username])
    print("RoomSync schema and demo users are ready.")


if __name__ == "__main__":
    main()
