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
        [
          "Erfassung",
          "Kontakte",
          "Veranstaltungsliste",
          "Geldtaschen",
        ].includes(name)
      ) {
        const area = name === "Kontakte" ? page.locator(".entry-list") : page;
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
  await page.locator("#entry-dialog [name=type]").selectOption("donation");
  assert.ok(await page.locator("#record [name=Contact]").isVisible());
  await page.locator("#entry-dialog [name=type]").selectOption("income");
  await page.locator(".record-extra summary").click();
  await check("Erfassung mit Zusatzfeldern", page.getByRole("dialog"));
  await page.locator("#record [data-act=cancel]").click();
  await nav("Veranstaltungen");
  await page.locator(".event-row").first().waitFor();
  await check("Veranstaltungsliste");
  await page.locator('[data-space="' + event.ID + '"]').click();
  await check("Veranstaltung");
  assert.equal(
    await page
      .locator("article .tabs")
      .locator(
        '[data-page="Kontakte"], [data-page="Spenden"], [data-page="Sponsoring"]',
      )
      .count(),
    0,
  );
  for (const key of ["Geldtaschen", "Zahlungen", "Preise"]) {
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
    if (key === "Zahlungen") {
      const dialog = page.getByRole("dialog");
      for (const [type, title] of [
        ["donation", "Festspende"],
        ["sponsorship", "Bannerrechnung"],
        ["payment", "Zahlung Bannerrechnung"],
      ]) {
        await page
          .getByRole("button", { name: "Veranstaltungsbuchung erfassen" })
          .click();
        await dialog.locator("[name=type]").selectOption(type);
        await dialog.locator("[name=Label]").fill(title);
        await dialog.locator("[name=amount]").fill("25,00");
        if (type === "sponsorship") {
          await dialog
            .locator("[name=Contact]")
            .selectOption({ label: label + " bestätigt" });
        } else {
          assert.equal(await dialog.locator("[name=Contact]").count(), 0);
          if (type === "payment") {
            await dialog
              .locator("[name=Reference]")
              .selectOption({ label: "Bannerrechnung" });
            await dialog.locator("[name=Method]").selectOption("Überweisung");
          }
        }
        await dialog
          .getByRole("button", { name: "Speichern", exact: true })
          .click();
        await dialog.waitFor({ state: "hidden" });
        await page
          .locator(".entry-list")
          .getByRole("cell", { name: title, exact: true })
          .waitFor();
      }
      const { entries } = await api("online?event=" + event.ID, {});
      const claim = entries.find(
        (r) => r.Kind === "sponsorship" && r.Data.Label === "Bannerrechnung",
      );
      const sponsor = entries.find((r) => r.ID === claim.Data.Contact);
      assert.equal(sponsor.Data.Label, label + " bestätigt");
      assert.equal(
        entries.find((r) => r.Kind === "payment").Data.Reference,
        claim.ID,
      );
      assert.equal(
        entries.find((r) => r.Data.Label === "Festspende").Data.Status,
        "Offen",
      );
      await page.getByRole("button", { name: "Rechnung öffnen" }).click();
      assert.equal(
        await page.locator("#export [name=profile]").inputValue(),
        "0",
      );
      assert.equal(
        await page.locator("#export [name=subject]").inputValue(),
        claim.ID,
      );
    }
    if (key === "Geldtaschen") {
      const actions = page.getByRole("region", {
        name: "Geldtaschen verwalten",
      });
      assert.deepEqual(await actions.getByRole("button").allTextContents(), [
        "Geldtasche anlegen",
        "Anfangsbestand zählen",
        "Wechselgeld nachlegen",
        "Endbestand zählen",
      ]);
      await actions.getByText("Weitere Vorgänge", { exact: true }).click();
      await check("Weitere Geldtaschenvorgänge", actions);
      assert.deepEqual(await actions.getByRole("heading").allTextContents(), [
        "Vor dem Fest",
        "Während des Fests",
        "Am Festende",
      ]);
      const dialog = page.getByRole("dialog");
      const wallet = "Tasche Süd";
      for (const name of [
        "Verfügbares Wechselgeld erfassen",
        "Wechselgeld je Tasche planen",
      ]) {
        await actions.getByRole("button", { name }).click();
        await dialog.getByRole("heading", { name: "Stückelung" }).waitFor();
        assert.equal(
          await dialog.locator("[name=Wallet]").count(),
          name.includes("planen") ? 1 : 0,
        );
        await page.keyboard.press("Escape");
      }
      await actions.getByRole("button", { name: "Geldtasche anlegen" }).click();
      await dialog.getByLabel("Bezeichnung").fill(wallet);
      await dialog
        .getByRole("button", { name: "Speichern", exact: true })
        .click();
      await dialog.waitFor({ state: "hidden" });
      await actions
        .getByRole("button", { name: "Wechselgeld nachlegen" })
        .click();
      await dialog.locator("[name=Wallet]").selectOption({ label: wallet });
      await dialog.locator("[name=Account]").fill("Handkassa");
      await dialog.getByLabel("Betrag in EUR").fill("25,00");
      assert.equal(await dialog.locator("[name=To]").count(), 0);
      await dialog
        .getByRole("button", { name: "Speichern", exact: true })
        .click();
      await dialog.waitFor({ state: "hidden" });
      for (const [name, phase, coins] of [
        ["Anfangsbestand zählen", "Anfang", "2"],
        ["Zwischenstand zählen", "Zwischenstand", "15"],
        ["Endbestand zählen", "Ende", "17"],
      ]) {
        await actions.getByRole("button", { name, exact: true }).click();
        await dialog.getByRole("heading", { name, exact: true }).waitFor();
        assert.equal(await dialog.locator("[name=Phase]").inputValue(), phase);
        assert.equal(
          await dialog.getByLabel("Vorgang", { exact: true }).count(),
          0,
        );
        await dialog.getByLabel("Bezeichnung").fill(name);
        await dialog.locator("[name=Wallet]").selectOption({ label: wallet });
        await dialog.locator("[name=coin200]").fill(coins);
        await dialog
          .getByRole("button", { name: "Speichern", exact: true })
          .click();
        await dialog.waitFor({ state: "hidden" });
      }
      const { entries } = await api("online?event=" + event.ID, {});
      const topUp = entries.find((r) => r.Kind === "supply").Data;
      assert.deepEqual(
        [topUp.Account, topUp.To, topUp.Amount],
        ["Handkassa", wallet, 2500],
      );
      assert.equal(topUp.Wallet, entries.find((r) => r.Kind === "wallet").ID);
      const counts = entries.filter((r) => r.Kind === "count");
      assert.deepEqual(
        Object.fromEntries(counts.map((r) => [r.Data.Phase, r.Data.Amount])),
        {
          Anfang: 400,
          Zwischenstand: 3000,
          Ende: 3400,
        },
      );
      await page
        .getByText(/Tasche Süd · Weitere Sammelbareinnahme\s+(?:€\s*)?5,00/)
        .waitFor();
    }
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
