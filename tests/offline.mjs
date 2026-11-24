import { chromium } from "playwright";
import { api, admin, auth, basic } from "./local-api.mjs";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import http from "node:http";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { unzipSync } from "fflate";
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  Header,
  Footer,
  ImageRun,
} from "docx";
const upstream = process.env.BONFIRE_URL || "http://127.0.0.1:8137";
let connected = true;
let dropOriginalAck;
const proxy = http.createServer((req, res) => {
  if (!connected) {
    req.socket.destroy();
    return;
  }
  const body = [];
  if (dropOriginalAck && req.url === "/api/sync")
    req.on("data", (chunk) => body.push(chunk));
  const out = http.request(
    new URL(req.url, upstream),
    { method: req.method, headers: req.headers },
    (r) => {
      if (
        dropOriginalAck &&
        r.statusCode === 200 &&
        body.length &&
        JSON.parse(Buffer.concat(body)).Ops?.some((o) => o.Kind === "original")
      ) {
        const done = dropOriginalAck;
        dropOriginalAck = null;
        r.once("end", () => {
          connected = false;
          res.destroy();
          done();
        });
        r.resume();
        return;
      }
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    },
  );
  out.on("error", () => res.destroy());
  req.pipe(out);
});
await new Promise((ok) => proxy.listen(0, "127.0.0.1", ok));
const base = "http://127.0.0.1:" + proxy.address().port;
const localEnv = await readFile(".env", "utf8").catch(() => "");
const password =
  process.env.BONFIRE_ADMIN_PASSWORD ||
  localEnv.match(/^BONFIRE_ADMIN_PASSWORD=(.+)$/m)?.[1].trim();
const credentials =
  "Basic " + Buffer.from("leitung:" + password).toString("base64");
