import { expect, test, type Browser, type Page } from "@playwright/test";

test.setTimeout(60_000);

async function signIn(browser: Browser, username: string) {
  const page = await browser.newPage();
  await page.goto("/");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(`demo-${username}-test-123`);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Shared expenses" })).toBeVisible();
  return page;
}

async function setupGroup(alex: Page, name: string, members: string[]) {
  await alex.getByLabel("Group name").fill(name);
  await alex.getByRole("button", { name: "Create group", exact: true }).click();
  await expect(alex.getByRole("heading", { name: "New expense", exact: true })).toBeVisible();
  for (const member of members) {
    await alex.getByLabel("Invite username").fill(member);
    await alex.getByRole("button", { name: "Send invitation", exact: true }).click();
    await expect(alex.getByRole("status")).toHaveText("Invitation saved.");
  }
}

async function accept(page: Page, name: string) {
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByRole("button", { name: "Accept invitation to " + name }).click();
  await expect(page.getByRole("heading", { name: "New expense", exact: true })).toBeVisible();
}

async function fillExpense(page: Page, description: string, total: string) {
  await page.getByLabel("Description").fill(description);
  await page.getByLabel("Total (USD)").fill(total);
}

async function openExpense(page: Page, description: string) {
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByRole("button", { name: new RegExp(description) }).click();
  await expect(page.getByRole("heading", { name: description, exact: true })).toBeVisible();
}

function share(page: Page, name: string) {
  return page.getByRole("region", { name: name + "'s share" });
}

test("four members settle the expense one share at a time", async ({ browser }) => {
  const [alex, sam, casey, jordan] = await Promise.all(
    ["alex", "sam", "casey", "jordan"].map(name => signIn(browser, name)),
  );
  try {
    const group = "Four-member house";
    const description = "November groceries";
    await setupGroup(alex, group, ["sam", "casey", "jordan"]);
    await Promise.all([sam, casey, jordan].map(page => accept(page, group)));
    await alex.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(alex.getByRole("checkbox", { name: "Jordan" })).toBeVisible();
    await expect(alex.getByRole("checkbox", { name: "Alex (payer)" })).toBeChecked();
    await expect(alex.getByRole("checkbox", { name: "Alex (payer)" })).toBeDisabled();
    await expect(alex.getByRole("checkbox", { name: "Sam" })).not.toBeChecked();
    await fillExpense(alex, description, "120.00");
    await alex.getByRole("button", { name: "Select all group members" }).click();
    await expect(alex.getByRole("region", { name: "Allocation preview" }).getByText("$30.00", { exact: true })).toHaveCount(4);
    await expect(alex.getByRole("radio")).toHaveCount(0);
    await alex.getByRole("button", { name: "Add expense", exact: true }).click();
    await expect(alex.locator(".balance")).toContainText("$90.00");

    for (const [name, debtor, remaining] of [
      ["Sam", sam, "$60.00"], ["Casey", casey, "$30.00"], ["Jordan", jordan, "$0.00"],
    ] as const) {
      await openExpense(debtor, description);
      const totalBeforeReport = await alex.locator(".balance strong").innerText();
      await expect(share(debtor, name).getByRole("link", { name: "Open external payment link" }))
        .toHaveAttribute("href", "https://pay.example.test/u/alex");
      await share(debtor, name).getByRole("button", { name: "Report $30.00 paid" }).click();
      await expect(share(debtor, name)).toContainText("Payment reported");
      await expect(debtor.locator(".balance")).toContainText(totalBeforeReport);
      await openExpense(alex, description);
      await share(alex, name).getByRole("button", { name: "Confirm $30.00 received" }).click();
      await expect(alex.locator(".balance")).toContainText(remaining);
      await expect(share(alex, name)).toContainText("Settled");
      await expect(alex.locator(".detail .title")).toContainText(name === "Jordan" ? "Settled" : "Open");
      if (name === "Sam") {
        await expect(share(alex, "Casey")).toContainText("Remaining: $30.00");
        await expect(share(alex, "Jordan")).toContainText("Remaining: $30.00");
      }
    }
  } finally {
    await Promise.all([alex, sam, casey, jordan].map(page => page.context().close()));
  }
});

