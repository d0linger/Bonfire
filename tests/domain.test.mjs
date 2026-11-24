import test from "node:test";
import assert from "node:assert/strict";
import {
  cents,
  totalPieces,
  counted,
  summary,
  journalMatches,
} from "../web/domain.js";
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
test("Pfand, Kundenerstattung und Kartenzahlung am selben Stand", () => {
  const list = [
    r("count", 10000, "Anfang"),
    r("count", 26000, "Ende"),
    r("deposit", 9000),
    r("deposit-return", 4000),
    r("refund", 2000),
    {
      Kind: "donation",
      Data: { Amount: 3000, Wallet: "Nord", Method: "Karte" },
    },
  ];
  assert.equal(counted(list, "Nord"), 13000);
  const report = summary([...list, r("income", 13000)]);
  assert.equal(report.receipts, 14000);
  assert.equal(report.costs, 0);
  assert.equal(report.ear, 14000);
});
test("Journalfilter kombinieren Zeitraum, Kategorie, Konto, Bar und Zahlungsart", () => {
  const row = {
    Kind: "expense",
    Data: {
      Date: "2026-04-01",
      Category: "Einkauf",
      Account: "Kassa",
      Bar: "Nord",
      Method: "Bar",
    },
  };
  const filters = {
    kind: "expense",
    from: "2026-04-01",
    until: "2026-04-01",
    category: "Einkauf",
    account: "Kassa",
    bar: "Nord",
    method: "Bar",
  };
  assert.equal(journalMatches(row, filters), true);
  for (const key of Object.keys(filters))
    assert.equal(
      journalMatches(row, {
        ...filters,
        [key]: key === "until" ? "2026-03-31" : "zzz",
      }),
      false,
    );
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
