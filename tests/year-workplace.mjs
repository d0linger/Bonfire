import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { admin, api } from "./local-api.mjs";

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
    await page.locator("#" + id + " button:not([type=button])").click();
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
  const chooseYear = async (id) => {
    if (!(await page.locator("#sidebar").isVisible()))
      await page.locator("#menu-toggle").click();
    await page.locator("#sidebar #fiscal-switch summary").click();
    await page
      .locator('#fiscal-switch button[data-fiscal="' + id + '"]')
      .click();
    await page.waitForFunction(
      () => !document.querySelector('article[aria-busy="true"]'),
    );
  };
  const createYear = async (label, start, end) => {
    await chooseYear("");
    await button("Geschäftsjahr anlegen").click();
    await page.getByRole("dialog", { name: "Geschäftsjahr anlegen" }).waitFor();
    const f = page.locator("#fiscal-year");
    await f.locator("[name=Name]").fill(label);
    await f.locator("[name=Starts]").fill(start);
    await f.locator("[name=Ends]").fill(end);
    await submit("fiscal-year");
    await page
      .getByRole("heading", { name: "Finanzen im Überblick" })
      .waitFor();
    assert.ok(
      (await page.locator("#workspace-picker").innerText()).includes(
        "Allgemeines Kassenbuch",
      ),
    );
    assert.equal(await page.locator("select[name=workspace]").count(), 0);
    return page
      .locator("#fiscal-switch [aria-current=true]")
      .getAttribute("data-fiscal");
  };
  const yearA = await createYear("Entwurf 2046", "2046-01-02", "2046-10-30");
  await chooseYear("");
  await button("Geschäftsjahr Entwurf 2046 bearbeiten").click();
  const yearDialog = page.getByRole("dialog", {
    name: "Geschäftsjahr bearbeiten",
  });
  assert.equal(
    await yearDialog.getByLabel("Bezeichnung").inputValue(),
    "Entwurf 2046",
  );
  assert.equal(
    await yearDialog.getByLabel("Von", { exact: true }).inputValue(),
    "2046-01-02",
  );
  assert.equal(
    await yearDialog.getByLabel("Bis", { exact: true }).inputValue(),
    "2046-10-30",
  );
  await yearDialog.getByLabel("Bezeichnung").fill("2046");
  await yearDialog.getByLabel("Von", { exact: true }).fill("2046-01-01");
  await yearDialog.getByLabel("Bis", { exact: true }).fill("2046-10-31");
  await submit("year-edit");
  await yearDialog.waitFor({ state: "hidden" });
  const yearRow = page
    .locator(".fiscal-year-row")
    .filter({ has: page.locator('[data-year="' + yearA + '"]') });
  assert.match(await yearRow.innerText(), /01\.01\.2046.*31\.10\.2046/);
  await yearRow.getByRole("button", { name: "2046", exact: true }).click();
  await page.getByRole("heading", { name: "Finanzen im Überblick" }).waitFor();
  const opening = button("Anfangsbestand fehlt");
  const enterOpening = async (target, date, amount) => {
    await opening.click();
    const dialog = page.getByRole("dialog", {
      name: "Anfangsbestand erfassen",
    });
    assert.equal(
      await dialog.locator(".booking-target strong").textContent(),
      target,
    );
    assert.equal(
      await dialog.getByLabel("Datum", { exact: true }).inputValue(),
      date,
    );
    await dialog.getByLabel("Betrag in EUR").fill(amount);
    await submit("record");
    await page
      .getByText("Mit erfasstem Anfangsbestand", { exact: true })
      .waitFor();
    assert.equal(await opening.count(), 0);
    assert.ok(
      (await page.locator(".kpi.featured strong").innerText()).includes(amount),
    );
  };
  await enterOpening(
    "Allgemeines Kassenbuch · Geschäftsjahr 2046",
    "2046-01-01",
    "175,50",
  );
  await go("Veranstaltungen");
  await button("Veranstaltung anlegen").click();
  await page.getByRole("dialog", { name: "Veranstaltung anlegen" }).waitFor();
  const event = page.locator("#event");
  await event.locator("[name=Name]").fill("Übung Sommerfest");
  await event.locator("[name=Starts]").fill("2046-08-20");
  await event.locator("[name=Ends]").fill("2046-08-21");
  await submit("event");
  const eventName = "Übung Sommerfest";
  await enterOpening(
    "Veranstaltung · " + eventName + " · Geschäftsjahr 2046",
    "2046-08-20",
    "0,00",
  );
  await go("Veranstaltungen");
  const eventRow = page
    .getByRole("listitem")
    .filter({ has: button(eventName) });
  await eventRow
    .getByText("20.08.2046 – 21.08.2046", { exact: true })
    .waitFor();
  await eventRow.getByText("Buchung offen", { exact: true }).waitFor();
  await eventRow
    .getByRole("button", { name: "Veranstaltungsbuchung erfassen" })
    .click();
  const eventBooking = "Festkassa " + randomUUID();
  const eventDialog = page.getByRole("dialog");
  assert.match(
    await eventDialog.locator(".booking-target").innerText(),
    /Veranstaltung · Übung Sommerfest · Geschäftsjahr 2046/,
  );
  await eventDialog
    .getByLabel("Bezeichnung", { exact: true })
    .fill(eventBooking);
  await eventDialog.getByLabel("Betrag in EUR").fill("12,34");
  await eventDialog
    .getByRole("button", { name: "Speichern", exact: true })
    .click();
  await page.getByRole("cell", { name: eventBooking, exact: true }).waitFor();
  for (const [type, label, amount] of [
    ["expense", "Geschirr", "3,34"],
    ["outlay", "Privat bezahlte Getränke", "10,00"],
  ]) {
    await button("Veranstaltungsbuchung erfassen").click();
    await eventDialog.locator("select[name=type]").selectOption(type);
    await eventDialog
      .getByLabel(type === "expense" ? "Wofür?" : "Bezeichnung", {
        exact: true,
      })
      .fill(label);
    if (type === "expense")
      await eventDialog
        .getByLabel("Rechnungssteller")
        .fill("Fiktiver Übungsmarkt");
    await eventDialog.getByLabel("Betrag in EUR").fill(amount);
    await submit("record");
    await page
      .getByRole("cell", {
        name: type === "expense" ? label + " · Fiktiver Übungsmarkt" : label,
        exact: true,
      })
      .waitFor();
  }
  await page.locator("#menu-toggle").click();
  const home = page.locator("a.brand-home");
  await home.focus();
  await home.press("Enter");
  await page.getByRole("heading", { name: "Finanzen im Überblick" }).waitFor();
  assert.ok(
    (await page.locator(".kpi.featured strong").innerText()).includes("175,50"),
  );
  assert.match(
    await page.locator("#workspace-picker").innerText(),
    /Allgemeines Kassenbuch · Geschäftsjahr 2046/,
  );
  assert.equal(
    await page
      .locator("#content")
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await go("Kassenbuch");
  await page
    .getByRole("heading", { name: "Kassenbuch", exact: true })
    .waitFor();
  assert.equal(
    await page.getByRole("cell", { name: eventBooking, exact: true }).count(),
    0,
  );
  await button("Buchung erfassen").click();
  const modal = page.getByRole("dialog", { name: "Buchung erfassen" });
  await modal.waitFor();
  assert.match(
    await modal.locator(".booking-target").innerText(),
    /Allgemeines Kassenbuch · Geschäftsjahr 2046/,
  );
  assert.ok(
    await modal.evaluate(
      (d) => d.matches(":modal") && d.contains(document.activeElement),
    ),
  );
  await page.keyboard.press("Escape");
  assert.ok(
    await button("Buchung erfassen").evaluate(
      (b) => b === document.activeElement,
    ),
  );
  await button("Buchung erfassen").click();
  const booking = "Eintritt " + randomUUID();
  await modal.locator("select[name=type]").selectOption("income");
  const editor = page.locator("#record");
  const details = editor.locator(".record-extra > summary");
  assert.ok(await editor.locator("[name=Method]").isVisible());
  assert.ok(!(await editor.locator("[name=Reference]").isVisible()));
  await details.click();
  await editor.locator("[name=Reference]").fill("Übungsbeleg 1");
  await details.click();
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
  await page
    .getByRole("row")
    .filter({ hasText: booking })
    .getByRole("button", { name: "Bearbeiten" })
    .click();
  assert.ok(await editor.getByLabel("Änderungsgrund").isVisible());
  await details.click();
  assert.equal(
    await editor.locator("[name=Reference]").inputValue(),
    "Übungsbeleg 1",
  );
  await editor.getByRole("button", { name: "Abbrechen", exact: true }).click();
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
  await modal
    .getByRole("button", { name: "Serverstand aktualisieren" })
    .click();
  await page.getByRole("cell", { name: uncertain, exact: true }).waitFor();
  assert.equal(
    await page.getByRole("cell", { name: uncertain, exact: true }).count(),
    1,
  );
  assert.equal(await page.locator("#record").count(), 0);
  const yearB = await createYear("2047", "2046-11-01", "2047-12-31");
  assert.notEqual(yearA, yearB);
  await opening.click();
  const priorMode = page.getByRole("radio", { name: "Aus Vorjahr übernehmen" });
  await priorMode.check();
  await page.getByText(/kein bestätigter Schlussbestand vor/).waitFor();
  await page.getByRole("radio", { name: "Händisch erfassen" }).check();
  assert.ok(await page.getByLabel("Betrag in EUR").isVisible());
  await page.keyboard.press("Escape");
  const previousSpaces = await (
    await page.request.get(url + "/api/events?year=" + yearA)
  ).json();
  const previousLedger = previousSpaces.find((e) => e.General);
  const finish = await page.request.post(
    url + "/api/online?event=" + previousLedger.ID,
    {
      data: {
        Ops: [
          {
            ID: randomUUID(),
            Target: randomUUID(),
            Kind: "actual",
            Data: {
              Date: "2046-10-31",
              Label: "Bestätigte Zählung",
              Amount: 22850,
            },
          },
        ],
        Action: "Abschluss",
      },
    },
  );
  assert.equal(finish.status(), 200, await finish.text());
  await opening.click();
  await priorMode.check();
  const carryForm = page.locator("#year-carry");
  await carryForm.waitFor();
  assert.match(await page.locator(".year-carry-preview").innerText(), /228,50/);
  await submit("year-carry");
  await page
    .getByText("Mit erfasstem Anfangsbestand", { exact: true })
    .waitFor();
  assert.match(
    await page.locator(".kpi.featured strong").innerText(),
    /228,50/,
  );
  await go("Veranstaltungen");
  await page
    .getByText("Für dieses Geschäftsjahr gibt es noch keine Veranstaltung.")
    .waitFor();
  assert.equal(await button("Übung Sommerfest").count(), 0);
  assert.equal(
    await page.locator("#fiscal-switch summary small").textContent(),
    "01.11.2046 – 31.12.",
  );
  const closingFest = "Prüffest Jahresabschluss";
  const response = await page.request.post(url + "/api/events", {
    data: {
      Year: yearB,
      Name: closingFest,
      Starts: "2047-09-01",
      Ends: "2047-09-01",
    },
  });
  assert.equal(response.status(), 200);
  const fest = await response.json();
  const ledgerB = (
    await (await page.request.get(url + "/api/events?year=" + yearB)).json()
  ).find((e) => e.General);
  const counted = (Kind, Date, Amount) => ({
    ID: randomUUID(),
    Target: randomUUID(),
    Kind,
    Data: { Date, Amount, Label: "Übungszählung" },
  });
  for (const [id, ops] of [
    [
      fest.ID,
      [counted("opening", fest.Starts, 0), counted("actual", fest.Ends, 0)],
    ],
    [ledgerB.ID, [counted("actual", ledgerB.Ends, 22850)]],
  ]) {
    const setup = await page.request.post(url + "/api/online?event=" + id, {
      data: { Ops: ops },
    });
    assert.equal(
      setup.status(),
      200,
      ops[0].Kind + ": " + (await setup.text()),
    );
  }
  await go("Veranstaltungen");
  await button(closingFest).click();
  const closeDialog = async (name, reason) => {
    await button(name).click();
    const dialog = page.getByRole("dialog", { name, exact: true });
    if (reason)
      await dialog.getByLabel("Grund für die Wiederöffnung").fill(reason);
    await dialog.getByRole("button", { name, exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
  };
  await closeDialog("Veranstaltung abschließen");
  await button("Veranstaltung wieder öffnen").waitFor();
  await go("Übersicht");
  await closeDialog("Geschäftsjahr abschließen");
  await page
    .getByText("Geschäftsjahr abgeschlossen · Nur Lesen", { exact: true })
    .waitFor();
  await go("Veranstaltungen");
  await button(closingFest).waitFor();
  assert.equal(await button("Veranstaltung anlegen").count(), 0);
  assert.equal(await button("Veranstaltungsbuchung erfassen").count(), 0);
  await button(closingFest).click();
  assert.equal(await button("Veranstaltung wieder öffnen").count(), 0);
  await go("Übersicht");
  await closeDialog("Geschäftsjahr wieder öffnen", "Korrektur im Test");
  await go("Veranstaltungen");
  await button(closingFest).click();
  await closeDialog("Veranstaltung wieder öffnen", "Beleg ergänzen");
  await button("Veranstaltung abschließen").waitFor();
  await chooseYear(yearA);
  await go("Veranstaltungen");
  const figures = eventRow.locator(".event-figures");
  await figures.waitFor();
  assert.deepEqual(await figures.locator("dt").allTextContents(), [
    "Einnahmen",
    "Ausgaben",
    "Ergebnis",
  ]);
  assert.match(await figures.locator("dd").nth(0).innerText(), /12,34/);
  assert.match(await figures.locator("dd").nth(1).innerText(), /3,34/);
  const listedResult = await figures.locator("dd.deficit").innerText();
  assert.match(listedResult, /[-−].*1,00/);
  assert.match(await figures.locator("small").innerText(), /10,00/);
  const eventID = await button(eventName).getAttribute("data-space");
  await button(eventName).click();
  await page.getByRole("heading", { name: eventName, exact: true }).waitFor();
  assert.equal(
    await page
      .locator(".kpi")
      .filter({ hasText: "Veranstaltungsergebnis" })
      .locator("strong")
      .innerText(),
    listedResult,
  );
  await button("Veranstaltungsbuchungen öffnen").click();
  await page.getByRole("cell", { name: eventBooking, exact: true }).waitFor();
  assert.equal(
    await page.getByRole("cell", { name: booking, exact: true }).count(),
    0,
  );
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
  const writerName = "fest-" + randomUUID();
  const writerPassword = randomUUID();
  await api("users", admin, {
    Name: writerName,
    Password: writerPassword,
    Role: "Write",
    Event: eventID,
  });
  const restricted = await browser.newContext();
  const writer = await restricted.newPage();
  await writer.goto(url);
  await writer.locator("#login [name=user]").fill(writerName);
  await writer.locator("#login [name=pass]").fill(writerPassword);
  await writer
    .locator("#login button[type=submit], #login button:not([type])")
    .click();
  await writer
    .locator("nav")
    .getByRole("button", { name: "Kassenbuch", exact: true })
    .click();
  await writer
    .getByText(
      "Für diesen Bereich ist kein allgemeines Kassenbuch freigegeben.",
    )
    .waitFor();
  assert.equal(
    await writer.getByRole("button", { name: "Buchung erfassen" }).count(),
    0,
  );
  await writer.getByRole("button", { name: "Veranstaltungen öffnen" }).click();
  await writer.getByRole("button", { name: eventName, exact: true }).click();
  await writer
    .getByRole("button", { name: "Veranstaltungsbuchungen öffnen" })
    .click();
  await writer.getByRole("cell", { name: eventBooking, exact: true }).waitFor();
  await writer
    .getByRole("button", { name: "Veranstaltungsbuchung erfassen" })
    .click();
  assert.match(
    await writer.getByRole("dialog").locator(".booking-target").innerText(),
    /Übung Sommerfest · Geschäftsjahr 2046/,
  );
  await restricted.close();
  console.log(
    "PASS Getrennte Kassenbuch- und Veranstaltungsbuchungen, explizite Veranstaltungswahl bei eingeschränkten Schreibrechten, Jahreswechsel, Verbindungsabbruch und mobile Ansicht.",
  );
} finally {
  await browser.close();
}
