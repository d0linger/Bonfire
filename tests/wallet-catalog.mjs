import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { admin, api, basic, onlineClient } from "./local-api.mjs";

const manager = await onlineClient();
const day = "2814-07-01";
const suffix = randomUUID().slice(0, 8);
const year = await manager("years", { Name: "Wallet catalogue " + suffix, Starts: day, Ends: "2814-07-31" });
const newEvent = (name, starts, ends) =>
  manager("events", { Year: year.ID, Name: name, Starts: starts, Ends: ends });
const first = await newEvent("First event", day, "2814-07-03");
const overlapping = await newEvent("Overlapping event", "2814-07-03", "2814-07-04");
const later = await newEvent("Later event", "2814-07-06", "2814-07-06");
const ledger = (await manager("events?year=" + year.ID)).find(event => event.General);
const catalogue = "wallet-catalog";
const list = async (client, event) =>
  (await client(catalogue + (event ? "?event=" + event.ID : ""))).wallets;
const find = async (id, client = manager, event) =>
  (await list(client, event)).find(wallet => wallet.ID === id);
async function user(role) {
  const name = role.toLowerCase() + "-" + suffix;
  const password = randomUUID();
  await api("users", admin, { Name: name, Password: password, Role: role, Event: first.ID });
  return onlineClient(basic(name, password));
}
const reader = await user("Read");
const writer = await user("Write");
const create = (client, name, options = {}) =>
  client(catalogue, { Action: "create", Name: name + " " + suffix, ...options });
const assign = (client, event, ids, options = {}, status = 200) =>
  client(catalogue, { Action: "assign", Event: event.ID, IDs: ids, ...options }, status);
const state = (client, event) => client("online?event=" + event.ID, {});
const entry = (Kind, date, fields, Target = randomUUID()) => ({
  ID: randomUUID(), Target, Kind, Data: { Date: date, Label: Kind + " fixture", ...fields },
});
const post = (client, event, ops) => client("online?event=" + event.ID, { Ops: ops });
const walletEntries = entries => entries.filter(row => row.Kind === "wallet");
const revision = async id => (await find(id)).Revision;

await reader(catalogue, { Action: "create", Name: "Forbidden" }, 403);
const suggested = await create(writer, "Main wallet", {
  Note: "Opening float is a suggestion", FloatCents: 2500, Pieces: { 500: 5 }, DefaultBar: "Front counter",
});
const spare = await create(manager, "Spare wallet");
const late = await create(manager, "Late addition");
const counted = await create(manager, "Counted suggestion", { Pieces: { 10: 2, 1000: 3 } });
assert.equal((await find(counted.ID)).FloatCents, 3020);
await manager(catalogue, { Action: "create", Name: "Mismatch " + suffix, FloatCents: 100, Pieces: { 10: 2 } }, 422);
await manager(catalogue, { Action: "create", Name: "Invalid denomination " + suffix, Pieces: { 17: 1 } }, 422);
const id = suggested.ID;
assert.equal((await find(id, reader)).FloatCents, 2500);
await reader(catalogue, { Action: "retire", ID: id, Revision: await revision(id) }, 403);
await reader(catalogue, { Action: "edit", ID: id, Revision: await revision(id), Name: "Forbidden" }, 403);
await assign(reader, first, [id], {}, 403);
await writer(catalogue + "?event=" + overlapping.ID, undefined, 403);
await assign(writer, overlapping, [id], {}, 403);

const bar = entry("bar", day, { Label: "FRONT COUNTER" });
await post(manager, first, [bar]);
await assign(manager, ledger, [id], {}, 409);
await assign(manager, first, [id, id], {}, 422);
assert.equal(walletEntries((await state(manager, first)).entries).length, 0);
const initial = await assign(writer, first, [id, spare.ID]);
assert.equal(initial.assigned.length, 2);
assert.equal(new Set(initial.assigned).size, 2);
assert.deepEqual(initial.existing, []);
const repeat = await assign(manager, first, [spare.ID, id]);
assert.deepEqual(repeat.assigned, []);
assert.deepEqual([...repeat.existing].sort(), [...initial.assigned].sort());
const firstState = await state(manager, first);
assert.equal(firstState.entries.length, 3, "assignment creates only the wallet records alongside the existing bar");
const local = walletEntries(firstState.entries).find(row => row.Data.Label === "Main wallet " + suffix);
assert.ok(local);
assert.equal(local.Data.Bar, bar.Target);
assert.equal(local.Data.Fields.suggestedBar, "Front counter");
assert.equal(local.Data.Fields.suggestedFloatCents, "2500");
assert.deepEqual(JSON.parse(local.Data.Fields.suggestedPieces), { 500: 5 });
assert.equal((await find(id, reader, first)).Used, true);
assert.equal((await find(id, manager, overlapping)).Used, false);
const totals = (await manager("events?year=" + year.ID + "&overview=1")).find(event => event.ID === first.ID);
assert.equal(totals.ReceiptsCents, 0);
assert.equal(totals.PaidCents, 0);

