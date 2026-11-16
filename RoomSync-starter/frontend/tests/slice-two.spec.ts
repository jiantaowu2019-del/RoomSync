import { expect, test, type Browser, type Page } from "@playwright/test";

test.setTimeout(60_000);

async function signIn(browser: Browser, username: string, freezeTime = false) {
  const page = await browser.newPage();
  if (freezeTime) {
    await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
    await page.clock.pauseAt(new Date("2026-01-01T00:00:10Z"));
  }
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
    const saved = alex.getByRole("region", { name: "Amount per person" });

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

test("Sam can fund either a four-member or a two-member expense", async ({ browser }) => {
  const [alex, sam, casey, jordan] = await Promise.all(
    ["alex", "sam", "casey", "jordan"].map(name => signIn(browser, name)),
  );
  try {
    const group = "Sam's expense group";
    await setupGroup(alex, group, ["sam", "casey", "jordan"]);
    await Promise.all([sam, casey, jordan].map(page => accept(page, group)));
    await sam.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(sam.getByRole("checkbox", { name: "Jordan", exact: true })).toBeVisible();
    const payer = sam.getByRole("checkbox", { name: "Sam (payer)", exact: true });
    const alexOption = sam.getByRole("checkbox", { name: "Alex", exact: true });
    await expect(payer).toBeChecked();
    await expect(payer).toBeDisabled();
    await expect(alexOption).toBeEnabled();
    await expect(alexOption).not.toBeChecked();
    await expect(sam.getByText("At least 2 people, including the payer.", { exact: false })).toBeVisible();

    const preview = sam.getByRole("region", { name: "Allocation preview" });
    const allAmounts = ["Sam$25.26", "Alex$25.25", "Casey$25.25", "Jordan$25.25"];
    await fillExpense(sam, "Sam paid for four", "101.01");
    await sam.getByRole("button", { name: "Select all group members" }).click();
    await expect(sam.getByRole("radio", { name: "Payer covers remainder" })).toBeChecked();
    await expect(preview.locator("li")).toHaveText(allAmounts);
    await sam.getByRole("button", { name: "Add expense", exact: true }).click();

    await openExpense(alex, "Sam paid for four");
    await expect(alex.locator(".expense-summary > div")).toHaveText(["Paid bySam", "Total paid$101.01"]);
    await expect(alex.getByRole("region", { name: "Amount per person" }).locator("li")).toHaveText(allAmounts);
    await expect(alex.locator(".balance")).toHaveText("Total outstanding$75.75");
    for (const name of ["Alex", "Casey", "Jordan"]) {
      await expect(share(alex, name)).toContainText("Remaining: $25.25");
    }
    await expect(share(alex, "Sam")).toHaveCount(0);

    await fillExpense(sam, "Sam paid with Casey", "101.01");
    await sam.getByRole("checkbox", { name: "Casey", exact: true }).check();
    await expect(alexOption).not.toBeChecked();
    await expect(sam.getByRole("button", { name: "Add expense", exact: true })).toBeEnabled();
    const twoAmounts = ["Sam$50.51", "Casey$50.50"];
    await expect(preview.locator("li")).toHaveText(twoAmounts);
    await sam.getByRole("button", { name: "Add expense", exact: true }).click();
    await expect(sam.getByRole("heading", { name: "Sam paid with Casey", exact: true })).toBeVisible();

    for (const observer of [alex, jordan]) {
      await openExpense(observer, "Sam paid with Casey");
      await expect(observer.getByRole("region", { name: "Amount per person" }).locator("li")).toHaveText(twoAmounts);
      await expect(observer.getByText("You have no allocation for this expense.")).toBeVisible();
      await expect(observer.getByRole("button", { name: /Report .* paid|Confirm .* received|Reject report/ })).toHaveCount(0);
    }
  } finally {
    await Promise.all([alex, sam, casey, jordan].map(page => page.context().close()));
  }
});

test("foreground polls and returning to the page update other accounts without losing a draft", async ({ browser }) => {
  const [alex, sam] = await Promise.all(["alex", "sam"].map(name => signIn(browser, name, true)));
  try {
    const group = "Cross-account updates";
    const original = "Selected expense";
    await setupGroup(alex, group, ["sam"]);
    await sam.clock.runFor(12_000);
    await sam.getByRole("button", { name: "Accept invitation to " + group }).click();
    await expect(sam.getByRole("heading", { name: "New expense", exact: true })).toBeVisible();
    await alex.clock.runFor(12_000);
    await expect(alex.getByRole("checkbox", { name: "Sam", exact: true })).toBeVisible();

    for (const description of [original, "Newer expense"]) {
      await fillExpense(alex, description, "60.00");
      await alex.getByRole("checkbox", { name: "Sam", exact: true }).check();
      await alex.getByRole("button", { name: "Add expense", exact: true }).click();
      await expect(alex.getByRole("heading", { name: description, exact: true })).toBeVisible();
    }
    await alex.getByRole("button", { name: /^Selected expense/ }).click();
    await expect(alex.getByRole("heading", { name: original, exact: true })).toBeVisible();

    await fillExpense(alex, "Unsubmitted draft", "23.01");
    await alex.getByRole("checkbox", { name: "Sam", exact: true }).check();
    const even = alex.getByRole("radio", { name: "Distribute as evenly as possible" });
    await even.check();

    await sam.clock.runFor(12_000);
    await sam.getByRole("button", { name: /^Selected expense/ }).click();
    await share(sam, "Sam").getByRole("button", { name: "Report $30.00 paid" }).click();
    await expect(share(sam, "Sam")).toContainText("Waiting for Alex to confirm receipt.");

    await alex.clock.runFor(12_000);
    const confirm = share(alex, "Sam").getByRole("button", { name: "Confirm $30.00 received" });
    await expect(confirm).toBeVisible();
    await expect(alex.getByRole("button", { name: /^Selected expense/ })).toHaveAttribute("aria-current", "true");
    await expect(alex.getByLabel("Description")).toHaveValue("Unsubmitted draft");
    await expect(alex.getByLabel("Total (USD)")).toHaveValue("23.01");
    await expect(alex.getByRole("checkbox", { name: "Alex (payer)", exact: true })).toBeChecked();
    await expect(alex.getByRole("checkbox", { name: "Sam", exact: true })).toBeChecked();
    await expect(even).toBeChecked();

    await sam.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await confirm.click();
    await expect(alex.locator(".detail .title")).toContainText("Settled");
    await sam.clock.runFor(12_000);
    await expect(sam.locator(".detail .title")).toContainText("Open");
    await sam.evaluate(() => {
      Reflect.deleteProperty(document, "visibilityState");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(sam.locator(".detail .title")).toContainText("Settled");
    await expect(sam.getByRole("button", { name: /^Selected expense/ })).toHaveAttribute("aria-current", "true");
  } finally {
    await Promise.all([alex, sam].map(page => page.context().close()));
  }
});

test("group shortcuts scroll and focus the correct mobile sections", async ({ browser }) => {
  const alex = await signIn(browser, "alex");
  try {
    await alex.setViewportSize({ width: 390, height: 844 });
    await setupGroup(alex, "Mobile shortcuts", []);
    const nav = alex.getByRole("navigation", { name: "Group shortcuts" });
    const create = nav.getByRole("button", { name: "New expense", exact: true });
    const view = nav.getByRole("button", { name: "View expenses", exact: true });
    await expect(create).toBeInViewport();
    await expect(view).toBeInViewport();

    await create.click();
    const formHeading = alex.getByRole("heading", { name: "New expense", exact: true });
    await expect(formHeading).toBeFocused();
    await expect(formHeading).toBeInViewport();
    expect(await alex.evaluate(() => scrollY)).toBeGreaterThan(0);

    await view.click();
    const listHeading = alex.getByRole("heading", { name: "Group expenses", exact: true });
    await expect(listHeading).toBeFocused();
    await expect(listHeading).toBeInViewport();
  } finally {
    await alex.context().close();
  }
});