test("preview matches saved allocations and observers see rejection activity", async ({ browser }) => {
  const [alex, sam, casey, jordan] = await Promise.all(
    ["alex", "sam", "casey", "jordan"].map(name => signIn(browser, name)),
  );
  try {
    const group = "Selected participants house";
    await setupGroup(alex, group, ["sam", "casey", "jordan"]);
    await Promise.all([accept(sam, group), accept(casey, group)]);
    await alex.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(alex.getByRole("checkbox", { name: "Casey" })).toBeVisible();
    await expect(alex.getByRole("checkbox", { name: "Jordan" })).toHaveCount(0);
    await accept(jordan, group);
    await alex.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(alex.getByRole("checkbox", { name: "Jordan" })).toBeVisible();
    const preview = alex.getByRole("region", { name: "Allocation preview" });
    const saved = alex.getByRole("region", { name: "Saved allocations" });

    await fillExpense(alex, "Even remainder", "120.03");
    await alex.getByRole("button", { name: "Select all group members" }).click();
    await expect(preview.locator("li")).toHaveText(["Alex$30.03", "Sam$30.00", "Casey$30.00", "Jordan$30.00"]);
    await alex.getByRole("radio", { name: "Distribute as evenly as possible" }).check();
    const even = ["Alex$30.01", "Sam$30.01", "Casey$30.01", "Jordan$30.00"];
    await expect(preview.locator("li")).toHaveText(even);
    await alex.getByRole("button", { name: "Add expense", exact: true }).click();
    await expect(saved.locator("li")).toHaveText(even);

    await fillExpense(alex, "Three-person dinner", "90.02");
    await expect(alex.getByRole("button", { name: "Add expense", exact: true })).toBeDisabled();
    await alex.getByRole("button", { name: "Select all group members" }).click();
    await alex.getByRole("checkbox", { name: "Jordan" }).uncheck();
    const payerRemainder = ["Alex$30.02", "Sam$30.00", "Casey$30.00"];
    await expect(preview.locator("li")).toHaveText(payerRemainder);
    await alex.getByRole("button", { name: "Add expense", exact: true }).click();
    await expect(saved.locator("li")).toHaveText(payerRemainder);
    await openExpense(sam, "Three-person dinner");
    await share(sam, "Sam").getByRole("button", { name: "Report $30.00 paid" }).click();

    await openExpense(jordan, "Three-person dinner");
    await expect(jordan.getByText("You have no allocation for this expense.")).toBeVisible();
    await expect(share(jordan, "Sam")).toContainText("Payment reported");
    await expect(jordan.getByRole("button", { name: /Confirm|Reject report|Report .* paid/ })).toHaveCount(0);
    await expect(jordan.getByRole("link", { name: "Open external payment link" })).toHaveCount(0);
    await openExpense(alex, "Three-person dinner");
    await share(alex, "Sam").getByRole("button", { name: "Reject report" }).click();
    await expect(alex.getByText("Visible to group members.")).toBeVisible();
    await alex.getByLabel("Rejection reason").fill("Wrong receipt");
    await alex.getByRole("button", { name: "Submit rejection" }).click();
    await expect(share(alex, "Sam")).toContainText("Wrong receipt");
    await openExpense(jordan, "Three-person dinner");
    await expect(share(jordan, "Sam")).toContainText("Wrong receipt");
    await expect(jordan.locator(".activity")).toContainText("Alex rejected the report");

    await fillExpense(alex, "One cent", "0.01");
    await alex.getByRole("checkbox", { name: "Sam" }).check();
    await expect(preview.locator("li")).toHaveText(["Alex$0.01", "Sam$0.00"]);
    await alex.getByRole("button", { name: "Add expense", exact: true }).click();
    await expect(saved.locator("li")).toHaveText(["Alex$0.01", "Sam$0.00"]);
    await expect(alex.getByText("No payments are due for this expense.")).toBeVisible();
    await expect(alex.locator(".detail .title")).toContainText("Settled");
  } finally {
    await Promise.all([alex, sam, casey, jordan].map(page => page.context().close()));
  }
});

test("retrying a committed group expense after a reload reuses its request key", async ({ browser }) => {
  const [alex, sam] = await Promise.all(["alex", "sam"].map(name => signIn(browser, name)));
  try {
    const group = "Retry house";
    const description = "Expense with a lost response";
    await setupGroup(alex, group, ["sam"]);
    await accept(sam, group);
    await alex.getByRole("button", { name: "Refresh", exact: true }).click();

    const submitExpense = async () => {
      await fillExpense(alex, description, "12.34");
      await alex.getByRole("checkbox", { name: "Sam" }).check();
      await alex.getByRole("button", { name: "Add expense", exact: true }).click();
    };
    const keys: (string | undefined)[] = [];
    await alex.route("**/api/groups/*/expenses", async route => {
      if (route.request().method() !== "POST") return route.continue();
      keys.push(route.request().headers()["idempotency-key"]);
      if (keys.length > 1) return route.continue();
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      await route.abort("failed");
    });
    await submitExpense();
    await expect(alex.getByRole("alert")).toContainText("Unable to reach RoomSync");
    await alex.reload();
    await alex.getByRole("button", { name: group, exact: true }).click();
    const rows = alex.getByRole("button", { name: new RegExp(description) });
    await expect(rows).toHaveCount(1);
    await submitExpense();
    await expect(alex.getByLabel("Description")).toHaveValue("");
    await expect(rows).toHaveCount(1);
    await expect(alex.getByText("created the expense", { exact: false })).toHaveCount(1);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
    await submitExpense();
    await expect(rows).toHaveCount(2);
    expect(keys[2]).not.toBe(keys[0]);
  } finally {
    await Promise.all([alex, sam].map(page => page.context().close()));
  }
});
