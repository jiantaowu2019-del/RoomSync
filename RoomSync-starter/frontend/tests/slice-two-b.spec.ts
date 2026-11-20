import { expect, test, type Browser, type Page } from "@playwright/test";

test.setTimeout(60_000);

async function login(browser: Browser, username: string) {
  const page = await browser.newPage();
  await page.goto("/");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill("demo-" + username + "-test-123");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Shared expenses" })).toBeVisible();
  return page;
}

async function post(page: Page, path: string, body: object) {
  const origin = new URL(page.url()).origin;
  const response = await page.request.post(origin + "/api" + path, {
    data: body, headers: { Origin: origin, "Idempotency-Key": crypto.randomUUID() },
  });
  expect(response.ok()).toBe(true);
  return response.status() === 204 ? null : response.json();
}

async function fixture(browser: Browser, name: string) {
  const alex = await login(browser, "alex");
  const sam = await login(browser, "sam");
  const origin = new URL(alex.url()).origin;
  const group = await post(alex, "/groups", { name });
  const memberIds = [(await (await alex.request.get(origin + "/api/session")).json()).viewer.id];
  for (const username of ["sam", "casey", "jordan"]) {
    const member = username === "sam" ? sam : await login(browser, username);
    await post(alex, "/groups/" + group.id + "/invitations", { username });
    await post(member, "/groups/" + group.id + "/join", {});
    memberIds.push((await (await member.request.get(origin + "/api/session")).json()).viewer.id);
    if (member !== sam) await member.context().close();
  }
  const expense = await post(alex, "/groups/" + group.id + "/expenses", {
    description: name, total_minor: 12000, participant_ids: memberIds, remainder_policy: "PAYER",
  });
  const address = "/groups/" + group.id + "?expense=" + expense.id;
  await Promise.all([alex.goto(address), sam.goto(address)]);
  await expect(sam.getByRole("heading", { name, exact: true, level: 2 })).toBeVisible();
  const details = await (await sam.request.get(origin + "/api/expenses/" + expense.id)).json();
  const share = details.shares.find((item: { debtor: string }) => item.debtor === "Sam");
  return { alex, sam, origin, groupId: group.id, expenseId: expense.id, shareId: share.id, address };
}

function samShare(page: Page) {
  return page.getByRole("region", { name: "Sam's share", exact: true });
}

async function refresh(page: Page) {
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
}

async function send(page: Page, amount: string, button: string) {
  await samShare(page).getByLabel("Payment amount (USD)").fill(amount);
  await samShare(page).getByRole("button", { name: button, exact: true }).click();
}

async function returnFromMock(page: Page) {
  await page.context().route("https://pay.example.test/u/alex", route => route.fulfill({
    contentType: "text/html", body: "<h1>Mock payment destination</h1>",
  }));
  const popupPromise = page.context().waitForEvent("page");
  await samShare(page).getByRole("link", { name: "Go to payment" }).click();
  const popup = await popupPromise;
  await expect(popup.getByRole("heading", { name: "Mock payment destination" })).toBeVisible();
  return popup;
}

async function focusReturn(page: Page) {
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
}

test("partial receipts and rejected reports retain their amounts and history", async ({ browser }) => {
  const { alex, sam } = await fixture(browser, "Partial settlement walkthrough");
  try {
    await expect(samShare(sam).getByLabel("Payment amount (USD)")).toHaveValue("30.00");
    await send(sam, "10.00", "Report $10.00 paid");
    await expect(samShare(sam)).toContainText("Remaining: $30.00");
    await expect(sam.locator(".balance")).toContainText("$90.00");
    await refresh(alex);
    await samShare(alex).getByRole("button", { name: "Confirm $10.00 received" }).click();
    await expect(alex.locator(".balance")).toContainText("$80.00");
    await refresh(sam);
    await expect(samShare(sam)).toContainText("Partially settled");
    await expect(samShare(sam)).toContainText("Confirmed: $10.00");
    await expect(samShare(sam).getByLabel("Payment amount (USD)")).toHaveValue("20.00");

    await send(sam, "5.00", "Report $5.00 paid");
    await refresh(alex);
    await samShare(alex).getByRole("button", { name: "Reject report" }).click();
    await alex.getByLabel("Rejection reason").fill("Please correct the transferred amount.");
    await alex.getByRole("button", { name: "Submit rejection" }).click();
    await refresh(sam);
    await expect(samShare(sam)).toContainText("Remaining: $20.00");
    await expect(samShare(sam)).toContainText("Please correct the transferred amount.");
    await expect(samShare(sam)).toContainText("Money already sent does not need to be paid again.");
    await send(sam, "20.00", "Report $20.00 paid");
    await refresh(alex);
    await samShare(alex).getByRole("button", { name: "Confirm $20.00 received" }).click();
    await expect(samShare(alex)).toContainText("Settled");
    await expect(alex.locator(".balance")).toContainText("$60.00");
    await expect(alex.locator(".detail .title")).toContainText("Open");
    await expect(samShare(alex).locator(".payment")).toHaveCount(3);
  } finally {
    await Promise.all([alex, sam].map(page => page.context().close()));
  }
});