const concurrent = await Promise.all([
  assign(manager, first, [late.ID]),
  assign(writer, first, [late.ID]),
]);
const added = concurrent.flatMap(result => result.assigned);
assert.equal(added.length, 1);
assert.deepEqual(concurrent.flatMap(result => result.existing), added);
assert.equal(walletEntries((await state(reader, first)).entries).length, 3);

const overlap = await assign(manager, overlapping, [id, spare.ID]);
assert.deepEqual(overlap.assigned, []);
assert.deepEqual(overlap.overlaps.map(wallet => wallet.ID).sort(), [id, spare.ID].sort());
assert.equal(walletEntries((await state(manager, overlapping)).entries).length, 0);
const confirmed = await assign(manager, overlapping, [id], { ConfirmOverlap: true });
assert.equal(confirmed.assigned.length, 1);
const otherLocal = walletEntries((await state(manager, overlapping)).entries)[0];
assert.equal(otherLocal.ID, confirmed.assigned[0]);
assert.notEqual(local.ID, otherLocal.ID);
assert.ok(!otherLocal.Data.Bar, "a missing default bar must not create a bar in another event");
assert.equal((await assign(manager, later, [id])).assigned.length, 1);

// Both cashiers can use the same event wallet. Events have independent counts and transfers.
function count(walletID, date, amount) {
  const target = "count:" + createHash("sha256").update(walletID + "|Anfang").digest("hex").slice(0, 32);
  return entry("count", date, {
    Wallet: walletID, Phase: "Anfang", Amount: amount, Fields: { countMode: "amount", countScope: "wallet" },
  }, target);
}
await post(writer, first, [count(local.ID, day, 1000)]);
await post(manager, first, [entry("supply", day, { Wallet: local.ID, Account: "Cashbox", To: local.ID, Amount: 400 })]);
await post(manager, overlapping, [count(otherLocal.ID, overlapping.Starts, 700)]);
const one = (await state(reader, first)).entries;
const two = (await state(manager, overlapping)).entries;
assert.deepEqual(one.filter(row => row.Kind === "count").map(row => row.Data.Amount), [1000]);
assert.deepEqual(two.filter(row => row.Kind === "count").map(row => row.Data.Amount), [700]);
assert.equal(one.filter(row => row.Kind === "supply" && row.Data.Wallet === local.ID).length, 1);
assert.equal(two.filter(row => row.Kind === "supply").length, 0);
const audit = (await manager("admin/audit?event=" + first.ID)).rows;
assert.ok(audit.some(row => row.Kind === "count" && row.User === "write-" + suffix));
assert.ok(audit.some(row => row.Kind === "supply" && row.User === "leitung"));

const original = await find(id);
const change = { Action: "edit", ID: id, Revision: original.Revision, Name: "Renamed " + suffix, FloatCents: 3000 };
await manager(catalogue, change);
await writer(catalogue, { ...change, Name: "Stale name" }, 409);
assert.equal((await find(id)).Name, change.Name);
assert.equal(walletEntries((await state(manager, first)).entries).find(row => row.ID === local.ID).Data.Label, original.Name);
await manager(catalogue, { Action: "retire", ID: id, Revision: await revision(id) });
assert.equal((await find(id)).Active, false);
assert.equal(walletEntries((await state(manager, first)).entries).find(row => row.ID === local.ID).Data.Fields.suggestedFloatCents, "2500");

const unused = await newEvent("Unassigned event", "2814-07-15", "2814-07-15");
await assign(manager, unused, [spare.ID, id], {}, 409);
assert.equal(walletEntries((await state(manager, unused)).entries).length, 0, "a retired item aborts the entire batch");
await manager(catalogue, { Action: "edit", ID: id, Revision: await revision(id), Name: change.Name, Active: true, FloatCents: 3000 });
assert.equal((await assign(manager, unused, [id])).assigned.length, 1);
assert.equal(walletEntries((await state(manager, unused)).entries)[0].Data.Fields.suggestedFloatCents, "3000");
const closed = await manager("years", { Name: "Closed catalogue year", Starts: "2815-01-01", Ends: "2815-01-01" });
const closedEvent = await manager("events", { Year: closed.ID, Name: "Closed event", Starts: closed.Starts, Ends: closed.Ends });
const closedLedger = (await manager("events?year=" + closed.ID)).find(event => event.General);
for (const event of [closedEvent, closedLedger]) {
  await post(manager, event, [entry("opening", closed.Starts, { Amount: 0 }), entry("actual", closed.Starts, { Amount: 0 })]);
}
await manager("online?event=" + closedEvent.ID, { Action: "Abschluss" });
await assign(manager, closedEvent, [spare.ID], {}, 409);
await manager("online?event=" + closedLedger.ID, { Action: "Geschäftsjahr abschließen" });
await assign(manager, closedEvent, [spare.ID], {}, 409);
assert.equal(walletEntries((await state(manager, closedEvent)).entries).length, 0);
console.log("PASS central wallet catalogue permissions, assignment, overlap, duplicate requests, per-event histories and closed workspaces");
