# RoomSync — Vertical Slice 1

RoomSync records the equal split of a USD expense and tracks an external payment
from the payer's report through the designated recipient's manual confirmation.
The two demo members are Alex and Sam.

## Run locally on Windows

Install Python 3.12 or later, Node.js 22.12 or later, and PostgreSQL. The included
Compose file can start PostgreSQL 18 if you have Docker Desktop running. Run the
following in PowerShell from the project directory.

```powershell
docker compose up -d db
Copy-Item .env.example .env
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-test.txt
npm.cmd --prefix frontend ci
npm.cmd --prefix frontend run build
```

Set distinct local passwords for Alex and Sam in `.env` (at least 12 characters
each). If you already run PostgreSQL, use an empty development database with a
local user that can create schema objects, and update `ROOMSYNC_DATABASE_URL`.
Load the settings into the current shell, apply the migration, and start the app.

```powershell
Get-Content .env | ForEach-Object {
  if ($_ -match '^([A-Z_]+)=(.*)$') {
    Set-Item -Path "Env:$($Matches[1])" -Value $Matches[2]
  }
}
.\.venv\Scripts\python.exe -m roomsync.setup
.\.venv\Scripts\python.exe -m uvicorn roomsync.http:create_app --factory --host 127.0.0.1 --port 8000
```

Open [the local app](http://127.0.0.1:8000) in two separate browser profiles.
Log in as `alex` and `sam` with the passwords configured for each. Startup
seeds the accounts once. Editing `.env` later does not reset a seeded password.

## Manual acceptance

1. As Alex, add a $60 expense. As Sam, refresh the expense list and verify the
   $30 outstanding balance and Alex's configured payment link.
2. Open the link in Sam's browser, then return to RoomSync. The example
   `pay.example.test` host is a placeholder. The automated browser test
   intercepts it and serves a mock payment page. Verify that the outstanding
   balance is still $30 and no payment is reported.
3. As Sam, report $30 paid. The full balance remains outstanding. Refresh
   Alex's view and reject the pending report with a reason.
4. Refresh Sam's view. Check the rejected report and reason, then report again.
   Refresh Alex's view and confirm receipt. Check that both members can see the
   $0 balance, Settled status, and previous rejection in the history.
5. Add a $0.01 expense. Check that it is Settled with no Payable Share. Add
   a $60.01 expense and check that the other member owes $30.

## Run automated tests

Run the commands in a separate shell from the project directory. The example
uses a disposable database on the Compose instance. If you use native
PostgreSQL, create an empty test database and substitute its connection URL.

```powershell
docker compose exec -T db createdb -U roomsync roomsync_test
$env:ROOMSYNC_TEST_DATABASE_URL = 'postgresql://roomsync:roomsync-local@127.0.0.1:5432/roomsync_test'
.\.venv\Scripts\python.exe -m pytest -q
npm.cmd --prefix frontend run build
$env:Path = (Resolve-Path .\.venv\Scripts).Path + ';' + $env:Path
$env:PLAYWRIGHT_BROWSER_CHANNEL = 'msedge'
npm.cmd --prefix frontend run test:e2e
```

Use installed Microsoft Edge for those browser commands, or clear
`PLAYWRIGHT_BROWSER_CHANNEL` and install Playwright Chromium with
`npm.cmd --prefix frontend exec -- playwright install chromium`. The browser
test starts its own app on port 8765. The tests create isolated PostgreSQL
schemas and use mock payment links.

## External payment configuration

`ROOMSYNC_PAYMENT_HOST` and `ROOMSYNC_PAYMENT_PATH_PREFIX` describe an exact
HTTPS host and a path prefix for a single receiver handle.
`ROOMSYNC_ALEX_PAYMENT_URL` and `ROOMSYNC_SAM_PAYMENT_URL` bind a URL to each
recipient. Each URL is optional. Invalid values fail at startup. The owner must
approve the provider and final URL rules before a live link is configured.
RoomSync stores reports and recipient attestations. The destination handles any
separate payment interaction.

See [design](docs/DESIGN.md), [test plan](docs/TEST_PLAN.md), and [PRD](docs/PRD.md).
