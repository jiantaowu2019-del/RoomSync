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

    const origin = new URL(alex.url()).origin;
    const created = await alex.request.post(origin + "/api/expenses", {
      data: { description: "Groceries", total_minor: 6000 },
      headers: { Origin: origin, "Idempotency-Key": "legacy-browser-fixture" },
    });
    expect(created.status()).toBe(201);
    const expenseId = (await created.json()).id;
    await alex.getByRole("link", { name: "Historical expenses", exact: true }).click();
    await alex.locator(".expense-item").filter({ hasText: "Groceries" }).click();
    await expect(alex).toHaveURL(`${origin}/history?expense=${expenseId}`);
    await expect(alex.getByRole("heading", { name: "Groceries" })).toBeVisible();
    await expect(alex.getByRole("link", { name: "Go to payment" })).toHaveCount(0);
    await sam.getByRole("link", { name: "Historical expenses", exact: true }).click();
    await expect(sam.locator(".balance")).toContainText("$30.00");

    await samContext.route("https://pay.example.test/u/alex", route =>
      route.fulfill({ contentType: "text/html", body: "<h1>Mock payment destination</h1>" }));
    const [popup] = await Promise.all([
      samContext.waitForEvent("page"),
      sam.getByRole("link", { name: "Go to payment" }).click(),
    ]);
    await expect(popup.getByRole("heading", { name: "Mock payment destination" })).toBeVisible();
    await popup.close();
    await sam.bringToFront();
    await sam.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(sam.getByRole("dialog")).toBeVisible();
    await sam.getByRole("button", { name: "Continue later", exact: true }).click();
    await sam.reload();
    await expect(sam.locator(".balance")).toContainText("$30.00");
    await expect(sam.getByText("Payment reported", { exact: true })).toHaveCount(0);

    await sam.getByRole("button", { name: "Report $30.00 paid" }).click();
    await expect(sam.getByText("Waiting for Alex to confirm receipt.")).toBeVisible();
    await expect(sam.locator(".balance")).toContainText("$30.00");
    await expect(sam.getByRole("link", { name: "Go to payment" })).toHaveCount(0);
    await expect(sam.getByText("Make payment outside RoomSync.", { exact: false })).toHaveCount(0);
    await expect(sam.getByRole("button", { name: "Confirm $30.00 received" })).toHaveCount(0);

    await alex.getByRole("button", { name: "Refresh" }).click();
    await alex.getByRole("button", { name: "Reject report" }).click();
    await alex.getByLabel("Rejection reason").fill("Incorrect payment reference");
    await alex.getByRole("button", { name: "Submit rejection" }).click();
    await expect(alex.getByText("Reason: Incorrect payment reference")).toBeVisible();
    await expect(alex.locator(".balance")).toContainText("$30.00");

    await sam.getByRole("button", { name: "Refresh" }).click();
    await expect(sam.getByRole("link", { name: "Go to payment" })).toHaveAttribute("href", "https://pay.example.test/u/alex");
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
    await expect(sam.getByRole("link", { name: "Go to payment" })).toHaveCount(0);
  } finally {
    await Promise.all([alexContext.close(), samContext.close()]);
  }
});
