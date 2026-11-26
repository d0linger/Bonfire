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
    const sheet = "xl/worksheets/sheet1.xml";
    const withExtraColumn = b.strFromU8(contents[sheet]).replace(/<\/row>(?=<\/sheetData>)/, '<c r="AD2"><v>9999</v></c></row>');
    if (!withExtraColumn.includes("AD2")) throw Error("Invalid workbook fixture");
    const extraColumn = await check(new File([b.zipSync({ ...contents, [sheet]: b.strToU8(withExtraColumn) })], "outside-column.xlsx"));
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
        textCell("B2", "Marktgemeinde Musterort") + textCell("E2", "Beschreibung") +
        '<c r="C2"><v>0</v></c><c r="D2"><v>19</v></c></row><row r="3">' +
        textCell("B3", "Fehlender Wert") +
        '<c r="C3"/></row><row r="4"><c r="C4"><v>-12.50</v></c></row></sheetData></worksheet>',
    );
    const alternative = await b.historyPreview(
      new File([b.zipSync(variant)], "varianten.xlsx"),
      "D1",
      "2025",
    );
    const budgetOnly = b.strFromU8(variant[sheet])
      .replace('</row><row r="2">', '<c r="F1"><v>2025</v></c></row><row r="2">')
      .replace("Ausgaben", "Globalbudget 2025")
      .replace("Marktgemeinde Musterort", "Globalbudget 2025");
    const budgetRows = await b.historyPreview(
      new File([b.zipSync({ ...variant, [sheet]: b.strToU8(budgetOnly) })], "budget.xlsx"),
      "D1",
      "2025",
    );
    if (budgetRows.some((r) => /^[CD]\d+$/.test(r.cell)))
      throw Error("A dated budget column appeared in the journal preview");
    const sparse = budgetOnly.replace(/<c r="(?:A2|C2|D2)"><v>[^<]*<\/v><\/c>/g, "")
      .replace('</row><row r="3">', '<c r="F2"><v>17</v></c></row><row r="3">');
    for (const xml of [sparse, sparse.replace('<c r="F2"><v>17</v></c>', textCell("F2", "15.07."))]) {
      const sparseRows = await b.historyPreview(
        new File([b.zipSync({ ...variant, [sheet]: b.strToU8(xml) })], "sparse-budget.xlsx"),
        "D1", "2025",
      );
      if (sparseRows.some((r) => /^[CD]\d+$/.test(r.cell)))
        throw Error("A sparse mixed row erased the budget headings");
    }
    const doc = (x, styles, parts = {}) =>
      new File(
        [
          b.zipSync({
            ...parts,
            ...(styles ? { "word/styles.xml": b.strToU8('<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' + styles + '</w:styles>') } : {}),
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
        "<w:p><w:r><w:t>{{organization.</w:t></w:r><w:r><w:t>name}}</w:t><w:br/><w:t>Second line</w:t><w:tab/><w:t>Value</w:t></w:r></w:p>",
      ),
    );
    for (const type of ["page", "column"]) {
      let error;
      try {
        await b.importTemplate(doc(`<w:p><w:r><w:t>Before</w:t><w:br w:type="${type}"/><w:t>After</w:t></w:r></w:p>`));
      } catch (cause) { error = cause; }
      if (error?.message !== "Unsupported Word break: " + type) throw Error("Expected rejection for " + type);
    }
    for (const value of ["", "true", "on", "1", "false", "off", "0"]) {
      const attribute = value ? ` w:val="${value}"` : "";
      const file = doc(`<w:p><w:pPr><w:pageBreakBefore${attribute}/></w:pPr><w:r><w:t>Receipt</w:t></w:r></w:p>`);
      let text, error;
      try { text = await b.importTemplate(file); } catch (cause) { error = cause; }
      if (["false", "off", "0"].includes(value)) {
        if (text !== "Receipt") throw Error("Disabled page break changed the imported paragraph");
      } else if (error?.message !== "Unsupported Word break: pageBreakBefore") throw Error("Expected paragraph break rejection");
    }
    const styles = '<w:style w:type="paragraph" w:styleId="Base"><w:pPr><w:pageBreakBefore/></w:pPr></w:style>' +
      '<w:style w:type="paragraph" w:styleId="Receipt" w:default="1"><w:basedOn w:val="Base"/></w:style>';
    for (const [properties, blocked] of [
      ["", true], ['<w:pStyle w:val="Receipt"/>', true],
      ['<w:pStyle w:val="Receipt"/><w:pageBreakBefore w:val="0"/>', false],
    ]) {
      let text, error;
      try { text = await b.importTemplate(doc(`<w:p><w:pPr>${properties}</w:pPr><w:r><w:t>Receipt</w:t></w:r></w:p>`, styles)); }
      catch (cause) { error = cause; }
      if (blocked ? error?.message !== "Unsupported Word break: pageBreakBefore" : text !== "Receipt") throw Error("Incorrect inherited paragraph break");
    }
    const alternate = doc('<w:p><w:r><w:t>Receipt</w:t></w:r></w:p>', null, {
      "word/_rels/document.xml.rels": b.strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="custom/layout.xml"/></Relationships>'),
      "word/custom/layout.xml": b.strToU8('<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' + styles + '</w:styles>'),
    });
    let alternateError;
    try { await b.importTemplate(alternate); } catch (error) { alternateError = error; }
    if (alternateError?.message !== "Text import requires styles in word/styles.xml.") throw Error("Alternate styles part was silently ignored");
    for (const [count, message] of [[1, "The Word styles part is missing."], [2, "The Word document declares multiple styles parts."]]) {
      const links = Array.from({length:count}, (_, i) => `<Relationship Id="r${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`).join("");
      const invalid = doc("<w:p><w:r><w:t>Test</w:t></w:r></w:p>", null, {
        "word/_rels/document.xml.rels": b.strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + links + '</Relationships>'),
      });
      let reason;
      try { await b.importTemplate(invalid); } catch (error) { reason = error.message; }
      if (reason !== message) throw Error("Expected styles relationship validation: " + message);
    }
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
      { "Review-report.pdf": new Blob(["TEST"]) },
    );
    const zip = b.unzipSync(new Uint8Array(await evidence.arrayBuffer()));
    return {
      journal, extraColumn,
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
      report: !!zip["Review-report.pdf"],
    };
  });
  const expected = [
    305,
    'Übung; zwei "Gläser"',
    "2026-07-15",
    "Possible duplicate",
  ];
  assert.deepEqual(result.journal, [expected, expected]);
  assert.deepEqual(result.extraColumn, expected);
  assert.deepEqual(result.historical, [
    ["C2", "2025-07-15", 305, false],
    ["C3", "", 820, true],
  ]);
  assert.equal(result.allD8, true);
  assert.deepEqual(result.comparison, [305, 515, "8.2"]);
  assert.deepEqual(result.variant, [
    ["C2", "expense", 0, false, "Excel date"],
    ["C3", "expense", null, true, "Check the date"],
    ["C4", "expense", 1250, true, "Check the date"],
  ]);
  assert.equal(result.runs, "{{organization.name}}\nSecond line\tValue");
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
  assert.ok(result.manifest.fehlendeBerichte.includes("Document-register.pdf"));
  console.log(
    "PASS: typed XLSX/quoted CSV roundtrip, duplicate review, manual source year, formula versus cached sum, blocked D8, split Word tokens and evidence package",
  );
} finally {
  await browser?.close();
  await new Promise((r) => server.close(r));
}
