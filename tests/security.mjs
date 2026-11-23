import { readFile } from "node:fs/promises";
import { randomUUID, createHmac } from "node:crypto";
import assert from "node:assert/strict";
const base = process.env.BONFIRE_URL || "http://127.0.0.1:8137",
  pass =
    process.env.BONFIRE_ADMIN_PASSWORD ||
    (await readFile(".env", "utf8"))
      .match(/^BONFIRE_ADMIN_PASSWORD=(.+)$/m)[1]
      .trim();
const basic = (u, p) => "Basic " + Buffer.from(u + ":" + p).toString("base64"),
  admin = basic("leitung", pass);
async function post(path, headers, body, status = 200) {
  const r = await fetch(base + "/api/" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  assert.equal(r.status, status);
  return r;
}
const e = await (
  await post(
    "events",
    { Authorization: admin },
    { Name: "Berechtigungsübung", Starts: "2030-08-01", Ends: "2030-08-02" },
  )
).json();
const user = "k-" + randomUUID().slice(0, 10),
  pw = randomUUID();
await post(
  "users",
  { Authorization: admin },
  { Name: user, Role: "Kassa", Password: pw, Event: e.ID },
);
const cred = { Authorization: basic(user, pw) };
const login = await post("login", cred, {});
const cookie = login.headers.get("set-cookie").split(";")[0],
  session = { Cookie: cookie };
const { secret } = await (await post("mfa", session, {})).json();
const bits = [...secret]
  .map((c) =>
    "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(c).toString(2).padStart(5, "0"),
  )
  .join("");
const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
const step = Buffer.alloc(8);
step.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
const mac = createHmac("sha1", key).update(step).digest();
const code = String(
  (mac.readUInt32BE(mac[19] & 15) & 0x7fffffff) % 1000000,
).padStart(6, "0");
const recovery = await (
  await post("mfa", session, { Secret: secret, Code: code })
).json();
assert.equal(recovery.length, 8);
await post("login", cred, {}, 401);
await post("login", { ...cred, "X-Bonfire-OTP": recovery[0] }, {});
await post("login", { ...cred, "X-Bonfire-OTP": recovery[0] }, {}, 401);
await post(
  "prepare",
  session,
  { Event: e.ID, Name: "Unzulässig", Donor: true },
  403,
);
const k = await (
    await post("prepare", session, { Event: e.ID, Name: "Kassa" })
  ).json(),
  a = await (
    await post(
      "prepare",
      { Authorization: admin },
      { Event: e.ID, Name: "Leitung", Donor: true },
    )
  ).json();
const auth = (d) => ({ Authorization: "Bearer " + d.device + "." + d.token });
const renewed = await (
  await post(
    "renew",
    { Authorization: admin },
    { Device: a.device, Proof: a.token },
  )
).json();
assert.ok(Date.parse(renewed) > Date.now() + 71 * 3600000);
await post(
  "renew",
  { Authorization: admin },
  { Device: k.device, Proof: k.token },
  403,
);
const Target = randomUUID();
await post("sync", auth(a), {
  Ops: [
    {
      ID: randomUUID(),
      Target,
      Seq: 1,
      Base: 0,
      Kind: "contact",
      Data: {
        Label: "Fiktiver Kontakt",
        Date: "2030-08-01",
        Fields: { birth: "2000-03-06" },
      },
    },
  ],
});
let pull = await (await post("sync", auth(k), {})).json();
assert.equal(
  pull.entries.find((r) => r.ID === Target).Data.Fields?.birth,
  undefined,
);
await post(
  "access",
  { Authorization: admin },
  {
    Event: e.ID,
    Name: user,
    Action: "revoke",
    Reason: "Test für Rechteentzug",
  },
);
await post("sync", auth(k), {}, 403);
await post(
  "renew",
  { ...cred, "X-Bonfire-OTP": recovery[1] },
  { Device: k.device, Proof: k.token },
  403,
);
console.log(
  "PASS: TOTP enrollment, one-use recovery, role-limited donor access, redacted birth date, immediate online revocation",
);
