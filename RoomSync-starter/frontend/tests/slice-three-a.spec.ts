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

async function fixture(browser: Browser, legacy = false) {
  const alex = await login(browser, "alex");
  const sam = await login(browser, "sam");
  const origin = new URL(alex.url()).origin;
  let groupId: number | null = null;
  let expense: { id: number };
  if (legacy) {
    expense = await post(alex, "/expenses", { description: "Private dispute acceptance", total_minor: 6000 });
  } else {
    groupId = (await post(alex, "/groups", { name: "Share dispute acceptance" })).id;
    await post(alex, `/groups/${groupId}/invitations`, { username: "sam" });
    await post(sam, `/groups/${groupId}/join`, {});
    const memberIds = await Promise.all([alex, sam].map(async page =>
      (await (await page.request.get(origin + "/api/session")).json()).viewer.id));
    expense = await post(alex, `/groups/${groupId}/expenses`, {
      description: "Share dispute acceptance", total_minor: 6000,
      participant_ids: memberIds, remainder_policy: "PAYER",
    });
  }
  const address = (legacy ? "/history" : "/groups/" + groupId) + "?expense=" + expense.id;
  await Promise.all([alex.goto(address), sam.goto(address)]);
  await expect(share(sam)).toContainText("Remaining: $30.00");
  const detail = await (await sam.request.get(origin + "/api/expenses/" + expense.id)).json();
  return { alex, sam, origin, groupId, expenseId: expense.id, shareId: detail.shares[0].id, address };
}

function share(page: Page) {
  return page.getByRole("region", { name: "Sam's share", exact: true });
}

function thread(page: Page) {
  return page.getByRole("region", { name: "Sam's dispute", exact: true });
}

async function focus(page: Page) {
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
}

async function report(page: Page, amount: string) {
  await share(page).getByLabel("Payment amount (USD)").fill(amount);
  await share(page).getByRole("button", { name: `Report $${amount} paid`, exact: true }).click();
  await expect(share(page)).toContainText("Waiting for Alex to confirm receipt.");
}

async function open(page: Page, reason = "Please explain this $5 portion.") {
  await thread(page).getByLabel("Disputed amount (USD)").fill("5.00");
  await thread(page).getByLabel("Dispute reason").fill(reason);
  await thread(page).getByRole("button", { name: "Open dispute", exact: true }).click();
  await expect(thread(page)).toContainText("Claimed when opened: $5.00");
}

async function reply(page: Page, body: string, count: number) {
  await thread(page).getByLabel("Response", { exact: true }).fill(body);
  await thread(page).getByRole("button", { name: "Add response", exact: true }).click();
  await expect(thread(page).locator(".dispute-response")).toHaveCount(count);
}

