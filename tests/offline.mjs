import { testPassword } from "./test-password.mjs";
import { chromium } from "playwright";
import { api, admin, auth } from "./local-api.mjs";
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
const destination = new URL(upstream);
assert.equal(destination.hostname, "127.0.0.1");
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
    { hostname: "127.0.0.1", port: destination.port, path: req.url, method: req.method, headers: req.headers },
    (r) => {
      if (
        dropOriginalAck &&
        r.statusCode === 200 &&
        body.length &&
        JSON.parse(Buffer.concat(body)).Ops?.some((o) => o.Kind === "original")
      ) {
        const originals = JSON.parse(Buffer.concat(body)).Ops.filter((o) => o.Kind === "original");
        const chunks = [];
        r.on("data", (chunk) => chunks.push(chunk));
        r.once("end", () => {
          const bytes = Buffer.concat(chunks);
          const receipt = JSON.parse(bytes);
          if (dropOriginalAck && originals.every((op) =>
            !receipt.conflicts.some((c) => c.ID === op.ID) &&
            receipt.entries.some((e) => e.ID === op.Target && e.Data.Number === op.Data.Number && e.Data.PDF === op.Data.PDF))) {
            const done = dropOriginalAck;
            dropOriginalAck = null;
            connected = false;
            res.destroy();
            done();
          } else {
            res.writeHead(r.statusCode, r.headers);
            res.end(bytes);
          }
        });
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
const password = testPassword();
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
  await press(p, "Sign in");
  await p.getByRole("heading", { name: "Financial overview" }).waitFor();
  await by(p, "workspace").selectOption(eventID);
  await p.waitForFunction(
    () => !document.querySelector('article[aria-busy="true"]'),
  );
  await press(p, "Prepare recording");
  await by(p, "event").selectOption(eventID);
  await by(p, "name").fill(name);
  await by(p, "digitalCount").fill(name === "Nord" ? "2" : "0");
  await p.locator("#prepare [name=pass]").fill(pin);
  await press(p, "Save offline profile");
  await p
    .getByRole("heading", { name: "Financial overview", exact: true })
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
  await p.locator('nav [data-page="' + section + '"]').click();
  if (section === "Veranstaltungen") {
    const tab = group === "Geldtaschen" ? "Geldtaschen" : type === "price" ? "Preise" : "Sponsoring";
    await p.locator('.tabs [data-page="' + tab + '"]').click();
  }
  if (group === "Geldtaschen") {
    const action =
      type === "count" ? "count:" + (values.Phase || "Anfang") : type;
    const trigger = p.locator('[data-wallet-action="' + action + '"]');
    if (!(await trigger.isVisible()))
      await p.locator(".wallet-more summary").click();
    await trigger.click();
  } else {
    await p.locator('[data-act="focusEntry"]').click();
  }
  if (await by(p, "type").count()) await by(p, "type").selectOption(type);
  await by(p, "Label").fill(label);
  await by(p, "Date").fill(exerciseDay);
  if (
    Object.keys(values).some((k) => k.startsWith("coin")) &&
    (await by(p, "field_countMode").count())
  )
    await by(p, "field_countMode").selectOption("pieces");
  for (const [name, value] of Object.entries(values)) {
    if (group === "Geldtaschen" && type === "count" && name === "Phase")
      continue;
    const input = by(p, name);
    const collapsed = input.locator("xpath=ancestor::details[not(@open)]");
    if (await collapsed.count())
      await collapsed.locator("summary").first().click();
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
  await press(p, "Save locally");
  await p.getByRole("cell", { name: label, exact: true }).first().waitFor();
}
async function sync(p) {
  await press(p, "Administration");
  await press(p, "Device and sync");
  const completed = p.waitForResponse(
    (r) =>
      r.ok() &&
      r.url().endsWith("/api/sync") &&
      Array.isArray(r.request().postDataJSON()?.Prints),
  );
  await press(p, "Sync now");
  await completed;
  await p.waitForFunction(
    () =>
      !document.querySelector('[aria-busy="true"]') &&
      /·\s+0 ausstehend$/.test(document.querySelector("#state")?.textContent),
  );
}
async function artifact(p, profile, subject, format, version = "active") {
  await press(p, "Documents");
  await by(p, "profile").selectOption(String(profile));
  if (subject) await by(p, "subject").selectOption({ label: subject });
  await by(p, "version").selectOption(version);
  await by(p, "format").selectOption(format);
  if (format === "Korrektur")
    await by(p, "revisionReason").fill("Begründete Übungsberichtigung");
  const dl = p.waitForEvent("download");
  if (format === "Original")
    await p
      .getByRole("button", { name: "Generate document", exact: true })
      .dblclick();
  else await press(p, "Generate document");
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
      field_street: "Musterplatz 8",
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
  await press(a.p, "Documents");
  await by(a.p, "profile").selectOption("0");
  await by(a.p, "subject").selectOption({ label: "Übungsbanner" });
  await by(a.p, "format").selectOption("Original");
  await by(a.p, "version").selectOption("active");
  await press(a.p, "Open print preview");
  await a.p
    .locator("#proof-status")
    .filter({ hasText: "Word draft" })
    .waitFor();
  await a.p
    .frameLocator("#proof-sheet iframe")
    .getByText("Übungsbanner", { exact: true })
    .first()
    .waitFor();
  assert.ok((await a.p.locator("#state").innerText()).includes("pending"));
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
    await press(a.p, "Generate document");
    await a.p
      .getByRole("alert")
      .filter({ hasText: /storage limit/ })
      .waitFor();
    assert.equal(await a.p.locator("#state").innerText(), before);
    assert.equal(outputs, 0);
  } finally {
    await a.p.evaluate(() => delete navigator.storage.estimate);
    a.p.off("download", countOutput);
  }
  const pdf = await artifact(a.p, 0, "Übungsbanner", "Original");
  console.log(
    "PASS storage exhaustion before offline issue leaves the queue unchanged; retry issues the original",
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
  await press(a.p, "Unlock");
  await press(a.p, "Documents");
  const repeat = a.p.waitForEvent("download");
  await press(a.p, "PDF");
  assert.deepEqual(await readFile(await (await repeat).path()), pdf);
  const lost = new Promise((resolve) => {
    dropOriginalAck = resolve;
  });
  connected = true;
  await press(a.p, "Administration");
  await press(a.p, "Device and sync");
  await press(a.p, "Sync now");
  let timer;
  try {
    await Promise.race([
      lost,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error("Original sync did not return the expected acknowledgement")),
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
  await press(a.p, "Unlock");
  await press(a.p, "Documents");
  const afterLoss = a.p.waitForEvent("download");
  await press(a.p, "PDF");
  assert.deepEqual(await readFile(await (await afterLoss).path()), pdf);
  connected = true;
  await sync(a.p);
  await sync(b.p);
  await b.p.getByRole("heading", { name: "Conflict · Südzählung" }).waitFor();
  console.log(
    "PASS the original survives an interrupted acknowledgement and cold restart for an identical reprint",
  );
  await b.p
    .getByRole("textbox", { name: "Reason", exact: true })
    .fill("Gegenzählung des Übungsteams");
  await press(b.p, "Save resolution");
  await b.p.waitForFunction(() => !document.querySelector("[id^=resolve-]"));
  await sync(a.p);
  await press(a.p, "Cashbook");
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
    Category: "Drink",
    Unit: "Glas",
    Status: "Approved",
    amount: "2,90",
  });
  await record(a.p, "Kontakte & Preise", "price", "Brot", {
    Category: "Food",
    Unit: "Stück",
    Status: "Approved",
    amount: "3,40",
  });
  await mkdir("test-results/exports", { recursive: true });
  async function currentJournal() {
    await press(a.p, "Administration");
    await press(a.p, "Data exchange");
    const file = a.p.waitForEvent("download");
    await press(a.p, "Export journal as CSV");
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
  await press(a.p, "Documents");
  await a.p.locator("#wordLayout input").setInputFiles({
    name: "Fiktiver-Brief.docx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    buffer: await Packer.toBuffer(template),
  });
  await press(a.p, "Use Word layout as draft letter");
  await a.p
    .getByText("Word layout available in the draft", { exact: true })
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
  await press(a.p, "Events");
  await press(a.p, "Sponsors and invoices");
  await a.p
    .getByText(/No\. \d+ · No dispatch record/)
    .first()
    .waitFor();
  await press(a.p, "Record handover");
  await by(a.p, "delivery").selectOption("Extern übergeben");
  await by(a.p, "evidence").fill("Fiktive Übergabebestätigung");
  await a.p
    .getByRole("dialog")
    .getByRole("button", { name: "Record handover" })
    .click();
  await a.p
    .getByText(/No\. \d+ · Handed over externally/)
    .first()
    .waitFor();
  connected = true;
  await press(a.p, "Documents");
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
  await templateForm.getByRole("button", { name: "Approve version" }).click();
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
  assert.equal(archiveRows.length,2);
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
    "PASS template approval preserves the original and records the replacement template and renderer versions",
  );
  await press(b.p, "Events");
  await press(b.p, "Sponsors and invoices");
  const sponsorRow = b.p
    .getByRole("row")
    .filter({ hasText: "Handed over externally" });
  await sponsorRow.getByText(/No dispatch record/).waitFor();
  assert.ok((await sponsorRow.innerText()).includes("20,00"));
  await press(b.p, "Documents");
  assert.equal(
    await b.p.getByRole("button", { name: "PDF", exact: true }).count(),
    2,
  );
  await press(b.p, "Documents");
  await b.p
    .getByText("Available numbers on this device: 0", { exact: true })
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
  await press(a.p, "Documents");
  await a.p
    .getByText("Available numbers on this device: 0", { exact: true })
    .waitFor();
  await by(a.p, "profile").selectOption("0");
  await by(a.p, "subject").selectOption({
    label: "Test ohne weitere Digitalnummer",
  });
  await by(a.p, "format").selectOption("Original");
  await press(a.p, "Generate document");
  await a.p
    .getByText("Issuing permission or reserved numbers are missing.", { exact: true })
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
  await press(a.p, "Events");
  await press(a.p, "Wallets");
  await a.p
    .getByRole("cell", { name: "Gezählte Abschöpfung", exact: true })
    .waitFor();
  await press(a.p, "Post pooled amount");
  await a.p.waitForFunction(
    () => !document.querySelector('[aria-busy="true"]'),
  );
  await press(a.p, "Cashbook");
  await a.p
    .getByRole("cell", { name: "Bar settlement Kasse Blau", exact: true })
    .waitFor();
  await a.p
    .getByRole("cell", { name: "Gezählte Abschöpfung", exact: true })
    .waitFor();
  await record(
    a.p,
    "Kontakte & Preise",
    "payment",
    "Restzahlung Übungsbanner",
    { Reference: "Übungsbanner", Method: "Bank transfer", amount: "20,00" },
  );
  await record(
    a.p,
    "Kontakte & Preise",
    "payment",
    "Zahlung zur zweiten Forderung",
    {
      Reference: "Test ohne weitere Digitalnummer",
      Method: "Bank transfer",
      amount: "3,00",
    },
  );
  // 100.00 opening + 14.25 admission + 42.00 cash revenue + 23.00 final bank payments.
  await record(
    a.p,
    "Perioden",
    "actual",
    "Unabhängig gezählter Gesamtbestand",
    { amount: "179,25" },
  );
  await sync(a.p);
  const reviewDevice = await api("prepare", admin, {
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
    await press(p, "Confirm end of recording");
    await p.getByText("Recording complete", { exact: true }).waitFor();
  }
  const closed = await review({ Action: "Abschluss" });
  assert.equal(closed.closed, true);
  assert.equal(closed.pending, 0);
  assert.equal(closed.conflicts.length, 0);
  await sync(a.p);
  await press(a.p, "Data exchange");
  const packageReady = a.p.waitForEvent("download");
  await press(a.p, "Download review package");
  const archive = await readFile(await (await packageReady).path());
  const contents = unzipSync(archive);
  const manifest = JSON.parse(
    new TextDecoder().decode(contents["manifest.json"]),
  );
  assert.equal(manifest.technicallyComplete, true);
  assert.equal(manifest.freigegeben, false);
  assert.equal(manifest.veranstaltung, eventID);
  assert.equal(
    manifest.vorlagenstaende["Review-report"],
    "closing_review_a4_new@standard",
  );
  assert.deepEqual(manifest.fehlendeDateien, []);
  assert.deepEqual(manifest.offeneGeraete, []);
  const covered = [...manifest.exportdateien, ...manifest.dateien];
  assert.deepEqual(covered.map((f) => f.path).sort(), Object.keys(contents).filter((p) => p !== "manifest.json").sort());
  for (const file of covered)
    assert.equal(
      createHash("sha256").update(contents[file.path]).digest("hex"),
      file.sha256,
      file.path,
    );
  assert.equal(manifest.konflikte, 0);
  assert.equal(manifest.ausstehend, 0);
  for (const f of [
    "Review-report.pdf",
    "Review-report.docx",
    "Document-register.pdf",
    "Document-register.docx",
    "Journal.xlsx",
    "Journal.csv",
  ])
    assert.ok(contents[f]?.length, f);
  await writeFile("test-results/gesamtfall-pruefpaket.zip", archive);
  await writeFile(
    "test-results/gesamtfall.json",
    JSON.stringify({
      eventName,
      actual: 17925,
      originals: 2,
    }),
  );
  console.log(
    "PASS offline role checks, actual counts, device seals, confirmed closing and evidence package",
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
