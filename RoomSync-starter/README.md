# RoomSync — Vertical Slice 2

RoomSync splits a group expense in USD and tracks each member's outstanding
share from payment report through receipt confirmation. Alex, Sam, Casey, and
Jordan are the demo accounts for the first Slice 2 delivery.

## Run locally on Windows

Install Python 3.12 or later, Node.js 22.12 or later, and PostgreSQL. Run the
following in PowerShell from the directory containing `compose.yaml`.
Stop an existing RoomSync web process before replacing the frontend build or
running setup. The PostgreSQL container can stay running.

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-test.txt
npm.cmd --prefix frontend ci
npm.cmd --prefix frontend run build
```

Reuse an existing `.venv` if it is already set up. Set distinct local passwords
for Alex and Sam in `.env` (12–256 characters). Keep the existing values if setup
has already seeded their accounts. For the four-account walkthrough, also set
`ROOMSYNC_CASEY_PASSWORD` and `ROOMSYNC_JORDAN_PASSWORD`. You can set both in
the current PowerShell environment before running setup, leaving `.env` intact.
All four passwords must be distinct. Setup rejects the example values.
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
Setup preserves the existing Slice 1 balances and history.
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

Open [the local app](http://127.0.0.1:8000) in four independent browser profiles.
Log in as `alex`, `sam`, `casey`, and `jordan` with their configured passwords. Setup seeds
the accounts once. A subsequent setup run checks the existing credentials and
reports a mismatch. If an old account was initialized with an example password,
its new logins are blocked pending an authorized credential correction.

## Manual acceptance for Slice 2

The home page lists groups and invitations. Clicking a group opens its own
`/groups/<groupId>` address. Refreshing that page stays in the group.
Use **Back to groups** or browser back to return to the list.
**Historical expenses** opens `/history`.

1. As Alex, use **Create group**, then invite `sam`, `casey`, and `jordan`.
   Accept in the other three profiles. In Alex's profile, the active roster
   updates when returning to the page or within one 12-second refresh cycle
   while it is visible.
2. Enter a $120.00 expense. Check **Select all group members** and verify a
   $30.00 preview for each member. Post and check the $90.00 outstanding total.
3. As Sam, report $30.00 paid. The total stays at $90.00. On Alex's open expense,
   wait for the report to appear or return to the page, then confirm Sam's
   receipt. Verify Sam is Settled, Casey and Jordan each still
   owe $30.00, and the expense is Open with $60.00 outstanding.
4. Report and confirm Casey's and Jordan's shares. The final outstanding
   total is $0.00 and the expense is Settled.
5. Post another expense with Alex, Sam, and Casey selected. Jordan can read
   the expense, report status, rejection reason, and activity. Jordan has no
   payment actions. Use $120.03 with all four selected to compare the two
   remainder previews and $0.01 to verify zero-cent allocations.
6. Open **Historical expenses** as Alex or Sam to view earlier two-person
   records and handle any pending reports. Casey and Jordan cannot read those
   records.
7. As Sam, post $101.01 with all four members and **Payer covers remainder**.
   Verify Sam is listed under **Paid by**, **Total paid** is $101.01, the
   **Amount per person** is $25.26 for Sam and $25.25 for each other
   participant, and **Total outstanding** is $75.75. On another expense,
   select only Casey alongside Sam. Alex can still view the saved expense.
8. With a draft open, let another member report a payment. The draft's
   description, amount, participant choices, and remainder policy should
   survive the automatic update. On a 390 × 844 mobile viewport, use
   **New expense** and **View expenses** next to the group name and check
   that each shortcut scrolls to and focuses its section heading.
9. From the home list, open one group, reload it, return to the list, and open
   another. Check the title, expense list and invitations belong to that group.
   In a non-member's browser, directly open its group address and check the
   unavailable message and return link. Repeat at 390 × 844 with a long group
   name to verify the title, return link and group shortcuts wrap clearly.

The mock payment link is optional for manual acceptance. Opening it or
returning leaves the balance unchanged. The automated browser test intercepts
the reserved mock host with a synthetic destination.

## Legacy Slice 1 checks

1. Open an existing $60 two-person expense or use a Slice 1 test fixture.
   As Sam, refresh the expense list and verify the
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
5. A pre-existing $0.01 expense remains Settled with no Payable Share.
   A pre-existing $60.01 expense has a $30 original Payable Share.

## Manual acceptance for Slice 2B

Use two independent browser sessions as Alex and Sam, with a four-member $120
expense paid by Alex. Each other member owes $30. Existing unsettled two-person
expenses also accept the same partial-payment workflow.

1. As Sam, change **Payment amount (USD)** from $30.00 to $10.00 and report it.
   The share remains $30 outstanding and the expense remains $90 outstanding.
   Alex confirms the $10 report. Sam's share is Partially settled, with $10
   confirmed and $20 remaining. The expense has $80 outstanding.
2. Sam reports $5, which Alex rejects with a reason. The remaining share stays
   $20. Read the rejection and re-report the actual amount already transferred.
   Previously transferred money does not need to be transferred again.
   Confirming the remaining $20 settles Sam's share while other unpaid members
   leave the expense Open with $60 outstanding.
3. On an unpaid share, choose $10 and use **Go to payment**. Return to RoomSync
   and check the original expense, recipient and amount in the confirmation
   dialog. **Continue later** keeps the draft and creates no report.
   **Transferred, report $10.00** explicitly reports the selected amount.
   The same jump prompts automatically only once. Use the direct Report button
   later if the money has already been transferred.

The reserved mock link may show a browser connection error during manual use.
Return to RoomSync to test the handoff. Automated tests intercept that URL with
a mock page. If the share changed, the return dialog shows its latest pending,
settled or reduced-balance state and requires reviewing the original expense.
If a report's response was lost, **Retry report** recovers the original result.
Once a report succeeds, a later intentional payment uses its own operation key.

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

The optional `ROOMSYNC_ALEX_PAYMENT_URL`, `ROOMSYNC_SAM_PAYMENT_URL`,
`ROOMSYNC_CASEY_PAYMENT_URL`, and `ROOMSYNC_JORDAN_PAYMENT_URL` bind mock
links to recipients. The runtime accepts only the reserved mock
destination `https://pay.example.test/u/<handle>`. Invalid values and attempts
to change the host or path policy fail at startup. A future live provider
requires owner approval and an explicit allowlist in code.
RoomSync stores reports and recipient attestations. The destination handles any
separate payment interaction.

See [design](docs/DESIGN.md), [test plan](docs/TEST_PLAN.md), and [PRD](docs/PRD.md).
