import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { admin } from "./local-api.mjs";

const fixture = JSON.parse(
  await readFile("test-results/gesamtfall.json", "utf8"),
);
assert.match(fixture.event, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
const snapshot = await fetch(
  new URL(
    "/api/workplace?event=" + encodeURIComponent(fixture.event),
    process.env.BONFIRE_URL,
  ),
  { headers: { Authorization: admin } },
);
assert.equal(snapshot.status, 200);
const { event, entries, pending, conflicts } = await snapshot.json();
assert.equal(event.ID, fixture.event);
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
