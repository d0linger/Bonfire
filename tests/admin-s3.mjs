import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { admin } from "./local-api.mjs";

const url = new URL(process.env.BONFIRE_URL);
assert.ok(url.hostname === "127.0.0.1" && url.port && url.port !== "8137");
assert.equal(process.env.BONFIRE_S3_TEST, "isolated");
const login = await fetch(new URL("/api/login", url), {
  method: "POST",
  headers: { Authorization: admin },
});
assert.equal(login.status, 200);
const cookie = login.headers.getSetCookie()[0].split(";")[0];
const endpoint = new URL("/api/admin/backup", url);
async function state() {
  const response = await fetch(endpoint.href + "?files=all", {
    headers: { Cookie: cookie },
  });
  assert.equal(response.status, 200);
  return response.json();
}
async function run(action, name) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ action, target: "s3", name }),
  });
  assert.equal(response.status, 202, await response.text());
  for (let i = 0; i < 180; i++) {
    const result = await state();
    if (!result.active && result.recent?.[0]?.action === action) {
      assert.equal(result.recent[0].outcome, "ok", result.recent[0].message);
      return result;
    }
    await delay(500);
  }
  throw new Error("Zeitüberschreitung beim S3-Auftrag " + action);
}

assert.equal((await state()).s3Configured, true);
await run("test");
const saved = await run("backup");
const name = saved.recent[0].message;
assert.ok(
  saved.files.some((file) => file.name === name && file.target === "s3"),
);
const download = await fetch(
  endpoint.href + "/file?target=s3&name=" + encodeURIComponent(name),
  { headers: { Cookie: cookie } },
);
assert.equal(download.status, 200);
const bytes = Buffer.from(await download.arrayBuffer());
assert.equal(bytes.subarray(0, 8).toString(), "BONFIRE2");
const verified = await run("probe", name);
assert.equal(verified.receipt.Name, name);
assert.match(verified.receipt.Hash, /^[a-f0-9]{64}$/);
console.log(
  "PASS S3-Verbindung, verschlüsseltes Objekt, Download und Wiederherstellungsprobe",
);
