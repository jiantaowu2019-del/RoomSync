import os

from .auth import password_hash
from .config import Settings
from .db import connect, migrate

DEMO_USERS = {"alex": "Alex", "sam": "Sam"}


def seed_member(cur, username: str, name: str, password: str):
    cur.execute("""
        INSERT INTO members (username, display_name, password_hash, demo_member)
        VALUES (%s, %s, %s, true)
        ON CONFLICT (username) DO NOTHING
    """, (username, name, password_hash(password)))


def main():
    settings = Settings.from_env()
    passwords = {
        username: os.environ[f"ROOMSYNC_{username.upper()}_PASSWORD"]
        for username in DEMO_USERS
    }
    if any(len(password) < 12 or len(password) > 256 for password in passwords.values()):
        raise SystemExit("Local demo passwords must be between 12 and 256 characters.")
    with connect(settings.database_url) as db:
        migrate(db)
        with db.cursor() as cur:
            for username, name in DEMO_USERS.items():
                seed_member(cur, username, name, passwords[username])
    print("RoomSync schema and demo users are ready.")


if __name__ == "__main__":
    main()
