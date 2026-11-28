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
const run = randomUUID();
const label = "Equal payment " + run, firstCorrection = "First correction " + run,
  secondCorrection = "Second correction " + run, privateDraft = "Private draft " + run;
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
  await button(dialog,"Refresh entries").waitFor();
  assert.ok(await dialog.locator("#record").evaluate(form => form.inert));
  assert.ok(await dialog.locator("[name=type]").isDisabled());
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

  await fill(desktop,"Rejected " + run);
  await desktop.route("**/api/online?*",route => route.abort("failed"),{times:1});
  await button(dialog,"Save").click();
  await button(dialog,"Refresh entries").click();
  await button(dialog,"Retry original entry").waitFor();
  await desktop.route("**/api/online?*",route => route.fulfill({status:422,body:"Validation rejected this entry."}),{times:1});
  await button(dialog,"Retry original entry").click();
  await dialog.getByRole("alert").getByText("Validation rejected this entry.").waitFor();
  assert.ok(await dialog.locator("#record").evaluate(form => !form.inert));
  assert.ok(await dialog.locator("[name=type]").isEnabled());
  await button(dialog,"Cancel").click();

  const mobile = await workspace(390);
  const mobileDialog = mobile.getByRole("dialog");
  const first = desktop.getByRole("row").filter({has:cell(label)}).first();
  const id = await first.locator("[data-edit]").getAttribute("data-edit");
  for (const [page,newName] of [[desktop,firstCorrection],[mobile,secondCorrection]]) {
    await page.locator('[data-edit="' + id + '"]').click();
    await page.getByLabel("Reason for correction").fill("Synthetic correction");
    await page.locator("#record [name=Label]").fill(newName);
  }
  await button(dialog,"Save correction").click();
  await cell(firstCorrection).waitFor();
  await button(mobileDialog,"Save correction").click();
  await button(mobileDialog,"Compare current entry").click();
  await mobileDialog.getByText("Current: " + firstCorrection + " · Your draft: " + secondCorrection).waitFor();
  assert.equal(await mobile.locator("#record [name=Label]").inputValue(),firstCorrection);
  await button(mobileDialog,"Cancel").click();

  await fill(mobile,privateDraft);
  await mobile.request.post(origin+"/api/logout");
  await button(mobileDialog,"Save").click();
  await login(mobile);
  await mobile.request.post(origin+"/api/logout");
  await button(mobileDialog,"Resume entry").click();
  await login(mobile);
  await button(mobileDialog,"Resume entry").click();
  assert.equal(await mobile.locator("#record [name=Label]").inputValue(),privateDraft);
  assert.equal(await mobile.locator("#record [name=amount]").inputValue(),"8,10");
  let release;
  const held = new Promise(resolve => {release=resolve;});
  await mobile.route("**/api/online?*",async route => {await held; await route.continue();},{times:1});
  await button(mobileDialog,"Save").click();
  await mobileDialog.getByRole("status").getByText("Saving…").waitFor();
  assert.ok(await mobileDialog.locator("#record button:not([type=button])").isDisabled());
  release();
  await mobile.getByRole("cell",{name:privateDraft,exact:true}).waitFor();
  await fill(mobile,"Do not disclose");
  await mobile.request.post(origin+"/api/logout");
  await button(mobileDialog,"Save").click();
  await login(mobile,writer,password);
  assert.equal(await button(mobile,"Resume entry").count(),0);
  assert.equal(await mobile.locator("#record").count(),0);
  const otherReceipt = await mobile.request.post(origin+"/api/"+receiptPath,{data:{CheckOperation:payload.Ops[0].ID}});
  assert.equal(otherReceipt.status(),200);
  assert.deepEqual(await otherReceipt.json(),{applied:false});

  const event = await call("events",{Name:"Float recovery " + run,Year:year.ID,Starts:date,Ends:date});
  const wallets = ["Source","Recipient"].map(Label => ({
    ID:randomUUID(),Target:randomUUID(),Kind:"wallet",Data:{Date:date,Label}
  }));
  await call("online?event=" + event.ID,{Ops:wallets});
  await desktop.reload();
  await button(desktop.locator("nav"),"Events").click();
  await desktop.locator('[data-space="' + event.ID + '"]').click();
  await button(desktop.locator(".tabs"),"Wallets").click();
  await button(desktop,"Add change").click();
  await dialog.locator("[name=Wallet]").selectOption(wallets[1].Target);
  await dialog.locator("[name=sourceWallet]").selectOption(wallets[0].Target);
  await dialog.locator("[name=field_countMode]").selectOption("pieces");
  await dialog.locator("[name=Date]").fill(date);
  await dialog.locator("[name=coin1000]").fill("2");
  await desktop.request.post(origin+"/api/logout");
  await button(dialog,"Save").click();
  await login(desktop);
  await button(dialog,"Resume entry").click();
  assert.equal(await dialog.locator("[name=coin1000]").inputValue(),"2");
  assert.match(await dialog.locator("#count-total").innerText(),/20,00/);
  assert.match(await dialog.locator('[data-piece="1000"]').innerText(),/20,00/);
  assert.ok(await dialog.locator("[name=Account]").isDisabled());
  assert.ok(await dialog.locator("#record").evaluate(form => form.checkValidity()));
  await dialog.locator("[name=sourceWallet]").selectOption("");
  assert.ok(await dialog.locator("[name=Account]").isEnabled());
  assert.ok(await dialog.locator("[name=Account]").isVisible());
  console.log("PASS same-user volatile draft, isolated identities, explicit stale correction, exact retry and saving feedback");
} finally { await browser.close(); }
