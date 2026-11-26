import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import { unzipSync, strFromU8 } from "fflate";
import { guestSheets } from "../web/guest-sheets.js";
import { fillBackground } from "../web/lfk.js";
import { PDFDocument } from "pdf-lib";
import { renderTables } from "../web/layouts.js";
const snapshot = {
  index: 10,
  width: 297,
  height: 210,
  organization: "Fiktive Feuerwehr",
  title: "Prüfjournal",
  event: "Druckübung",
  date: "2035-09-01",
  status: "Arbeitsfassung",
  layoutMargin: 24,
  footer: "Fiktive Prüffußzeile",
  cardHeader: "Synthetischer Prüfstand",
  tables: {
    intro: "Mehrseitiges Journal",
    blocks: [
      {
        headers: ["Zahlungsdatum", "Buchungsbeschreibung", "Betrag"],
        widths: [36, 190, 47],
        rows: Array.from({ length: 160 }, (_, i) => [
          "2035-09-01",
          "Prüfzeile " +
            String(i + 1).padStart(3, "0") +
            " · Äpfel, Öl und Straße",
          "1.234,56 €",
        ]),
      },
    ],
    after: [],
  },
};
const files = await renderTables(snapshot);
await mkdir("test-results/exports", { recursive: true });
for (const type of ["pdf", "docx"])
  await writeFile(
    "test-results/exports/Journal-lang." + type,
    new Uint8Array(await files[type].arrayBuffer()),
  );
const parts = unzipSync(new Uint8Array(await files.docx.arrayBuffer()));
const word = strFromU8(parts["word/document.xml"]);
assert.ok(word.includes("Prüfzeile 160") && word.includes("w:tblHeader"));
assert.match(word, /w:left="1361"/);
assert.ok(
  Object.keys(parts).some(
    (name) =>
      name.startsWith("word/footer") &&
      strFromU8(parts[name]).includes("Fiktive Prüffußzeile"),
  ),
);
const invoice = {
  ...snapshot,
  index: 0,
  width: 210,
  height: 297,
  tables: {
    invoice: true,
    meta: ["2035-09-01", "Nr. 1000"],
    address: ["Erfundene Firma", "Musteradresse 1"],
    intro: "Testpositionen",
    blocks: [],
    after: [],
  },
};
assert.ok((await renderTables(invoice)).pdf.size > 0);
await assert.rejects(
  renderTables({
    ...invoice,
    tables: {
      ...invoice.tables,
      address: ["Erfundener sehr langer Empfänger ".repeat(40)],
    },
  }),
  /address window/,
);
await assert.rejects(
  renderTables({
    ...snapshot,
    tables: {
      ...snapshot.tables,
      blocks: [
        {
          headers: ["Text"],
          widths: [200],
          rows: [["Langer Zeilentext ".repeat(5000)]],
        },
      ],
    },
  }),
  /page height/,
);
console.log(
  "PASS mehrseitiges Journal, wiederholte Tabellenköpfe, benutzerdefinierter Rand, Fußzeile und explizite Überlaufprüfung",
);


const guestSheet = {
  width: 210, height: 297, font: "helvetica", title: "Guest prices", event: "Synthetic fair",
  tables: { blocks: [{ headers: ["Food"], rows: [["Soup", "Bowl", "4,50"]] }], after: ["Please return bowls"] },
};
const copies = await guestSheets(guestSheet);
const guestXML = strFromU8(unzipSync(new Uint8Array(await copies.docx.arrayBuffer()))["word/document.xml"]);
assert.equal(guestXML.split("Please return bowls").length - 1, 2);
assert.equal((await PDFDocument.load(await copies.pdf.arrayBuffer())).getPageCount(), 1);
await assert.rejects(guestSheets({
  ...guestSheet, tables: { ...guestSheet.tables, blocks: [{ headers: ["Category ".repeat(50)], rows: [["Soup", "", "4,50"]] }] },
}), /category heading/);
const form = await PDFDocument.create();
form.addPage([420, 298]);
await assert.rejects(fillBackground(Buffer.from(await form.save()).toString("base64"),
  ["1,50", "1", "Synthetic fire brigade", "Łucja Sample"]), /field Donor name and address/);
