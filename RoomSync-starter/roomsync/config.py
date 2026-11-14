import os
import re
from dataclasses import dataclass
from urllib.parse import urlsplit

MOCK_HOST = "pay.example.test"


@dataclass(frozen=True)
class PaymentLinks:
    host: str
    path_prefix: str
    recipients: dict[str, str]

    def __post_init__(self):
        label = r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
        if not re.fullmatch(rf"(?:{label}\.)+{label}", self.host) or len(self.host) > 253:
            raise ValueError("Payment host must be an exact lowercase DNS hostname.")
        if not re.fullmatch(r"/(?:[A-Za-z0-9_-]+/)*", self.path_prefix):
            raise ValueError("Payment path prefix must start and end with a slash.")
        handle_path = re.escape(self.path_prefix) + r"[A-Za-z0-9_-]{1,128}"
        for url in self.recipients.values():
            if not re.fullmatch(rf"https://{re.escape(self.host)}{handle_path}", url):
                raise ValueError("Payment URL does not match the configured HTTPS host and handle path.")


@dataclass(frozen=True)
class Settings:
    database_url: str
    origin: str
    links: PaymentLinks

    def __post_init__(self):
        origin = urlsplit(self.origin)
        if origin.path or origin.query or origin.fragment or not origin.hostname or origin.username:
            raise ValueError("ROOMSYNC_ORIGIN must be a bare HTTP(S) origin.")
        if origin.scheme == "http" and origin.hostname in {"127.0.0.1", "localhost", "::1"}:
            return
        if origin.scheme != "https":
            raise ValueError("ROOMSYNC_ORIGIN must use HTTPS outside localhost.")

    @classmethod
    def from_env(cls):
        return cls(
            database_url=os.environ["ROOMSYNC_DATABASE_URL"],
            origin=os.getenv("ROOMSYNC_ORIGIN", "http://127.0.0.1:8000"),
            links=PaymentLinks(
                host=os.getenv("ROOMSYNC_PAYMENT_HOST", MOCK_HOST),
                path_prefix=os.getenv("ROOMSYNC_PAYMENT_PATH_PREFIX", "/u/"),
                recipients={
                    username: url
                    for username in ("alex", "sam")
                    if (url := os.getenv(f"ROOMSYNC_{username.upper()}_PAYMENT_URL"))
                },
            ),
        )
