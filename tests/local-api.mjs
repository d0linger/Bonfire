import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
const pass =
  process.env.BONFIRE_ADMIN_PASSWORD ||
  (await readFile(".env", "utf8"))
    .match(/^BONFIRE_ADMIN_PASSWORD=(.+)$/m)[1]
    .trim();
const base = process.env.BONFIRE_URL || "http://127.0.0.1:8137",
  basic = (u, p) => "Basic " + Buffer.from(u + ":" + p).toString("base64"),
  admin = basic("leitung", pass),
  auth = (d) => "Bearer " + d.device + "." + d.token;
async function api(path, token, body, status = 200) {
  const res = await fetch(base + "/api/" + path, {
    method: "POST",
    headers: { Authorization: token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  assert.equal(res.status, status, text.slice(0, 160));
  return status === 200 ? JSON.parse(text) : null;
}
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname))
  throw Error("Lokaler Prüfdienst erforderlich.");

export { api, admin, auth, basic };
