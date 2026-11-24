import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { admin } from "./local-api.mjs";

const url = new URL(process.env.BONFIRE_URL);
assert.ok(url.hostname === "127.0.0.1" && url.port && url.port !== "8137");
const login = await fetch(new URL("/api/login", url), {
  method: "POST",
  headers: { Authorization: admin },
});
assert.equal(login.status, 200);
const cookie = login.headers.getSetCookie()[0].split(";")[0];
async function api(path, body) {
  const response = await fetch(new URL("/api/" + path, url), {
    method: body ? "POST" : "GET",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  return response.json();
}
const day = "2478-05-14";
const year =
  (await api("years")).find((y) => y.Starts === day) ??
  (await api("years", { Name: "Layoutprüfung", Starts: day, Ends: day }));
const event = await api("events", {
  Name: "Übungsfest " + randomUUID(),
  Year: year.ID,
  Starts: day,
  Ends: day,
});
const browser = await chromium.launch({
  executablePath: process.env.BONFIRE_BROWSER || undefined,
});
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const failures = [];
  let views = 0;
  async function check(name, root = page.locator("article")) {
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      const touching = await root.evaluate((el) => {
        const controls = [
          ...el.querySelectorAll("button, a[href], summary"),
        ].filter(
          (b) =>
            b.checkVisibility() &&
            b.offsetWidth &&
            b.offsetHeight &&
            !b.closest("dialog:not([open])"),
        );
        // A scrolled list can extend behind a dialog footer. Measure the visible part.
        const boxes = controls
          .map((control) => {
            let { top, bottom, left, right } = control.getBoundingClientRect();
            for (
              let p = control.parentElement;
              p && p !== document.body;
              p = p.parentElement
            ) {
              const style = getComputedStyle(p),
                bounds = p.getBoundingClientRect();
              if (style.overflowY !== "visible") {
                top = Math.max(top, bounds.top);
                bottom = Math.min(bottom, bounds.bottom);
              }
              if (style.overflowX !== "visible") {
                left = Math.max(left, bounds.left);
                right = Math.min(right, bounds.right);
              }
            }
            return { control, top, bottom, left, right };
          })
          .filter((box) => box.bottom > box.top && box.right > box.left);
        const issues = [];
        for (const [i, x] of boxes.entries()) {
          const a = x.control;
          for (const y of boxes.slice(i + 1)) {
            const b = y.control;
            if (a.contains(b) || b.contains(a)) continue;
            const dx = Math.max(x.left - y.right, y.left - x.right);
            const dy = Math.max(x.top - y.bottom, y.top - x.bottom);
            if ((dx < 3.5 && dy < -2) || (dy < 3.5 && dx < -2))
              issues.push([a.textContent.trim(), b.textContent.trim()]);
          }
        }
        return issues;
      });
      for (const pair of touching) failures.push({ name, width, pair });
      if (
        process.env.BONFIRE_LAYOUT_SCREENSHOTS &&
        ["Erfassung", "Kontakte"].includes(name)
      ) {
        const area = name === "Erfassung" ? page : page.locator(".entry-list");
        await area.screenshot({
          path: "test-results/layout-" + name + "-" + width + ".png",
        });
      }
    }
    views++;
  }
  await page.goto(url.href);
  await page.locator("#login").waitFor();
  await check("Anmeldung");
  await context.addCookies([
    {
      name: "bonfire_session",
      value: cookie.split("=")[1],
      url: url.origin + "/api/",
    },
  ]);
  await page.reload();
  await page.getByRole("heading", { name: "Finanzen im Überblick" }).waitFor();
  async function nav(key) {
    const btn = page.locator('nav [data-page="' + key + '"]');
    if (!(await btn.isVisible()))
      await page.locator("#admin-navigation summary").click();
    await btn.click();
  }
  await check("Übersicht");
  await page.locator("#fiscal-switch summary").click();
  await page.locator('#fiscal-switch [data-fiscal="' + year.ID + '"]').click();

  await page.waitForFunction(
    () => !document.querySelector('article[aria-busy="true"]'),
  );
  await nav("Kontakte");
  const label = "Prüfkontakt " + randomUUID().slice(0, 8);
  await page.locator(".filter-box summary").click();
  await page.locator("#filter input").fill(label);
  await page.locator("#filter button").click();
  await page.getByText("Keine Einträge.", { exact: true }).waitFor();
  await check("Leere Kontakte");
  async function createAndEdit(section, name) {
    const dialog = page.getByRole("dialog");
    await page
      .getByRole("button", {
        name: section === "Spenden" ? "Spende erfassen" : "Kontakt anlegen",
        exact: true,
      })
      .click();
    assert.ok(await dialog.evaluate((el) => el.matches(":modal")));
    await dialog.getByLabel("Bezeichnung").fill(name);
    if (section === "Spenden")
      await dialog.getByLabel("Betrag in EUR").fill("5,50");
    await dialog
      .getByRole("button", { name: "Speichern", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    await page
      .getByRole("row")
      .filter({ hasText: name })
      .getByRole("button", { name: "Bearbeiten" })
      .click();
    assert.equal(await dialog.getByLabel("Bezeichnung").inputValue(), name);
    await dialog.getByLabel("Bezeichnung").fill(name + " bestätigt");
    await dialog.getByLabel("Änderungsgrund").fill("Fiktive Berichtigung");
    await dialog
      .getByRole("button", { name: "Berichtigung speichern" })
      .click();
    await dialog.waitFor({ state: "hidden" });
    await page
      .getByRole("cell", { name: name + " bestätigt", exact: true })
      .waitFor();
  }
  await createAndEdit("Kontakte", label);
  await check("Kontakte");
  const archive = page
    .getByRole("row")
    .filter({ hasText: label })
    .getByRole("button", { name: "Archivieren" });
  await archive.click();
  const reason = page.getByRole("dialog");
  await reason.getByLabel("Begründung").waitFor();
  assert.ok(await reason.evaluate((d) => d.matches(":modal")));
  await check("Kontakt archivieren", reason);
  await page.keyboard.press("Escape");
  assert.ok(await archive.evaluate((b) => b === document.activeElement));
  await nav("Spenden");
  await createAndEdit("Spenden", "Übungsspende " + randomUUID().slice(0, 8));
  await nav("Journal");
  await page.locator("[data-act=focusEntry]").click();
  await check("Erfassung", page.getByRole("dialog"));
  await page.locator(".record-extra summary").click();
  await check("Erfassung mit Zusatzfeldern", page.getByRole("dialog"));
  await page.locator("#record [data-act=cancel]").click();
  await nav("Veranstaltungen");
  await page.locator('[data-space="' + event.ID + '"]').click();
  await check("Veranstaltung");
  for (const key of ["Geldtaschen", "Zahlungen", "Preise", "Sponsoring"]) {
    await page
      .locator(
        'article .tabs [data-page="' +
          key +
          '"], nav [data-page="' +
          key +
          '"]',
      )
      .first()
      .click();
    await check(key);
  }
  for (const key of [
    "Spenden",
    "Dokumente",
    "Perioden",
    "Verwaltung",
    "Backup",
    "Benutzer",
    "Audit-Log",
    "Systemstatus",
  ]) {
    await nav(key);
    if (key === "Systemstatus")
      await page.getByRole("heading", { name: "PostgreSQL" }).waitFor();
    if (key === "Audit-Log") await page.locator(".ops-pages").waitFor();
    if (key === "Backup") await page.locator('[data-backup="new"]').waitFor();
    if (key === "Benutzer")
      await page.getByRole("heading", { name: "Benutzerkonten" }).waitFor();
    await check(key);
    if (key === "Benutzer") {
      await page.locator("[data-account-id]").first().click();
      await check("Kontoaktionen", page.getByRole("dialog"));
      await page.keyboard.press("Escape");
    }
    const dialogs =
      key === "Backup"
        ? ["Jetzt sichern", "Wiederherstellen"]
        : key === "Benutzer"
          ? [
              "Benutzer anlegen",
              "Zugang bearbeiten",
              "Passwort zurücksetzen",
              "Sitzungen widerrufen",
              "Zugang sperren",
            ]
          : [];
    for (const name of dialogs) {
      if (key === "Benutzer" && name !== "Benutzer anlegen")
        await page.locator("[data-account-id]").first().click();
      await page.getByRole("button", { name, exact: true }).click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      await check(name, dialog);
      await page.keyboard.press("Escape");
    }
    if (key === "Backup" || key === "Benutzer") {
      const tabs = page.locator(
        key === "Backup" ? "[data-backup-tab]" : "[data-account-tab]",
      );
      for (let i = 1; i < (await tabs.count()); i++) {
        const tab = tabs.nth(i);
        const name = await tab.innerText();
        await tab.click();
        await check(name);
      }
    }
  }
  await page.locator("#fiscal-switch summary").click();
  await page.locator('#fiscal-switch [data-fiscal=""]').click();
  await check("Geschäftsjahre");
  await page.getByRole("button", { name: "Geschäftsjahr anlegen" }).click();
  await check("Geschäftsjahr anlegen", page.getByRole("dialog"));
  assert.deepEqual(failures, []);
  console.log(
    "PASS Aktionsabstände in " +
      views +
      " Ansichten und Dialogzuständen bei 390 und 1440 Pixeln.",
  );
} finally {
  await browser.close();
}