test("a lost partial report response retries once and a later equal amount is a new payment", async ({ browser }) => {
  const { alex, sam, shareId, expenseId, origin } = await fixture(browser, "Retry partial reports");
  try {
    const keys: (string | undefined)[] = [];
    await sam.route("**/api/shares/" + shareId + "/payments", async route => {
      keys.push(route.request().headers()["idempotency-key"]);
      if (keys.length > 1) return route.continue();
      const saved = await route.fetch();
      expect(saved.status()).toBe(201);
      await route.abort("failed");
    });
    await send(sam, "10.00", "Report $10.00 paid");
    await expect(sam.getByRole("alert")).toContainText("Unable to reach RoomSync");
    await sam.reload();
    const retry = samShare(sam).getByRole("button", { name: "Retry report $10.00", exact: true });
    await expect(retry).toBeVisible();
    await retry.click();
    await expect(samShare(sam).locator(".payment")).toHaveCount(1);
    await expect(retry).toHaveCount(0);
    expect(keys[1]).toBe(keys[0]);
    await refresh(alex);
    await samShare(alex).getByRole("button", { name: "Confirm $10.00 received" }).click();
    await expect(samShare(alex)).toContainText("Remaining: $20.00");
    await refresh(sam);
    await send(sam, "10.00", "Report $10.00 paid");
    await expect(samShare(sam).locator(".payment")).toHaveCount(2);
    expect(keys[2]).not.toBe(keys[0]);
    await refresh(alex);
    await samShare(alex).getByRole("button", { name: "Confirm $10.00 received" }).click();
    await expect(samShare(alex)).toContainText("Remaining: $10.00");
    const details = await (await sam.request.get(origin + "/api/expenses/" + expenseId)).json();
    const share = details.shares.find((item: { id: number }) => item.id === shareId);
    expect(share.outstanding_minor).toBe(1000);
    expect(new Set(share.payments.map((payment: { id: number }) => payment.id)).size).toBe(2);
  } finally {
    await Promise.all([alex, sam].map(page => page.context().close()));
  }
});

