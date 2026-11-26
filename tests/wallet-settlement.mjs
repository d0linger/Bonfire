import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { api, admin, basic, onlineClient, practiceEvent } from "./local-api.mjs";
const day = "2703-08-03";
const cashier = await onlineClient();
const event = await practiceEvent(cashier, "Wallet settlement exercise", day);
const reviewer = "p-" + randomUUID().slice(0, 12),
  pw = randomUUID();
await api("users", admin, {
  Name: reviewer,
  Password: pw,
  Role: "Read",
  Event: event.ID,
});
const reader = await onlineClient(basic(reviewer, pw));
const route = "online?event=" + event.ID;
const send = (body, status) => cashier(route, body, status);
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
await send({ Ops: first });
const separate = rec("donation", { Wallet, Amount: 1000, Method: "Bar" });
await send({ Ops: [separate] });
// A donation recorded after the count does not change the previously settled cash.
await send({ Ops: [settlement(12000, 1)] }, 409);
await send({ Ops: [rec("actual", { Amount: 30000 })] });
await reader(route, { Action: "Abschluss" }, 403);
assert.equal((await send({ Action: "Abschluss" })).closed, true);
const booked = (await reader(route, {})).entries.filter((r) => r.ID === "settlement:" + Wallet);
assert.equal(booked.length, 1);
assert.equal(booked[0].Data.Amount, 13000);
console.log("PASS wallet opening and closing denominations, deposits, refunds, card donation, settlement cutoff and read-only access");
