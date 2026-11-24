import { testPassword } from "./test-password.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
const base = process.env.BONFIRE_URL || "http://127.0.0.1:8137";
const pw =
  testPassword();
const basic = (name, pass) =>
  "Basic " + Buffer.from(name + ":" + pass).toString("base64");
const admin = basic("leitung", pw);
async function post(path, auth, body, status = 200) {
  const res = await fetch(base + "/api/" + path, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  assert.equal(res.status, status, res.status === status ? "" : text);
  return status === 200 ? JSON.parse(text) : null;
}
const auth = (d) => "Bearer " + d.device + "." + d.token;
const send = (d, q, status) => post("sync", auth(d), q, status);
const rec = (seq, kind, label, n) => ({
  ID: randomUUID(),
  Target: randomUUID(),
  Seq: seq,
  Base: 0,
  Kind: kind,
  Data: { Label: label, Date: "2026-09-11", Amount: n },
});
if (process.argv.includes("--replay")) {
  const { d, acked, pending } = JSON.parse(
    await readFile("test-results/replay.json", "utf8"),
  );
  const sent = await send(d, { Ops: [acked, pending] });
  assert.equal(sent.last, 2);
  assert.equal(sent.entries.filter((r) => r.Kind !== "contact").length, 2);
  const again = await send(d, { Ops: [acked, pending] });
  assert.deepEqual(again.entries, sent.entries);
  console.log(
    "PASS: restored DB accepts previously pending device operation and repeated acknowledged batch exactly once",
  );
} else {
  const suffix = randomUUID().slice(0, 8);
  const event = await post("events", admin, {
    Name: "Übungsprüfung " + suffix,
    Starts: "2026-08-05",
    Ends: "2026-11-01",
  });
  const user = "pruefung-" + suffix;
  const testPw = randomUUID();
  await post("users", admin, {
    Name: user,
    Password: testPw,
    Role: "Read",
    Event: event.ID,
  });
  const prepare = (name, who = admin) =>
    post("prepare", who, { Name: name, Event: event.ID });
  const a = await prepare("Kassa A"),
    b = await prepare("Kassa B"),
    review = await prepare("Prüfung", basic(user, testPw));
  assert.notEqual(a.first, b.first);
  await send(review, { Ops: [rec(1, "income", "Unzulässig", 50)] }, 403);
  const income = rec(1, "income", "Sammelbetrag", 8000);
  const [x, y] = await Promise.all([
    send(a, { Ops: [income] }),
    send(a, { Ops: [income] }),
  ]);
  assert.equal(x.entries.filter((r) => r.Kind !== "contact").length, 1);
  assert.equal(y.entries.filter((r) => r.Kind !== "contact").length, 1);
  await send(
    a,
    { Ops: [{ ...income, Data: { ...income.Data, Amount: 1 } }] },
    422,
  );
  const open = rec(2, "opening", "Eröffnung", 0),
    actual = rec(3, "actual", "Ist", 8000);
  await send(a, { Ops: [open, actual] });
  await send(a, { Action: "Abschluss" }, 422);
  await send(a, { Action: "Ende", Last: 3 });
  await send(b, { Action: "Ende", Last: 0 });
  await send(review, { Action: "Ende", Last: 0 });
  assert.equal((await send(a, { Action: "Abschluss" })).closed, true);
  await send(a, { Ops: [rec(4, "income", "Nachträglich", 1)] }, 403);
  const audit = await post("manage", auth(review), { Action: "audit" });
  assert.ok(audit.some((r) => r.action === "Veranstaltungsabschluss"));
  const event2 = await post("events", admin, {
    Name: "Wiederherstellung " + suffix,
    Starts: "2026-09-01",
    Ends: "2026-09-30",
  });
  const d = await post("prepare", admin, {
    Name: "Prüfgerät",
    Event: event2.ID,
  });
  const acked = rec(1, "income", "Bereits angenommen", 200),
    pending = rec(2, "expense", "Noch ausständig", 50);
  await send(d, { Ops: [acked] });
  await mkdir("test-results", { recursive: true });
  await writeFile(
    "test-results/replay.json",
    JSON.stringify({ d, acked, pending }),
    { mode: 0o600 },
  );
  console.log(
    "PASS: simultaneous retries, ID collision, review role, disjoint reservations, device seals, balance review, audit, rejected late entry",
  );
}