test("returning prompts once, Later preserves the draft, and explicit reporting uses the original expense", async ({ browser }) => {
  const { alex, sam, origin, groupId, expenseId, shareId, address } = await fixture(browser, "Original payment expense");
  try {
    await samShare(sam).getByLabel("Payment amount (USD)").fill("10.00");
    let popup = await returnFromMock(sam);
    await popup.close();
    await focusReturn(sam);
    let dialog = sam.getByRole("dialog");
    await expect(dialog).toContainText("Did you transfer $10.00 to Alex?");
    await expect(dialog).toContainText("Expense: Original payment expense");
    await dialog.getByRole("button", { name: "Continue later" }).click();
    let details = await (await alex.request.get(origin + "/api/expenses/" + expenseId)).json();
    expect(details.shares.find((share: { id: number }) => share.id === shareId).payments).toHaveLength(0);
    expect(details.outstanding_minor).toBe(9000);
    await focusReturn(sam);
    await expect(sam.getByRole("dialog")).toHaveCount(0);
    await expect(samShare(sam).getByLabel("Payment amount (USD)")).toHaveValue("10.00");

    popup = await returnFromMock(sam);
    const original = await (await alex.request.get(origin + "/api/expenses/" + expenseId)).json();
    const other = await post(alex, "/groups/" + groupId + "/expenses", {
      description: "Another selected expense", total_minor: 6000,
      participant_ids: original.allocations.map((allocation: { member_id: number }) => allocation.member_id),
      remainder_policy: "PAYER",
    });
    await sam.goto("/groups/" + groupId + "?expense=" + other.id);
    await expect(sam.getByRole("heading", { name: "Another selected expense", exact: true })).toBeVisible();
    dialog = sam.getByRole("dialog");
    await expect(dialog).toContainText("Expense: Original payment expense");
    await popup.close();
    await dialog.getByRole("button", { name: "Transferred, report $10.00", exact: true }).click();
    await expect(sam).toHaveURL(new URL(address, origin).toString());
    await expect(samShare(sam)).toContainText("Waiting for Alex to confirm receipt.");
    await focusReturn(sam);
    await expect(sam.getByRole("dialog")).toHaveCount(0);
    details = await (await alex.request.get(origin + "/api/expenses/" + expenseId)).json();
    expect(details.shares.find((share: { id: number }) => share.id === shareId).payments).toHaveLength(1);
    const otherDetails = await (await alex.request.get(origin + "/api/expenses/" + other.id)).json();
    expect(otherDetails.shares.every((share: { payments: unknown[] }) => share.payments.length === 0)).toBe(true);
  } finally {
    await Promise.all([alex, sam].map(page => page.context().close()));
  }
});

test("a lost return-dialog report response recovers the same operation from the original expense", async ({ browser }) => {
  const { alex, sam, shareId, expenseId, origin } = await fixture(browser, "Uncertain return report");
  try {
    const keys: (string | undefined)[] = [];
    await sam.route("**/api/shares/" + shareId + "/payments", async route => {
      keys.push(route.request().headers()["idempotency-key"]);
      if (keys.length > 1) return route.continue();
      expect((await route.fetch()).status()).toBe(201);
      await route.abort("failed");
    });
    await samShare(sam).getByLabel("Payment amount (USD)").fill("10.00");
    const popup = await returnFromMock(sam);
    await popup.close();
    await focusReturn(sam);
    const dialog = sam.getByRole("dialog");
    await dialog.getByRole("button", { name: "Transferred, report $10.00", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("Retry the report from the original expense");
    await dialog.getByRole("button", { name: "Continue later" }).click();
    const retry = samShare(sam).getByRole("button", { name: "Retry report $10.00", exact: true });
    await expect(retry).toBeVisible();
    await retry.click();
    await expect(retry).toHaveCount(0);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    const details = await (await alex.request.get(origin + "/api/expenses/" + expenseId)).json();
    expect(details.shares.find((share: { id: number }) => share.id === shareId).payments).toHaveLength(1);
    expect(details.outstanding_minor).toBe(9000);
  } finally {
    await Promise.all([alex, sam].map(page => page.context().close()));
  }
});

for (const changed of ["pending", "settled", "smaller balance"] as const) {
  test("payment return reads a latest " + changed + " state before allowing a report", async ({ browser }) => {
    const { alex, sam, shareId } = await fixture(browser, "Changed return " + changed);
    try {
      await samShare(sam).getByLabel("Payment amount (USD)").fill("10.00");
      const popup = await returnFromMock(sam);
      const amount = changed === "pending" ? 500 : changed === "settled" ? 3000 : 2500;
      const actual = await post(sam, "/shares/" + shareId + "/payments", { amount_minor: amount });
      if (changed !== "pending") await post(alex, "/payments/" + actual.id + "/confirm", { amount_minor: amount });
      await popup.close();
      await focusReturn(sam);
      const dialog = sam.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Transferred, report $10.00", exact: true })).toBeDisabled();
      await expect(dialog).toContainText(changed === "pending" ? "already awaiting confirmation"
        : changed === "settled" ? "This share is settled" : "draft exceeds the latest balance");
      await dialog.getByRole("button", { name: "Continue later" }).click();
    } finally {
      await Promise.all([alex, sam].map(page => page.context().close()));
    }
  });
}

