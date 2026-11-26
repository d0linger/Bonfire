import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { admin } from "./local-api.mjs";

const url = new URL(process.env.BONFIRE_URL);
assert.ok(["127.0.0.1", "localhost"].includes(url.hostname) && url.port && url.port !== "8137");
const login = await fetch(new URL("/api/login", url), {
  method: "POST", headers: { Authorization: admin },
});
assert.equal(login.status, 200);
const cookie = login.headers.getSetCookie()[0].split(";")[0];
const post = (path, body) => fetch(new URL("/api/" + path, url), {
  method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
async function create(path, body) {
  const response = await post(path, body);
  assert.equal(response.status, 200);
  return response.json();
}
const day = "2285-03-07";
const year = await create("years", { Name: "Duplicate guard", Starts: day, Ends: day });
const event = await create("events", { Name: "Synthetic fundraiser", Year: year.ID, Starts: day, Ends: day });
const path = "online?event=" + event.ID;
const posting = (reference) => ({
  ID: randomUUID(), Target: randomUUID(), Kind: "income",
  Data: { Label: "Synthetic receipt", Date: day, Amount: 1000, Fields: { matter: reference } },
});
const reference = randomUUID();
await create(path, { Ops: [posting(reference)] });
const duplicate = await post(path, { Ops: [posting(reference)] });
assert.equal(duplicate.status, 409, "Duplicate business reference must return 409; received " + duplicate.status);
await create(path, { Ops: [posting(randomUUID())] });
const snapshot = await create(path, {});
const receipts = snapshot.entries.filter((entry) => entry.Kind === "income");
assert.equal(receipts.length, 2);
assert.equal(receipts.reduce((sum, row) => sum + row.Data.Amount, 0), 2000);
console.log("PASS duplicate reference rejected and independent equal-value receipts preserved");
