import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { api, auth, admin, basic } from "./local-api.mjs";
import { pricesAt } from "../web/price-history.js";
const day = "2034-09-01";
const event = await api("events", admin, {
  Name: "Fiktive Preistafel " + randomUUID().slice(0, 8),
  Starts: day,
  Ends: day,
});
const person = "k-" + randomUUID().slice(0, 10),
  pw = randomUUID();
await api("users", admin, {
  Name: person,
  Password: pw,
  Role: "Kassa",
  Event: event.ID,
});
const lead = await api("prepare", admin, {
  Event: event.ID,
  Name: "Preisfreigabe",
});
const desk = await api("prepare", basic(person, pw), {
  Event: event.ID,
  Name: "Kassenprofil",
});
const item = randomUUID();
const base = {
  Label: "Übungsportion",
  Date: day,
  Amount: 250,
  Status: "Freigegeben",
  Category: "Essen",
  Variant: "Klein",
  Unit: "2 cl / 0,02 cl",
  Fields: {
    unitA: "2 cl",
    unitB: "0,02 cl",
    guest: "Kostprobe",
    allergens: "Übungsangabe",
  },
};
const rec = (Seq, Base, data) => ({
  ID: randomUUID(),
  Seq,
  Base,
  Target: item,
  Kind: "price",
  Data: data,
});
const send = (d, o, status) => api("sync", auth(d), { Ops: [o] }, status);
await send(lead, rec(1, 0, base), 422);
const resolved = {
  ...base,
  Unit: "2 cl",
  Fields: { ...base.Fields, unitReason: "Erfundene Portionsvorgabe geprüft" },
};
await send(desk, rec(1, 0, resolved), 403);
const start = await send(lead, rec(1, 0, resolved));
const version = start.priceHistory.at(-1).Version;
await send(
  desk,
  rec(1, 1, { ...resolved, Status: "Entwurf", Note: "Fremdänderung" }),
  403,
);
const next = await send(
  lead,
  rec(2, 1, { ...resolved, Amount: 320, Note: "Neuer Preisstand" }),
);
const old = pricesAt(next.entries, next.priceHistory, version).find(
  (x) => x.ID === item,
);
assert.deepEqual(old.Data.Fields, resolved.Fields);
assert.equal(old.Data.Amount, 250);
assert.equal(old.Data.Variant, "Klein");
assert.equal(old.Data.Unit, "2 cl");
const current = pricesAt(
  next.entries,
  next.priceHistory,
  next.priceHistory.at(-1).Version,
).find((x) => x.ID === item);
assert.equal(current.Data.Amount, 320);
assert.throws(() => pricesAt(next.entries, next.priceHistory, -1));
console.log(
  "PASS Preisfreigabe, strittige Maßangaben, Rollen und Wiederwahl des historischen Preisstands",
);
