import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { jsPDF } from "jspdf";
import { admin, api, onlineClient } from "./local-api.mjs";
import { disposableURL, testPassword } from "./test-password.mjs";

const origin = disposableURL(), day = "2851-05-02", call = await onlineClient();
const years = await call("years");
const year = years.find(y => y.Starts === day) || await call("years", {Name: "Evidence practice", Starts: day, Ends: day});
const ledger = (await call("events?year=" + year.ID)).find(e => e.General);
const source = Buffer.from("Synthetic journal " + randomUUID());
const hash = createHash("sha256").update(source).digest("hex");
const id = "import:" + hash + ":0-C7", caption = "Exercise " + randomUUID();
const op = (Kind, Target, Data) => ({ ID: randomUUID(), Kind, Target, Base: 0, Data: { Date: day, Label: "Test fixture", ...Data } });
const contributor = op("contact", randomUUID(), {Label: "Contributor " + randomUUID(), Fields: {birth: "1985-06-09"}});
const imported = op("income", id, {Label: caption, Contact: contributor.Target, Amount: 1500, Reference: "source:" + hash, Note: "Checked the source", Fields: {sheet: "Practice", cell: "C7", original: "15.00"}});
const other = op("income", randomUUID(), {Amount: 1500});
const document = new jsPDF();
document.text("Synthetic booking evidence", 10, 15);
const pdf = Buffer.from(document.output("arraybuffer"));
const receipt = (label, parent) => op("attachment", randomUUID(), {
  Label: label, Filename: label + ".pdf", Reference: parent, File: pdf.toString("base64"),
});
const one = receipt("First receipt", id), two = receipt("Second receipt", id), unrelated = receipt("Unrelated receipt", other.Target);
const path = "online?event=" + ledger.ID;
await call(path, {Ops: [
  op("import-source", "source:" + hash, {Reference: hash, Filename: "synthetic.xlsx", Status: "D1", File: source.toString("base64")}),
  contributor, imported, other, one, two, unrelated,
]}, 200, {"X-Bonfire-Donor":"true"});
const reader = "reader-" + randomUUID(), password = randomUUID();
await api("users", admin, {Name: reader, Password: password, Role:"Read", Event:ledger.ID});
const browser = await chromium.launch({executablePath: process.env.BONFIRE_BROWSER});
const corrected = caption + " revised";
const btn = (host, name) => host.getByRole("button", {name, exact:true});
try {
  for (const [width, user, secret] of [[1440, "leitung", testPassword()], [390, reader, password]]) {
    const page = await browser.newPage({viewport:{width,height:844},hasTouch:width===390});
    page.setDefaultTimeout(20000);
    await page.goto(origin);
    await page.locator("#login [name=user]").fill(user);
    await page.locator("#login [name=pass]").fill(secret);
    await page.locator("#login button:not([type=button])").click();
    const openNav = async () => {
      if (!await page.locator("nav").isVisible()) await page.locator("#menu-toggle").click();
    };
    await page.locator("#fiscal-switch").waitFor({state:"attached"});
    await openNav();
    await page.locator("#fiscal-switch summary").click();
    await Promise.all([
      page.waitForResponse(r => r.url().includes("/api/online?event=" + ledger.ID)),
      page.locator('[data-fiscal="' + year.ID + '"]').click(),
    ]);
    await page.waitForFunction(() => !window.document.querySelector('article[aria-busy=true]'));
    await page.getByRole("heading", {name:"Financial overview", exact:true}).waitFor();
    const go = async name => {
      await openNav();
      await btn(page.locator("nav"), name).click();
      await page.waitForFunction(() => !window.document.querySelector('article[aria-busy=true]'));
    };
    await go("Cashbook");
    await page.locator(".filter-box summary").click();
    await page.locator("#filter [name=filter]").fill(caption);
    await btn(page.locator("#filter"), "Filter").click();
    const row = page.locator('[data-booking-detail="' + id + '"]');
    await row.click();
    const dialog = page.getByRole("dialog", {name:"Booking details"});
    await dialog.getByText("Practice · C7").waitFor();
    await dialog.getByText(contributor.Data.Label, {exact:true}).waitFor();
    assert.equal(await dialog.getByText("1985-06-09").count(),0);
    assert.equal(await dialog.getByText("Checked the source").count(),1);
    assert.equal(await dialog.getByRole("link", {name:"Open receipt"}).count(),2);
    assert.equal(await dialog.getByText("Unrelated receipt.pdf").count(),0);
    const open = dialog.getByRole("link", {name:"Open receipt"}).first();
    assert.equal(await open.getAttribute("target"), "_blank");
    const url = new URL(await open.getAttribute("href"), origin);
    const opening = page.context().waitForEvent("response", res => res.url() === url.href);
    await open.click();
    assert.equal((await opening).status(),200);
    for (const tab of page.context().pages()) if (tab !== page) await tab.close();
    await page.bringToFront();
    const response = await page.request.get(url.href);
    assert.equal(response.status(),200);
    assert.equal(response.headers()["content-type"],"application/pdf");
    assert.deepEqual(await response.body(), pdf);
    assert.equal((await page.request.get(url.href + "&download=1")).headers()["content-disposition"].split(";")[0],"attachment");
    url.searchParams.set("file", unrelated.Target);
    assert.equal((await page.request.get(url.href)).status(),404);
    if (user === reader) {
      assert.equal(await dialog.getByText("synthetic.xlsx").count(),0);
      const blocked = await page.request.post(origin + "/api/" + path, {data:{Ops:[{...imported,ID:randomUUID(),Base:2}]}});
      assert.equal(blocked.status(),403);
      url.searchParams.set("event",randomUUID());
      assert.equal((await page.request.get(url.href)).status(),403);
    }
    await btn(dialog,"Back to entries").click();
    assert.equal(await row.evaluate(el => el === el.ownerDocument.activeElement),true);
    await go("Documents");
    await go("Cashbook");
    assert.equal(await page.locator("#filter [name=filter]").inputValue(),caption);
    assert.equal(await row.evaluate(el => el === el.ownerDocument.activeElement),true);
    const edit = row.locator("xpath=ancestor::tr").getByRole("button",{name:"Edit",exact:true});
    if (user === reader) {
      assert.equal(await edit.count(),0);
      await row.click();
      await dialog.getByText("Description confirmed").waitFor();
    } else {
      await edit.click();
      const form = page.locator("#record");
      await form.getByText("Practice · C7").waitFor();
      await form.locator('[name=Label]').fill(corrected);
      await form.locator('[name=Note]').fill("Description confirmed");
      await btn(form,"Save correction").click();
      await btn(page,corrected).waitFor();
      const saved = (await call(path, {})).entries.filter(r => r.ID === id);
      assert.equal(saved.length,1);
      assert.equal(saved[0].Revision,2);
      assert.equal(saved[0].Data.Amount,1500);
      assert.deepEqual(saved[0].Data.Fields,imported.Data.Fields);
      assert.equal(saved[0].Data.Reference,imported.Data.Reference);
      assert.equal(saved[0].Data.ImportNote,"Checked the source");
    }
    await page.close();
  }
  console.log("PASS imported booking correction, filtered desktop and mobile details, exact evidence bytes, role and scope checks");
} finally {
  await browser.close();
}
