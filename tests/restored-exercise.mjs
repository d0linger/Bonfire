import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { admin } from "./local-api.mjs";

const fixture = JSON.parse(
  await readFile("test-results/gesamtfall.json", "utf8"),
);
const target=new URL(process.env.BONFIRE_URL);
assert.equal(target.hostname,"127.0.0.1");
const base="http://127.0.0.1:"+target.port;
const options={headers:{Authorization:admin},redirect:"error"};
const events=await fetch(base+"/api/events",options);
assert.equal(events.status,200);
const matches=(await events.json()).filter(e=>e.Name===fixture.eventName);
assert.equal(matches.length,1);
const snapshot=await fetch(base+"/api/workplace?event="+encodeURIComponent(matches[0].ID),options);
assert.equal(snapshot.status, 200);
const { event, entries, pending, conflicts } = await snapshot.json();
assert.equal(event.ID, matches[0].ID);
assert.equal(event.Closed, true);
assert.equal(pending, 0);
assert.equal(conflicts, 0);
const byKind = (kind) => entries.filter((r) => r.Kind === kind);
assert.deepEqual(
  byKind("actual").map((r) => r.Data.Amount),
  [fixture.actual],
);
assert.equal(byKind("original").length, fixture.originals);
assert.equal(byKind("count").length, 2);
assert.ok(
  entries.some(
    (r) => r.Kind === "income" && r.Data.Label === "Eintritt Sammelbetrag",
  ),
);
console.log(
  "PASS derselbe geprüfte Offline-Gesamtfall nach Restore mit manuellem Istbestand, Originalen, allen Gerätesiegeln und Abschluss",
);
