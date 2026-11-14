import uvicorn

from roomsync.http import create_app
from tests.support import isolated_settings

ORIGIN = "http://127.0.0.1:8765"

if __name__ == "__main__":
    with isolated_settings(ORIGIN) as settings:
        uvicorn.run(create_app(settings), host="127.0.0.1", port=8765, log_level="warning")
