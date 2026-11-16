from unittest.mock import Mock

import pytest
from fastapi import HTTPException

from roomsync.auth import authenticate, password_hash
from roomsync.setup import demo_passwords


@pytest.mark.parametrize(("alex", "sam", "message"), [
    ("", "valid-sam-test-password", "non-example"),
    ("replace-with-local-alex-password", "valid-sam-test-password", "non-example"),
    ("valid-alex-test-password", "replace-with-local-sam-password", "non-example"),
    ("replace-with-local-sam-password", "valid-sam-test-password", "non-example"),
    ("the-same-demo-password", "the-same-demo-password", "different"),
])
def test_setup_rejects_missing_example_or_reused_passwords(monkeypatch, alex, sam, message):
    monkeypatch.setenv("ROOMSYNC_ALEX_PASSWORD", alex)
    monkeypatch.setenv("ROOMSYNC_SAM_PASSWORD", sam)
    with pytest.raises(SystemExit, match=message):
        demo_passwords()


def test_setup_accepts_distinct_local_passwords(monkeypatch):
    monkeypatch.setenv("ROOMSYNC_ALEX_PASSWORD", "valid-alex-test-password")
    monkeypatch.setenv("ROOMSYNC_SAM_PASSWORD", "valid-sam-test-password")
    monkeypatch.delenv("ROOMSYNC_CASEY_PASSWORD", raising=False)
    monkeypatch.delenv("ROOMSYNC_JORDAN_PASSWORD", raising=False)
    assert demo_passwords() == {"alex": "valid-alex-test-password", "sam": "valid-sam-test-password"}


def test_setup_requires_both_additional_demo_passwords(monkeypatch):
    monkeypatch.setenv("ROOMSYNC_ALEX_PASSWORD", "valid-alex-test-password")
    monkeypatch.setenv("ROOMSYNC_SAM_PASSWORD", "valid-sam-test-password")
    monkeypatch.setenv("ROOMSYNC_CASEY_PASSWORD", "valid-casey-test-password")
    monkeypatch.delenv("ROOMSYNC_JORDAN_PASSWORD", raising=False)
    with pytest.raises(SystemExit, match="non-example"):
        demo_passwords()
    monkeypatch.setenv("ROOMSYNC_JORDAN_PASSWORD", "valid-jordan-test-password")
    assert set(demo_passwords()) == {"alex", "sam", "casey", "jordan"}


def test_login_rejects_a_legacy_example_password():
    password = "replace-with-local-alex-password"
    cur = Mock()
    cur.fetchone.return_value = {"id": 1, "password_hash": password_hash(password)}
    with pytest.raises(HTTPException) as error:
        authenticate(cur, "alex", password)
    assert error.value.status_code == 401
