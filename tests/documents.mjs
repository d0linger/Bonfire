import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "playwright";
import { createServer } from "node:http";
const { outputFiles } = await build({
  stdin: {
    contents: `export * from "./web/exchange.js"; export * from "./web/historical.js"; export * from "./web/templates.js"; export {zipSync,unzipSync,strToU8,strFromU8} from "fflate";`,
    resolveDir: process.cwd(),
  },
  format: "iife",
  globalName: "bonfire",
  bundle: true,
  write: false,
});
const server = createServer((req, res) => {
  res.setHeader(
    "Content-Type",
    req.url === "/lib.js" ? "application/javascript" : "text/html",
  );
  res.end(
    req.url === "/lib.js"
      ? outputFiles[0].contents
      : '<script src="/lib.js"></script>',
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.BONFIRE_BROWSER || undefined,
    headless: true,
  });
  const page = await browser.newPage();
  await page.goto("http://127.0.0.1:" + server.address().port);
  const result = await page.evaluate(async () => {
    const b = window.bonfire;
    const rows = [
      {
        ID: "fiktiv",
        Revision: 1,
        Kind: "income",
        Data: {
          Date: "2026-07-15",
          Label: 'Übung; zwei "Gläser"',
          Amount: 305,
          Method: "Bar",
        },
      },
    ];
    const csv = await b.csv(rows),
      workbook = b.workbook(rows);
    const check = async (file) => {
      const [r] = await b.preview(file, rows);
      return [r.amount, r.label, r.date, r.status];
    };
    const journal = [
      await check(new File([csv], "test.csv")),
      await check(new File([workbook], "test.xlsx")),
    ];
    const contents = b.unzipSync(new Uint8Array(await workbook.arrayBuffer()));
    contents["xl/worksheets/sheet1.xml"] = b.strToU8(
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="2"><c r="A2" t="inlineStr"><is><t>Übung</t></is></c><c r="B2" t="inlineStr"><is><t>15.07.</t></is></c><c r="C2"><v>3.05</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>Gesamtsumme</t></is></c><c r="C3"><f>SUM(C2:C2)</f><v>8.2</v></c></row></sheetData></worksheet>',
    );
    const history = new File([b.zipSync(contents)], "synthetisch.xlsx");
    const d1 = await b.historyPreview(history, "D1", "2025"),
      d8 = await b.historyPreview(history, "D8", "2026");
    const variant = { ...contents };
    const textCell = (ref, text) =>
      '<c r="' + ref + '" t="inlineStr"><is><t>' + text + "</t></is></c>";
    variant["xl/worksheets/sheet1.xml"] = b.strToU8(
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1">' +
        textCell("A1", "Datum") +
        textCell("B1", "Beschreibung") +
        textCell("C1", "Ausgaben") +
        textCell("D1", "Globalbudget") +
        '</row><row r="2"><c r="A2"><v>45999</v></c>' +
        textCell("B2", "Übungsaufwand") +
        '<c r="C2"><v>0</v></c><c r="D2"><v>19</v></c></row><row r="3">' +
        textCell("B3", "Fehlender Wert") +
        '<c r="C3"/></row></sheetData></worksheet>',
    );
    const alternative = await b.historyPreview(
      new File([b.zipSync(variant)], "varianten.xlsx"),
      "D1",
      "2025",
    );
    const doc = (x) =>
      new File(
        [
          b.zipSync({
            "word/document.xml": b.strToU8(
              '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
                x +
                "</w:body></w:document>",
            ),
          }),
        ],
        "uebung.docx",
      );
    const runs = await b.importTemplate(
      doc(
        "<w:p><w:r><w:t>{{organization.</w:t></w:r><w:r><w:t>name}}</w:t></w:r></w:p>",
      ),
    );
    let rejected = false;
    try {
      await b.importTemplate(
        doc("<w:p><w:r><w:t>{{unbekannt}}</w:t></w:r></w:p>"),
      );
    } catch {
      rejected = true;
    }
    const evidence = await b.evidence(
      {
        synced: "test",
        device: "nur-test",
        ops: [],
        conflicts: [],
        pending: 1,
        closed: true,
        devices: [{ ID: "geraet-sued", Name: "Süd", Sealed: false }],
      },
      [
        ...rows,
        {
          ID: "fehlende-kopie",
          Kind: "original",
          Revision: 1,
          Data: { Date: "2026-07-15", Label: "Ausstehende Kopie" },
        },
      ],
      { "Pruefbericht.pdf": new Blob(["TEST"]) },
    );
    const zip = b.unzipSync(new Uint8Array(await evidence.arrayBuffer()));
    return {
      journal,
      historical: d1.map((r) => [r.cell, r.date, r.amount, r.blocked]),
      allD8: d8.every((r) => r.blocked),
      comparison: [d1[1].calculatedCent, d1[1].differenceCent, d1[1].cached],
      variant: alternative.map((r) => [
        r.cell,
        r.kind,
        r.amount,
        r.blocked,
        r.yearOrigin,
      ]),
      runs,
      rejected,
      manifest: JSON.parse(b.strFromU8(zip["manifest.json"])),
      report: !!zip["Pruefbericht.pdf"],
    };
  });
  const expected = [
    305,
    'Übung; zwei "Gläser"',
    "2026-07-15",
    "Mögliche Dublette",
  ];
  assert.deepEqual(result.journal, [expected, expected]);
  assert.deepEqual(result.historical, [
    ["C2", "2025-07-15", 305, false],
    ["C3", "", 820, true],
  ]);
  assert.equal(result.allD8, true);
  assert.deepEqual(result.comparison, [305, 515, "8.2"]);
  assert.deepEqual(result.variant, [
    ["C2", "expense", 0, false, "Excel-Datum"],
    ["C3", "expense", null, true, "Datum prüfen"],
  ]);
  assert.equal(result.runs, "{{organization.name}}");
  assert.ok(result.rejected && result.report);
  assert.equal(result.manifest.freigegeben, false);
  assert.equal(result.manifest.veranstaltungAbgeschlossen, true);
  assert.deepEqual(result.manifest.offeneGeraete, [
    { id: "geraet-sued", name: "Süd" },
  ]);
  assert.deepEqual(result.manifest.fehlendeDateien, [
    { id: "fehlende-kopie", format: "PDF" },
    { id: "fehlende-kopie", format: "DOCX" },
  ]);
  assert.ok(result.manifest.fehlendeBerichte.includes("Belegjournal.pdf"));
  console.log(
    "PASS: typed XLSX/quoted CSV roundtrip, duplicate review, manual source year, formula versus cached sum, blocked D8, split Word tokens and evidence package",
  );
} finally {
  await browser?.close();
  await new Promise((r) => server.close(r));
}
