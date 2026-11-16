# RoomSync — Vertical Slice 1

RoomSync records the equal split of a USD expense and tracks an external payment
from the payer's report through the designated recipient's manual confirmation.
The two demo members are Alex and Sam.

## Run locally on Windows

Install Python 3.12 or later, Node.js 22.12 or later, and PostgreSQL. Run the
following in PowerShell from the directory containing `compose.yaml`.

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-test.txt
npm.cmd --prefix frontend ci
npm.cmd --prefix frontend run build
```

Reuse an existing `.venv` if it is already set up. Set distinct local passwords
for Alex and Sam in `.env` (12–256 characters). Setup rejects the example values.
For the included Docker database, set `ROOMSYNC_DB_PORT` to the published host
port and `ROOMSYNC_DB_PASSWORD` to the current database password. Both Compose
and the app use these values. The default host port is `5432`. A custom value
changes the host side only. Container PostgreSQL still listens on `5432`.

`ROOMSYNC_DATABASE_URL` is an optional full override. Remove an old override
from your local configuration when switching to the shared settings. For a
native or separate PostgreSQL server, set the override to a development database
with a user that can create schema objects.

With Docker Desktop running, use the command that matches your setup.

- **New database:** run `docker compose up -d --no-recreate db`.
- **Existing container:** use `docker compose start db` if stopped. Run
  `docker compose port db 5432` to see the actual host port. Match the app's
  settings to that port and the password of the existing PostgreSQL role. The
  Docker image applies `POSTGRES_PASSWORD` only during initial database creation.
  Changing `.env` or Compose settings does not change the existing role password.

Load the settings in the current shell, apply the migration, and start the app.
Use a fresh PowerShell session when removing a previously loaded URL override.

```powershell
Get-Content .env | ForEach-Object {
  if ($_ -match '^([A-Z_]+)=(.*)$') {
    Set-Item -Path "Env:$($Matches[1])" -Value $Matches[2]
  }
}
.\.venv\Scripts\python.exe -m roomsync.setup
if ($LASTEXITCODE -ne 0) { throw 'RoomSync setup failed.' }
.\.venv\Scripts\python.exe -m uvicorn roomsync.http:create_app --factory --host 127.0.0.1 --port 8000
```

Open [the local app](http://127.0.0.1:8000) in two separate browser profiles.
Log in as `alex` and `sam` with the passwords configured for each. Setup seeds
the accounts once. A subsequent setup run checks the existing credentials and
reports a mismatch. If an old account was initialized with an example password,
its new logins are blocked pending an authorized credential correction.

## Manual acceptance

1. As Alex, add a $60 expense. As Sam, refresh the expense list and verify the
   $30 outstanding balance and Alex's configured payment link.
2. Open the link in Sam's browser, then return to RoomSync. The example
   `pay.example.test` host is a placeholder. The automated browser test
   intercepts it and serves a mock payment page. Verify that the outstanding
   balance is still $30 and no payment is reported.
3. As Sam, report $30 paid. The full balance remains outstanding and the payment
   link is hidden. Refresh Alex's view and reject the pending report with a reason.
4. Refresh Sam's view. Check the rejected report, reason, and restored link, then report again.
   Refresh Alex's view and confirm receipt. Check that both members can see the
   $0 balance, Settled status, and previous rejection in the history.
5. Add a $0.01 expense. Check that it is Settled with no Payable Share. Add
   a $60.01 expense and check that the other member owes $30.

## Run automated tests

Run the commands in a separate shell from the project directory. Use a
dedicated PostgreSQL database whose name ends in `_test`. The example assumes
the default local database credentials. For an existing container, use its
actual published port and URL-encode any special characters in its password.

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
test starts its own app on port 8765. Set `ROOMSYNC_E2E_PORT` in the test shell
to choose another available port. The npm test runner owns its isolated schema
and drops it after Playwright exits, even when Playwright force-stops the test
server on Windows. The tests use mock payment links.

## External payment configuration

`ROOMSYNC_ALEX_PAYMENT_URL` and `ROOMSYNC_SAM_PAYMENT_URL` bind a URL to each
recipient. Each URL is optional. Slice 1 accepts only the reserved mock
destination `https://pay.example.test/u/<handle>`. Invalid values and attempts
to change the host or path policy fail at startup. A future live provider
requires owner approval and an explicit allowlist in code.
RoomSync stores reports and recipient attestations. The destination handles any
separate payment interaction.

See [design](docs/DESIGN.md), [test plan](docs/TEST_PLAN.md), and [PRD](docs/PRD.md).
