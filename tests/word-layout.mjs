import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
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
  ImageRun,
} from "docx";
import { writeFile, mkdir, readFile } from "node:fs/promises";
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
              children: [
                new ImageRun({
                  type: "png",
                  data: await readFile("dist/icon-32.png"),
                  transformation: { width: 32, height: 32 },
                }),
              ],
            }),
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
  const rendered = await page.evaluate(async (encoded) => {
    const out = await window.localWord.wordFiles(encoded, {
      "organization.name": "Übungsorganisation",
      "donation.amount_cents": 305,
    });
    return { pdf: Array.from(new Uint8Array(await out.pdf.arrayBuffer())), docx: Array.from(new Uint8Array(await out.docx.arrayBuffer())) };
  }, file.toString("base64"));
  const xml = strFromU8(unzipSync(Uint8Array.from(rendered.docx))["word/document.xml"]);
  assert.ok(xml.includes("Übungsorganisation") && xml.includes("3,05") && !xml.includes("{{"));
  const bytes = rendered.pdf;
  assert.equal(Buffer.from(bytes).subarray(0, 5).toString(), "%PDF-");
  await mkdir("test-results/exports", { recursive: true });
  await writeFile("test-results/exports/Word-Pruefung.pdf", Buffer.from(bytes));
  const parts = unzipSync(file);
  const body = strFromU8(parts["word/document.xml"]);
  const shape = '<w:p><w:r><w:pict><v:rect xmlns:v="urn:schemas-microsoft-com:vml" style="width:72px;height:36px" fillcolor="red"/></w:pict></w:r></w:p>';
  parts["word/document.xml"] = strToU8(body.replace("<w:sectPr", shape + "<w:sectPr"));
  await page.goto(new URL("/word-renderer.html", url).href);
  await page.evaluate((docx) => {
    // Keep the embedded image pending beyond the first frame, like a large Word document.
    const read = FileReader.prototype.readAsDataURL;
    FileReader.prototype.readAsDataURL = function (blob) {
      requestAnimationFrame(() => requestAnimationFrame(() => read.call(this, blob)));
    };
    window.addEventListener("message", (event) => {
      if (event.data.id === "vml-test" && !event.data.docx) {
        document.documentElement.dataset.preview = event.data.error || String(event.data.pages);
      }
    });
    window.postMessage({ id: "vml-test", mode: "preview", docx: Uint8Array.from(docx) }, location.origin);
  }, [...zipSync(parts)]);
  await page.locator("html[data-preview]").waitFor({ state: "attached" });
  assert.equal(await page.locator("html").getAttribute("data-preview"), "1");
  const graphic = page.locator("#pages section.docx svg").filter({ has: page.locator("rect") });
  assert.equal(await graphic.getAttribute("width"), "72");
  assert.equal(await graphic.getAttribute("height"), "36");
  console.log("PASS: local Word rendering under application CSP");
} finally {
  await browser.close();
}
