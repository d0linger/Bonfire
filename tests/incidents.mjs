import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { api, admin, auth, basic } from "./local-api.mjs";
const year = randomInt(4000, 9000),
  day = year + "-03-17";
const event = await api("events", admin, {
  Name: "Allgemeines Übungskassenbuch " + randomUUID().slice(0, 8),
  General: false,
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
const a = await prepare("West"),
  b = await prepare("Ost"),
  r = await prepare("Prüfteam", basic(reviewer, pw));
const post = (d, body, status) => api("sync", auth(d), body, status);
const decide = (d, Action, status) =>
  api(
    "manage",
    auth(d),
    {
      Action,
      Target: b.device,
      Reason: "Erfundene Übung zur Geräteklärung",
    },
    status,
  );
const op = (Seq, Kind, Amount) => ({
  ID: randomUUID(),
  Target: randomUUID(),
  Seq,
  Kind,
  Base: 0,
  Data: { Label: "Übungsbuchung", Date: day, Amount },
});
await post(a, { Ops: [op(1, "opening", 0), op(2, "actual", 5000)] });
const income = op(1, "income", 5000);
await decide(a, "incident");
await post(b, { Ops: [income] }, 403);
const proof = { Device: b.device, Proof: b.token, Next: randomUUID() };
await api("renew", admin, proof, 403);
await decide(r, "incomplete", 403);
await decide(a, "incomplete");
let out = await post(r, {});
const info = out.devices.find((d) => d.ID === b.device);
assert.equal(info.IncidentState, "incomplete");
assert.equal(info.Sealed, false);
assert.match(info.IncidentNote, /Ausnahmeentscheid/);
await post(a, { Action: "Abschluss" }, 422);
await decide(a, "return");
await post(b, {}, 403);
await api("renew", admin, proof);
await api("renew", admin, proof); // A lost response can be retried.
await post(b, {}, 403);
const recovered = { ...b, token: proof.Next };
const retries = await Promise.all([
  post(recovered, { Ops: [income] }),
  post(recovered, { Ops: [income] }),
]);
for (const snapshot of retries) {
  assert.equal(snapshot.conflicts.filter((c) => c.ID === income.ID).length, 1);
  assert.ok(!snapshot.entries.some((row) => row.ID === income.Target));
}
const resolve = {
  Resolve: income.ID,
  Choice: "übernehmen",
  Reason: "Abgleich mit dem gezählten Barbestand",
  Last: 0,
};
await post(recovered, resolve, 403);
await post(recovered, { Action: "Ende", Last: 1 }, 422);
await post(a, resolve);
out = await post(recovered, { Ops: [income] });
assert.equal(out.entries.filter((row) => row.ID === income.Target).length, 1);
const print = {
  ID: randomUUID(),
  Subject: randomUUID(),
  At: new Date().toISOString(),
};
assert.deepEqual(
  (await post(recovered, { Prints: [print] })).acknowledgedPrints,
  [],
);
await post(recovered, { Action: "Ende", Last: 1, Prints: [print] }, 422);
out = await post(recovered, { Action: "Ende", Last: 1 });
assert.equal(out.sealed, true);
assert.equal(out.incidentState, "");
await post(a, { Action: "Ende", Last: 2 });
await post(r, { Action: "Ende", Last: 0 });
assert.equal((await post(a, { Action: "Abschluss" })).closed, true);
const audit = await api("manage", auth(r), { Action: "audit" });
for (const prefix of [
  "Gerät vermisst",
  "Ausnahmeentscheid",
  "Gerät zurück",
  "Rückkehr abgeglichen",
  "Veranstaltungsabschluss",
])
  assert.ok(
    audit.some((x) => x.action.startsWith(prefix)),
    prefix,
  );
console.log(
  "PASS Geräteverlust, Ausnahme, Tokenwechsel, parallele Rückkehr, Einzelklärung und bestätigter Abschluss",
);
