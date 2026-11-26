import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { api, admin, auth, basic } from "./local-api.mjs";
const day = "2034-08-03";
const event = await api("events", admin, {
  Name: "Rechenprüfung " + randomUUID().slice(0, 8),
  Starts: day,
  Ends: day,
});
const reviewer = "p-" + randomUUID().slice(0, 12),
  pw = randomUUID();
await api("users", admin, {
  Name: reviewer,
  Password: pw,
  Role: "Read",
  Event: event.ID,
});
const prepare = (Name, who) => api("prepare", who, { Name, Event: event.ID });
const d = await prepare("Kassa", admin),
  rev = await prepare("Abschluss", basic(reviewer, pw));
const send = (d, body, status) => api("sync", auth(d), body, status);
let seq = 0;
const rec = (Kind, Data, Target = randomUUID(), Base = 0) => ({
  ID: randomUUID(),
  Seq: ++seq,
  Target,
  Base,
  Kind,
  Data: { Date: day, Label: "Übung " + Kind, ...Data },
});
const wallet = rec("wallet", {}),
  Wallet = wallet.Target;
const count = (Phase, n) =>
  rec(
    "count",
    { Wallet, Phase, Amount: n, Pieces: { 1000: n / 1000 } },
    "count:" +
      createHash("sha256")
        .update(Wallet + "|" + Phase)
        .digest("hex")
        .slice(0, 32),
  );
const settlement = (Amount, base = 0) =>
  rec(
    "income",
    {
      Wallet,
      Method: "Bar",
      Amount,
      Reference: "wallet-settlement",
      Note: "Zähldifferenz geklärt",
    },
    "settlement:" + Wallet,
    base,
  );
const first = [
  wallet,
  rec("opening", { Amount: 10000 }),
  count("Anfang", 10000),
  rec("deposit", { Wallet, Amount: 9000, Method: "Bar" }),
  rec("deposit-return", { Wallet, Amount: 4000, Method: "Bar" }),
  rec("refund", { Wallet, Amount: 2000, Method: "Bar" }),
  rec("donation", { Wallet, Amount: 3000, Method: "Karte" }),
  count("Ende", 26000),
  settlement(13000),
];
let result = await send(d, { Ops: first });
assert.deepEqual(result.conflicts, []);
const separate = rec("donation", { Wallet, Amount: 1000, Method: "Bar" });
await send(d, { Ops: [separate] });
const wrong = settlement(12000, 1);
result = await send(d, { Ops: [wrong] });
assert.ok(result.conflicts.some((x) => x.ID === wrong.ID));
await send(d, {
  Resolve: wrong.ID,
  Choice: "beibehalten",
  Reason: "Sammelbetrag um Einzelspende vermindern",
});
await send(d, {
  Ops: [rec("actual", { Amount: 30000 })],
});
await send(d, { Action: "Ende", Last: seq });
await send(rev, { Action: "Ende", Last: 0 });
assert.equal((await send(d, { Action: "Abschluss" })).closed, true);
const booked = (await send(d, {})).entries.filter((r) => r.ID === "settlement:" + Wallet);
assert.equal(booked.length, 1);
assert.equal(booked[0].Data.Amount, 13000);
console.log(
  "PASS unabhängige Zählungen, Pfand und Rückgabe, Kundenrückzahlung, Kartenspende, Sammelkorrektur und Abschluss",
);
