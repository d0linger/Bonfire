import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { admin } from "./local-api.mjs";

const url = process.env.BONFIRE_URL;
if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname))
  throw Error("Lokalen Prüfstack angeben.");
assert.equal((await (await fetch(url + "/api/mode")).json()).offline, false);
const [, password] = Buffer.from(admin.slice(6), "base64")
  .toString()
  .split(":");
const browser = await chromium.launch({
  executablePath: process.env.BONFIRE_BROWSER || undefined,
});
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  const button = (name) => page.getByRole("button", { name, exact: true });
  const submit = async (id) => {
    await page.locator("#" + id + " button").click();
    await page.waitForFunction(
      () => !document.querySelector('article[aria-busy="true"]'),
    );
  };
  const go = async (name) => {
    if (!(await page.locator("nav").isVisible()))
      await page.locator("#menu-toggle").click();
    await page
      .locator("nav")
      .getByRole("button", { name, exact: true })
      .click();
  };
  await page.goto(url);
  await page.locator("#login [name=user]").fill("leitung");
  await page.locator("#login [name=pass]").fill(password);
  assert.equal(
    await page
      .getByText("Offlineprofile und Sicherungen", { exact: true })
      .count(),
    0,
  );
  await submit("login");
  const createYear = async (label, start, end) => {
    await page.locator("[name=year]").selectOption("");
    const f = page.locator("#fiscal-year");
    await f.locator("[name=Name]").fill(label);
    await f.locator("[name=Starts]").fill(start);
    await f.locator("[name=Ends]").fill(end);
    await submit("fiscal-year");
    await page
      .getByRole("heading", { name: "Finanzen im Überblick" })
      .waitFor();
    assert.equal(
      await page.locator("[name=workspace] option:checked").textContent(),
      "Allgemeines Kassenbuch",
    );
    return page.locator("[name=year]").inputValue();
  };
  const yearA = await createYear("2046", "2046-01-01", "2046-10-31");
  await go("Veranstaltungen");
  const event = page.locator("#event");
  await event.locator("[name=Name]").fill("Übung Sommerfest");
  await event.locator("[name=Starts]").fill("2046-08-20");
  await event.locator("[name=Ends]").fill("2046-08-21");
  await submit("event");
  await go("Kassenbuch");
  await button("Buchung erfassen").click();
  const booking = "Eintritt " + randomUUID();
  await page.locator("#record [name=Label]").fill(booking);
  await page.locator("#record [name=amount]").fill("50,00");
  await context.setOffline(true);
  await submit("record");
  await page
    .getByRole("alert")
    .getByText(/Keine Serververbindung/)
    .waitFor();
  await context.setOffline(false);
  await submit("record");
  await page.getByRole("cell", { name: booking, exact: true }).waitFor();
  await page.reload();
  await go("Kassenbuch");
  await page.getByRole("cell", { name: booking, exact: true }).waitFor();
  await button("Buchung erfassen").click();
  const uncertain = "Wechselgeldbeleg " + randomUUID();
  await page.locator("#record [name=Label]").fill(uncertain);
  await page.locator("#record [name=amount]").fill("3,00");
  await page.route(
    "**/api/online?*",
    async (route) => {
      const result = await route.fetch();
      assert.equal(result.status(), 200);
      await route.abort("failed");
    },
    { times: 1 },
  );
  await submit("record");
  await page
    .getByRole("alert")
    .getByText(/nicht bestätigt/)
    .waitFor();
  await submit("record");
  await page
    .getByRole("alert")
    .getByText(/zuerst den Serverstand/)
    .waitFor();
  await button("Serverstand aktualisieren").click();
  await page.getByRole("cell", { name: uncertain, exact: true }).waitFor();
  assert.equal(
    await page.getByRole("cell", { name: uncertain, exact: true }).count(),
    1,
  );
  assert.equal(await page.locator("#record").count(), 0);
  const yearB = await createYear("2047", "2046-11-01", "2047-12-31");
  assert.notEqual(yearA, yearB);
  await go("Veranstaltungen");
  assert.equal(await button("Übung Sommerfest").count(), 0);
  await page.locator("[name=year]").selectOption(yearA);
  await page
    .locator("[name=workspace] option")
    .filter({ hasText: "Übung Sommerfest" })
    .waitFor({ state: "attached" });
  await page
    .locator("[name=workspace]")
    .selectOption({ label: "Übung Sommerfest" });
  await page
    .getByRole("heading", { name: "Übung Sommerfest", exact: true })
    .waitFor();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  assert.deepEqual(
    await page.evaluate(() =>
      indexedDB.databases().then((d) => d.map((x) => x.name)),
    ),
    [],
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS Zwei freie Geschäftsjahre, eigenes Kassenbuch, Veranstaltung im Jahr, Onlinebuchung nach Verbindungsabbruch, Reload und mobile Jahresauswahl.",
  );
} finally {
  await browser.close();
}
