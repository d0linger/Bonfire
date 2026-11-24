import test from "node:test";
import assert from "node:assert/strict";
import { fiscalRange } from "../web/fiscal-picker.js";
import {
  cents,
  totalPieces,
  counted,
  pooledRevenue,
  summary,
  journalMatches,
} from "../web/domain.js";
import { walletTable } from "../web/workplace.js";
const r = (Kind, Amount, Phase = "") => ({
  Kind,
  Data: { Amount, Phase, Wallet: "Nord" },
});
test("Jahresauswahl kürzt jedes Datum nur bei eindeutigem Bezugsjahr", () => {
  const period = (Name, Starts, Ends) => fiscalRange({ Name, Starts, Ends });
  assert.equal(
    period("Geschäftsjahr 2027", "2026-11-01", "2027-12-31"),
    "01.11.2026 – 31.12.",
  );
  assert.equal(
    period("2027", "2027-04-01", "2028-03-31"),
    "01.04. – 31.03.2028",
  );
  assert.equal(period("2026", "2026-01-01", "2026-10-31"), "01.01. – 31.10.");
  for (const label of ["Rumpfjahr", "2026/2027"]) {
    assert.equal(
      period(label, "2026-11-01", "2027-12-31"),
      "01.11.2026 – 31.12.2027",
    );
  }
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
test("Börsen einer Bar ergeben nur bei vollständiger Zählung eine Barsumme", () => {
  const entries = [
    { Kind: "bar", ID: "bar1", Data: { Label: "Getränke" } },
    ...["Nord", "Süd"].map((ID) => ({
      Kind: "wallet",
      ID,
      Data: { Label: ID, Bar: "bar1" },
    })),
    r("count", 2000, "Anfang"),
    r("count", 9100, "Ende"),
    { Kind: "count", Data: { Wallet: "Süd", Phase: "Anfang", Amount: 3500 } },
  ];
  const barRow = (rows) =>
    walletTable(rows).match(
      /<tr><th scope="row">Bar · Getränke[\s\S]*?<\/tr>/,
    )[0];
  assert.match(barRow(entries), /55,00/);
  assert.match(barRow(entries), /Offen/);
  assert.doesNotMatch(barRow(entries), /91,00/);
  entries.push({
    Kind: "count",
    Data: { Wallet: "Süd", Phase: "Ende", Amount: 12100 },
  });
  assert.match(barRow(entries), /212,00/);
  assert.match(barRow(entries), /157,00/);
  entries.splice(
    3,
    entries.length - 3,
    r("count", 2000, "Anfang"),
    { Kind: "count", Data: { Wallet: "Süd", Phase: "Anfang", Amount: 3500 } },
    {
      Kind: "count",
      Data: { Phase: "Ende", Amount: 21200, Fields: { countScope: "all" } },
    },
  );
  assert.match(barRow(entries), /Nur gesamt erfasst/);
  assert.doesNotMatch(barRow(entries), /212,00/);
  assert.equal(pooledRevenue(entries), 15700);
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
