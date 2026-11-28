import test from "node:test";
import assert from "node:assert/strict";
import { fiscalRange } from "../web/fiscal-picker.js";
import {
  cents,
  bookingDate,
  totalPieces,
  counted,
  cashAfterCount,
  pooledRevenue,
  summary,
  journalMatches,
} from "../web/domain.js";
import { walletTable } from "../web/workplace.js";
test("cash custody preserves the closing observation and distinguishes later returns", () => {
  const wallet=new Set(["blue"]), closing={Date:"2026-09-30",PostingOrder:"7",Amount:15000};
  const movement=(order,amount,kind="return")=>({Kind:kind,Data:{Date:closing.Date,PostingOrder:order,Amount:amount,Wallet:"blue",Account:"blue",To:"main"}});
  assert.deepEqual(cashAfterCount([movement("4",3000,"skim"),movement("8",4000)], closing,wallet),{returned:4000,held:11000});
  assert.deepEqual(cashAfterCount([movement("8",15000)], closing,wallet),{returned:15000,held:0});
  assert.equal(cashAfterCount([movement("",4000)],closing,wallet),null);
  assert.equal(cashAfterCount([],null,wallet),null);
  assert.equal(closing.Amount,15000);
});
test("posting dates respect a cross-calendar workspace and balance boundaries", () => {
  const scope = {Starts: "2025-11-01", Ends: "2026-09-30"};
  for (const day of [scope.Starts, "2026-01-01", scope.Ends]) {
    assert.equal(bookingDate(scope, "expense", "", day), day);
  }
  for (const day of ["2025-10-31", "2026-10-01"]) {
    assert.equal(bookingDate(scope, "income", "", day), "");
    assert.equal(bookingDate(scope, "count", "Anfang", day), scope.Starts);
    assert.equal(bookingDate(scope, "actual", "", day), scope.Ends);
  }
});
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
test("Later top-ups do not change an earlier closing count", () => {
  const rows = [r("count", 1000, "Anfang"), r("count", 1500, "Ende"), r("supply", 200)];
  rows.forEach((entry,i) => {entry.Data.Date = i === 2 ? "2026-05-02" : "2026-05-01";});
  assert.equal(counted(rows,"Nord"),500);
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
  assert.match(barRow(entries), /Pending/);
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
  assert.match(barRow(entries), /Combined count only/);
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

test("R01 gemeinsame Referenzzählungen", async () => {
  const { readFile } = await import("node:fs/promises");
  const cases = JSON.parse(await readFile(new URL("./cash-vectors.json", import.meta.url)));
  for (const vector of cases) {
    if (vector.valid) assert.equal(totalPieces(vector.pieces), vector.amount, vector.name);
    else assert.throws(() => totalPieces(vector.pieces), undefined, vector.name);
  }
});

test("R03–R06 shared cash settlement vectors", async () => {
  const {readFile} = await import("node:fs/promises");
  const cases = JSON.parse(await readFile(new URL("./settlement-vectors.json", import.meta.url)));
  for (const c of cases) {
    const movements = Object.entries({
      supply:c.supply, skim:c.skim, expense:c.expense, donation:c.donation,
      refund:c.refund, deposit:c.deposit, "deposit-return":c.depositReturn,
    }).filter(([,amount])=>amount !== undefined).map(([kind,amount])=>r(kind,amount));
    const entries = [r("count",c.opening,"Anfang"), ...movements, r("count",c.closing,"Ende")];
    if (c.returned) entries.push(r("return",c.returned));
    assert.equal(counted(entries,"Nord"),c.unbooked,c.name);
    assert.equal(summary([...entries,r("income",c.unbooked)]).receipts,c.net,c.name);
  }
});

test("same-day top-ups outside the count window are excluded at both scopes", () => {
  const movement = (kind, amount, order, phase = "") => ({
    Kind: kind,
    Data: { Amount: amount, Wallet: "Nord", PostingOrder: String(order), Date: "2026-07-02", Phase: phase },
  });
  const closing = movement("count", 2000, 12, "Ende");
  const rows = [
    { ID: "Nord", Kind: "wallet", Data: {} },
    movement("count", 1000, 10, "Anfang"),
    movement("supply", 400, 9),
    movement("supply", 300, 13),
    closing,
    movement("supply", 200, 11),
  ];
  assert.equal(counted(rows, "Nord"), 800);
  closing.Data.Wallet = "";
  closing.Data.Fields = { countScope: "all" };
  assert.equal(pooledRevenue(rows), 800);
});

test("a pooled transfer adjusts only the wallet whose opening count preceded it", () => {
  const move = (Kind, PostingOrder, fields) => ({ Kind, Data: { Date: "2026-06-01", PostingOrder, ...fields } });
  const rows = [
    {ID:"a",Kind:"wallet",Data:{}}, {ID:"b",Kind:"wallet",Data:{}},
    move("count",2,{Wallet:"a",Phase:"Anfang",Amount:0}),
    move("count",4,{Wallet:"b",Phase:"Anfang",Amount:0}),
    move("transfer",3,{Account:"a",To:"b",Amount:100}),
    move("count",5,{Phase:"Ende",Amount:0,Fields:{countScope:"all"}}),
  ];
  assert.equal(pooledRevenue(rows),100);
  rows.push(move("donation",3,{Method:"Bar",Amount:100}));
  assert.equal(pooledRevenue(rows),null);
});

test("historical cash on a boundary date needs a known posting order", () => {
  for (const date of ["2026-05-01","2026-05-03"]) {
    const count = (phase, day, order) => ({Kind:"count",Data:{ Phase:phase, Date:day, PostingOrder:order, Wallet:"w", Amount:100 }});
    const rows = [{ID:"w",Kind:"wallet",Data:{}},count("Anfang","2026-05-01",1),count("Ende","2026-05-03",3),
      {Kind:"supply",Data:{Date:date,Wallet:"w",Amount:100}}];
    assert.equal(counted(rows,"w"),null);
    rows[2].Data.Wallet=""; rows[2].Data.Fields={countScope:"all"};
    assert.equal(pooledRevenue(rows),null);
    rows[1].Data.Wallet=""; rows[1].Data.Fields={countScope:"all"};
    assert.equal(pooledRevenue(rows),null);
    rows[3].Data.Date="2026-05-02";
    assert.equal(pooledRevenue(rows),-100);
  }
});
