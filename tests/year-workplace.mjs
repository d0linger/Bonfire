import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { admin, api } from "./local-api.mjs";

const url = process.env.BONFIRE_URL;
if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname) || new URL(url).port === "8137")
  throw Error("Lokalen Prüfstack angeben.");
assert.equal((await (await fetch(url + "/api/mode")).json()).offline, false);
const credentials = Buffer.from(admin.slice(6), "base64").toString();
const password = credentials.slice(credentials.indexOf(":") + 1);
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
      .getByText("Offline profiles and backups", { exact: true })
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
    await button("Create fiscal year").click();
    await page.getByRole("dialog", { name: "Create fiscal year" }).waitFor();
    const f = page.locator("#fiscal-year");
    await f.locator("[name=Name]").fill(label);
    await f.locator("[name=Starts]").fill(start);
    await f.locator("[name=Ends]").fill(end);
    await submit("fiscal-year");
    await page
      .getByRole("heading", { name: "Financial overview" })
      .waitFor();
    assert.ok(
      (await page.locator("#workspace-picker").innerText()).includes(
        "General cashbook",
      ),
    );
    assert.equal(await page.locator("select[name=workspace]").count(), 0);
    return page
      .locator("#fiscal-switch [aria-current=true]")
      .getAttribute("data-fiscal");
  };
  const yearA = await createYear("Entwurf 2046", "2046-01-02", "2046-10-30");
  if (!(await page.locator("nav").isVisible())) await page.locator("#menu-toggle").click();
  const organization = page.locator("#admin-navigation").getByRole("button", { name: "Organization", exact: true });
  if (!(await organization.isVisible())) await page.locator("#admin-navigation summary").click();
  await organization.click();
  await button("Data exchange").click();
  const previewForm = page.locator("#preview");
  await previewForm.locator("input[type=file]").setInputFiles({
    name: "training.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("Date;Type;Description;Amount_Cents\n2046-01-03;expense;Training supplies;425\n"),
  });
  await previewForm.getByRole("button", { name: "Review file" }).click();
  await button("Review import row").click();
  const importForm = page.locator("#importRow");
  assert.equal(await importForm.locator("[name=kind]").inputValue(), "");
  await importForm.locator("[name=ix]").selectOption("0");
  assert.equal(await importForm.locator("[name=kind]").inputValue(), "expense");
  assert.equal(await importForm.locator("[name=date]").inputValue(), "2046-01-03");
  await importForm.locator("[name=ix]").selectOption("");
  assert.equal(await importForm.locator("[name=date]").inputValue(), "");
  await button("Cancel").click();
  await chooseYear("");
  await button("Edit fiscal year Entwurf 2046").click();
  const yearDialog = page.getByRole("dialog", {
    name: "Edit fiscal year",
  });
  assert.equal(
    await yearDialog.getByLabel("Name").inputValue(),
    "Entwurf 2046",
  );
  assert.equal(
    await yearDialog.getByLabel("Start date", { exact: true }).inputValue(),
    "2046-01-02",
  );
  assert.equal(
    await yearDialog.getByLabel("End date", { exact: true }).inputValue(),
    "2046-10-30",
  );
  await yearDialog.getByLabel("Name").fill("2046");
  await yearDialog.getByLabel("Start date", { exact: true }).fill("2046-01-01");
  await yearDialog.getByLabel("End date", { exact: true }).fill("2046-10-31");
  await submit("year-edit");
  await yearDialog.waitFor({ state: "hidden" });
  const yearRow = page
    .locator(".fiscal-year-row")
    .filter({ has: page.locator('[data-year="' + yearA + '"]') });
  assert.match(await yearRow.innerText(), /01\/01\/2046.*31\/10\/2046/);
  await yearRow.getByRole("button", { name: "2046", exact: true }).click();
  await page.getByRole("heading", { name: "Financial overview" }).waitFor();
  const opening = button("Opening balance missing");
  const enterOpening = async (target, date, amount) => {
    await opening.click();
    const dialog = page.getByRole("dialog", {
      name: "Enter opening balance",
    });
    assert.equal(
      await dialog.locator(".booking-target strong").textContent(),
      target,
    );
    assert.equal(
      await dialog.getByLabel("Date", { exact: true }).inputValue(),
      date,
    );
    await dialog.getByLabel("Amount in EUR").fill(amount);
    await submit("record");
    await page
      .getByText("Opening balance recorded", { exact: true })
      .waitFor();
    assert.equal(await opening.count(), 0);
    assert.ok(
      (await page.locator(".kpi.featured strong").innerText()).includes(amount),
    );
  };
  await enterOpening(
    "General cashbook · Fiscal year 2046",
    "2046-01-01",
    "175,50",
  );
  await go("Events");
  await button("Create event").click();
  await page.getByRole("dialog", { name: "Create event" }).waitFor();
  const event = page.locator("#event");
  await event.locator("[name=Name]").fill("Übung Sommerfest");
  await event.locator("[name=Starts]").fill("2046-08-20");
  await event.locator("[name=Ends]").fill("2046-08-21");
  await submit("event");
  const eventName = "Übung Sommerfest";
  await enterOpening(
    "Event · " + eventName + " · Fiscal year 2046",
    "2046-08-20",
    "0,00",
  );
  await go("Events");
  const eventRow = page
    .getByRole("listitem")
    .filter({ has: button(eventName) });
  await eventRow
    .getByText("20/08/2046 – 21/08/2046", { exact: true })
    .waitFor();
  await eventRow.getByText("Open for bookings", { exact: true }).waitFor();
  await eventRow
    .getByRole("button", { name: "Record event transaction" })
    .click();
  const eventBooking = "Festkassa " + randomUUID();
  const eventDialog = page.getByRole("dialog");
  assert.match(
    await eventDialog.locator(".booking-target").innerText(),
    /Event · Übung Sommerfest · Fiscal year 2046/,
  );
  await eventDialog
    .getByLabel("Description", { exact: true })
    .fill(eventBooking);
  await eventDialog.getByLabel("Amount in EUR").fill("12,34");
  await eventDialog
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await page.getByRole("cell", { name: eventBooking, exact: true }).waitFor();
  for (const [type, label, amount] of [
    ["expense", "Geschirr", "3,34"],
    ["outlay", "Privat bezahlte Getränke", "10,00"],
  ]) {
    await button("Record event transaction").click();
    await eventDialog.locator("select[name=type]").selectOption(type);
    await eventDialog
      .getByLabel(type === "expense" ? "What was it for?" : "Description", {
        exact: true,
      })
      .fill(label);
    if (type === "expense")
      await eventDialog
        .getByLabel("Invoice issuer")
        .fill("Fiktiver Übungsmarkt");
    await eventDialog.getByLabel("Amount in EUR").fill(amount);
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
  await page.getByRole("heading", { name: "Financial overview" }).waitFor();
  assert.ok(
    (await page.locator(".kpi.featured strong").innerText()).includes("175,50"),
  );
  assert.match(
    await page.locator("#workspace-picker").innerText(),
    /General cashbook · Fiscal year 2046/,
  );
  assert.equal(
    await page
      .locator("#content")
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await go("Cashbook");
  await page
    .getByRole("heading", { name: "Cashbook", exact: true })
    .waitFor();
  assert.equal(
    await page.getByRole("cell", { name: eventBooking, exact: true }).count(),
    0,
  );
  await button("Record transaction").click();
  const modal = page.getByRole("dialog", { name: "Record transaction" });
  await modal.waitFor();
  assert.match(
    await modal.locator(".booking-target").innerText(),
    /General cashbook · Fiscal year 2046/,
  );
  assert.ok(
    await modal.evaluate(
      (d) => d.matches(":modal") && d.contains(document.activeElement),
    ),
  );
  await page.keyboard.press("Escape");
  assert.ok(
    await button("Record transaction").evaluate(
      (b) => b === document.activeElement,
    ),
  );
  await button("Record transaction").click();
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
    .getByText(/The server is unreachable/)
    .waitFor();
  await context.setOffline(false);
  await submit("record");
  await page.getByRole("cell", { name: booking, exact: true }).waitFor();
  await page.reload();
  await go("Cashbook");
  await page.getByRole("cell", { name: booking, exact: true }).waitFor();
  await page
    .getByRole("row")
    .filter({ hasText: booking })
    .getByRole("button", { name: "Edit" })
    .click();
  assert.ok(await editor.getByLabel("Reason for correction").isVisible());
  await details.click();
  assert.equal(
    await editor.locator("[name=Reference]").inputValue(),
    "Übungsbeleg 1",
  );
  await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  await button("Record transaction").click();
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
    .getByText(/did not confirm this operation/)
    .waitFor();
  await submit("record");
  await page
    .getByRole("alert")
    .getByText(/Refresh the server records/)
    .waitFor();
  await modal
    .getByRole("button", { name: "Refresh entries" })
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
  const priorMode = page.getByRole("radio", { name: "Carry forward from prior year" });
  await priorMode.check();
  await page.getByText(/no confirmed closing balance/).waitFor();
  await page.getByRole("radio", { name: "Enter manually" }).check();
  assert.ok(await page.getByLabel("Amount in EUR").isVisible());
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
    .getByText("Opening balance recorded", { exact: true })
    .waitFor();
  assert.match(
    await page.locator(".kpi.featured strong").innerText(),
    /228,50/,
  );
  await go("Events");
  await page
    .getByText("There are no events in this fiscal year yet.")
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
  await go("Events");
  await button(closingFest).click();
  const closeDialog = async (name, reason) => {
    await button(name).click();
    const dialog = page.getByRole("dialog", { name, exact: true });
    if (reason)
      await dialog.getByLabel("Reason for reopening").fill(reason);
    await dialog.getByRole("button", { name, exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
  };
  await closeDialog("Close event");
  await button("Reopen event").waitFor();
  await go("Overview");
  await closeDialog("Close fiscal year");
  await page
    .getByText("Fiscal year closed · Read only", { exact: true })
    .waitFor();
  await go("Events");
  await button(closingFest).waitFor();
  assert.equal(await button("Create event").count(), 0);
  assert.equal(await button("Record event transaction").count(), 0);
  await button(closingFest).click();
  await page.getByRole("heading", { name: closingFest, exact: true }).waitFor();
  assert.equal(await button("Reopen event").count(), 0);
  await go("Overview");
  await closeDialog("Reopen fiscal year", "Korrektur im Test");
  await go("Events");
  await button(closingFest).click();
  await closeDialog("Reopen event", "Beleg ergänzen");
  await button("Close event").waitFor();
  await chooseYear(yearA);
  await go("Events");
  const figures = eventRow.locator(".event-figures");
  await figures.waitFor();
  assert.deepEqual(await figures.locator("dt").allTextContents(), [
    "Income",
    "Expenses",
    "Net result",
  ]);
  assert.match(await figures.locator("dd").nth(0).innerText(), /12,34/);
  assert.match(await figures.locator("dd").nth(1).innerText(), /3,34/);
  const listedResult = await figures.locator("dd.deficit").innerText();
  assert.equal(listedResult.replace(/[€\s]/g, "").replace("−", "-"), "-1,00");
  assert.match(await figures.locator("small").innerText(), /10,00/);
  const eventID = await button(eventName).getAttribute("data-space");
  await button(eventName).click();
  await page.getByRole("heading", { name: eventName, exact: true }).waitFor();
  assert.equal(
    await page
      .locator(".kpi")
      .filter({ hasText: "Event result" })
      .locator("strong")
      .innerText(),
    listedResult,
  );
  await button("Open event transactions").click();
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
    .getByRole("button", { name: "Cashbook", exact: true })
    .click();
  await writer
    .getByText(
      "No general cashbook is available for this workspace.",
    )
    .waitFor();
  assert.equal(
    await writer.getByRole("button", { name: "Record transaction" }).count(),
    0,
  );
  await writer.getByRole("button", { name: "Open events" }).click();
  await writer.getByRole("button", { name: eventName, exact: true }).click();
  await writer
    .getByRole("button", { name: "Open event transactions" })
    .click();
  await writer.getByRole("cell", { name: eventBooking, exact: true }).waitFor();
  await writer
    .getByRole("button", { name: "Record event transaction" })
    .click();
  assert.match(
    await writer.getByRole("dialog").locator(".booking-target").innerText(),
    /Übung Sommerfest · Fiscal year 2046/,
  );
  await restricted.close();
  console.log(
    "PASS Getrennte Kassenbuch- und Veranstaltungsbuchungen, explizite Veranstaltungswahl bei eingeschränkten Schreibrechten, Jahreswechsel, Verbindungsabbruch und mobile Ansicht.",
  );
} finally {
  await browser.close();
}