test("two responses preserve a single receipt and the original claim through later settlement", async ({ browser }) => {
  const { alex, sam, origin, expenseId } = await fixture(browser);
  try {
    await report(sam, "10.00");
    await focus(alex);
    await share(alex).getByRole("button", { name: "Confirm $10.00 received" }).click();
    await expect(share(alex)).toContainText("Remaining: $20.00");
    await focus(sam);
    await expect(thread(sam)).toContainText("visible to active group members");
    await open(sam, "<b>Please explain this $5 portion.</b>");
    await thread(sam).getByLabel("Response", { exact: true }).fill("Unsent response draft");
    await focus(alex);
    await expect(thread(alex)).toContainText("Claimed when opened: $5.00");
    await reply(alex, "First explanation", 1);
    await reply(alex, "Second explanation", 2);
    await focus(sam);
    await expect(thread(sam).locator(".dispute-response")).toHaveCount(2);
    await expect(thread(sam).getByLabel("Response", { exact: true })).toHaveValue("Unsent response draft");
    await expect(thread(sam).locator("b")).toHaveCount(0);
    await expect(thread(sam)).toContainText("<b>Please explain this $5 portion.</b>");
    const detail = await (await sam.request.get(origin + "/api/expenses/" + expenseId)).json();
    expect(detail.shares[0].confirmed_minor).toBe(1000);
    expect(detail.shares[0].outstanding_minor).toBe(2000);
    await expect(share(sam)).toContainText("Original share: $30.00 · Confirmed: $10.00");
    await expect(share(sam)).toContainText("Remaining: $20.00");

    await report(sam, "18.00");
    await focus(alex);
    await share(alex).getByRole("button", { name: "Confirm $18.00 received" }).click();
    await expect(thread(alex)).toContainText("Current balance: $2.00");
    await expect(thread(alex)).toContainText("Claimed when opened: $5.00");
    await expect(thread(alex)).toContainText("Balance when opened: $20.00");
    await focus(sam);
    await expect(share(sam)).toContainText("Remaining: $2.00");
    await report(sam, "2.00");
    await focus(alex);
    await share(alex).getByRole("button", { name: "Confirm $2.00 received" }).click();
    await expect(thread(alex)).toContainText("Current balance: $0.00");
    await Promise.all([alex.reload(), sam.reload()]);
    await expect(thread(alex)).toBeVisible();
    await expect(thread(sam)).toBeVisible();
    await expect(thread(alex)).toContainText("Claimed when opened: $5.00");
    await expect(thread(alex).locator(".dispute-response")).toHaveCount(2);
    await expect(alex.locator(".detail .title")).toContainText("Settled");
    await expect(thread(alex).getByRole("heading", { name: "Dispute · Open", exact: true })).toBeVisible();
    await reply(alex, "A response after financial settlement", 3);
    await focus(sam);
    await expect(thread(sam).locator(".dispute-response")).toHaveCount(3);
    await expect(thread(sam).getByLabel("Response", { exact: true })).toHaveValue("Unsent response draft");
  } finally {
    await Promise.all([alex, sam].map(page => page.context().close()));
  }
});

