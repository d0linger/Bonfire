import { readFile } from "node:fs/promises";
import { randomUUID, randomInt } from "node:crypto";
import assert from "node:assert/strict";
const pass =
  process.env.BONFIRE_ADMIN_PASSWORD ||
  (await readFile(".env", "utf8"))
    .match(/^BONFIRE_ADMIN_PASSWORD=(.+)$/m)[1]
    .trim();
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
  Role: "Prüfung",
  Password: pw,
  Event: event.ID,
});
const prepare = (name, who = admin) =>
  api("prepare", who, { Name: name, Event: event.ID });
const a = await prepare("West"),
  b = await prepare("Ost"),
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
const offer = rec(
  a,
  "handover",
  "Geldtasche Rot",
  { Wallet: wallet.Target, To: b.device, Status: "Angeboten" },
  "handover:" + wallet.Target,
);
await send(a, offer);
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
  out.entries.find((r) => r.ID === wallet.Target).Data.Fields.owner,
  b.device,
);
const act = rec(a, "actual", "Unabhängiger Istbestand", { Amount: 4000 });
await send(a, act);
await api("manage", auth(r), { Action: "period-close", Target: p.Target }, 422);
for (const d of [a, b, r])
  await api("sync", auth(d), { Action: "Ende", Last: seq.get(d.device) || 0 });
const closed = await api("manage", auth(r), {
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
await send(c, srcBar, srcPrice);
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
const purse = snapshot.entries.find((x) => x.Kind === "wallet");
assert.equal(purse.Data.Fields.owner, fresh.device);
assert.equal(
  snapshot.entries.find((x) => x.Kind === "price").Data.Status,
  "Entwurf",
);
assert.ok(
  !snapshot.entries.some((x) =>
    ["income", "expense", "handover", "actual", "period", "original"].includes(
      x.Kind,
    ),
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
  "PASS: approved prior snapshot, structure-only copy with new authority and draft prices, 50/70/60 financial conflict",
);
console.log(
  "PASS: general ledger, linked paper register and duplicate review, gross 280 / fee 5 / neutral payout 275",
);
console.log(
  "PASS: grouped reimbursements, excessive payment held for review, reversal, two-device handover, period seals, frozen backdating, reopening and controlled correction",
);
