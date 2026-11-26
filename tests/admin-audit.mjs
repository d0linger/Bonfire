import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { admin, basic } from "./local-api.mjs";
const url = new URL(process.env.BONFIRE_URL);
if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.port === "8137")
  throw Error("Isolierter Teststack erforderlich.");
async function login(auth) {
  const r = await fetch(new URL("/api/login", url), {
    method: "POST",
    headers: { Authorization: auth },
  });
  assert.equal(r.status, 200);
  return r.headers.getSetCookie()[0].split(";")[0];
}
async function api(path, cookie, body, status = 200) {
  const res = await fetch(new URL("/api/" + path, url), {
    method: body === undefined ? "GET" : "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const txt = await res.text();
  assert.equal(res.status, status, txt.slice(0, 100));
  return status === 200 ? JSON.parse(txt) : null;
}
const manager = await login(admin);
await api("admin/audit", "", undefined, 401);
const day = "2225-12-01",
  suffix = randomUUID().slice(0, 8);
let year = (await api("years", manager)).find(
  (y) => y.Starts === day && y.Ends === day,
);
year ??= await api("years", manager, {
  Name: "Auditjahr",
  Starts: day,
  Ends: day,
});
const create = (Name) =>
  api("events", manager, { Name, Year: year.ID, Starts: day, Ends: day });
const e = await create("Auditprobe " + suffix),
  other = await create("Zweiter Prüfbereich " + suffix);
const operation = {
  ID: randomUUID(),
  Target: randomUUID(),
  Kind: "income",
  Data: { Date: day, Label: "Eintritt", Amount: 4000 },
};
const send = (op) => api("online?event=" + e.ID, manager, { Ops: [op] });
await send(operation);
const correction = {
  ...operation,
  ID: randomUUID(),
  Base: 1,
  Data: { ...operation.Data, Amount: 5000, Note: "Zählbeleg abgeglichen." },
};
await send(correction);
const filtered = await api(
  "admin/audit?event=" + e.ID + "&q=" + operation.Target,
  manager,
);
const diff = filtered.rows.find((r) => r.Action === "Geldbewegung berichtigt");
const accepted = await api(
  "admin/audit?event=" + e.ID + "&outcome=Übernommen",
  manager,
);
assert.ok(
  accepted.rows.length &&
    accepted.rows.every((row) => row.Outcome === "Übernommen"),
);
assert.equal(
  (await api("admin/audit?event=" + e.ID + "&outcome=Konflikt", manager)).rows
    .length,
  0,
);
assert.equal(diff.PreviousCents, 4000);
assert.equal(diff.Cents, 5000);
assert.equal(diff.Base, 1);
assert.equal(diff.Revision, 2);
assert.equal(diff.Reason, correction.Data.Note);
assert.equal(diff.Source, "Online-Arbeitsplatz");
const exported = await api(
  "admin/audit/export?event=" + e.ID + "&action=berichtigt",
  manager,
  {},
);
assert.ok(exported.csv.includes("Zählbeleg abgeglichen."));
assert.ok(exported.csv.includes("4000;5000"));
const sensitive = "Passwort: fiktives-Testgeheimnis";
await send({
  ...correction,
  ID: randomUUID(),
  Base: 2,
  Data: { ...correction.Data, Amount: 5100, Note: sensitive },
});
const safe = await api("admin/audit/export?event=" + e.ID, manager, {});
assert.ok(!safe.csv.includes(sensitive));
assert.ok(safe.csv.includes("Sensible Angabe ausgeblendet"));
// Historical conflict decisions are retained when an installation switches to online mode.
const donation = { ...operation, Kind: "donation", ID: randomUUID(), Target: randomUUID() };
await send(donation);
const project = process.env.COMPOSE_PROJECT_NAME;
assert.match(project, /^bonfire-online-[a-f0-9]{32}$/);
const legacyReason = "Synthetic private donor detail";
execFileSync("docker", ["compose", "-p", project, "exec", "-T", "db", "psql", "-X", "-v", "ON_ERROR_STOP=1",
  "-U", "bonfire", "-d", "bonfire", "-v", "event=" + e.ID, "-v", "operation=" + donation.ID, "-v", "reason=" + legacyReason],
  { input: "INSERT INTO audit(event,username,action,subject) SELECT :'event'::uuid,'leitung',decision || ': ' || :'reason',:'operation' FROM unnest(ARRAY['beibehalten','übernehmen']) AS decision;" });
const otherExport = await api("admin/audit/export?event=" + other.ID, manager, {});
assert.ok(otherExport.csv.includes(other.Name));
for (const Role of ["Read", "Write"]) {
  const Name = "audit-" + Role.toLowerCase() + suffix,
    Password = randomUUID();
  await api("users", manager, { Name, Password, Role, Event: e.ID });
  const cookie = await login(basic(Name, Password));
  await api("admin/status", cookie, undefined, 403);
  await api("admin/audit/integrity", cookie, undefined, 403);
  const allowedExport = await api("admin/audit/export?event=" + e.ID, cookie, {});
  assert.ok(allowedExport.csv.includes(e.Name));
  assert.ok(!allowedExport.csv.includes(legacyReason));
  const decisions = (await api("admin/audit?event=" + e.ID, cookie)).rows.filter(r => ["beibehalten","übernehmen"].includes(r.Action));
  assert.equal(decisions.length, 2);
  assert.ok(decisions.every(r => r.Kind === "donation" && r.Reason === "Sensible Angabe ausgeblendet."));
  const scoped = await api("admin/audit", cookie);
  assert.ok(scoped.rows.length);
  assert.ok(scoped.rows.every((row) => row.Event === e.Name));
  assert.equal(
    (await api("admin/audit?event=" + other.ID, cookie)).rows.length,
    0,
  );
  assert.ok(
    !(
      await api("admin/audit/export?event=" + other.ID, cookie, {})
    ).csv.includes(other.Name),
  );
}
const proof = await api("admin/audit/integrity", manager);
assert.equal(proof.chains.length, 2);
assert.ok(proof.chains.every((c) => c.OK && c.Entries > 0));
const state = await api("admin/status", manager);
assert.ok(state.databaseBytes > 0);
assert.ok(state.sessions > 0);
assert.ok(state.schema >= 20);
await api("logout", manager, {});
await api("admin/audit", manager, undefined, 401);
console.log(
  "PASS Finanzrevision vorher/nachher, Filter und CSV, sensible Angaben, Rollensicht, Sitzungen, beide Prüfketten und echte Statusdaten.",
);