test("a settled share keeps its dispute after selecting a same-named food expense and reloading", async ({ browser }) => {
  const pages: Page[] = [];
  try {
    for (const username of ["alex", "sam", "casey", "jordan"]) pages.push(await login(browser, username));
    const [alex, sam] = pages;
    const origin = new URL(alex.url()).origin;
    const group = await post(alex, "/groups", { name: "Settled share with an open food expense" });
    const memberIds = await Promise.all(pages.map(async page =>
      (await (await page.request.get(origin + "/api/session")).json()).viewer.id));
    for (const [index, username] of ["sam", "casey", "jordan"].entries()) {
      await post(alex, `/groups/${group.id}/invitations`, { username });
      await post(pages[index + 1], `/groups/${group.id}/join`, {});
    }
    const fields = { description: "food", total_minor: 10000, participant_ids: memberIds, remainder_policy: "PAYER" };
    const older = await post(alex, `/groups/${group.id}/expenses`, fields);
    const food = await post(sam, `/groups/${group.id}/expenses`, fields);
    const address = `/groups/${group.id}?expense=${food.id}`;
    for (const page of [alex, sam]) {
      await page.goto(`/groups/${group.id}?expense=${older.id}`);
      await page.locator(".expense-item").filter({ hasText: "Paid by Sam" }).click();
      await expect(page.getByRole("region", { name: "Alex's share", exact: true })).toBeVisible();
    }
    const alexShare = (page: Page) => page.getByRole("region", { name: "Alex's share", exact: true });
    const alexThread = (page: Page) => page.getByRole("region", { name: "Alex's dispute", exact: true });
    const reason = "Please retain my original $5 food dispute.";
    await alexThread(alex).getByLabel("Disputed amount (USD)").fill("5.00");
    await alexThread(alex).getByLabel("Dispute reason").fill(reason);
    await alexThread(alex).getByRole("button", { name: "Open dispute", exact: true }).click();
    await expect(alexThread(alex)).toContainText(reason);
    async function pay(amount: string) {
      await alexShare(alex).getByLabel("Payment amount (USD)").fill(amount);
      await alexShare(alex).getByRole("button", { name: `Report $${amount} paid`, exact: true }).click();
      await expect(alexShare(alex)).toContainText("Waiting for Sam to confirm receipt.");
    }
    async function receive(amount: string, remaining: string) {
      await focus(sam);
      await alexShare(sam).getByRole("button", { name: `Confirm $${amount} received`, exact: true }).click();
      await expect(alexShare(sam)).toContainText(`Remaining: $${remaining}`);
    }
    async function respondAs(page: Page, body: string, count: number) {
      await alexThread(page).getByLabel("Response", { exact: true }).fill(body);
      await alexThread(page).getByRole("button", { name: "Add response", exact: true }).click();
      await expect(alexThread(page).locator(".dispute-response")).toHaveCount(count);
    }
    await pay("18.00");
    await receive("18.00", "7.00");
    await respondAs(sam, "First response before settlement", 1);
    await respondAs(sam, "Second response before settlement", 2);
    await focus(alex);
    await expect(alexThread(alex).locator(".dispute-response")).toHaveCount(2);
    await pay("7.00");
    await receive("7.00", "0.00");
    const details = await (await sam.request.get(origin + `/api/expenses/${food.id}`)).json();
    const settled = details.shares.find((item: { debtor: string }) => item.debtor === "Alex");
    expect([settled.status, settled.outstanding_minor, settled.dispute.status, settled.dispute.claimed_minor])
      .toEqual(["SETTLED", 0, "OPEN", 500]);
    expect(settled.dispute.responses).toHaveLength(2);
    expect(details.status).toBe("OPEN");
    expect(details.outstanding_minor).toBe(5000);
    expect(details.shares.filter((item: { debtor: string }) => item.debtor !== "Alex")
      .map((item: { outstanding_minor: number }) => item.outstanding_minor)).toEqual([2500, 2500]);

    // Reload after the final receipt, not just after an API-only fixture setup.
    await Promise.all([alex.reload(), sam.reload()]);
    for (const page of [alex, sam]) {
      await expect(alexThread(page)).toBeVisible();
      await expect(page).toHaveURL(new URL(address, origin).toString());
      await expect(alexShare(page).getByText("Settled", { exact: true })).toBeVisible();
      await expect(page.locator(".detail .title")).toContainText("Open");
      await expect(alexThread(page)).toContainText("Dispute · Open");
      await expect(alexThread(page)).toContainText("Claimed when opened: $5.00");
      await expect(alexThread(page)).toContainText(reason);
      await expect(alexThread(page).locator(".dispute-response")).toHaveCount(2);
      await expect(alexThread(page).getByRole("button", { name: "Open dispute", exact: true })).toHaveCount(0);
    }
    await respondAs(sam, "Sam can respond after settlement and reload", 3);
    await focus(alex);
    await expect(alexThread(alex).locator(".dispute-response")).toHaveCount(3);
    await respondAs(alex, "Alex can also respond after settlement and reload", 4);
    await Promise.all([alex.reload(), sam.reload()]);
    for (const page of [alex, sam]) await expect(alexThread(page).locator(".dispute-response")).toHaveCount(4);
    const denied = await alex.request.post(origin + `/api/shares/${settled.id}/disputes`, {
      data: { amount_minor: 100, reason: "A new thread must not be created" },
      headers: { Origin: origin, "Idempotency-Key": crypto.randomUUID() },
    });
    expect(denied.status()).toBe(409);
  } finally {
    await Promise.all(pages.map(page => page.context().close()));
  }
});

