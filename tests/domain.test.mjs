import test from "node:test";
import assert from "node:assert/strict";
import { cents, totalPieces, counted, summary } from "../web/domain.js";
const r = (Kind, Amount, Phase = "") => ({
  Kind,
  Data: { Amount, Phase, Wallet: "Nord" },
});
test("Centbeträge und Stückelung", () => {
  assert.equal(cents("0,29"), 29);
  assert.throws(() => cents("0.009"));
  assert.equal(totalPieces({ 5000: 1, 2: 3 }), 5006);
  assert.throws(() => totalPieces({ 5: 0.1 }));
});
test("Geldtasche mit Rückgabe und bereits erfasster Spende", () => {
  const list = [
    r("count", 30000, "Anfang"),
    r("count", 42000, "Ende"),
    r("supply", 10000),
    r("skim", 65000),
    r("expense", 5000),
    r("return", 42000),
  ];
  assert.equal(counted(list, "Nord"), 72000);
  assert.equal(counted([...list, r("donation", 10000)], "Nord"), 62000);
  assert.equal(counted([], "Nord"), null);
});
test("Erstattung und interne Umbuchung zählen einmal", () => {
  const s = summary([
    r("income", 15000),
    r("outlay", 8000),
    r("reimbursement", 8000),
    r("transfer", 30000),
    r("payout", 5000),
  ]);
  assert.equal(s.ear, 7000);
  assert.equal(s.result, 7000);
  assert.equal(s.outstanding, 0);
});