const eventName = "Übungsfest " + randomUUID().slice(0, 8);
const exerciseDay = new Date().toISOString().slice(0, 10);
const event = await fetch(base + "/api/events", {
  method: "POST",
  headers: { Authorization: credentials, "Content-Type": "application/json" },
  body: JSON.stringify({
    Name: eventName,
    Starts: exerciseDay,
    Ends: exerciseDay,
  }),
});
assert.equal(event.status, 200);
const eventID = (await event.json()).ID;
const root = await mkdtemp(join(tmpdir(), "bonfire-browser-"));
const contexts = new Set();
const pin = randomUUID();
async function start(name, offline = false) {
  const ctx = await chromium.launchPersistentContext(join(root, name), {
    headless: true,
    executablePath: process.env.BONFIRE_BROWSER || undefined,
    viewport:
      name === "B" ? { width: 390, height: 844 } : { width: 1280, height: 900 },
  });
  contexts.add(ctx);
  if (offline) connected = false;
  const p = ctx.pages()[0] || (await ctx.newPage());
  p.setDefaultTimeout(10000);
  p.on("pageerror", (e) => console.error("Browser", e.message));
  await p.goto(base);
  return { ctx, p };
}
const by = (p, n) => p.locator('[name="' + n + '"]');
async function press(p, text) {
  const control = p.getByRole("button", { name: text, exact: true });
  if (
    !(await control.isVisible()) &&
    (await p.locator("#menu-toggle").isVisible()) &&
    (await p
      .locator("nav")
      .getByRole("button", { name: text, exact: true, includeHidden: true })
      .count())
  ) {
    await p.locator("#menu-toggle").click();
  }
  await control.click();
}
async function ready(p, name) {
  await by(p, "user").fill("leitung");
  await p.locator("#login [name=pass]").fill(password);
  await press(p, "Anmelden");
  await p.getByRole("heading", { name: "Finanzen im Überblick" }).waitFor();
  await by(p, "workspace").selectOption(eventID);
  await press(p, "Erfassung vorbereiten");
  await by(p, "event").selectOption(eventID);
  await by(p, "name").fill(name);
  await by(p, "digitalCount").fill(name === "Nord" ? "2" : "0");
  await p.locator("#prepare [name=pass]").fill(pin);
  await press(p, "Offlineprofil speichern");
  await p
    .getByRole("heading", { name: "Finanzen im Überblick", exact: true })
    .waitFor();
}
async function record(p, group, type, label, values = {}) {
  const section =
    {
      Journal: "Kassenbuch",
      Geldtaschen: "Veranstaltungen",
      Perioden: "Abschluss",
    }[group] ||
    {
      organization: "Verwaltung",
      contact: "Kontakte",
      donation: "Spenden",
      payment: "Veranstaltungen",
      sponsorship: "Veranstaltungen",
      price: "Veranstaltungen",
    }[type];
  await press(p, section);
  if (section === "Veranstaltungen")
    await press(
      p,
      group === "Geldtaschen"
        ? "Geldtaschen"
        : type === "price"
          ? "Preise & Druck"
          : "Sponsoren & Rechnungen",
    );
  await p.locator('[data-act="focusEntry"]').click();
  await by(p, "type").selectOption(type);
  await by(p, "Label").fill(label);
  await by(p, "Date").fill(exerciseDay);
  for (const [name, value] of Object.entries(values)) {
    const input = by(p, name);
    if (name === "Contact") {
      await p.locator("[data-contact-filter]").fill("Musterplatz");
      assert.ok(
        await input
          .locator("option")
          .evaluateAll(
            (options, label) =>
              options.some((o) => o.text === label && !o.hidden),
            value,
          ),
      );
    }
    if (await input.evaluate((el) => el.tagName === "SELECT"))
      await input.selectOption({ label: value });
    else await input.fill(value);
  }
  if (values.coin200) {
    assert.ok(
      (await p.locator("#count-total").textContent()).includes(
        (Number(values.coin200) * 2).toFixed(2).replace(".", ","),
      ),
    );
  }
  await press(p, "Lokal speichern");
  await p.getByRole("cell", { name: label, exact: true }).first().waitFor();
}
async function sync(p) {
  await press(p, "Verwaltung");
  await press(p, "Gerät & Sync");
  const completed = p.waitForResponse(
    (r) =>
      r.ok() &&
      r.url().endsWith("/api/sync") &&
      Array.isArray(r.request().postDataJSON()?.Prints),
  );
  await press(p, "Jetzt abgleichen");
  await completed;
  await p.waitForFunction(
    () =>
      !document.querySelector('[aria-busy="true"]') &&
      /·\s+0 ausstehend$/.test(document.querySelector("#state")?.textContent),
  );
}
async function artifact(p, profile, subject, format, version = "active") {
  await press(p, "Dokumente");
  await by(p, "profile").selectOption(String(profile));
  if (subject) await by(p, "subject").selectOption({ label: subject });
  await by(p, "version").selectOption(version);
  await by(p, "format").selectOption(format);
  if (format === "Korrektur")
    await by(p, "revisionReason").fill("Begründete Übungsberichtigung");
  const dl = p.waitForEvent("download");
  if (format === "Original")
    await p
      .getByRole("button", { name: "Dokument erzeugen", exact: true })
      .dblclick();
  else await press(p, "Dokument erzeugen");
  const path = await (await dl).path();
  return readFile(path);
}
try {
  let a = await start("A");
  await ready(a.p, "Nord");
  await record(a.p, "Geldtaschen", "wallet", "Kasse Blau");
  await sync(a.p);
  const b = await start("B");
  await ready(b.p, "Süd");
  connected = false;
  await record(b.p, "Geldtaschen", "skim", "Gezählte Abschöpfung", {
    Wallet: "Kasse Blau",
    amount: "30,00",
    Account: "Kasse Blau",
    To: "Hauptkasse",
  });
  await record(a.p, "Geldtaschen", "count", "Nordzählung", {
    Wallet: "Kasse Blau",
    Phase: "Ende",
    coin200: "8",
  });
  await record(b.p, "Geldtaschen", "count", "Südzählung", {
    Wallet: "Kasse Blau",
    Phase: "Ende",
    coin200: "7",
  });
  await record(a.p, "Kontakte & Preise", "organization", "Übungsfeuerwehr", {
    Address: "Testweg 1",
    field_IBAN: "TESTKONTO",
    field_holder: "Übungsfeuerwehr",
    field_legal: "Fiktiver Belegtext für den Entwicklungstest",
  });
  await record(
    a.p,
    "Kontakte & Preise",
    "contact",
    "Übungsfirma " + eventID.slice(0, 8),
    {
      Address: "Musterplatz 8",
    },
  );
  await record(a.p, "Kontakte & Preise", "sponsorship", "Übungsbanner", {
    amount: "40,00",
    Contact: "Übungsfirma " + eventID.slice(0, 8) + " · Musterplatz 8",
    field_due: "2026-12-01",
    field_paymentRef: "SPONSOR-UEBUNG-42",
    field_service: "Übungsfest",
  });
  await record(b.p, "Journal", "income", "Eintritt Sammelbetrag", {
    amount: "14,25",
  });
  await press(a.p, "Dokumente");
  await by(a.p, "profile").selectOption("0");
  await by(a.p, "subject").selectOption({ label: "Übungsbanner" });
  await by(a.p, "format").selectOption("Original");
  await by(a.p, "version").selectOption("active");
  await press(a.p, "Druckvorschau öffnen");
  await a.p
    .locator("#proof-status")
    .filter({ hasText: "Word-Arbeitsfassung" })
    .waitFor();
  await a.p
    .frameLocator("#proof-sheet iframe")
    .getByText("Übungsbanner", { exact: true })
    .first()
    .waitFor();
  assert.ok((await a.p.locator("#state").innerText()).includes("ausstehend"));
  await a.p.screenshot({ path: "test-results/ansichten-dokumente.png" });
  const before = await a.p.locator("#state").innerText();
  let outputs = 0;
  const countOutput = () => outputs++;
  a.p.on("download", countOutput);
  try {
    await a.p.evaluate(() => {
      Object.defineProperty(navigator.storage, "estimate", {
        configurable: true,
        value: async () => ({ quota: 1, usage: 1 }),
      });
    });
    await press(a.p, "Dokument erzeugen");
    await a.p
      .getByRole("alert")
      .filter({ hasText: /Speichergrenze/ })
      .waitFor();
    assert.equal(await a.p.locator("#state").innerText(), before);
    assert.equal(outputs, 0);
  } finally {
    await a.p.evaluate(() => delete navigator.storage.estimate);
    a.p.off("download", countOutput);
  }
  const pdf = await artifact(a.p, 0, "Übungsbanner", "Original");
  console.log(
    "PASS Speichergrenze vor Offlineausgabe sichtbar, keine Ausgabe oder Änderung der Warteschlange, ursprüngliches Original nach Freigabe erzeugt",
  );
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  const dl = a.p.waitForEvent("download");
  await press(a.p, "DOCX");
  const word = await readFile(await (await dl).path());
  assert.ok(unzipSync(word)["word/document.xml"]);
  await a.ctx.close();
  contexts.delete(a.ctx);
  a = await start("A", true);
  await by(a.p, "pass").fill(pin);
  await press(a.p, "Entsperren");
  await press(a.p, "Dokumente");
  const repeat = a.p.waitForEvent("download");
  await press(a.p, "PDF");
  assert.deepEqual(await readFile(await (await repeat).path()), pdf);
  const lost = new Promise((resolve) => {
    dropOriginalAck = resolve;
  });
  connected = true;
  await press(a.p, "Verwaltung");
  await press(a.p, "Gerät & Sync");
  await press(a.p, "Jetzt abgleichen");
  let timer;
  try {
    await Promise.race([
      lost,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error("Original-Sync ohne erwartete Bestätigung")),
          30000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  await a.ctx.close();
  contexts.delete(a.ctx);
  a = await start("A", true);
  await by(a.p, "pass").fill(pin);
  await press(a.p, "Entsperren");
  await press(a.p, "Dokumente");
  const afterLoss = a.p.waitForEvent("download");
  await press(a.p, "PDF");
  assert.deepEqual(await readFile(await (await afterLoss).path()), pdf);
  connected = true;
  await sync(a.p);
  await sync(b.p);
  await b.p.getByRole("heading", { name: "Konflikt · Südzählung" }).waitFor();
  console.log(
    "PASS Original serverseitig gespeichert, Bestätigung gezielt unterbrochen, Kaltstart und bytegleicher Nachdruck vor erfolgreicher Wiederholung",
  );
  await b.p
    .getByRole("textbox", { name: "Begründung", exact: true })
    .fill("Gegenzählung des Übungsteams");
  await press(b.p, "Klärung speichern");
  await b.p.waitForFunction(() => !document.querySelector("[id^=resolve-]"));
  await sync(a.p);
  await press(a.p, "Kassenbuch");
  await a.p.getByRole("cell", { name: "Eintritt Sammelbetrag" }).waitFor();
  connected = false;
  await record(a.p, "Kontakte & Preise", "payment", "Zahlung Übungsbanner", {
    Reference: "Übungsbanner",
    Wallet: "Kasse Blau",
    amount: "20,00",
  });
  await record(a.p, "Kontakte & Preise", "donation", "Testspende", {
    Wallet: "Kasse Blau",
    amount: "5,50",
  });
  await record(a.p, "Kontakte & Preise", "price", "Apfelsaft", {
    Category: "Getränk",
    Unit: "Glas",
    Status: "Freigegeben",
    amount: "2,90",
  });
  await record(a.p, "Kontakte & Preise", "price", "Brot", {
    Category: "Essen",
    Unit: "Stück",
    Status: "Freigegeben",
    amount: "3,40",
  });
  await mkdir("test-results/exports", { recursive: true });
  async function currentJournal() {
    await press(a.p, "Verwaltung");
    await press(a.p, "Datenaustausch");
    const file = a.p.waitForEvent("download");
    await press(a.p, "Journal als CSV");
    return readFile(await (await file).path());
  }
  const journalBeforeExports = await currentJournal();
  for (let i = 0; i < 11; i++) {
    const subject = {
      0: "Übungsbanner",
      1: "Zahlung Übungsbanner",
      2: "Testspende",
      6: "Testspende",
    }[i];
    const bytes = await artifact(a.p, i, subject, "PDF");
    assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
    const wordBytes = await artifact(a.p, i, subject, "DOCX");
    await writeFile("test-results/exports/T" + (i + 1) + ".pdf", bytes);
    await writeFile("test-results/exports/T" + (i + 1) + ".docx", wordBytes);
    const word = unzipSync(wordBytes);
    assert.ok(word["word/document.xml"]);
    assert.ok(word["[Content_Types].xml"]);
  }
  assert.deepEqual(await currentJournal(), journalBeforeExports);
  const template = new Document({
    sections: [
      {
        properties: { page: { size: { width: 11906, height: 16838 } } },
        headers: {
          default: new Header({ children: [new Paragraph("Übungskopf")] }),
        },
        footers: {
          default: new Footer({ children: [new Paragraph("Übungsfuß")] }),
        },
        children: [
          new Paragraph({
            children: [new TextRun("{{organization."), new TextRun("name}}")],
          }),
          new Table({
            rows: [
              new TableRow({
                children: [
                  new TableCell({
                    children: [new Paragraph("{{donation.amount_cents}}")],
                  }),
                ],
              }),
            ],
          }),
          new Paragraph({
            children: [
              new ImageRun({
                type: "png",
                data: await readFile("dist/icon-32.png"),
                transformation: { width: 32, height: 32 },
              }),
            ],
          }),
        ],
      },
    ],
  });
  await press(a.p, "Dokumente");
  await a.p.locator("#wordLayout input").setInputFiles({
    name: "Fiktiver-Brief.docx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    buffer: await Packer.toBuffer(template),
  });
  await press(a.p, "Word-Layout als Briefentwurf übernehmen");
  await a.p
    .getByText("Word-Layout im Entwurf verfügbar", { exact: true })
    .waitFor();
  const layoutPDF = await artifact(a.p, 6, "Testspende", "PDF", "draft");
  const layoutDOCX = await artifact(a.p, 6, "Testspende", "DOCX", "draft");
  const parts = unzipSync(layoutDOCX);
  assert.ok(
    parts["word/header1.xml"] &&
      parts["word/footer1.xml"] &&
      Object.keys(parts).some((p) => p.startsWith("word/media/")),
  );
  assert.ok(
    !new TextDecoder().decode(parts["word/document.xml"]).includes("{{"),
  );
  assert.equal(layoutPDF.subarray(0, 5).toString(), "%PDF-");
  await writeFile("test-results/exports/Brief-Layout.pdf", layoutPDF);
  console.log(
    "PASS: offline imported Word layout with table, image, header, footer and split tokens in PDF/DOCX",
  );
  await press(a.p, "Veranstaltungen");
  await press(a.p, "Sponsoren & Rechnungen");
  await a.p
    .getByText(/Nr\. \d+ · Ohne Versandvermerk/)
    .first()
    .waitFor();
  await by(a.p, "delivery").selectOption("Extern übergeben");
  await by(a.p, "evidence").fill("Fiktive Übergabebestätigung");
  await press(a.p, "Übergabe dokumentieren");
  await a.p
    .getByText(/Nr\. \d+ · Extern übergeben/)
    .first()
    .waitFor();
  connected = true;
  await press(a.p, "Dokumente");
  const templateForm = a.p.locator("#template");
  await templateForm
    .locator("[name=Reference]")
    .selectOption("invoice_transfer_a4");
  await templateForm
    .locator("[name=Label]")
    .fill("Überarbeitete Übungsrechnung");
  await templateForm.locator("[name=Note]").fill("Geprüfter neuer Textstand");
  const published = a.p.waitForResponse(
    (r) =>
      r.ok() &&
      r.url().endsWith("/api/sync") &&
      r
        .request()
        .postDataJSON()
        ?.Ops?.some((op) => op.Kind === "template"),
  );
  await templateForm.getByRole("button", { name: "Fassung freigeben" }).click();
  await published;
  await a.p.waitForFunction(
    () => !document.querySelector('[aria-busy="true"]'),
  );
  connected = false;
  const archived = a.p.waitForEvent("download");
  await press(a.p, "PDF");
  assert.deepEqual(await readFile(await (await archived).path()), pdf);
  const substitute = await artifact(a.p, 0, "Übungsbanner", "Korrektur");
  assert.notDeepEqual(substitute, pdf);
  connected = true;
  await sync(a.p);
  const secondPull = b.p.waitForResponse(
    (r) =>
      r.ok() &&
      r.url().endsWith("/api/sync") &&
      r.request().postDataJSON()?.Prints,
  );
  await sync(b.p);
  const archiveRows = (await (await secondPull).json()).entries
    .filter((r) => r.Kind === "original")
    .sort((a, b) => a.Data.Number - b.Data.Number);
  const snapshots = archiveRows.map((r) => JSON.parse(r.Data.Note));
  assert.equal(snapshots[0].templateVersionID, "invoice_transfer_a4@standard");
  assert.equal(snapshots[1].templateVersionID, "invoice_transfer_a4@1");
  assert.equal(snapshots[1].title, "Überarbeitete Übungsrechnung");
  for (const snap of snapshots) {
    assert.match(snap.archive.renderBuild.sourceSHA256, /^[0-9a-f]{64}$/);
    assert.ok(
      snap.archive.renderBuild.libraries.jspdf &&
        snap.archive.renderBuild.libraries.docx &&
        snap.archive.fontPreset,
    );
  }
  console.log(
    "PASS Vorlagenfreigabe, bytegleicher Nachdruck des früheren Originals und neue Vorlagen-/Rendernachweise im Korrekturbeleg",
  );
  await press(b.p, "Veranstaltungen");
  await press(b.p, "Sponsoren & Rechnungen");
  const sponsorRow = b.p
    .getByRole("row")
    .filter({ hasText: "Extern übergeben" });
  await sponsorRow.getByText(/Ohne Versandvermerk/).waitFor();
  assert.ok((await sponsorRow.innerText()).includes("20,00"));
  await press(b.p, "Dokumente");
  assert.equal(
    await b.p.getByRole("button", { name: "PDF", exact: true }).count(),
    2,
  );
  await press(b.p, "Dokumente");
  await b.p
    .getByText("Freie Nummern dieses Geräts: 0", { exact: true })
    .waitFor();
  await record(
    a.p,
    "Kontakte & Preise",
    "sponsorship",
    "Test ohne weitere Digitalnummer",
    {
      amount: "3,00",
      Contact: "Übungsfirma " + eventID.slice(0, 8) + " · Musterplatz 8",
    },
  );
  await press(a.p, "Dokumente");
  await a.p
    .getByText("Freie Nummern dieses Geräts: 0", { exact: true })
    .waitFor();
  await by(a.p, "profile").selectOption("0");
  await by(a.p, "subject").selectOption({
    label: "Test ohne weitere Digitalnummer",
  });
  await by(a.p, "format").selectOption("Original");
  await press(a.p, "Dokument erzeugen");
  await a.p
    .getByText("Ausstellungsrecht oder Nummernreserve fehlt.", { exact: true })
    .waitFor();
  const draft = await artifact(
    a.p,
    0,
    "Test ohne weitere Digitalnummer",
    "PDF",
  );
  assert.equal(draft.subarray(0, 5).toString(), "%PDF-");
  assert.equal(
    await a.p.getByRole("button", { name: "PDF", exact: true }).count(),
    2,
  );
  connected = true;
  await record(a.p, "Perioden", "opening", "Eröffnungsbestand aus Zählblatt", {
    amount: "100,00",
  });
  await record(a.p, "Geldtaschen", "count", "Gezählte Eröffnung Kasse Blau", {
    Wallet: "Kasse Blau",
    Phase: "Anfang",
    coin200: "2",
  });
  await press(a.p, "Veranstaltungen");
  await press(a.p, "Geldtaschen");
  await a.p
    .getByRole("cell", { name: "Gezählte Abschöpfung", exact: true })
    .waitFor();
  await press(a.p, "Sammelbetrag buchen");
  await a.p.waitForFunction(
    () => !document.querySelector('[aria-busy="true"]'),
  );
  await press(a.p, "Kassenbuch");
  await a.p
    .getByRole("cell", { name: "Barabrechnung Kasse Blau", exact: true })
    .waitFor();
  await a.p
    .getByRole("cell", { name: "Gezählte Abschöpfung", exact: true })
    .waitFor();
  // 100.00 opening + 14.25 admission + (16.00 - 4.00 + 30.00) cash revenue.
  await record(
    a.p,
    "Perioden",
    "actual",
    "Unabhängig gezählter Gesamtbestand",
    { amount: "156,25" },
  );
  await sync(a.p);
  const reviewer = "gesamt-" + eventID.slice(0, 8),
    reviewerPassword = randomUUID();
  await api("users", admin, {
    Name: reviewer,
    Password: reviewerPassword,
    Role: "Prüfung",
    Event: eventID,
  });
  const reviewDevice = await api("prepare", basic(reviewer, reviewerPassword), {
    Event: eventID,
    Name: "Abschlussprüfung",
    DigitalCount: 0,
  });
  const review = (body) => api("sync", auth(reviewDevice), body);
  await review({ Action: "Ende", Last: 0 });
  await api("sync", auth(reviewDevice), { Action: "Abschluss" }, 422);
  for (const p of [a.p, b.p]) {
    await sync(p);
    p.once("dialog", (dialog) => dialog.accept());
    await press(p, "Mein Erfassungsende bestätigen");
    await p.getByText("Erfassungsende bestätigt", { exact: true }).waitFor();
  }
  const closed = await review({ Action: "Abschluss" });
  assert.equal(closed.closed, true);
  assert.equal(closed.pending, 0);
  assert.equal(closed.conflicts.length, 0);
  await sync(a.p);
  await press(a.p, "Datenaustausch");
  const packageReady = a.p.waitForEvent("download");
  await press(a.p, "Prüfpaket laden");
  const archive = await readFile(await (await packageReady).path());
  const contents = unzipSync(archive);
  const manifest = JSON.parse(
    new TextDecoder().decode(contents["manifest.json"]),
  );
  assert.equal(manifest.freigegeben, true);
  assert.equal(manifest.veranstaltung, eventID);
  assert.equal(
    manifest.vorlagenstaende.Pruefbericht,
    "closing_review_a4_new@standard",
  );
  assert.deepEqual(manifest.fehlendeDateien, []);
  assert.deepEqual(manifest.offeneGeraete, []);
  const covered = [...manifest.exportdateien, ...manifest.dateien];
  assert.equal(covered.length, Object.keys(contents).length - 1);
  for (const file of covered)
    assert.equal(
      createHash("sha256").update(contents[file.path]).digest("hex"),
      file.sha256,
      file.path,
    );
  assert.equal(manifest.konflikte, 0);
  assert.equal(manifest.ausstehend, 0);
  for (const f of [
    "Pruefbericht.pdf",
    "Pruefbericht.docx",
    "Belegjournal.pdf",
    "Belegjournal.docx",
    "Journal.xlsx",
    "Journal.csv",
  ])
    assert.ok(contents[f]?.length, f);
  await writeFile("test-results/gesamtfall-pruefpaket.zip", archive);
  await writeFile(
    "test-results/gesamtfall.json",
    JSON.stringify({
      event: eventID,
      actual: 15625,
      originals: archiveRows.length,
    }),
  );
  console.log(
    "PASS derselbe Offline-Gesamtfall mit Rollenprüfung, manueller Istzählung, Gerätesiegeln, bestätigtem Abschluss und Prüfpaket",
  );
  console.log(
    "PASS Doppelklick vergibt ein Original; zwei reservierte Nummern verbraucht, Nullreserve sichtbar, weiterer PDF-Entwurf ohne neue Nummer",
  );
  console.log(
    "PASS: immutable original and separately numbered replacement after offline correction",
  );
  console.log(
    "PASS: all eleven offline PDF/DOCX profiles produced parseable file containers",
  );
  console.log(
    "PASS: two persistent profiles, network disconnected, separate entries, conflicting count, offline cold restart, exact PDF reprint, DOCX ZIP, sync and resolution",
  );
} finally {
  proxy.close();
  for (const c of contexts) await c.close();
  await rm(root, { recursive: true, force: true });
}
