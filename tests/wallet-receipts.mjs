import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { admin, api, basic, onlineClient } from "./local-api.mjs";

const cashier=await onlineClient();
const day="2818-09-02";
const year=await cashier("years",{Name:"Synthetic receipt allocations",Starts:day,Ends:day});
const event=await cashier("events",{Name:"Synthetic bar",Starts:day,Ends:day,Year:year.ID});
const ledger=(await cashier("events?year="+year.ID)).find(e=>e.General);
const wallet=randomUUID();
const receipt=randomUUID();
const make=(Target,Kind,Data)=>({ID:randomUUID(),Target,Kind,Data:{Label:Kind,Date:day,...Data}});
const count=(Phase,Amount)=>make("count:"+createHash("sha256").update(wallet+"|"+Phase).digest("hex").slice(0,32),"count",{
  Phase,Amount,Wallet:wallet,Fields:{countMode:"amount",countScope:"wallet"},
});
await cashier("online?event="+ledger.ID,{Ops:[make(receipt,"income",{Amount:6000,Label:"Cashbook takings",Method:"Bar"})]});
await cashier("online?event="+event.ID,{Ops:[make(wallet,"wallet",{Label:"Blue wallet"}),count("Anfang",10000),
 make(randomUUID(),"supply",{Amount:2000,Account:"main",Wallet:wallet,To:wallet}),
 make(randomUUID(),"skim",{Amount:3000,Wallet:wallet,Account:wallet,To:"main"}),count("Ende",15000),
 make(randomUUID(),"return",{Amount:15000,Wallet:wallet,Account:wallet,To:"main"}),
]});
for (const role of ["Read","Write"]) {
  const limited = "receipt-"+role.toLowerCase()+"-"+randomUUID().slice(0,8), password=randomUUID();
  await api("users",admin,{Name:limited,Password:password,Role:role,Event:event.ID});
  const scoped=await onlineClient(basic(limited,password));
  assert.deepEqual(await scoped("events/wallet-links?event="+event.ID+"&wallet="+wallet),[]);
  await scoped("events/wallet-links",{Event:event.ID,Wallet:wallet,Receipt:receipt,SourceRevision:1,Counted:6000,
    Amount:6000,Revision:0,PostRevision:0,Request:randomUUID()},403);
}
const browser=await chromium.launch({executablePath:process.env.BONFIRE_BROWSER});
try{
 const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 const base=process.env.BONFIRE_URL;
 const res=await context.request.post(base+"/api/login",{headers:{Authorization:admin}});
 assert.equal(res.status(),200);
 const page=await context.newPage();
 await page.goto(base);
 await page.locator("#menu-toggle").click();
 await page.locator("#fiscal-switch summary").click();await page.locator('[data-fiscal="'+year.ID+'"]').click();
 const nav=page.locator('nav [data-page="Veranstaltungen"]');
 if(!(await nav.isVisible()))await page.locator("#menu-toggle").click();
 await nav.click();await page.locator('[data-space="'+event.ID+'"]').click();
 await page.locator('.tabs [data-page="Geldtaschen"]').click();
 const walletRow=page.getByRole("row").filter({has:page.getByRole("rowheader",{name:"Blue wallet",exact:true})});
 const cells=await walletRow.getByRole("cell").allTextContents();
 assert.deepEqual(cells.map(s=>s.replace(/\s/g,"").split("·")[0]),["€100,00","€150,00","€150,00","€0,00","€60,00"]);
 await page.getByRole("button",{name:"Assign existing receipt",exact:true}).click();
 const dialog=page.getByRole("dialog");
 await dialog.getByLabel("Cashbook receipt",{exact:true}).selectOption(receipt);
 await dialog.getByLabel("Amount allocated to this count in EUR").fill("60");
 await dialog.getByRole("button",{name:"Save allocation"}).click();
 await dialog.waitFor({state:"hidden"});
 await page.getByText(/Linked cashbook receipts\s+€\s*60,00.*Remaining\s+€\s*0,00/).waitFor();
 assert.equal(await page.getByRole("button",{name:"Post remaining income"}).count(),0);
 const view=(await cashier("events?year="+year.ID+"&overview=1")).find(e=>e.ID===event.ID);
 assert.equal(view.ReceiptsCents,6000);
 const links=await cashier("events/wallet-links?event="+ledger.ID+"&receipt="+receipt);
 assert.deepEqual(links.map(l=>[l.EventName,l.WalletName,l.Amount]),[["Synthetic bar","Blue wallet",6000]]);
 const journal=(await cashier("online?event="+event.ID,{})).entries;
 assert.equal(journal.filter(r=>r.Kind==="income").length,0);
 console.log("PASS full wallet return retains historical count, mobile allocation attributes the existing receipt with no second journal movement");

 // A revised count may be smaller than either of two previous allocations. It must
 // still be possible to release one receipt at a time using the cashier's normal dialog.
 const second=randomUUID();
 await cashier("online?event="+ledger.ID,{Ops:[make(second,"income",{Amount:3000,Label:"Second cash receipt",Method:"Bar"})]});
 async function assign(source,euros,reason="") {
   await page.getByRole("button",{name:"Assign existing receipt"}).click();
   await dialog.getByLabel("Cashbook receipt",{exact:true}).selectOption(source);
   await dialog.getByLabel("Amount allocated to this count in EUR").fill(euros);
   await dialog.getByLabel("Reason for correction").fill(reason);
   await dialog.getByRole("button",{name:"Save allocation"}).click();
   await dialog.waitFor({state:"hidden"});
 }
 await assign(receipt,"30","Split between the two verified receipts");
 await assign(second,"30");
 const end=journal.find(r=>r.Kind==="count" && r.Data.Phase==="Ende");
 await cashier("online?event="+event.ID,{Ops:[{ID:randomUUID(),Target:end.ID,Kind:"count",Base:end.Revision,
   Data:{...end.Data,Amount:10000,Note:"Corrected closing observation"}}]});
 await page.getByRole("button",{name:"Refresh entries"}).click();
 await page.getByText(/Counted takings\s+€\s*10,00/).waitFor();
 await assign(receipt,"0","Release the first share after the recount");
 await page.getByText(/Linked cashbook receipts\s+€\s*30,00/).waitFor();
 await assign(second,"10","Keep only the amount supported by the recount");
 await page.getByText(/Linked cashbook receipts\s+€\s*10,00.*Remaining\s+€\s*0,00/).waitFor();
 console.log("PASS two allocations can be unwound through the mobile wallet dialog after a correction leaves both above the new count");
}finally{await browser.close();}
