import { expect, test, type Page } from "@playwright/test";

async function login(page: Page, username: string) {
  await page.goto("/");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(`demo-${username}-test-123`);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Shared expenses" })).toBeVisible();
}

test("two members settle an expense after rejecting an incorrect report", async ({ browser }) => {
  const alexContext = await browser.newContext();
  const samContext = await browser.newContext();
  try {
    const alex = await alexContext.newPage();
    const sam = await samContext.newPage();
    await login(alex, "alex");
    await login(sam, "sam");

    await alex.getByLabel("Description").fill("Groceries");
    await alex.getByLabel("Total (USD)").fill("60.00");
    await alex.getByRole("button", { name: "Add expense" }).click();
    await expect(alex.getByRole("heading", { name: "Groceries" })).toBeVisible();
    await expect(alex.getByRole("link", { name: "Open external payment link" })).toHaveCount(0);
    await sam.getByRole("button", { name: "Refresh" }).click();
    await expect(sam.locator(".balance")).toContainText("$30.00");

    await samContext.route("https://pay.example.test/u/alex", route =>
      route.fulfill({ contentType: "text/html", body: "<h1>Mock payment destination</h1>" }));
    const [popup] = await Promise.all([
      samContext.waitForEvent("page"),
      sam.getByRole("link", { name: "Open external payment link" }).click(),
    ]);
    await expect(popup.getByRole("heading", { name: "Mock payment destination" })).toBeVisible();
    await popup.close();
    await sam.reload();
    await expect(sam.locator(".balance")).toContainText("$30.00");
    await expect(sam.getByText("Payment reported", { exact: true })).toHaveCount(0);

    await sam.getByRole("button", { name: "Report $30.00 paid" }).click();
    await expect(sam.getByText("Waiting for Alex to confirm receipt.")).toBeVisible();
    await expect(sam.locator(".balance")).toContainText("$30.00");
    await expect(sam.getByRole("link", { name: "Open external payment link" })).toHaveCount(0);
    await expect(sam.getByText("Make payment outside RoomSync.", { exact: false })).toHaveCount(0);
    await expect(sam.getByRole("button", { name: "Confirm $30.00 received" })).toHaveCount(0);

    await alex.getByRole("button", { name: "Refresh" }).click();
    await alex.getByRole("button", { name: "Reject report" }).click();
    await alex.getByLabel("Rejection reason").fill("Incorrect payment reference");
    await alex.getByRole("button", { name: "Submit rejection" }).click();
    await expect(alex.getByText("Reason: Incorrect payment reference")).toBeVisible();
    await expect(alex.locator(".balance")).toContainText("$30.00");

    await sam.getByRole("button", { name: "Refresh" }).click();
    await expect(sam.getByRole("link", { name: "Open external payment link" })).toHaveAttribute("href", "https://pay.example.test/u/alex");
    await sam.getByRole("button", { name: "Report $30.00 paid" }).click();
    await expect(sam.getByText("Waiting for Alex to confirm receipt.")).toBeVisible();
    await alex.getByRole("button", { name: "Refresh" }).click();
    await alex.getByRole("button", { name: "Confirm $30.00 received" }).click();
    await expect(alex.locator(".balance")).toContainText("$0.00");
    await expect(alex.getByText("Receipt confirmed", { exact: true })).toBeVisible();
    await sam.reload();
    await expect(sam.locator(".detail .title")).toContainText("Settled");
    await expect(sam.locator(".balance")).toContainText("$0.00");
    await expect(sam.getByText("Reason: Incorrect payment reference")).toBeVisible();
    await expect(sam.getByRole("link", { name: "Open external payment link" })).toHaveCount(0);
  } finally {
    await Promise.all([alexContext.close(), samContext.close()]);
  }
});

test("retrying a committed expense after a reload reuses its request key", async ({ page }) => {
  const description = "Expense with a lost response";
  await login(page, "alex");
  const submitExpense = async () => {
    await page.getByLabel("Description").fill(description);
    await page.getByLabel("Total (USD)").fill("12.34");
    await page.getByRole("button", { name: "Add expense" }).click();
  };

  const keys: (string | undefined)[] = [];
  await page.route("**/api/expenses", async route => {
    if (route.request().method() !== "POST") return route.continue();
    keys.push(route.request().headers()["idempotency-key"]);
    if (keys.length > 1) return route.continue();
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    await route.abort("failed");
  });
  await submitExpense();
  await expect(page.getByRole("alert")).toContainText("Unable to reach RoomSync");
  await page.reload();
  const rows = page.getByRole("button", { name: new RegExp(description) });
  await expect(rows).toHaveCount(1);
  await submitExpense();
  await expect(page.getByLabel("Description")).toHaveValue("");
  await expect(rows).toHaveCount(1);
  await expect(page.getByText("created the expense", { exact: false })).toHaveCount(1);
  expect(keys[0]).toBeTruthy();
  expect(keys[1]).toBe(keys[0]);

  await submitExpense();
  await expect(rows).toHaveCount(2);
  expect(keys[2]).not.toBe(keys[0]);
});
