import { disposableURL, testPassword } from "./test-password.mjs";
import assert from "node:assert/strict";
const pass =
  testPassword();
const base = disposableURL(),
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

export { api, admin, auth, basic };
