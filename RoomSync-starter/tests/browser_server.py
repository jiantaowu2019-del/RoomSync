import os

import uvicorn

from roomsync.http import create_app
from tests.support import browser_settings

if __name__ == "__main__":
    port = int(os.environ["ROOMSYNC_E2E_PORT"])
    settings = browser_settings(f"http://127.0.0.1:{port}")
    uvicorn.run(create_app(settings), host="127.0.0.1", port=port, log_level="warning")
