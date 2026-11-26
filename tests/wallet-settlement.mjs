import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { api, admin, basic, onlineClient, practiceEvent } from "./local-api.mjs";
const day = "2703-08-03";
const cashier = await onlineClient();
const event = await practiceEvent(cashier, "Wallet settlement exercise", day);
const reviewer = "p-" + randomUUID().slice(0, 12),
  pw = randomUUID();
await api("users", admin, {
  Name: reviewer,
  Password: pw,
  Role: "Read",
  Event: event.ID,
});
const reader = await onlineClient(basic(reviewer, pw));
const route = "online?event=" + event.ID;
const send = (body, status) => cashier(route, body, status);
let seq = 0;
const rec = (Kind, Data, Target = randomUUID(), Base = 0) => ({
  ID: randomUUID(),
  Seq: ++seq,
  Target,
  Base,
  Kind,
  Data: { Date: day, Label: "Übung " + Kind, ...Data },
});
const wallet = rec("wallet", {}),
  Wallet = wallet.Target;
const count = (Phase, n) =>
  rec(
    "count",
    { Wallet, Phase, Amount: n, Pieces: { 1000: n / 1000 } },
    "count:" +
      createHash("sha256")
        .update(Wallet + "|" + Phase)
        .digest("hex")
        .slice(0, 32),
  );
const settlement = (Amount, base = 0) =>
  rec(
    "income",
    {
      Wallet,
      Method: "Bar",
      Amount,
      Reference: "wallet-settlement",
      Note: "Zähldifferenz geklärt",
    },
    "settlement:" + Wallet,
    base,
  );
const first = [
  wallet,
  rec("opening", { Amount: 10000 }),
  count("Anfang", 10000),
  rec("deposit", { Wallet, Amount: 9000, Method: "Bar" }),
  rec("deposit-return", { Wallet, Amount: 4000, Method: "Bar" }),
  rec("refund", { Wallet, Amount: 2000, Method: "Bar" }),
  rec("donation", { Wallet, Amount: 3000, Method: "Karte" }),
  count("Ende", 26000),
  settlement(13000),
];
await send({ Ops: first });
const separate = rec("donation", { Wallet, Amount: 1000, Method: "Bar" });
await send({ Ops: [separate] });
// A donation recorded after the count does not change the previously settled cash.
await send({ Ops: [settlement(12000, 1)] }, 409);
await send({ Ops: [rec("actual", { Amount: 30000 })] });
await reader(route, { Action: "Abschluss" }, 403);
assert.equal((await send({ Action: "Abschluss" })).closed, true);
const booked = (await reader(route, {})).entries.filter((r) => r.ID === "settlement:" + Wallet);
assert.equal(booked.length, 1);
assert.equal(booked[0].Data.Amount, 13000);
console.log("PASS wallet opening and closing denominations, deposits, refunds, card donation, settlement cutoff and read-only access");

// Bulk records always use this event's local wallet IDs, independent of the reusable catalogue.
const bulkEvent = await cashier("events", { Year: event.Year, Name: "Bulk entry exercise", Starts: day, Ends: day });
const eventRoute = "online?event=" + bulkEvent.ID;
const localWallets = ["Entrance", "Food", "Reserve"].map(Label => rec("wallet", { Label }));
const [entrance, food, reserve] = localWallets.map(row => row.Target);
await cashier(eventRoute, { Ops: localWallets });
const recordBatch = (body, status = 200, client = cashier) => client("events/wallet-batch", body, status);
const entries = async () => new Map((await cashier(eventRoute, {})).entries.map(row => [row.ID, row]));
const request = (Mode, values) => ({
  Event: bulkEvent.ID, Request: randomUUID(), Mode, Date: day, Wallets: [entrance, food], ...values,
});
const untilOpening = await entries();
const opening = request("opening", { Pieces: { 1000: 2, 50: 3 } });
const readerName = "bulk-reader-" + randomUUID().slice(0, 8);
const readerPassword = randomUUID();
await api("users", admin, { Name: readerName, Password: readerPassword, Role: "Read", Event: bulkEvent.ID });
await recordBatch(opening, 403, await onlineClient(basic(readerName, readerPassword)));
const scopedName = "bulk-writer-" + randomUUID().slice(0, 8);
const writerPassword = randomUUID();
await api("users", admin, { Name: scopedName, Password: writerPassword, Role: "Write", Event: event.ID });
await recordBatch(opening, 403, await onlineClient(basic(scopedName, writerPassword)));
const secondCashier = "bulk-cashier-" + randomUUID().slice(0, 8);
const secondPassword = randomUUID();
await api("users", admin, { Name: secondCashier, Password: secondPassword, Role: "Write", Event: bulkEvent.ID });
const secondSession = await onlineClient(basic(secondCashier, secondPassword));
const ledger = (await cashier("events?year=" + event.Year)).find(item => item.General);
await recordBatch({ ...opening, Event: ledger.ID }, 409);
await recordBatch({ ...opening, Event: event.ID }, 409);
for (const invalid of [
  { ...opening, Amount: 2150 },
  { ...opening, Wallets: [entrance, entrance] },
  { ...opening, Wallets: [entrance, Wallet] }, // Wallet belongs to a different event.
  request("topup", { Amount: 0, Source: "main-cashbox" }),
  request("topup", { Amount: 100, Source: entrance }),
  request("topup", { Amount: 100, Source: randomUUID() }),
  request("opening", { Pieces: { 17: 1 } }),
]) await recordBatch(invalid, 422);
assert.deepEqual(await entries(), untilOpening, "invalid and forbidden batches must not post any entries");

