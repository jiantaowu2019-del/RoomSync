import json
import shutil
import subprocess
from pathlib import Path

import pytest
from psycopg2.extensions import parse_dsn

from roomsync.config import MOCK_HOST, MOCK_PATH_PREFIX, PaymentLinks, Settings
from tests.support import validate_test_dsn


@pytest.mark.parametrize("url", [
    "http://pay.example.test/u/alex",
    "https://pay.example.test.evil.test/u/alex",
    "https://evil.test@pay.example.test/u/alex",
    "https://pay.example.test:443/u/alex",
    "https://pay.example.test./u/alex",
    "https://pay.example.test/u/../alex",
    "https://pay.example.test/u/alex%2fother",
    "https://pay.example.test/u/alex?next=https://evil.test",
    "https://pay.example.test/u/alex#receipt",
    "https://pay.example.test/another/alex",
    "https://pay.example.test/u/alex\n",
])
def test_untrusted_payment_links_are_rejected(url):
    with pytest.raises(ValueError, match="Payment URL"):
        PaymentLinks(MOCK_HOST, "/u/", {"alex": url})


def test_mock_payment_recipients_are_configurable(monkeypatch):
    monkeypatch.setenv("ROOMSYNC_DATABASE_URL", "dbname=unused")
    monkeypatch.setenv("ROOMSYNC_ORIGIN", "http://localhost:8000")
    monkeypatch.setenv("ROOMSYNC_PAYMENT_HOST", MOCK_HOST)
    monkeypatch.setenv("ROOMSYNC_PAYMENT_PATH_PREFIX", MOCK_PATH_PREFIX)
    monkeypatch.setenv("ROOMSYNC_ALEX_PAYMENT_URL", "https://pay.example.test/u/alex_1")
    monkeypatch.setenv("ROOMSYNC_SAM_PAYMENT_URL", "https://pay.example.test/u/sam-2")
    settings = Settings.from_env()
    assert settings.links.recipients == {
        "alex": "https://pay.example.test/u/alex_1",
        "sam": "https://pay.example.test/u/sam-2",
    }


@pytest.mark.parametrize(("host", "prefix"), [("*.example.test", "/"), (MOCK_HOST, "/../"), (MOCK_HOST, "u/")])
def test_invalid_payment_policy_fails_closed(host, prefix):
    with pytest.raises(ValueError):
        PaymentLinks(host, prefix, {})


@pytest.mark.parametrize("host", ["unapproved.example.test", "127.1", "0x7f.1", "127.0.0.1"])
def test_matching_url_does_not_authorize_unapproved_host(host):
    with pytest.raises(ValueError, match="mock"):
        PaymentLinks(host, MOCK_PATH_PREFIX, {"alex": f"https://{host}/u/alex"})


@pytest.mark.parametrize("origin", [
    "https://example.test:", "https://example.test:abc", "https://example.test:65536",
    "https://example.test:0", "https://example.test:443", "https://example.test:08443",
    "https://:password@example.test", "https://@example.test", "https://Example.test",
    "https://example.test/", "https://example.test?", "https://example.test#",
    "https://[fe80::1%25eth0]",
    "https://127.1", "https://0x7f.1", " http://localhost:8000", "http://example.test",
])
def test_invalid_or_noncanonical_origin_is_rejected(origin):
    with pytest.raises(ValueError, match="ROOMSYNC_ORIGIN"):
        Settings("dbname=unused", origin, PaymentLinks(MOCK_HOST, MOCK_PATH_PREFIX, {}))


@pytest.mark.parametrize("origin", [
    "http://127.0.0.1:8000", "http://localhost", "http://[::1]:8000",
    "https://example.test", "https://example.test:8443",
])
def test_canonical_origin_is_accepted(origin):
    assert Settings("dbname=unused", origin, PaymentLinks(MOCK_HOST, MOCK_PATH_PREFIX, {})).origin == origin


def test_local_database_url_uses_default_and_shared_compose_settings(monkeypatch):
    for name in ("ROOMSYNC_DATABASE_URL", "ROOMSYNC_DB_PORT", "ROOMSYNC_DB_PASSWORD"):
        monkeypatch.delenv(name, raising=False)
    assert parse_dsn(Settings.from_env().database_url)["port"] == "5432"

    monkeypatch.setenv("ROOMSYNC_DB_PORT", "5433")
    monkeypatch.setenv("ROOMSYNC_DB_PASSWORD", "test@password:/#?")
    resolved = parse_dsn(Settings.from_env().database_url)
    assert resolved == {
        "user": "roomsync", "password": "test@password:/#?", "dbname": "roomsync",
        "host": "127.0.0.1", "port": "5433",
    }

    monkeypatch.setenv("ROOMSYNC_DB_PORT", "not-a-port")
    with pytest.raises(ValueError, match="ROOMSYNC_DB_PORT"):
        Settings.from_env()
    monkeypatch.setenv("ROOMSYNC_DATABASE_URL", "dbname=external")
    assert Settings.from_env().database_url == "dbname=external"


@pytest.mark.parametrize("host_port", [None, "5433"])
def test_compose_and_app_share_the_local_database_config(monkeypatch, host_port):
    if not shutil.which("docker"):
        pytest.skip("Docker Compose CLI is required to render the configuration.")
    root = Path(__file__).resolve().parents[1]
    monkeypatch.delenv("ROOMSYNC_DATABASE_URL", raising=False)
    monkeypatch.delenv("ROOMSYNC_DB_PORT", raising=False)
    monkeypatch.delenv("ROOMSYNC_DB_PASSWORD", raising=False)
    if host_port:
        monkeypatch.setenv("ROOMSYNC_DB_PORT", host_port)
        monkeypatch.setenv("ROOMSYNC_DB_PASSWORD", "local@config-test")
    result = subprocess.run(
        ["docker", "compose", "-f", "compose.yaml", "--env-file", ".env.example", "config", "--format", "json"],
        cwd=root, capture_output=True, text=True, check=True, timeout=15,
    )
    service = json.loads(result.stdout)["services"]["db"]
    port = service["ports"][0]
    dsn = parse_dsn(Settings.from_env().database_url)
    assert port["host_ip"] == dsn["host"] == "127.0.0.1"
    assert str(port["published"]) == dsn["port"] == (host_port or "5432")
    assert port["target"] == 5432
    assert service["environment"]["POSTGRES_PASSWORD"] == dsn["password"]


@pytest.mark.parametrize("name", ["roomsync", "postgres", ""])
def test_integration_test_dsn_cannot_target_development_db(name):
    with pytest.raises(ValueError, match="dedicated PostgreSQL database"):
        validate_test_dsn(f"dbname='{name}'")
