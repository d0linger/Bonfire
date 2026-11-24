import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { api, auth, admin, basic } from "./local-api.mjs";
const day = "2036-02-15",
  event = await api("events", admin, {
    Name: "Kontenwechsel " + randomUUID(),
    Starts: day,
    Ends: day,
  });
const reviewer = "p-" + randomUUID().slice(0, 10),
  pw = randomUUID();
await api("users", admin, {
  Name: reviewer,
  Role: "Read",
  Event: event.ID,
  Password: pw,
});
const prep = (Name, who = admin) =>
  api("prepare", who, { Name, Event: event.ID });
const a = await prep("Leitung"),
  b = await prep("Getrennt"),
  r = await prep("Prüfung", basic(reviewer, pw));
const send = (d, body, status) => api("sync", auth(d), body, status);
const mode = (Accounts) =>
  api("manage", auth(a), { Action: "accounts", Accounts });
const make = (Seq, Kind, Data, Target = randomUUID(), Base = 0) => ({
  ID: randomUUID(),
  Seq,
  Kind,
  Target,
  Base,
  Data: { Date: day, Label: "Kontenübung", ...Data },
});
const account = make(1, "account", {}),
  open = make(2, "opening", { Amount: 0 }),
  old = make(3, "income", { Amount: 100 }),
  actual = make(4, "actual", { Amount: 600 });
await send(a, { Ops: [account, open, old, actual] });
await mode(true);
const late = make(1, "income", { Amount: 500 });
late.LocalTime = "2099-07-15T11:21:09+02:00";
let out = await send(b, { Ops: [late] });
assert.ok(out.conflicts.some((c) => c.ID === late.ID));
assert.equal(out.entries.find((x) => x.ID === old.Target).Data.Account, "");
const resolve = {
  Resolve: late.ID,
  Choice: "übernehmen",
  Last: 0,
  Reason: "Reale Kontoquelle geprüft",
};
await send(
  a,
  { ...resolve, Account: "erfundene-nicht-registrierte-kennung" },
  422,
);
await send(a, { ...resolve, Account: account.Target });
await mode(false);
out = await send(b, {});
assert.equal(
  out.entries.find((x) => x.ID === late.Target).Data.Account,
  account.Target,
);
await mode(true);
await send(a, { Action: "Ende", Last: 4 });
await send(b, { Action: "Ende", Last: 1 });
await send(r, { Action: "Ende", Last: 0 });
await send(a, { Action: "Abschluss" }, 422);
const fix = await prep("Historische Zuordnung");
await send(fix, {
  Ops: [open, old, actual].map((o, i) =>
    make(
      i + 1,
      o.Kind,
      {
        ...o.Data,
        Account: account.Target,
        Note: "Historischen Kontoauszug geprüft",
      },
      o.Target,
      1,
    ),
  ),
});
await send(fix, { Action: "Ende", Last: 3 });
assert.equal((await send(a, { Action: "Abschluss" })).closed, true);
const audit = await api("manage", auth(a), { Action: "audit" });
assert.ok(audit.some((x) => x.action.includes("deaktiviert")));
const conflictAudit = audit.find(
  (x) => x.subject === late.ID && x.action === "Konflikt",
);
assert.equal(conflictAudit.device, b.device);
assert.equal(conflictAudit.source_device, b.device);
assert.equal(
  new Date(conflictAudit.local_time).toISOString(),
  "2099-07-15T09:21:09.000Z",
);
assert.notEqual(new Date(conflictAudit.at).getUTCFullYear(), 2099);
const decision = audit.find(
  (x) => x.subject === late.ID && x.action.startsWith("übernehmen:"),
);
assert.equal(decision.device, a.device);
const revisions = await api("manage", auth(r), {
  Action: "journal-period",
  Target: day,
  Reason: day,
});
assert.ok(revisions.every((x) => x.veranstaltung === event.Name));
const history = revisions.filter((x) => x.vorgang === old.Target);
assert.deepEqual(
  history.map((x) => [x.richtung, x.cent, x.revision]),
  [
    ["Buchung", 100, 1],
    ["Storno", -100, 1],
    ["Buchung", 100, 2],
  ],
);
console.log(
  "PASS Moduswechsel erhält historische Lücken, kontrollierte Kontozuordnung im Sync und vollständiger Einzelkontoabschluss",
);