const results = await Promise.all([recordBatch(opening), recordBatch(opening)]);
for (const result of results) {
  assert.equal(result.count, 2);
  assert.equal(result.perWalletCents, 2150);
  assert.equal(result.totalCents, 4300);
}
const afterOpening = await entries();
const counts = [...afterOpening.values()].filter(row => !untilOpening.has(row.ID));
assert.deepEqual(counts.map(row => row.Data.Wallet).sort(), [entrance, food].sort());
for (const row of counts) {
  assert.equal(row.Kind, "count");
  assert.equal(row.Data.Phase, "Anfang");
  assert.equal(row.Data.Amount, 2150);
  assert.deepEqual(row.Data.Pieces, { 1000: 2, 50: 3 });
}
await recordBatch({ ...opening, Pieces: { 1000: 3 } }, 409);
await recordBatch(request("opening", { Wallets: [reserve, food], Amount: 700 }), 409);
assert.deepEqual(await entries(), afterOpening, "a conflicting existing count must also roll back the new reserve count");

const topUp = request("topup", { Amount: 325, Source: reserve });
const transfer = await recordBatch(topUp, 200, secondSession);
assert.equal(transfer.totalCents, 650);
const afterSupply = await entries();
const supplies = [...afterSupply.values()].filter(row => !afterOpening.has(row.ID));
assert.deepEqual(supplies.map(row => row.Data.To).sort(), [entrance, food].sort());
for (const row of supplies) {
  assert.equal(row.Kind, "supply");
  assert.equal(row.Data.Amount, 325);
  assert.equal(row.Data.Account, reserve);
  assert.equal(row.Data.Wallet, row.Data.To);
}
assert.deepEqual(await recordBatch(topUp, 200, secondSession), transfer);
await recordBatch(topUp, 409); // An unrelated session cannot claim the original cashier's receipt.
assert.deepEqual(await entries(), afterSupply, "resubmitting a completed top-up must not deliver change twice");
const overview = (await cashier("events?year=" + event.Year + "&overview=1")).find(item => item.ID === bulkEvent.ID);
assert.equal(overview.ReceiptsCents, 0);
assert.equal(overview.PaidCents, 0);

// Each wallet closes with 500 cents of receipts above its counted opening and delivered change.
const ends = [entrance, food].map(walletID => rec("count", {
  Wallet: walletID, Phase: "Ende", Amount: 2975, Fields: { countMode: "amount", countScope: "wallet" },
}, "count:" + createHash("sha256").update(walletID + "|Ende").digest("hex").slice(0, 32)));
await cashier(eventRoute, { Ops: ends });
const report = (walletID, amount) => rec("income", {
  Wallet: walletID, Method: "Bar", Amount: amount, Reference: "wallet-settlement",
}, "settlement:" + walletID);
await cashier(eventRoute, { Ops: [report(entrance, 825)] }, 409);
await cashier(eventRoute, { Ops: [report(entrance, 500), report(food, 500)] });
const settled = (await cashier("events?year=" + event.Year + "&overview=1")).find(item => item.ID === bulkEvent.ID);
assert.equal(settled.ReceiptsCents, 1000, "opening cash and top-ups must be excluded from settlement revenue");

const pooledEvent = await cashier("events", { Year: event.Year, Name: "Pooled opening", Starts: day, Ends: day });
const pooledRoute = "online?event=" + pooledEvent.ID;
const pooledWallet = rec("wallet", { Label: "Pooled fixture" });
const pooled = rec("count", {
  Phase: "Anfang", Amount: 1000, Fields: { countMode: "amount", countScope: "all" },
}, "count:" + createHash("sha256").update("|Anfang").digest("hex").slice(0, 32));
await cashier(pooledRoute, { Ops: [pooledWallet, pooled] });
await recordBatch(request("opening", { Event: pooledEvent.ID, Wallets: [pooledWallet.Target], Amount: 1000 }), 409);
const pooledCounts = (await cashier(pooledRoute, {})).entries.filter(row => row.Kind === "count");
assert.deepEqual(pooledCounts.map(row => row.ID), [pooled.Target]);
console.log("PASS event-only bulk wallet counts and transfers, identical concurrent retries, atomic validation and pooled-count conflicts");
