import os
import re
from dataclasses import dataclass
from ipaddress import IPv4Address, IPv6Address
from urllib.parse import quote, urlsplit

MOCK_HOST = "pay.example.test"
MOCK_PATH_PREFIX = "/u/"
DEFAULT_DB_PORT = "5432"
DEFAULT_DB_PASSWORD = "roomsync-local"


def local_database_url():
    port = os.getenv("ROOMSYNC_DB_PORT") or DEFAULT_DB_PORT
    if not re.fullmatch(r"[1-9][0-9]{0,4}", port) or int(port) > 65535:
        raise ValueError("ROOMSYNC_DB_PORT must be an integer between 1 and 65535.")
    password = quote(os.getenv("ROOMSYNC_DB_PASSWORD") or DEFAULT_DB_PASSWORD, safe="")
    return f"postgresql://roomsync:{password}@127.0.0.1:{port}/roomsync"


def validate_origin(value: str):
    try:
        origin = urlsplit(value)
        port = origin.port
        host = origin.hostname
        if not host or origin.scheme not in {"http", "https"}:
            raise ValueError
        if ":" in host:
            if "%" in host:
                raise ValueError
            authority = f"[{IPv6Address(host).compressed}]"
        else:
            label = r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
            if not re.fullmatch(rf"{label}(?:\.{label})*", host):
                raise ValueError
            last_label = host.rsplit(".", 1)[-1]
            if re.fullmatch(r"(?:[0-9]+|0x[0-9a-f]*)", last_label):
                authority = str(IPv4Address(host))
            else:
                authority = host
        default_port = 80 if origin.scheme == "http" else 443
        if port is not None and port != default_port:
            authority += f":{port}"
        if port == 0 or value != f"{origin.scheme}://{authority}":
            raise ValueError
    except ValueError:
        raise ValueError("ROOMSYNC_ORIGIN must be a canonical HTTP(S) origin.") from None

    if origin.scheme == "http" and host not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError("ROOMSYNC_ORIGIN must use HTTPS outside localhost.")


@dataclass(frozen=True)
class PaymentLinks:
    host: str
    path_prefix: str
    recipients: dict[str, str]

    def __post_init__(self):
        if (self.host, self.path_prefix) != (MOCK_HOST, MOCK_PATH_PREFIX):
            raise ValueError("Only the approved mock payment host and path are supported.")
        prefix = re.escape(f"https://{MOCK_HOST}{MOCK_PATH_PREFIX}")
        for url in self.recipients.values():
            if not re.fullmatch(rf"{prefix}[A-Za-z0-9_-]{{1,128}}", url):
                raise ValueError("Payment URL must use the approved HTTPS mock host and handle path.")


@dataclass(frozen=True)
class Settings:
    database_url: str
    origin: str
    links: PaymentLinks

    def __post_init__(self):
        validate_origin(self.origin)

    @classmethod
    def from_env(cls):
        return cls(
            database_url=os.getenv("ROOMSYNC_DATABASE_URL") or local_database_url(),
            origin=os.getenv("ROOMSYNC_ORIGIN", "http://127.0.0.1:8000"),
            links=PaymentLinks(
                host=os.getenv("ROOMSYNC_PAYMENT_HOST", MOCK_HOST),
                path_prefix=os.getenv("ROOMSYNC_PAYMENT_PATH_PREFIX", MOCK_PATH_PREFIX),
                recipients={
                    username: url
                    for username in ("alex", "sam")
                    if (url := os.getenv(f"ROOMSYNC_{username.upper()}_PAYMENT_URL"))
                },
            ),
        )
