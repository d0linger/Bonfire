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

export async function onlineClient(authorization = admin) {
  const login = await fetch(base + "/api/login", { method: "POST", headers: { Authorization: authorization } });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie()[0].split(";")[0];
  return async function call(route, body, status = 200, headers = {}) {
    const response = await fetch(base + "/api/" + route, {
      method: body === undefined ? "GET" : "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = await response.text();
    assert.equal(response.status, status, value.slice(0, 160));
    return status === 200 ? JSON.parse(value) : null;
  };
}

export async function practiceEvent(call, name, day) {
  const year = await call("years", { Name: name, Starts: day, Ends: day });
  return call("events", { Name: name, Year: year.ID, Starts: day, Ends: day });
}
