import os
import re
from contextlib import contextmanager
from uuid import uuid4

from psycopg2 import sql
from psycopg2.extensions import make_dsn, parse_dsn

from roomsync.config import MOCK_HOST, MOCK_PATH_PREFIX, PaymentLinks, Settings
from roomsync.db import connect, migrate
from roomsync.setup import DEMO_USERS, seed_member

PASSWORDS = {name: f"demo-{name}-test-123" for name in DEMO_USERS}
MOCK_URL = f"https://{MOCK_HOST}/u/alex"
BROWSER_DSN = "ROOMSYNC_BROWSER_TEST_DSN"


def validate_test_dsn(dsn):
    database = parse_dsn(dsn).get("dbname", "")
    if not database.endswith("_test"):
        raise ValueError("Use a dedicated PostgreSQL database whose name ends in _test.")
    return dsn


def mock_settings(dsn, origin):
    return Settings(dsn, origin, PaymentLinks(MOCK_HOST, MOCK_PATH_PREFIX, {"alex": MOCK_URL}))


def browser_settings(origin):
    dsn = validate_test_dsn(os.environ.get(BROWSER_DSN, ""))
    if not re.fullmatch(r"-c search_path=test_[a-f0-9]{32}", parse_dsn(dsn).get("options", "")):
        raise ValueError("Start browser tests through npm run test:e2e to provision an isolated schema.")
    return mock_settings(dsn, origin)


@contextmanager
def temporary_schema():
    base_url = validate_test_dsn(os.environ.get("ROOMSYNC_TEST_DATABASE_URL", ""))
    schema = "test_" + uuid4().hex
    quoted_schema = sql.Identifier(schema)
    with connect(base_url) as db, db.cursor() as cur:
        cur.execute(sql.SQL("CREATE SCHEMA {}").format(quoted_schema))
    schema_dsn = make_dsn(base_url, options=f"-c search_path={schema}")
    try:
        yield schema_dsn
    finally:
        with connect(base_url) as db, db.cursor() as cur:
            cur.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(quoted_schema))


@contextmanager
def isolated_database():
    with temporary_schema() as dsn:
        with connect(dsn) as db, db.cursor() as cur:
            migrate(db)
            for username, display_name in DEMO_USERS.items():
                seed_member(cur, username, display_name, PASSWORDS[username])
        yield dsn


@contextmanager
def isolated_settings(origin):
    with isolated_database() as dsn:
        yield mock_settings(dsn, origin)
