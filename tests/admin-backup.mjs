import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { zipSync, strToU8 } from "fflate";
const base = process.env.BONFIRE_URL;
if (
  !base ||
  new URL(base).hostname !== "127.0.0.1" ||
  !new URL(base).port ||
  new URL(base).port === "8137" ||
  process.env.BONFIRE_BACKUP_RESTORE_TEST !== "isolated"
)
  throw Error(
    "Ausschließlich mit einer eigens erstellten Testinstallation auf Zufallsport ausführen.",
  );
let password =
  process.env.BONFIRE_ADMIN_PASSWORD ||
  (await readFile(".env", "utf8"))
    .match(/^BONFIRE_ADMIN_PASSWORD=(.+)$/m)[1]
    .trim();
let login = process.env.BONFIRE_TEST_LOGIN || "leitung";
let cookie = "";
async function signIn() {
  const r = await fetch(base + "/api/login", {
    method: "POST",
    headers: {
      Authorization:
        "Basic " + Buffer.from(login + ":" + password).toString("base64"),
    },
  });
  assert.equal(r.status, 200);
  cookie = r.headers.getSetCookie()[0].split(";")[0];
}
async function api(path, body, status = 200) {
  const r = await fetch(base + "/api/" + path, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  assert.equal(r.status, status, t.slice(0, 120));
  return status < 300 ? JSON.parse(t) : null;
}
async function waitJob(action, outcome = "ok") {
  for (let i = 0; i < 240; i++) {
    const state = await api("admin/backup");
    if (!state.active && state.recent?.[0]?.action === action) {
      assert.equal(state.recent[0].outcome, outcome, state.recent[0].message);
      return state;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw Error("Auftrag nicht abgeschlossen: " + action);
}
await signIn();
await api("admin/backup");
const user = "probe-" + randomUUID().slice(0, 6) + "@example.invalid",
  pw = randomUUID();
const modify = (v) =>
  api("admin/users", { Reason: "Isolierte Restore-Prüfung", ...v });
await modify({
  Action: "create",
  Login: user,
  Label: "Übungsleitung",
  Role: "Leitung",
  Password: pw,
  Events: [],
});
const row = (await api("admin/users")).users.find((u) => u.ID === user);
const alias = "alias-" + user;
await modify({
  Action: "edit",
  ID: user,
  Version: row.Version,
  Login: alias,
  Label: "Übungsleitung",
  Role: "Leitung",
  Events: [],
});
login = alias;
password = pw;
await signIn();
const year = await api("years", {
  Name: "Aufbewahrung " + randomUUID(),
  Starts: "2581-01-01",
  Ends: "2581-01-31",
});
const [space] = await api("events?year=" + year.ID);
const book = (body) => api("online?event=" + space.ID, body),
  actor = await book({});
const tempUser = "wechsel-" + user;
await modify({
  Action: "create",
  Login: tempUser,
  Label: "Anmeldetest",
  Role: "Kassa",
  Password: pw,
  MustChange: true,
  Events: [space.ID],
});
const waiting = await fetch(base + "/api/login", {
  method: "POST",
  headers: {
    Authorization:
      "Basic " + Buffer.from(tempUser + ":" + pw).toString("base64"),
  },
});
const ticket = (await waiting.json()).passwordChange;
assert.ok(ticket);
await api(
  "admin/backup",
  { action: "schedule", target: "local", cron: "99 * * * *", days: 30 },
  422,
);
await api("admin/backup", {
  action: "schedule",
  target: "local",
  cron: "0 2 * * *",
  days: 14,
});
assert.equal((await api("admin/backup")).schedules.local.days, 14);
await api("admin/backup", { action: "backup", target: "local" }, 202);
const saved = await waitJob("backup"),
  name = saved.recent[0].message;
assert.ok(saved.files.some((f) => f.name === name));
const download = await fetch(
  base + "/api/admin/backup/file?target=local&name=" + encodeURIComponent(name),
  { headers: { Cookie: cookie } },
);
assert.equal(download.status, 200);
const bytes = Buffer.from(await download.arrayBuffer());
assert.equal(bytes.subarray(0, 8).toString(), "BONFIRE2");
assert.equal(bytes.includes(Buffer.from("PGDMP")), false);
const damaged = Buffer.from(bytes);
damaged[damaged.length - 1] ^= 1;
const failedUpload = await fetch(base + "/api/admin/backup/upload", {
  method: "POST",
  headers: { Cookie: cookie },
  body: damaged,
});
assert.equal(failedUpload.status, 200);
await api(
  "admin/backup",
  { action: "probe", target: "upload", name: (await failedUpload.json()).name },
  202,
);
await waitJob("probe", "failed");
const failures = await api("admin/audit?outcome=Fehlgeschlagen");
const failure = failures.rows.find(
  (r) => r.Action === "Backup · probe failed" && r.Subject === "upload",
);
assert.ok(failure);
const auditLink = await api(
  "admin/audit?q=" + encodeURIComponent("#" + failure.ID),
);
assert.ok(auditLink.rows.some((r) => r.ID === failure.ID));
const upload = await fetch(base + "/api/admin/backup/upload", {
  method: "POST",
  headers: { Cookie: cookie },
  body: bytes,
});
assert.equal(upload.status, 200);
const imported = (await upload.json()).name;
await api(
  "admin/backup",
  { action: "probe", target: "upload", name: imported },
  202,
);
await waitJob("probe");
await api("admin/backup", { action: "probe", target: "local", name }, 202);
const verified = await waitJob("probe");
assert.equal(verified.receipt.Name, name);
assert.ok(verified.receipt.Hash.length === 64);
const marker = "Restore-Test-" + randomUUID();
await api("years", { Name: marker, Starts: "2580-01-01", Ends: "2580-02-01" });
const date = "2581-01-02",
  bill = {
    ID: randomUUID(),
    Target: randomUUID(),
    Kind: "sponsorship",
    Data: { Date: date, Label: "Bargeldbeleg im Test", Amount: 300 },
  };
await book({ Ops: [bill] });
const number = actor.nextNumber;
const original = {
  ID: randomUUID(),
  Target: "original:" + bill.Target,
  Kind: "original",
  Data: {
    Date: date,
    Label: "Übungsbeleg",
    Reference: bill.Target,
    Number: number,
    PDF: Buffer.from("%PDF-1.4\nfiktiv\n%%EOF").toString("base64"),
    DOCX: Buffer.from(
      zipSync({
        "word/document.xml": strToU8("<document/>"),
        "[Content_Types].xml": strToU8("<Types/>"),
      }),
    ).toString("base64"),
    Note: JSON.stringify({
      profile: "invoice_transfer_a4",
      subject: bill.Target,
      number,
      date,
    }),
  },
};
await book({ Ops: [original] });
await api(
  "admin/backup",
  {
    action: "promote",
    target: "local",
    name,
    confirmation: "WIEDERHERSTELLEN",
    password: "definitely incorrect",
  },
  403,
);
await api(
  "admin/backup",
  {
    action: "promote",
    target: "local",
    name,
    confirmation: "WIEDERHERSTELLEN",
    password,
  },
  202,
);
let revoked = false;
for (let i = 0; i < 180; i++) {
  const res = await fetch(base + "/api/workplace", {
    headers: { Cookie: cookie },
  });
  if (res.status === 401) {
    revoked = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 500));
}
assert.ok(revoked, "Alte Sitzung blieb gültig");
for (let i = 0; i < 30; i++) {
  try {
    await signIn();
    break;
  } catch (e) {
    if (i === 29) throw e;
    await new Promise((r) => setTimeout(r, 300));
  }
}
const restored = await waitJob("promote");
assert.ok(!(await api("years")).some((y) => y.Name === marker));
assert.equal(restored.receipt, null);
assert.equal((await book({})).nextNumber, number + 1);
await api("password-change", { Ticket: ticket, Password: randomUUID() }, 410);
console.log(
  "PASS Verschlüsseltes lokales Backup, Zeitplan, Download, Upload, Probe, erneute Anmeldung, Datenbankwechsel, alter Stand und Sitzungswiderruf.",
);
