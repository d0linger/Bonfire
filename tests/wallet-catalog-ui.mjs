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
  console.log("PASS create reusable wallets on desktop, select several on mobile, identify assigned wallets and view the suggested opening float");
} finally {
  await browser.close();
}
