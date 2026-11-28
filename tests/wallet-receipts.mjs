import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { admin, onlineClient } from "./local-api.mjs";

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
}finally{await browser.close();}
