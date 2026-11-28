import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { admin, api, onlineClient } from "./local-api.mjs";
import { disposableURL, testPassword } from "./test-password.mjs";

const origin = disposableURL(), date = "2538-02-15";
const call = await onlineClient();
const year = (await call("years")).find(item => item.Starts === date)
  || await call("years", {Name: "Entry recovery", Starts: date, Ends: date});
const ledger = (await call("events?year=" + year.ID)).find(item => item.General);
const writer = "recovery-" + randomUUID(), password = randomUUID();
await api("users", admin, {Name: writer, Password: password, Role:"Write", Event:ledger.ID});
const browser = await chromium.launch({executablePath:process.env.BONFIRE_BROWSER});
const label = "Equal payment " + randomUUID();
const button = (root,name) => root.getByRole("button",{name,exact:true});
async function login(page, user="leitung", secret=testPassword()) {
  await page.locator("#login [name=user]").fill(user);
  await page.locator("#login [name=pass]").fill(secret);
  await page.locator("#login button:not([type=button])").click();
  await page.locator("#fiscal-switch").waitFor({state:"attached"});
}
async function workspace(width) {
  const page = await browser.newPage({viewport:{width,height:844},isMobile:width===390,hasTouch:width===390});
  page.setDefaultTimeout(8000);
  await page.goto(origin);
  await login(page);
  const openNav = async () => {
    if (!await page.locator("nav").isVisible()) await page.locator("#menu-toggle").click();
  };
  await openNav();
  await page.locator("#fiscal-switch summary").click();
  await page.locator('[data-fiscal="' + year.ID + '"]').click();
  await page.waitForFunction(() => !document.querySelector('article[aria-busy=true]'));
  await page.getByRole("heading",{name:"Financial overview",exact:true}).waitFor();
  await openNav();
  await button(page.locator("nav"),"Cashbook").click();
  return page;
}
async function fill(page, value) {
  await button(page,"Record transaction").click();
  await page.locator("#record [name=Label]").fill(value);
  await page.locator("#record [name=Date]").fill(date);
  await page.locator("#record [name=amount]").fill("8,10");
}
try {
  const desktop = await workspace(1440);
  const dialog = desktop.getByRole("dialog");
  const cell = name => desktop.getByRole("cell",{name,exact:true});
  await fill(desktop,label);
  await button(dialog,"Save").click();
  await cell(label).waitFor();
  await fill(desktop,label);
  let payload;
  await desktop.route("**/api/online?*",async route => {
    payload = route.request().postDataJSON();
    await route.abort("failed");
  },{times:1});
  await button(dialog,"Save").click();
  await button(dialog,"Refresh entries").click();
  await button(dialog,"Retry original entry").waitFor();
  assert.equal(await desktop.locator("#record [name=Label]").inputValue(),label);
  const outgoing = desktop.waitForRequest(r => r.url().includes("/api/online?") && r.postDataJSON()?.Ops?.length);
  await button(dialog,"Retry original entry").click();
  assert.deepEqual((await outgoing).postDataJSON(),payload);
  await dialog.waitFor({state:"hidden"});
  assert.equal(await cell(label).count(),2);
  const receiptPath = "online?event=" + ledger.ID;
  assert.deepEqual(await call(receiptPath,{CheckOperation:payload.Ops[0].ID}),{applied:true});
  await call(receiptPath,{CheckOperation:payload.Ops[0].ID,Ops:payload.Ops},422);

  const mobile = await workspace(390);
  const mobileDialog = mobile.getByRole("dialog");
  const first = desktop.getByRole("row").filter({has:cell(label)}).first();
  const id = await first.locator("[data-edit]").getAttribute("data-edit");
  for (const [page,newName] of [[desktop,"First correction"],[mobile,"Second correction"]]) {
    await page.locator('[data-edit="' + id + '"]').click();
    await page.getByLabel("Reason for correction").fill("Synthetic correction");
    await page.locator("#record [name=Label]").fill(newName);
  }
  await button(dialog,"Save correction").click();
  await cell("First correction").waitFor();
  await button(mobileDialog,"Save correction").click();
  await button(mobileDialog,"Compare current entry").click();
  await mobileDialog.getByText("Current: First correction · Your draft: Second correction").waitFor();
  assert.equal(await mobile.locator("#record [name=Label]").inputValue(),"First correction");
  await button(mobileDialog,"Cancel").click();

  await fill(mobile,"Private draft");
  await mobile.request.post(origin+"/api/logout");
  await button(mobileDialog,"Save").click();
  await login(mobile);
  await button(mobileDialog,"Resume entry").click();
  assert.equal(await mobile.locator("#record [name=Label]").inputValue(),"Private draft");
  assert.equal(await mobile.locator("#record [name=amount]").inputValue(),"8,10");
  let release;
  const held = new Promise(resolve => {release=resolve;});
  await mobile.route("**/api/online?*",async route => {await held; await route.continue();},{times:1});
  await button(mobileDialog,"Save").click();
  await mobileDialog.getByRole("status").getByText("Saving…").waitFor();
  assert.ok(await mobileDialog.locator("#record button:not([type=button])").isDisabled());
  release();
  await mobile.getByRole("cell",{name:"Private draft",exact:true}).waitFor();
  await fill(mobile,"Do not disclose");
  await mobile.request.post(origin+"/api/logout");
  await button(mobileDialog,"Save").click();
  await login(mobile,writer,password);
  assert.equal(await button(mobile,"Resume entry").count(),0);
  assert.equal(await mobile.locator("#record").count(),0);
  const otherReceipt = await mobile.request.post(origin+"/api/"+receiptPath,{data:{CheckOperation:payload.Ops[0].ID}});
  assert.equal(otherReceipt.status(),200);
  assert.deepEqual(await otherReceipt.json(),{applied:false});
  console.log("PASS same-user volatile draft, isolated identities, explicit stale correction, exact retry and saving feedback");
} finally { await browser.close(); }
