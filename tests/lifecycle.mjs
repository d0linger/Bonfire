import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { api, auth, admin } from "./local-api.mjs";
const day = "2035-07-01",
  name = "Fiktive Person " + randomUUID().slice(0, 8);
const event = await api("events", admin, {
  Name: "Archivtest " + name,
  Starts: day,
  Ends: day,
});
const prepare = (Name) => api("prepare", admin, { Event: event.ID, Name });
const a = await prepare("Stammdaten"),
  b = await prepare("Erfassung");
const id = randomUUID(),
  original = { Date: day, Label: name };
const make = (Seq, Base, Data, Kind = "contact", Target = id) => ({
  ID: randomUUID(),
  Seq,
  Base,
  Kind,
  Target,
  Data,
});
const send = (d, body, status) => api("sync", auth(d), body, status);
await send(a, { Ops: [make(1, 0, original)] });
const stale = make(1, 1, {
  ...original,
  Address: "Übungsstraße 1",
  Note: "Neue Adresse",
});
const retire = make(2, 1, {
  ...original,
  Retired: true,
  Fields: { lifecycle: "Archiviert", lifecycleReason: "Doppelanlage geprüft" },
});
await send(a, { Ops: [retire] });
let out = await send(b, { Ops: [stale] });
assert.equal(out.conflicts[0].ID, stale.ID);
assert.equal(out.entries.find((r) => r.ID === id).Data.Retired, true);
await send(
  a,
  {
    Resolve: stale.ID,
    Choice: "übernehmen",
    Last: 2,
    Reason: "Adresse aus zweitem Gerät",
  },
  422,
);
await send(a, {
  Resolve: stale.ID,
  Choice: "beibehalten",
  Reason: "Archivierung bleibt bestehen",
});
const late = make(
  2,
  0,
  { ...original, Amount: 500, Contact: id },
  "donation",
  randomUUID(),
);
out = await send(b, { Ops: [late] });
assert.ok(out.conflicts.some((c) => c.ID === late.ID));
const restore = make(3, 2, {
  ...original,
  Fields: {
    lifecycle: "Wiederhergestellt",
    lifecycleReason: "Person erneut aktiv",
  },
});
await send(a, { Ops: [restore] });
out = await send(a, {
  Resolve: late.ID,
  Choice: "übernehmen",
  Last: 0,
  Reason: "Kontakt wieder freigegeben",
});
assert.ok(out.entries.some((r) => r.ID === late.Target));
await send(
  b,
  {
    Ops: [
      make(
        3,
        1,
        { ...late.Data, Retired: true, Note: "Entfernen" },
        "donation",
        late.Target,
      ),
    ],
  },
  422,
);
assert.equal(out.entries.find((r) => r.ID === id).Revision, 3);
console.log(
  "PASS Archivierung gegen veraltete Bearbeitung, blockierter Neubezug, explizite Wiederherstellung und unveränderte Finanzhistorie",
);
