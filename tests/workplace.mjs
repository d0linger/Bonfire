import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { api, admin, auth, basic } from "./local-api.mjs";
const url = process.env.BONFIRE_URL;
if (!url || !["127.0.0.1", "localhost"].includes(new URL(url).hostname))
  throw Error("BONFIRE_URL der lokalen Prüfinstallation setzen.");
const date = "2035-06-21",
  event = await api("events", admin, {
    Name: "Sommerfest am Gerätehaus",
    Starts: date,
    Ends: "2035-06-22",
  });
const other = await api("events", admin, {
  Name: "Separater Prüfarbeitsbereich",
  Starts: date,
  Ends: date,
});
const user = "pruefung-" + randomUUID().slice(0, 6),
  pass = randomUUID();
await api("users", admin, {
  Name: user,
  Role: "Read",
  Password: pass,
  Event: event.ID,
});
const d = await api("prepare", admin, {
  Event: event.ID,
  Name: "Fiktive Hauptkassa",
});
const rows = [
  ["opening", "Anfangsbestand", 240000],
  ["income", "Eintritt Sommerfest", 84000],
  ["expense", "Einkauf Getränke", 18650],
  ["income", "Kuchenstand", 21500],
  ["expense", "Papier und Druck", 3200],
];
await api("sync", auth(d), {
  Ops: rows.map(([Kind, Label, Amount], i) => ({
    ID: randomUUID(),
    Target: randomUUID(),
    Seq: i + 1,
    Kind,
    Base: 0,
    Data: {
      Date: date,
      Label,
      Amount,
      Note: "Synthetischer interner Prüfvermerk",
    },
  })),
});
const get = (id, token) =>
  fetch(url + "/api/workplace?event=" + id, {
    headers: token ? { Authorization: token } : {},
  });
assert.equal((await get(event.ID)).status, 401);
assert.equal((await get(other.ID, basic(user, pass))).status, 403);
const snapshot = await (await get(event.ID, basic(user, pass))).json();
assert.equal(snapshot.entries.length, rows.length);
assert.equal(snapshot.pending, 1);
assert.ok(!JSON.stringify(snapshot).includes("interner Prüfvermerk"));
await mkdir("test-results/ansichten", { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.BONFIRE_BROWSER || undefined,
  headless: true,
});
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 960 },
    colorScheme: "light",
  });
  await page.goto(url);
  await page.locator("#login [name=user]").fill(user);
  await page.locator("#login [name=pass]").fill(pass);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading", { name: "Finanzen im Überblick" }).waitFor();
  await page.getByText("Server erreichbar", { exact: true }).waitFor();
  const main = page.locator("article");
  assert.ok((await main.innerText()).includes("3.236,50"));
  assert.equal(await page.locator("nav button[data-page]").count(), 8);
  await page.screenshot({
    path: "test-results/ansichten/arbeitsplatz-desktop.png",
  });
  await page.reload();
  await main.getByRole("heading", { name: "Finanzen im Überblick" }).waitFor();
  for (const name of [
    "Kassenbuch",
    "Veranstaltungen",
    "Kontakte",
    "Spenden",
    "Dokumente",
    "Abschluss",
    "Verwaltung",
    "Übersicht",
  ]) {
    await page
      .locator("nav")
      .getByRole("button", { name, exact: true })
      .click();
    if (name === "Kassenbuch")
      await main.getByText("Kuchenstand", { exact: true }).waitFor();
    if (name === "Veranstaltungen")
      await main
        .getByRole("button", { name: "Geldtaschen", exact: true })
        .click();
    if (name === "Dokumente")
      assert.equal(await page.locator(".catalog li").count(), 11);
    if (name === "Verwaltung")
      assert.equal(await page.locator("#user,#event,#access").count(), 0);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.locator("#menu-toggle").isVisible());
  assert.ok(!(await page.locator("nav").isVisible()));
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({
    path: "test-results/ansichten/arbeitsplatz-mobil.png",
    fullPage: true,
  });
  await page.locator("#menu-toggle").click();
  await page.locator("nav").getByRole("button", { name: "Kassenbuch" }).click();
  assert.ok(!(await page.locator("nav").isVisible()));
  await page.context().setOffline(true);
  await page.getByText("Offline", { exact: true }).waitFor();
  await page.context().setOffline(false);
  await page.getByText("Server erreichbar", { exact: true }).waitFor();
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForFunction(()=>document.documentElement.dataset.theme==="dark");
  assert.notEqual(
    await page
      .locator("body")
      .evaluate((el) => getComputedStyle(el).backgroundColor),
    "rgb(244, 245, 247)",
  );
  const after = await (await get(event.ID, basic(user, pass))).json();
  assert.equal(after.pending, snapshot.pending);
  console.log(
    "PASS Anmeldung direkt im Finanzüberblick, Reload, acht Module, echte Salden, Rollenprüfung, mobile Navigation, Dunkelmodus und unveränderte Gerätezahl",
  );
} finally {
  await browser.close();
}
