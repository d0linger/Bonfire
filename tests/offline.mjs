import { chromium } from "playwright";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import http from "node:http";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
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
const proxy = http.createServer((req, res) => {
  if (!connected) {
    req.socket.destroy();
    return;
  }
  const out = http.request(
    new URL(req.url, upstream),
    { method: req.method, headers: req.headers },
    (r) => {
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
const event = await fetch(base + "/api/events", {
  method: "POST",
  headers: { Authorization: credentials, "Content-Type": "application/json" },
  body: JSON.stringify({
    Name: eventName,
    Starts: "2026-06-01",
    Ends: "2026-06-06",
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
  await p.getByRole("button", { name: text, exact: true }).click();
}
async function ready(p, name) {
  await by(p, "user").fill("leitung");
  await p.locator("#login [name=pass]").fill(password);
  await press(p, "Anmelden");
  await by(p, "event").selectOption(eventID);
  await by(p, "name").fill(name);
  await p.locator("#prepare [name=pass]").fill(pin);
  await press(p, "Offlineprofil speichern");
  await p.getByRole("heading", { name: "Übersicht", exact: true }).waitFor();
}
async function record(p, group, type, label, values = {}) {
  await press(p, group);
  await by(p, "type").selectOption(type);
  await by(p, "Label").fill(label);
  for (const [name, value] of Object.entries(values)) {
    const input = by(p, name);
    if (await input.evaluate((el) => el.tagName === "SELECT"))
      await input.selectOption({ label: value });
    else await input.fill(value);
  }
  await press(p, "Lokal speichern");
  await p.getByRole("cell", { name: label, exact: true }).first().waitFor();
}
async function sync(p) {
  await press(p, "Gerät & Sync");
  await press(p, "Jetzt abgleichen");
  await p.waitForFunction(() =>
    document.querySelector("#state")?.textContent.endsWith("0 ausstehend"),
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
  await press(p, "Dokument erzeugen");
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
    Contact: "Übungsfirma " + eventID.slice(0, 8),
    field_due: "2026-12-01",
    field_service: "Übungsfest",
  });
  await record(b.p, "Journal", "income", "Eintritt Sammelbetrag", {
    amount: "14,25",
  });
  const pdf = await artifact(a.p, 0, "Übungsbanner", "Original");
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
  connected = true;
  await sync(a.p);
  await sync(b.p);
  await b.p.getByRole("heading", { name: "Konflikt · Südzählung" }).waitFor();
  await b.p
    .getByRole("textbox", { name: "Begründung", exact: true })
    .fill("Gegenzählung des Übungsteams");
  await press(b.p, "Klärung speichern");
  await b.p.waitForFunction(() => !document.querySelector("[id^=resolve-]"));
  await sync(a.p);
  await press(a.p, "Journal");
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
  await press(a.p, "Word-Layout als lokalen Briefentwurf übernehmen");
  await a.p
    .getByText("Word-Layout lokal gespeichert", { exact: true })
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
  const substitute = await artifact(a.p, 0, "Übungsbanner", "Korrektur");
  assert.notDeepEqual(substitute, pdf);
  connected = true;
  await sync(a.p);
  await sync(b.p);
  await press(b.p, "Dokumente");
  assert.equal(
    await b.p.getByRole("button", { name: "PDF", exact: true }).count(),
    2,
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
