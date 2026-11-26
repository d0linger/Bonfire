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
out = await send(b, {});
assert.equal(out.entries.find((r) => r.ID === id).Revision, 3);
const left = await prepare("Kontakt Ost"),
  right = await prepare("Kontakt West");
const sameName = "Namenstest " + randomUUID().slice(0, 10);
const ids = [randomUUID(), randomUUID()];
const proposals = [left, right].map((device, i) =>
  make(
    1,
    0,
    {
      Date: day,
      Label: sameName,
      Address: i === 0 ? "Übungsort Ost 12" : "Übungsort West 34",
    },
    "contact",
    ids[i],
  ),
);
const results = await Promise.all(
  [left, right].map((d, i) => send(d, { Ops: [proposals[i]] })),
);
const index = results.findIndex((r, i) =>
  r.conflicts.some((c) => c.ID === proposals[i].ID),
);
assert.ok(index >= 0);
const winner = 1 - index;
assert.ok(results[winner].entries.some((r) => r.ID === ids[winner]));
const accepted = await send(a, {
  Resolve: proposals[index].ID,
  Choice: "übernehmen",
  Last: 0,
  Reason: "Zweite Person mit eigener Anschrift",
});
for (let i = 0; i < 2; i++) {
  const entry = accepted.entries.find((r) => r.ID === ids[i]);
  assert.equal(entry.Data.Address, proposals[i].Data.Address);
  assert.equal(entry.Revision, 1);
}
assert.equal(
  accepted.entries.find((r) => r.ID === ids[index]).Data.Fields.distinct,
  "Zweite Person mit eigener Anschrift",
);
const multi = await send(left, {
  Ops: [
    make(
      2,
      0,
      { Date: day, Label: "Übungsbanner", Amount: 500, Contact: ids[winner] },
      "sponsorship",
      randomUUID(),
    ),
    make(
      3,
      0,
      { Date: day, Label: "Übungsspende", Amount: 200, Contact: ids[winner] },
      "donation",
      randomUUID(),
    ),
  ],
});
assert.deepEqual(
  multi.entries
    .filter((x) => x.Data.Contact === ids[winner])
    .map((x) => x.Kind)
    .sort(),
  ["donation", "sponsorship"],
);
console.log(
  "PASS unabhängige Neuanlagen mit gleichem Namen, getrennte Anschriften und Doppelfunktion Sponsor/Spender",
);
console.log(
  "PASS Archivierung gegen veraltete Bearbeitung, blockierter Neubezug, explizite Wiederherstellung und unveränderte Finanzhistorie",
);
