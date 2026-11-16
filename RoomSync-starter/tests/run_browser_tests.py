import os
import subprocess
import sys
from pathlib import Path

from tests.support import BROWSER_DSN, isolated_database

FRONTEND = Path(__file__).resolve().parents[1] / "frontend"


def run_browser_tests(args):
    with isolated_database() as dsn:
        # The runner owns teardown even when Playwright force-kills its web server.
        return subprocess.run(
            ["node", str(FRONTEND / "node_modules" / "@playwright" / "test" / "cli.js"), "test", *args],
            cwd=FRONTEND,
            env={**os.environ, BROWSER_DSN: dsn},
            check=False,
        ).returncode


if __name__ == "__main__":
    raise SystemExit(run_browser_tests(sys.argv[1:]))