for (const kind of ["dispute", "response"] as const) {
  test("a lost " + kind + " response survives reload and recovers one operation", async ({ browser }) => {
    const { alex, sam, origin, expenseId, shareId } = await fixture(browser);
    try {
      let path = `/shares/${shareId}/disputes`;
      let actor = sam;
      if (kind === "response") {
        const opened = await post(sam, path, { amount_minor: 500, reason: "Original reason" });
        path = `/disputes/${opened.id}/responses`;
        actor = alex;
        await alex.reload();
      }
      const keys: (string | undefined)[] = [];
      await actor.route("**/api" + path, async route => {
        keys.push(route.request().headers()["idempotency-key"]);
        if (keys.length > 1) return route.continue();
        expect((await route.fetch()).status()).toBe(201);
        await route.abort("failed");
      });
      if (kind === "dispute") {
        await thread(actor).getByLabel("Disputed amount (USD)").fill("5.00");
        await thread(actor).getByLabel("Dispute reason").fill("Original reason");
      } else await thread(actor).getByLabel("Response", { exact: true }).fill("Intentional response");
      await thread(actor).getByRole("button", { name: kind === "dispute" ? "Open dispute" : "Add response", exact: true }).click();
      await expect(actor.getByRole("alert")).toContainText("Unable to reach RoomSync");
      await actor.reload();
      const retry = thread(actor).getByRole("button", { name: kind === "dispute" ? "Retry dispute" : "Retry response", exact: true });
      await expect(retry).toBeVisible();
      await retry.click();
      await expect(retry).toHaveCount(0);
      expect(keys).toHaveLength(2);
      expect(keys[1]).toBe(keys[0]);
      let detail = await (await actor.request.get(origin + "/api/expenses/" + expenseId)).json();
      expect(detail.shares[0].outstanding_minor).toBe(3000);
      const event = kind === "dispute" ? "DISPUTE_OPENED" : "DISPUTE_RESPONSE_ADDED";
      expect(detail.audit.filter((item: { kind: string }) => item.kind === event)).toHaveLength(1);
      if (kind === "response") {
        await reply(actor, "Intentional response", 2);
        expect(keys[2]).not.toBe(keys[0]);
        detail = await (await actor.request.get(origin + "/api/expenses/" + expenseId)).json();
        expect(detail.shares[0].dispute.responses).toHaveLength(2);
      }
    } finally {
      await Promise.all([alex, sam].map(page => page.context().close()));
    }
  });
}

for (const legacy of [false, true]) {
  test(legacy ? "legacy dispute history stays private to the original two people" : "an uninvolved group member can read but cannot respond", async ({ browser }) => {
    const { alex, sam, groupId, shareId, address, origin, expenseId } = await fixture(browser, legacy);
    const casey = await login(browser, "casey");
    try {
      await open(sam);
      const detail = await (await sam.request.get(origin + "/api/expenses/" + expenseId)).json();
      const disputeId = detail.shares[0].dispute.id;
      await post(alex, `/disputes/${disputeId}/responses`, { body: "Visible response" });
      if (!legacy) {
        await post(alex, `/groups/${groupId}/invitations`, { username: "casey" });
        await post(casey, `/groups/${groupId}/join`, {});
      }
      await casey.goto(address);
      if (legacy) {
        await expect(casey.getByRole("alert")).toContainText("Historical expenses are unavailable");
        await expect(casey.getByText("Please explain this $5 portion.", { exact: true })).toHaveCount(0);
      } else {
        await expect(thread(casey)).toContainText("Visible response");
        await expect(thread(casey).getByLabel("Response", { exact: true })).toHaveCount(0);
        await expect(thread(casey).getByLabel("Disputed amount (USD)")).toHaveCount(0);
        await expect(casey.getByText("responded to a dispute", { exact: false })).toBeVisible();
      }
      const response = await casey.request.post(origin + `/api/disputes/${disputeId}/responses`, {
        data: { body: "Forged response" }, headers: { Origin: origin, "Idempotency-Key": crypto.randomUUID() },
      });
      expect(response.status()).toBe(legacy ? 404 : 403);
      const opening = await casey.request.post(origin + `/api/shares/${shareId}/disputes`, {
        data: { amount_minor: 100, reason: "Forged opening" }, headers: { Origin: origin, "Idempotency-Key": crypto.randomUUID() },
      });
      expect(opening.status()).toBe(legacy ? 404 : 403);
    } finally {
      await Promise.all([alex, sam, casey].map(page => page.context().close()));
    }
  });
}
