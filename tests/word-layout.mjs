import { chromium } from "playwright";
import { build } from "esbuild";
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
} from "docx";
import { writeFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.BONFIRE_BROWSER || undefined,
});
try {
  const page = await browser.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") console.log("Browser:", m.text().slice(0, 280));
  });
  page.on("pageerror", (m) => console.log("Renderer:", m.message));
  const script = (
    await build({
      stdin: {
        contents: 'export {wordFiles} from "./web/word-profile.js"',
        resolveDir: process.cwd(),
      },
      format: "iife",
      globalName: "localWord",
      bundle: true,
      write: false,
    })
  ).outputFiles[0].text;
  await page.route("**/word-fixture.js", (r) =>
    r.fulfill({ contentType: "application/javascript", body: script }),
  );
  const url = process.env.BONFIRE_URL || "http://127.0.0.1:8137";
  await page.goto(url);
  await page.addScriptTag({ url: "/word-fixture.js" });
  const file = await Packer.toBuffer(
    new Document({
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
          ],
        },
      ],
    }),
  );
  const bytes = await page.evaluate(async (encoded) => {
    const out = await localWord.wordFiles(encoded, {
      "organization.name": "Übungsorganisation",
      "donation.amount_cents": 305,
    });
    return Array.from(new Uint8Array(await out.pdf.arrayBuffer()));
  }, file.toString("base64"));
  assert.equal(Buffer.from(bytes).subarray(0, 5).toString(), "%PDF-");
  await mkdir("test-results/exports", { recursive: true });
  await writeFile("test-results/exports/Word-Pruefung.pdf", Buffer.from(bytes));
  console.log("PASS: local Word rendering under application CSP");
} finally {
  await browser.close();
}
