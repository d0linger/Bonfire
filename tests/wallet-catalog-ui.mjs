import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { admin, onlineClient } from "./local-api.mjs";

const entriesByID = rows => new Map(rows.map(row => [row.ID, row]));
const manager = await onlineClient();
const suffix = randomUUID().slice(0, 8);
const day = "2816-08-01";
const year = await manager("years", { Name: "Browser wallet exercise " + suffix, Starts: day, Ends: day });
const event = await manager("events", { Name: "Browser event " + suffix, Year: year.ID, Starts: day, Ends: day });
const first = "Ticket desk " + suffix;
const second = "Spare wallet " + suffix;
const url = process.env.BONFIRE_URL;
const browser = await chromium.launch({ executablePath: process.env.BONFIRE_BROWSER });
try {
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const login = await context.request.post(url + "/api/login", { headers: { Authorization: admin } });
  assert.ok(login.ok());
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const button = (scope, name) => scope.getByRole("button", { name, exact: true });
  const dialog = page.getByRole("dialog");
  await page.goto(url);
  await page.locator("#fiscal-switch summary").click();
  await page.locator('[data-fiscal="' + year.ID + '"]').click();
  const directory = button(page.locator("nav"), "Wallet list");
  if (!(await directory.isVisible())) await page.locator("#admin-navigation summary").click();
  await directory.click();
  await page.getByRole("heading", { name: "Wallet list", exact: true }).waitFor();
  assert.equal(await button(page, "Bulk wallet entry").count(), 0);
  for (const name of [first, second]) {
    await button(page, "Create wallet").click();
    await dialog.getByLabel("Wallet name").fill(name);
    if (name === first) {
      await dialog.getByLabel("Usual bar (optional)").fill("Ticket bar");
      await dialog.getByLabel("Suggested opening float in EUR").fill("25.00");
    }
    await button(dialog, "Save wallet").click();
    await page.getByRole("rowheader", { name, exact: true }).waitFor();
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#menu-toggle").click();
  await button(page.locator("nav"), "Events").click();
  await page.locator('[data-space="' + event.ID + '"]').click();
  await button(page.locator(".tabs"), "Wallets").click();
  await button(page, "Add from wallet list").click();
  await dialog.getByRole("checkbox", { name: new RegExp(first) }).check();
  await dialog.getByRole("checkbox", { name: new RegExp(second) }).check();
  assert.ok(await dialog.evaluate(el => el.getBoundingClientRect().right <= innerWidth + 1));
  const eventState = () => manager("online?event=" + event.ID, {});
  const beforeAssignment = (await eventState()).entries;
  const previousIDs = new Set(beforeAssignment.map(row => row.ID));
  await button(dialog, "Add selected wallets").click();
  await dialog.waitFor({ state: "hidden" });

  const afterAssignment = (await eventState()).entries;
  assert.deepEqual(entriesByID(afterAssignment.filter(row => previousIDs.has(row.ID))), entriesByID(beforeAssignment));
  const assigned = afterAssignment.filter(row => !previousIDs.has(row.ID));
  assert.deepEqual(assigned.map(row => row.Kind), ["wallet", "wallet"]);
  const local = assigned.find(row => row.Data.Label === first);
  assert.ok(local);
  await button(page, "Add from wallet list").click();
  for (const name of [first, second]) {
    const saved = dialog.getByRole("checkbox", { name: new RegExp(name) });
    assert.ok(await saved.isDisabled());
  }
  await page.keyboard.press("Escape");

  await button(page, "Count opening balance").click();
  await dialog.locator('[name="Wallet"]').selectOption(local.ID);
  await dialog.getByText(/Suggested opening float:.*25,00.*actually counted/).waitFor();
  await dialog.locator('[name="field_countMode"]').selectOption("amount");
  assert.equal(await dialog.locator('[name="amount"]').inputValue(), "");
  await page.keyboard.press("Escape");
  assert.deepEqual(entriesByID((await eventState()).entries), entriesByID(afterAssignment), "viewing a float suggestion must not change the ledger");
  const walletIDs = assigned.map(row => row.ID).sort();
  for (const mode of ["opening", "topup"]) {
    await button(page, "Bulk wallet entry").click();
    const form = dialog.locator("#bulk-wallets");
    await form.getByLabel("Action", { exact: true }).selectOption(mode);
    if (mode === "topup") {
      assert.equal(await form.getByLabel("Date", { exact: true }).inputValue(), "");
      await form.getByLabel("Date", { exact: true }).fill(day);
    }
    for (const name of [first, second]) {
      await form.getByRole("checkbox", { name: new RegExp(name) }).check();
    }
    const perWallet = mode === "opening" ? /12,50/ : /12,00/;
    const aggregate = mode === "opening" ? /25,00/ : /24,00/;
    if (mode === "opening") {
      await form.getByLabel("Amount per wallet in EUR").fill("12.50");
    } else {
      await form.getByLabel("Change source").selectOption("main-cashbox");
      await form.getByLabel("Enter amount", { exact: true }).selectOption("pieces");
      await form.locator('[data-denomination="1000"][data-step="1"]').click();
      await form.locator('[data-denomination="100"][data-step="2"]').click();
    }
    assert.match(await form.locator("#bulk-per-wallet").innerText(), perWallet);
    assert.match(await form.locator("#bulk-total").innerText(), aggregate);
    assert.match(await form.locator("#bulk-wallet-count").innerText(), /2/);
    assert.ok(await dialog.evaluate(el => el.getBoundingClientRect().right <= innerWidth + 1));
    const batchPath = "**/api/events/wallet-batch";
    let interruptedRequest;
    if (mode === "topup") {
      const breakdown = await form.locator(".bulk-denominations").innerText();
      assert.match(breakdown, /4 \u00d7 [^\d]*1,00/);
      assert.match(breakdown, /2 \u00d7 [^\d]*10,00/);
      await page.route(batchPath, async route => {
        interruptedRequest = route.request().postDataJSON();
        const committed = await route.fetch();
        assert.equal(committed.status(), 200);
        await route.abort("failed"); // The server committed, but the cashier did not receive its response.
      }, { times: 1 });
    }
    await button(form, "Save wallet entries").click();
    if (mode === "topup") {
      await dialog.locator(".entry-error:not(:empty)").waitFor();
      assert.ok(await form.getByLabel("Action", { exact: true }).isDisabled());
      const retried = page.waitForRequest(request => new URL(request.url()).pathname === "/api/events/wallet-batch");
      await button(dialog, "Retry wallet entries").click();
      assert.deepEqual((await retried).postDataJSON(), interruptedRequest);
    }
    await dialog.waitFor({ state: "hidden" });
    const kind = mode === "opening" ? "count" : "supply";
    const saved = (await eventState()).entries.filter(row => row.Kind === kind);
    assert.deepEqual(saved.map(row => row.Data.Wallet).sort(), walletIDs);
    for (const row of saved) {
      assert.equal(row.Data.Amount, mode === "opening" ? 1250 : 1200);
      if (mode === "opening") assert.equal(row.Data.Phase, "Anfang");
      else {
        assert.deepEqual(row.Data.Pieces, { 1000: 1, 100: 2 });
        assert.equal(row.Data.Account, "main-cashbox");
      }
    }
  }
  const batchPath = "**/api/events/wallet-batch";
  async function enterTopUp(amount) {
    await button(page, "Bulk wallet entry").click();
    await dialog.getByLabel("Action", { exact: true }).selectOption("topup");
    await dialog.getByLabel("Change source").selectOption("main-cashbox");
    await dialog.getByRole("checkbox", { name: new RegExp(first) }).check();
    await dialog.getByLabel("Amount per wallet in EUR").fill(amount);
  }
  let delayed;
  await enterTopUp("7.50");
  await page.route(batchPath, async (route) => {
    delayed = route.request().postDataJSON();
    await route.abort("failed");
  }, { times: 1 });
  await button(dialog, "Save wallet entries").click();
  await dialog.locator(".entry-error:not(:empty)").waitFor();
  await page.reload(); // Lose in-memory details, retain the opaque ID in this tab.
  await page.locator("#menu-toggle").click();
  await button(page.locator("nav"), "Events").click();
  await page.locator('[data-space="' + event.ID + '"]').click();
  await button(page.locator(".tabs"), "Wallets").click();
  await enterTopUp("9.00");
  // The original transaction commits only after the reloaded dialog read its event.
  await manager("events/wallet-batch", delayed);
  const storedRequest = () => page.evaluate((id) => Object.keys(sessionStorage)
    .some((key) => key.startsWith("bonfire-wallet-batch:") && sessionStorage.getItem(key) === id), delayed.Request);
  await page.route("**/api/online?event=" + event.ID, (route) => route.abort("failed"), { times: 1 });
  const mismatch = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/events/wallet-batch");
  await button(dialog, "Save wallet entries").click();
  assert.equal((await mismatch).status(), 409);
  await dialog.locator(".entry-error:not(:empty)").waitFor();
  assert.ok(await storedRequest(), "failed reconciliation must retain the committed request ID");
  const retry = page.waitForRequest((r) => new URL(r.url()).pathname === "/api/events/wallet-batch");
  await button(dialog, "Retry wallet entries").click();
  assert.equal((await retry).postDataJSON().Request, delayed.Request);
  await button(dialog, "Acknowledge saved batch").waitFor();
  assert.ok(await storedRequest(), "confirmation alone must not clear the ID before acknowledgement");
  assert.equal(await dialog.getByLabel("Amount per wallet in EUR").isVisible(), false);
  await page.keyboard.press("Escape");
  await button(page, "Bulk wallet entry").click();
  assert.equal(await button(dialog, "Save wallet entries").count(), 0);
  await button(dialog, "Acknowledge saved batch").click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await storedRequest(), false);
  const recorded = (await eventState()).entries.filter((r) => r.Kind === "supply");
  assert.equal(recorded.length, walletIDs.length + 1, "reconciliation must not create a duplicate top-up");
  const original = recorded.filter((r) => r.Data.Fields.walletBatch === delayed.Request);
  assert.equal(original.length, 1);
  assert.equal(original[0].Data.Amount, 750);
  console.log("PASS late wallet commit, changed details after reload, failed reconciliation and explicit acknowledgement");
  console.log("PASS mobile event bulk entry previews the per-wallet and combined total and saves opening counts and change deliveries");
  console.log("PASS create reusable wallets on desktop, select several on mobile, identify assigned wallets and view the suggested opening float");
} finally {
  await browser.close();
}
