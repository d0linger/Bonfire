import { testPassword } from "./test-password.mjs";
import { createHash, randomUUID, randomInt } from "node:crypto";
import assert from "node:assert/strict";
import { counted, summary } from "../web/domain.js";
const pass =
  testPassword();
const base = process.env.BONFIRE_URL || "http://127.0.0.1:8137",
  basic = (u, p) => "Basic " + Buffer.from(u + ":" + p).toString("base64"),
  admin = basic("leitung", pass),
  auth = (d) => "Bearer " + d.device + "." + d.token;
async function api(path, token, body, status = 200) {
  const res = await fetch(base + "/api/" + path, {
    method: "POST",
    headers: { Authorization: token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  assert.equal(res.status, status, text.slice(0, 160));
  return status === 200 ? JSON.parse(text) : null;
}
const year = randomInt(4000, 9000),
  day = year + "-03-17";
const event = await api("events", admin, {
  Name: "Allgemeines Übungskassenbuch " + randomUUID().slice(0, 8),
  General: true,
  Starts: day,
  Ends: day,
});
const reviewer = "p-" + randomUUID().slice(0, 12),
  pw = randomUUID();
await api("users", admin, {
  Name: reviewer,
  Role: "Read",
  Password: pw,
  Event: event.ID,
});
const prepare = (name, who = admin) =>
  api("prepare", who, { Name: name, Event: event.ID });
const cashier = "k-" + randomUUID().slice(0, 12),
  cashierPassword = randomUUID();
await api("users", admin, {
  Name: cashier,
  Role: "Write",
  Password: cashierPassword,
  Event: event.ID,
});
const a = await prepare("West"),
  b = await prepare("Ost", basic(cashier, cashierPassword)),
  r = await prepare("Prüfteam", basic(reviewer, pw));
const seq = new Map();
const rec = (d, Kind, Label, data = {}, Target = randomUUID(), Base = 0) => ({
  ID: randomUUID(),
  Seq: seq.set(d.device, (seq.get(d.device) || 0) + 1).get(d.device),
  Target,
  Base,
  Kind,
  Data: { Label, Date: day, ...data },
});
const send = (d, ...Ops) => api("sync", auth(d), { Ops });
const p = rec(a, "period", "Prüfzeitraum", { To: day }),
  open = rec(a, "opening", "Eröffnung", { Amount: 10000 }),
  wallet = rec(a, "wallet", "Geldtasche Rot");
await send(a, p, open, wallet);
const direct = rec(a, "expense", "Direkte Kosten", { Amount: 3500 });
const priv = rec(a, "outlay", "Auslage A", { Amount: 2000 });
const priv2 = rec(a, "outlay", "Auslage B", { Amount: 1000 });
await send(a, direct, priv, priv2);
const settle = rec(a, "reimbursement", "Erstattungsfahrt", {
  Amount: 3000,
  Allocations: { [priv.Target]: 2000, [priv2.Target]: 1000 },
});
assert.equal((await send(a, settle)).conflicts.length, 0);
const excess = rec(a, "reimbursement", "Doppelte Erstattung", {
  Amount: 100,
  Reference: priv.Target,
});
let out = await send(a, excess);
assert.equal(out.conflicts.length, 1);
await api("sync", auth(a), {
  Resolve: excess.ID,
  Choice: "beibehalten",
  Reason: "Erstattung bereits vollständig",
});
const correction = rec(
  a,
  "expense",
  "Direkte Kosten berichtigt",
  { Amount: 3000, Note: "Eingabefehler im Übungsfall" },
  direct.Target,
  1,
);
await send(a, correction);
const journal = await api("manage", auth(a), { Action: "journal" });
assert.ok(journal.some((x) => x.action.startsWith("Storno")));
const delivery = {
  Wallet: wallet.Target,
  Account: "Hauptkasse",
  To: "Geldtasche Rot",
  Amount: 5000,
  Fields: { matter: "Wechselgeld 17" },
};
const firstSupply = rec(b, "supply", "Wechselgeld an Rot", delivery);
const secondSupply = rec(a, "supply", "Zweite Lieferung", {
  ...delivery,
  Fields: { matter: "Wechselgeld 18" },
});
await Promise.all([send(a, secondSupply), send(b, firstSupply)]);
out = await send(b, firstSupply);
assert.deepEqual(out.conflicts, []);
assert.equal(
  out.entries.filter(
    (x) => x.Kind === "supply" && x.Data.Wallet === wallet.Target,
  ).length,
  2,
);
const repeatedDelivery = rec(a, "supply", "Erneut dieselbe Übergabe", delivery);
out = await send(a, repeatedDelivery);
assert.ok(out.conflicts.some((x) => x.ID === repeatedDelivery.ID));
assert.equal(out.entries.filter((x) => x.Kind === "supply").length, 2);
await api("sync", auth(a), {
  Resolve: repeatedDelivery.ID,
  Choice: "beibehalten",
  Reason: "Lieferung bereits am anderen Gerät erfasst",
});
const offer = rec(
  a,
  "handover",
  "Geldtasche Rot",
  { Wallet: wallet.Target, To: b.device, Status: "Angeboten" },
  "handover:" + wallet.Target,
);
await send(a, offer);
const skim = rec(b, "skim", "Abschöpfung während offener Übergabe", {
  Wallet: wallet.Target,
  Amount: 2000,
  Account: "Geldtasche Rot",
  To: "Hauptkasse",
});
assert.deepEqual((await send(b, skim)).conflicts, []);
const take = rec(
  b,
  "handover",
  "Geldtasche Rot",
  {
    Wallet: wallet.Target,
    To: b.device,
    Status: "Bestätigt",
    Note: "Physischer Empfang bestätigt",
  },
  offer.Target,
  1,
);
out = await send(b, take);
assert.equal(
  out.entries.find((r) => r.ID === offer.Target).Data.Status,
  "Bestätigt",
);
assert.equal(out.entries.find((r) => r.ID === wallet.Target).Revision, 1);
const observed = (phase, n) =>
  rec(
    a,
    "count",
    "Zählung " + phase,
    {
      Amount: n,
      Phase: phase,
      Wallet: wallet.Target,
      Fields: { countMode: "amount" },
    },
    "count:" +
      createHash("sha256")
        .update(wallet.Target + "|" + phase)
        .digest("hex")
        .slice(0, 32),
  );
const checkCash = await send(a, observed("Anfang", 0), observed("Ende", 8000));
assert.deepEqual(
  checkCash.conflicts.map((c) => c.Kind),
  [],
);
assert.equal(counted(checkCash.entries, wallet.Target), 0);
const settlement = rec(
  a,
  "income",
  "Börse abgerechnet",
  {
    Wallet: wallet.Target,
    Method: "Bar",
    Amount: 0,
    Reference: "wallet-settlement",
  },
  "settlement:" + wallet.Target,
);
assert.deepEqual((await send(a, settlement)).conflicts, []);
const returned = rec(a, "return", "Rückgabe nach bestätigter Übergabe", {
  Wallet: wallet.Target,
  Amount: 8000,
  Account: "Geldtasche Rot",
  To: "Hauptkasse",
});
assert.deepEqual((await send(a, returned)).conflicts, []);
const act = rec(a, "actual", "Unabhängiger Istbestand", { Amount: 4000 });
await send(a, act);
await api("manage", auth(a), { Action: "period-close", Target: p.Target }, 422);
for (const d of [a, b, r])
  await api("sync", auth(d), { Action: "Ende", Last: seq.get(d.device) || 0 });
const closed = await api("manage", auth(a), {
  Action: "period-close",
  Target: p.Target,
});
assert.match(closed, /^[0-9a-f-]{36}$/);
const nextDay = year + "-03-18";
const previous = await api("manage", auth(a), {
  Action: "prior",
  Target: nextDay,
});
assert.equal(previous.ID, closed);
assert.equal(previous.Actuals[""], 4000);
const following = await api("events", admin, {
  Name: "Folgeperiode " + randomUUID().slice(0, 8),
  General: true,
  Starts: nextDay,
  Ends: nextDay,
});
const nextDevice = await api("prepare", admin, {
  Event: following.ID,
  Name: "Folgeperiode",
});
const carried = rec(nextDevice, "opening", "Bestätigter Übertrag", {
  Date: nextDay,
  Amount: 4000,
  Account: "",
  Fields: { previous: previous.ID },
});
const carriedState = await send(nextDevice, carried);
assert.equal(
  carriedState.entries.find((x) => x.ID === carried.Target).Data.Fields
    .previous,
  closed,
);
const invalidCarry = rec(nextDevice, "opening", "Falscher Übertrag", {
  Date: nextDay,
  Amount: 3999,
  Account: "",
  Fields: { previous: previous.ID },
});
assert.ok(
  (await send(nextDevice, invalidCarry)).conflicts.some(
    (x) => x.ID === invalidCarry.ID,
  ),
);
const duplicateCarry = rec(nextDevice, "opening", "Doppelter Übertrag", {
  Date: nextDay,
  Amount: 4000,
  Account: "",
  Fields: { previous: previous.ID },
});
assert.ok(
  (await send(nextDevice, duplicateCarry)).conflicts.some(
    (x) => x.ID === duplicateCarry.ID,
  ),
);
const c = await prepare("Nachtrag");
const late = rec(c, "income", "Verspätete Meldung", { Amount: 55 });
out = await send(c, late);
assert.ok(out.conflicts.some((x) => x.ID === late.ID));
assert.ok(!out.entries.some((x) => x.ID === late.Target));
await api("manage", auth(a), {
  Action: "period-open",
  Target: p.Target,
  Reason: "Begründeter synthetischer Nachtrag",
});
out = await api("sync", auth(a), {
  Resolve: late.ID,
  Choice: "übernehmen",
  Reason: "Wiedereröffnete Übungsperiode",
  Last: 0,
});
assert.equal(out.entries.find((x) => x.ID === late.Target).Data.Amount, 55);
assert.equal(a.event.General, true);
const receipt = rec(c, "income", "Bestehende Bareinnahme", {
  Amount: 500,
  Method: "Bar",
});
const paper = rec(
  c,
  "paper",
  "Papierbeleg zur Zahlung",
  { Number: c.first, Status: "Ausgegeben", Reference: receipt.Target },
  "paper:" + c.first,
);
out = await send(c, receipt, paper);
assert.ok(out.entries.some((x) => x.ID === paper.Target));
const registers = await api("manage", auth(a), { Action: "numbers" });
assert.ok(
  registers.some((x) => x.paper.includes("P-" + c.first + " Ausgegeben")),
);
const duplicate = rec(
  c,
  "paper",
  "Papierbeleg doppelt",
  { Number: c.first + 1, Status: "Ausgegeben", Reference: receipt.Target },
  "paper:" + (c.first + 1),
);
out = await send(c, duplicate);
assert.ok(out.conflicts.some((x) => x.ID === duplicate.ID));
const card = rec(c, "card", "Kartengutschrift", {
  Amount: 28000,
  Account: "Zahlstelle",
  Fields: { provider: "Terminal A" },
});
const fee = rec(c, "fee", "Gebühr", {
  Amount: 500,
  Account: "Zahlstelle",
  Fields: { provider: "Terminal A" },
});
const payout = rec(c, "payout", "Auszahlung", {
  Amount: 27500,
  Account: "Zahlstelle",
  To: "Bank",
  Fields: { provider: "Terminal A" },
});
out = await send(c, card, fee, payout);
assert.ok(out.entries.some((x) => x.ID === payout.Target));
const over = rec(c, "payout", "Überhöhte zweite Auszahlung", {
  Amount: 1,
  Account: "Zahlstelle",
  To: "Bank",
  Fields: { provider: "Terminal A" },
});
out = await send(c, over);
assert.ok(out.conflicts.some((x) => x.ID === over.ID));
const srcBar = rec(c, "bar", "Garten");
const srcPrice = rec(c, "price", "Saft", {
  Status: "Freigegeben",
  Unit: "Glas",
  Category: "Getränk",
  Amount: 290,
  Bar: srcBar.Target,
});
const templateRef = "invoice_transfer_a4";
const srcTemplate = rec(
  c,
  "template",
  "Übungsrechnung",
  {
    Reference: templateRef,
    Fields: { footer: "Fußzeile Übungsfest", margin: "16" },
  },
  "template:" + templateRef,
);
await send(c, srcBar, srcPrice, srcTemplate);
const retiredPrice = rec(c, "price", "Früherer Artikel", {
  Status: "Entwurf",
  Category: "Getränk",
  Amount: 300,
  Unit: "Glas",
  Bar: srcBar.Target,
});
await send(c, retiredPrice);
const retire = rec(
  c,
  "price",
  retiredPrice.Data.Label,
  {
    ...retiredPrice.Data,
    Retired: true,
    Fields: { lifecycle: "Archiviert", lifecycleReason: "Sortiment beendet" },
  },
  retiredPrice.Target,
  1,
);
const archiveState = await send(c, retire);
assert.equal(
  archiveState.entries.find((x) => x.ID === retiredPrice.Target).Data.Retired,
  true,
);
const presale = rec(c, "presale", "Übungs-Vorverkauf", {
  Amount: 6000,
  Bar: srcBar.Target,
  Method: "Überweisung",
  Fields: {
    saleQuantity: "3",
    unitCents: "2000",
    paymentEvidence: "Fiktiver Kontoauszug 1",
  },
});
await api(
  "sync",
  auth(c),
  { Ops: [{ ...presale, Data: { ...presale.Data, Amount: 6100 } }] },
  422,
);
await send(c, presale);
const production = rec(c, "expense", "Herstellung Vorverkauf", {
  Amount: 1400,
  Bar: srcBar.Target,
  Method: "Überweisung",
  Fields: { sale: presale.Target },
});
out = await send(c, production);
const saleRows = out.entries.filter(
  (x) => x.ID === presale.Target || x.ID === production.Target,
);
assert.equal(summary(saleRows).result, 4600);
assert.equal(
  saleRows.find((x) => x.ID === presale.Target).Data.Fields.paymentEvidence,
  "Fiktiver Kontoauszug 1",
);
assert.equal(
  saleRows.find((x) => x.ID === production.Target).Data.Fields.sale,
  presale.Target,
);
console.log(
  "PASS Vorverkauf mit Mengenprüfung, Zahlungsnachweis und eigener Herstellungsausgabe",
);
const copied = await api("manage", auth(c), {
  Action: "copy",
  Target: "Neue Übung",
  Start: nextDay,
  End: nextDay,
});
const fresh = await api("prepare", admin, {
  Event: copied,
  Name: "Neue Leitung",
});
assert.equal(fresh.event.Starts, nextDay);
const snapshot = await send(fresh);
const copiedTemplate = snapshot.entries.find(
  (x) => x.ID === srcTemplate.Target,
);
assert.equal(copiedTemplate.Data.Reference, templateRef);
assert.equal(copiedTemplate.Data.Fields.footer, srcTemplate.Data.Fields.footer);
assert.equal(copiedTemplate.Data.Date, nextDay);
assert.ok(
  !snapshot.entries.some((x) => x.Data.Label === retiredPrice.Data.Label),
);
const copiedBar = snapshot.entries.find(
  (x) => x.Kind === "bar" && x.Data.Label === "Garten",
);
assert.notEqual(copiedBar.ID, srcBar.Target);
assert.equal(
  snapshot.entries.find((x) => x.Kind === "price").Data.Bar,
  copiedBar.ID,
);
const purse = snapshot.entries.find((x) => x.Kind === "wallet");
assert.equal(purse.Data.Fields?.owner, undefined);
assert.equal(
  snapshot.entries.find((x) => x.Kind === "price").Data.Status,
  "Entwurf",
);
assert.ok(
  !snapshot.entries.some((x) =>
    [
      "income",
      "expense",
      "presale",
      "handover",
      "actual",
      "period",
      "original",
    ].includes(x.Kind),
  ),
);
const initialExpense = rec(c, "expense", "Konkurrenz", { Amount: 5000 });
await send(c, initialExpense);
const other = await prepare("Weitere Person");
const high = rec(
  c,
  "expense",
  "Auf 70",
  { Amount: 7000, Note: "Belegprüfung West" },
  initialExpense.Target,
  1,
);
const low = rec(
  other,
  "expense",
  "Auf 60",
  { Amount: 6000, Note: "Belegprüfung Ost" },
  initialExpense.Target,
  1,
);
await send(c, high);
let compete = await send(other, low);
assert.equal(compete.conflicts.find((x) => x.ID === low.ID).Base, 1);
compete = await api("sync", auth(c), {
  Resolve: low.ID,
  Choice: "übernehmen",
  Reason: "Originalbetrag geprüft",
  Last: 2,
});
assert.equal(
  compete.entries.find((x) => x.ID === initialExpense.Target).Data.Amount,
  6000,
);
console.log(
  "PASS: approved prior snapshot, freely accessible copied wallets and draft prices, 50/70/60 financial conflict",
);
console.log(
  "PASS: general ledger, linked paper register and duplicate review, gross 280 / fee 5 / neutral payout 275",
);
console.log(
  "PASS: grouped reimbursements, excessive payment held for review, reversal, two-device handover, period seals, frozen backdating, reopening and controlled correction",
);
