import assert from "node:assert/strict";
import test from "node:test";
import { festivalStatement } from "../web/festabrechnung.js";
import { guestSheets } from "../web/guest-sheets.js";
import { PDFDocument } from "pdf-lib";
import { unzipSync, strFromU8 } from "fflate";

test("Einzel- und Sammelzählung ergeben denselben Reingewinn mit Spende, Vorverkauf und Bankomat", () => {
  const entry = (ID, Kind, Amount, more = {}) => ({
    ID,
    Kind,
    Data: { Label: ID, Amount, ...more },
  });
  const rows = [
    entry("w", "wallet"),
    entry("start", "count", 10000, { Wallet: "w", Phase: "Anfang" }),
    entry("top", "supply", 2000, { Account: "k", Wallet: "w", To: "w" }),
    entry("barspende", "donation", 1000, { Wallet: "w", Method: "Bar" }),
    entry("vor", "presale", 4000, { Method: "Überweisung" }),
    entry("zusage", "sponsorship", 50000),
    entry("zahlung", "payment", 3000, {
      Method: "Überweisung",
      Reference: "zusage",
    }),
    entry("gast", "cashback", 5000, {
      Wallet: "w",
      Account: "w",
      To: "terminal",
    }),
    entry("bank", "payout", 4900, { Account: "terminal", To: "bank" }),
    entry("gebühr", "fee", 100, { Account: "terminal" }),
    entry("material", "expense", 1200, { Method: "Überweisung" }),
  ];
  const end = entry("ende", "count", 18000, { Wallet: "w", Phase: "Ende" });
  const a = festivalStatement([...rows, end]);
  const b = festivalStatement([
    ...rows,
    {
      ...end,
      Data: { ...end.Data, Wallet: "", Fields: { countScope: "all" } },
    },
  ]);
  assert.equal(a.result[0].value, 10000);
  assert.equal(a.total, 16700);
  assert.equal(b.total, a.total);
  assert.equal(
    festivalStatement([
      ...rows,
      end,
      entry("settlement:w", "income", 10000, { Wallet: "w", Method: "Bar" }),
    ]).total,
    a.total,
  );
  assert.equal(festivalStatement(rows).total, null);
});

test("Zwei Gästepreislisten je Blatt behalten auf Folgeseiten jeden Artikel in beiden Fassungen", async () => {
  for (const [width, height] of [
    [210, 297],
    [215.9, 279.4],
  ]) {
    const rows = Array.from({ length: 55 }, (_, i) => [
      "Probeartikel " + String(i).padStart(3, "0"),
      "Portion",
      "2,50 EUR",
    ]);
    const files = await guestSheets({
      title: "Preisliste",
      event: "Übungsfest",
      font: "helvetica",
      width,
      height,
      tables: { blocks: [{ headers: ["Essen"], rows }] },
    });
    const pdf = await PDFDocument.load(await files.pdf.arrayBuffer());
    assert.ok(pdf.getPageCount() >= 3);
    const parts = unzipSync(new Uint8Array(await files.docx.arrayBuffer())),
      xml = strFromU8(parts["word/document.xml"]);
    for (const [name] of rows) assert.equal(xml.split(name).length, 3);
  }
});
