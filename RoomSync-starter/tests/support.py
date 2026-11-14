import os
from contextlib import contextmanager
from uuid import uuid4

from psycopg2 import sql
from psycopg2.extensions import make_dsn

from roomsync.config import MOCK_HOST, PaymentLinks, Settings
from roomsync.db import connect, migrate
from roomsync.setup import DEMO_USERS, seed_member

PASSWORDS = {"alex": "demo-alex-test-123", "sam": "demo-sam-test-123"}
MOCK_URL = f"https://{MOCK_HOST}/u/alex"


@contextmanager
def isolated_settings(origin):
    base_url = os.environ["ROOMSYNC_TEST_DATABASE_URL"]
    schema = "test_" + uuid4().hex
    quoted_schema = sql.Identifier(schema)
    with connect(base_url) as db, db.cursor() as cur:
        cur.execute(sql.SQL("CREATE SCHEMA {}").format(quoted_schema))
    schema_dsn = make_dsn(base_url, options=f"-c search_path={schema}")
    try:
        settings = Settings(schema_dsn, origin, PaymentLinks(MOCK_HOST, "/u/", {"alex": MOCK_URL}))
        with connect(schema_dsn) as db, db.cursor() as cur:
            migrate(db)
            for username, display_name in DEMO_USERS.items():
                seed_member(cur, username, display_name, PASSWORDS[username])
        yield settings
    finally:
        with connect(base_url) as db, db.cursor() as cur:
            cur.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(quoted_schema))
