import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { api, admin, auth, basic } from "./local-api.mjs";
const date = "3334-08-20";
const file = Buffer.from(
  "Datum;Art;Text;Cent\n" + date + ";income;Fiktiv-" + randomUUID() + ";1000\n",
);
const digest = createHash("sha256").update(file).digest("hex");
const source = "source:" + digest;
const target = "import:" + digest + ":2";
const send = (d, Ops, status = 200) => api("sync", auth(d), { Ops }, status);
const op = (Seq, Kind, Target, Data) => ({
  ID: randomUUID(),
  Seq,
  Base: 0,
  Kind,
  Target,
  Data: { Date: date, ...Data },
});
async function prepare() {
  const event = await api("events", admin, {
    Name: "Übung Import " + randomUUID(),
    Starts: date,
    Ends: date,
  });
  return api("prepare", admin, { Event: event.ID, Name: "Importprüfung" });
}
const a = await prepare(),
  b = await prepare();
const archive = () =>
  op(1, "import-source", source, {
    Label: "Fiktive Prüfquelle",
    Reference: digest,
    Status: "Journal",
    Filename: "uebung.csv",
    File: file.toString("base64"),
  });
const excluded = archive();
excluded.Data.Status = "D8";
await send(a, [excluded], 422);
await Promise.all([send(a, [archive()]), send(b, [archive()])]);
const user = "k-" + randomUUID().slice(0, 12),
  pw = randomUUID();
await api("users", admin, {
  Name: user,
  Password: pw,
  Role: "Kassa",
  Event: a.event.ID,
});
const cash = await api("prepare", basic(user, pw), {
  Name: "Prüfkassa",
  Event: a.event.ID,
});
const visible = (await send(cash, [])).entries.find((x) => x.ID === source);
assert.ok(visible && !visible.Data.File && !visible.Data.Filename);
assert.equal(visible.Data.Reference, digest);
const row = () =>
  op(2, "income", target, {
    Label: "Übungsübernahme",
    Amount: 1000,
    Reference: source,
    Note: "Einzelzeile geprüft",
    Fields: { sheet: "Journal", cell: "2" },
  });
const operations = [row(), row()];
const devices = [a, b];
const results = await Promise.all(
  devices.map((d, i) => send(d, [operations[i]])),
);
const winner = results.findIndex((r) => r.entries.some((x) => x.ID === target));
assert.ok(winner >= 0);
const loser = 1 - winner;
assert.ok(results[loser].conflicts.some((c) => c.ID === operations[loser].ID));
const retry = await send(devices[winner], [operations[winner]]);
assert.equal(retry.entries.filter((x) => x.ID === target).length, 1);
await api(
  "sync",
  auth(devices[loser]),
  {
    Resolve: operations[loser].ID,
    Choice: "übernehmen",
    Reason: "Doppelübernahme prüfen",
    Last: 0,
  },
  422,
);
const other = op(3, "income", "import:" + digest + ":99", {
  ...operations[loser].Data,
});
assert.ok(
  (await send(devices[loser], [other])).conflicts.some(
    (x) => x.ID === other.ID,
  ),
);
console.log(
  "PASS fiktive Importquelle, gesperrte Folgevorlage, konkurrierende Übernahme zwischen Veranstaltungen und wiederholte Übertragung mit einmaliger Geldwirkung",
);
