import pytest

from roomsync.config import MOCK_HOST, PaymentLinks, Settings


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


def test_payment_policy_and_recipients_are_configurable(monkeypatch):
    monkeypatch.setenv("ROOMSYNC_DATABASE_URL", "dbname=unused")
    monkeypatch.setenv("ROOMSYNC_ORIGIN", "http://localhost:8000")
    monkeypatch.setenv("ROOMSYNC_PAYMENT_HOST", "other-mock.example.test")
    monkeypatch.setenv("ROOMSYNC_PAYMENT_PATH_PREFIX", "/mock/receivers/")
    monkeypatch.setenv("ROOMSYNC_ALEX_PAYMENT_URL", "https://other-mock.example.test/mock/receivers/alex_1")
    monkeypatch.setenv("ROOMSYNC_SAM_PAYMENT_URL", "https://other-mock.example.test/mock/receivers/sam-2")
    settings = Settings.from_env()
    assert settings.links.recipients == {
        "alex": "https://other-mock.example.test/mock/receivers/alex_1",
        "sam": "https://other-mock.example.test/mock/receivers/sam-2",
    }


@pytest.mark.parametrize(("host", "prefix"), [("*.example.test", "/"), (MOCK_HOST, "/../"), (MOCK_HOST, "u/")])
def test_invalid_payment_policy_fails_closed(host, prefix):
    with pytest.raises(ValueError):
        PaymentLinks(host, prefix, {})
