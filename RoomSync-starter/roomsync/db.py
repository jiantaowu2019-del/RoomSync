from contextlib import contextmanager
from pathlib import Path

import psycopg2
from psycopg2.extras import RealDictCursor

MIGRATION_LOCK = 708292410


@contextmanager
def connect(database_url: str):
    db = psycopg2.connect(database_url, cursor_factory=RealDictCursor, connect_timeout=5)
    try:
        with db:
            yield db
    finally:
        db.close()


def migrate(db):
    with db.cursor() as cur:
        cur.execute("SELECT pg_advisory_xact_lock(%s)", (MIGRATION_LOCK,))
        cur.execute("""
            CREATE TABLE IF NOT EXISTS schema_migrations (
                name text PRIMARY KEY,
                applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
            )
        """)
        for path in sorted(Path(__file__).with_name("migrations").glob("*.sql")):
            cur.execute("SELECT 1 FROM schema_migrations WHERE name = %s", (path.name,))
            if cur.fetchone() is None:
                cur.execute(path.read_text(encoding="utf-8"))
                cur.execute("INSERT INTO schema_migrations (name) VALUES (%s)", (path.name,))
