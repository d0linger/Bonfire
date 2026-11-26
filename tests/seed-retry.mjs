import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { onlineClient } from "./local-api.mjs";

const call = await onlineClient();
const year = await call("years", {Name:"Seed recovery test", Starts:"2026-01-01", Ends:"2026-12-31"});
const event = await call("events", {Name:"Übung · Sommerfest am Birkenhain", Year:year.ID, Starts:"2026-06-01", Ends:"2026-06-30"});
const read = async () => (await call("online?event=" + event.ID, {})).entries;
assert.equal((await read()).length, 0);
const seed = () => execFileSync(process.execPath, ["ops/seed.mjs"], {stdio:"inherit"});
seed();
const populated = await read();
assert.ok(populated.some(r => r.Kind === "wallet"));
assert.ok(populated.some(r => r.Kind === "sponsorship"));
seed();
assert.deepEqual((await read()).map(r => r.ID).sort(), populated.map(r => r.ID).sort());
console.log("PASS seed repaired an empty event and the retry preserved all record identities");
