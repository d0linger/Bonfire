import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { PDFDocument } from "pdf-lib";
import { unzipSync, strFromU8 } from "fflate";
import { admin } from "./local-api.mjs";

const url = new URL(process.env.BONFIRE_URL);
assert.equal(url.hostname, "127.0.0.1");
assert.ok(url.port && url.port !== "8137");
const browser = await chromium.launch({executablePath: process.env.BONFIRE_BROWSER});
try {
  const context = await browser.newContext();
  const post = async (path, data, headers = {}) => {
    const result = await context.request.post(url.origin + "/api/" + path, {data, headers});
    assert.equal(result.status(), 200, path + ": " + (await result.text()).slice(0, 120));
    return result.json();
  };
  await post("login", undefined, {Authorization: admin});
  const day = "2411-05-04";
  const year = await post("years", {Name:"Exportprüfung", Starts:day, Ends:day});
  const event = await post("events", {Year:year.ID, Name:"Fiktives Frühlingsfest", Starts:day, Ends:day});
  const path = "online?event=" + event.ID;
  const entry = (Kind, Label, fields = {}) => ({
    Kind, Target:randomUUID(), ID:randomUUID(), Data:{Label, Date:day, ...fields},
  });
  const wallet = entry("wallet","Börse Blau");
  const claim = entry("sponsorship","Übungsbanner",{Amount:10000});
  const payment = entry("payment","Teilzahlung",{Amount:4000, Method:"Bar", Reference:claim.Target, Wallet:wallet.Target});
  const donation = entry("donation","Übungsspende",{Amount:550, Method:"Bar", Wallet:wallet.Target});
  const prices = ["Getränk","Essen"].map(Category => entry("price",Category === "Essen" ? "Bread" : "Juice",{
    Category,Unit:"Portion",Status:"Freigegeben",Amount:250,
  }));
  const before = await post(path,{Ops:[wallet,claim,payment,donation,...prices]});
  const output = "test-results/online-exports";
  await mkdir(output,{recursive:true});
  for (let i=0; i<11; i++) {
    const page = await context.newPage();
    await page.goto(url.origin);
    await page.locator("#fiscal-switch summary").click();
    await page.locator('[data-fiscal="' + year.ID + '"]').click();
    await page.locator('nav [data-page="Veranstaltungen"]').click();
    await page.locator('[data-space="' + event.ID + '"]').click();
    await page.locator('.tabs [data-page="Dokumente"]').click();
    const form = page.locator("#export");
    for (const format of ["PDF","DOCX"]) {
      await form.locator('[name="profile"]').selectOption(String(i));
      const subject = {0:claim,1:payment,2:donation,6:donation}[i];
      if (subject) await form.locator('[name="subject"]').selectOption(subject.Target);
      await form.locator('[name="organization"]').fill("Übungsfeuerwehr");
      await form.locator('[name="format"]').selectOption(format);
      const download = page.waitForEvent("download",{timeout:15000});
      await form.getByRole("button",{name:"Dokument erzeugen"}).click();
      const file = await download.catch(async err => {throw new Error("T"+(i+1)+" "+format+": "+await page.locator("#notice").innerText(),{cause:err});});
      const bytes = await readFile(await file.path());
      await page.waitForFunction(() => !document.querySelector('article[aria-busy="true"]'));
      if (format === "PDF") {
        const pdf = await PDFDocument.load(bytes);
        const [width,height] = {2:[148,105],5:[216,279],10:[297,210]}[i] || [210,297];
        for (const sheet of pdf.getPages()) {
          assert.equal(Math.round(sheet.getWidth()*25.4/72),width);
          assert.equal(Math.round(sheet.getHeight()*25.4/72),height);
        }
        assert.ok(pdf.getPageCount() > 0);
      } else {
        const xml = strFromU8(unzipSync(bytes)["word/document.xml"]);
        assert.match(xml, /<w:body>/);
        if (i === 0) assert.match(xml,/Übungsbanner/);
        if (i === 1) assert.match(xml,/40,00/);
      }
      await writeFile(output + "/T" + (i+1) + "." + format.toLowerCase(),bytes);
    }
    await page.close();
  }
  const after = await post(path,{});
  assert.equal(after.last,before.last);
  assert.equal(after.nextNumber,before.nextNumber);
  console.log("PASS 11 Profile als PDF und DOCX, Seitenformate, Teilzahlungsbetrag und unverändertes Journal.");
} finally {
  await browser.close();
}
