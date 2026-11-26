import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { api, auth, admin, basic } from "./local-api.mjs";
const year = randomInt(3800, 9000),
  start = year + "-09-04",
  next = year + "-09-05";
const create = (Name, date) =>
  api("events", admin, { Name, Starts: date, Ends: date });
const first = await create("Vorperiode " + randomUUID(), start),
  second = await create("Folgeperiode " + randomUUID(), next);
const user = "p-" + randomUUID().slice(0, 10),
  pw = randomUUID(),
  review = basic(user, pw);
await api("users", admin, {
  Name: user,
  Password: pw,
  Role: "Read",
  Event: first.ID,
});
await api("access", admin, {
  Action: "grant",
  Name: user,
  Event: second.ID,
  Reason: "Fiktiver Periodenvergleich",
});
const prep = (e, who, Name) => api("prepare", who, { Name, Event: e.ID });
const a = await prep(first, admin, "Kassa Vorperiode"),
  b = await prep(second, admin, "Kassa Folgeperiode");
const r = await prep(first, review, "Prüfung Vorperiode"),
  t = await prep(second, review, "Prüfung Folgeperiode");
const send = (d, body, status) => api("sync", auth(d), body, status);
const close = (d, p, status = 200) =>
  api("manage", auth(d), { Action: "period-close", Target: p.Target }, status);
const reopen = (d, p, status = 200) =>
  api(
    "manage",
    auth(d),
    {
      Action: "period-open",
      Target: p.Target,
      Reason: "Begründete Nachprüfung",
    },
    status,
  );
const op = (Seq, Kind, Date, rest = {}, Target = randomUUID(), Base = 0) => ({
  ID: randomUUID(),
  Seq,
  Kind,
  Target,
  Base,
  Data: { Date, Label: "Übungsprüfung", ...rest },
});
const p = op(1, "period", start, { To: start }),
  income = op(3, "income", start, { Amount: 500 }),
  actual = op(4, "actual", start, { Amount: 500 });
await send(a, {
  Ops: [p, op(2, "opening", start, { Amount: 0 }), income, actual],
});
await send(a, { Action: "Ende", Last: 4 });
await send(r, { Action: "Ende", Last: 0 });
const source = await close(a, p);
const q = op(1, "period", next, { To: next }),
  carried = op(2, "opening", next, {
    Amount: 500,
    Fields: { previous: source },
  }),
  count = op(3, "actual", next, { Amount: 500 });
await send(b, { Ops: [q, carried, count] });
await send(b, { Action: "Ende", Last: 3 });
await send(t, { Action: "Ende", Last: 0 });
const initial = await close(b, q);
await reopen(a, p, 422);
await reopen(b, q);
await reopen(a, p);
const correction = await prep(first, admin, "Nachtrag Vorperiode");
await send(correction, {
  Ops: [income, actual].map((row, i) =>
    op(
      i + 1,
      row.Kind,
      start,
      { Amount: 700, Note: "Begründeter Nachtrag" },
      row.Target,
      1,
    ),
  ),
});
await send(correction, { Action: "Ende", Last: 2 });
const revised = await close(a, p);
assert.notEqual(revised, source);
await close(b, q, 422);
const follow = await prep(second, admin, "Nachtrag Folgeperiode");
const erase = op(
  1,
  "opening",
  next,
  { Amount: 700, Note: "Herkunft weglassen" },
  carried.Target,
  1,
);
assert.ok(
  (await send(follow, { Ops: [erase] })).conflicts.some(
    (x) => x.ID === erase.ID,
  ),
);
await send(b, {
  Resolve: erase.ID,
  Choice: "beibehalten",
  Reason: "Herkunft bleibt erforderlich",
});
await send(follow, {
  Ops: [
    op(
      2,
      "opening",
      next,
      {
        Amount: 700,
        Fields: { previous: revised },
        Note: "Neue Quellfassung geprüft",
      },
      carried.Target,
      1,
    ),
    op(
      3,
      "actual",
      next,
      { Amount: 700, Note: "Istnachweis geprüft" },
      count.Target,
      1,
    ),
  ],
});
await send(follow, { Action: "Ende", Last: 3 });
assert.notEqual(await close(b, q), initial);
console.log(
  "PASS abhängige Folgeperiode schützt Quellabschluss, korrigierter Übertrag verlangt neue Quellen-ID und unabhängigen Istnachweis",
);
