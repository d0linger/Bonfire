import test from "node:test";
import assert from "node:assert/strict";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import schemas from "../web/variants.json" with { type: "json" };
import { closure, exportContext, invoiceReference } from "../web/context.js";
import { denominationNeeds, summary } from "../web/domain.js";
import { donationReport } from "../web/donors.js";
import { sponsorshipStatus } from "../web/sponsorship.js";
import { tablesFor } from "../web/layouts.js";
import { evidence } from "../web/exchange.js";
import { unzipSync, strFromU8 } from "fflate";
const row = (Kind, Data, ID = Kind) => ({ ID, Kind, Data });
test("a locked, balanced workspace can have an open evidence question and no independent approval", async () => {
  const day = "2042-06-01";
  const records = [
    row("opening", {Date: day, Label: "Opening cash", Amount: 500, BalanceOrder: "1"}),
    row("actual", {Date: day, Label: "Observed cash", Amount: 500, BalanceOrder: "2"}),
    row("source-question", {Date: day, Label: "Confirm delivery", Reference: "Sample note 3", Status: "Open"}),
  ];
  const workspace = {event: {ID: "test-event", Name: "Practice event", Starts: day, Ends: day},
    closed: true, ops: [], conflicts: [], pending: 0};
  const reports = Object.fromEntries(["Review-report.pdf", "Review-report.docx", "Document-register.pdf", "Document-register.docx"]
    .map(name => [name, new Blob(["synthetic test"])]));
  const archive = await evidence(workspace, records, reports);
  const manifest = JSON.parse(strFromU8(unzipSync(new Uint8Array(await archive.arrayBuffer()))["manifest.json"]));
  assert.equal(manifest.technicallyComplete, true);
  assert.equal(manifest.reconciliation.difference_cents, 0);
  assert.equal(manifest.independentReview, "not_recorded");
  assert.equal(manifest.freigegeben, false);
  assert.equal(manifest.sourceQuestions[0].source, "Sample note 3");
  const report = tablesFor(9, {event: "Practice event"}, records, "", {closed: true});
  assert.ok(report.after.includes("Independent review: not recorded"));
  assert.ok(report.after.includes("Confirm delivery · Sample note 3"));
});
test("journal exports identify the workspace and place early bookings first", () => {
  const records = [
    row("expense", { Date: "2042-07-08", Amount: 520, Label: "Supplies" }),
    row("income", { Date: "2042-01-09", Amount: 700, Label: "Collection" }),
  ];
  const journal = tablesFor(10, { event: "General cashbook" }, records, "", {
    starts: "2042-01-01", ends: "2042-09-30",
  });
  assert.equal(journal.intro, "General cashbook · 2042-01-01 – 2042-09-30");
  assert.deepEqual(journal.blocks[0].rows.map(line => line[2]), ["Collection", "Supplies"]);
  const period = row("period", { Label: "Q1", Date: "2042-01-01", To: "2042-03-31" });
  const limited = tablesFor(10, { event: "General cashbook" }, [...records, period], "", {
    period: period.ID, workspaceName: "Brigade cashbook",
  });
  assert.equal(limited.intro, "Brigade cashbook · Q1 · 2042-01-01 – 2042-03-31");
  assert.deepEqual(limited.blocks[0].rows.map(line => line[2]), ["Collection"]);
});
test("Gemeinsames Zählblatt mit erfasstem Betrag lässt unbekannte Stückzahlen leer", () => {
  const count = row(
    "count",
    {
      Phase: "Ende",
      Amount: 12345,
      Fields: { countScope: "all", countMode: "amount" },
    },
    "gesamt",
  );
  const sheet = tablesFor(7, {}, [count], count.ID, {});
  assert.match(sheet.intro, /All wallets/);
  assert.match(sheet.after[0], /123,45/);
  assert.ok(
    sheet.blocks[0].rows.every((line) => line[3] === "" && line[4] === ""),
  );
});
test("Überweisungsbezug bleibt bei Altbestand verwendbar und folgt bei Originalen der zugeteilten Nummer", () => {
  const bill = { Label: "Übungsforderung" };
  assert.equal(invoiceReference(bill), bill.Label);
  assert.equal(invoiceReference(bill, 73), "Invoice 73");
  assert.equal(invoiceReference({ ...bill, Reference: "ALT-1" }, 73), "ALT-1");
  assert.equal(
    invoiceReference({ ...bill, Fields: { paymentRef: "  FEST-1 " } }, 73),
    "FEST-1",
  );
});
test("100 EUR Zusage, 40 EUR Zahlung und eine dokumentierte Übergabe haben getrennte Zustände", () => {
  const claim = row(
    "sponsorship",
    { Label: "Übungsforderung", Amount: 10000, Fields: { pledge: "Zugesagt" } },
    "s1",
  );
  const payment = row("payment", { Amount: 4000, Reference: "s1" }, "p1");
  const issued = row(
    "original",
    { Number: 32001, Reference: "s1" },
    "original:s1",
  );
  const receipt = row("dispatch", {
    Reference: issued.ID,
    Status: "Extern übergeben",
  });
  const records = [claim, payment, issued, receipt];
  const [status] = sponsorshipStatus(records);
  assert.deepEqual(
    [
      status.pledge,
      status.paid,
      status.outstanding,
      status.originals[0].dispatch,
    ],
    ["Zugesagt", 4000, 6000, "Extern übergeben"],
  );
  const paid = [
    ...records,
    row("payment", { Amount: 6000, Reference: "s1" }, "p2"),
  ];
  assert.equal(sponsorshipStatus(paid)[0].outstanding, 0);
  const bill = tablesFor(
    0,
    { context: { "payment.reference": "ÜBUNG" } },
    paid,
    "s1",
    {},
  );
  assert.ok(
    !bill.after.some(
      (s) => s.includes("Payment reference") || s.includes("Due"),
    ),
  );
});
test("Meldejahr separat, anonyme Spende ohne Identität, fehlende Angaben sichtbar", () => {
  const rows = [
    row("contact", { Fields: { given: "Mona", family: "Muster" } }, "fiktiv"),
    row("donation", {
      Date: "2026-01-01",
      Amount: 200,
      Contact: "fiktiv",
      Status: "Anonym",
    }),
    row(
      "donation",
      {
        Date: "2025-12-11",
        Amount: 300,
        Contact: "fiktiv",
        Fields: { reporting: "2026" },
      },
      "nachtrag",
    ),
  ];
  const got = donationReport(rows, "2026");
  assert.equal(got.length, 2);
  assert.equal(got[0].person, null);
  assert.deepEqual(got[1].fehlendeAngaben, ["Date of birth"]);
  assert.equal(got[1].person.vorname, "Mona");
  assert.equal(donationReport(rows, "2025").length, 0);
});
test("Wechselgeldplanung trennt fehlenden Bestand von null und summiert Bedarf aller Taschen", () => {
  const plans = ["Nord", "Süd"].map((Wallet) =>
    row("plan", { Phase: "Anfang", Wallet, Pieces: { 500: 4 } }),
  );
  assert.equal(
    denominationNeeds(plans).find((x) => x.cent === 500).missing,
    null,
  );
  assert.deepEqual(
    denominationNeeds([...plans, row("reserve", { Pieces: { 500: 5 } })]).find(
      (x) => x.cent === 500,
    ),
    { cent: 500, need: 8, stock: 5, missing: 3 },
  );
});
test("Barergebnis ohne Gemeinkostenumlage und tatsächliche Gesamtkosten", () => {
  const rows = [
    row("bar", { Label: "Nord" }, "nord"),
    row("income", { Amount: 72000, Bar: "nord" }),
    row("card", { Amount: 28000, Bar: "nord" }),
    row("expense", { Amount: 35000, Bar: "nord" }),
    row("outlay", { Amount: 8000, Bar: "nord" }),
    row("fee", { Amount: 500, Bar: "nord" }),
    row("expense", { Amount: 20000 }),
  ];
  const spec = tablesFor(8, { event: "Übungsfest" }, rows, null, {
    bar: "nord",
  });
  assert.match(spec.blocks[0].rows.at(-1)[3], /565,00/);
  assert.equal(summary(rows).result, 36500);
  const bar = rows.filter((r) => r.Data.Bar === "nord");
  assert.equal(summary(bar).ear, 64500);
  const after = [...bar, row("reimbursement", { Amount: 8000, Bar: "nord" })];
  assert.equal(summary(after).ear, 56500);
  assert.equal(summary(after).result, 56500);
});
test("Abschlussvertrag unterscheidet fehlendes Ist, bestätigte Null und Periodenfreigabe", () => {
  const rows = [row("opening", { Amount: 0, Date: "2026-06-01", BalanceOrder: "1" })];
  const unknown = closure(rows, false, false)["report.closing"];
  assert.equal(unknown.actual_closing_cents, null);
  assert.equal(unknown.difference_cents, null);
  const confirmed = closure(
    [...rows, row("actual", { Amount: 0, Date: "2026-06-30", BalanceOrder: "2" })],
    false,
    true,
  );
  assert.equal(confirmed["report.closing"].difference_cents, 0);
  assert.equal(confirmed["report.review"].independent_review, "not_recorded");
  assert.equal(confirmed["report.export_set"].completeness_status, "complete");
});

test("the event cash surplus includes assigned receipts exactly once", () => {
  const rows = [row("wallet-link", { Amount: 500 })];
  const statement = tablesFor(8, { event: "Practice event" }, rows, null, {});
  assert.match(statement.blocks[0].rows.at(-1)[1], /5,00/);
  assert.match(statement.blocks[0].rows.at(-1)[3], /5,00/);
  assert.match(statement.after[0], /Cash surplus: .*5,00/);
  assert.equal(summary(rows).ear, 0);
});

test("closing comparisons require a current, unambiguous observation per account", () => {
  const a = "10000000-0000-4000-8000-000000000001";
  const b = "10000000-0000-4000-8000-000000000002";
  const day = "2026-06-05";
  let order = 0;
  const posting = (kind, account, amount, date = day) =>
    row(kind, { Account: account, Amount: amount, Date: date, BalanceOrder: String(++order) });
  const rows = [row("account", { Label: "Bank" }, a), row("account", { Label: "Cash" }, b),
    posting("opening", a, 100), posting("opening", b, 0), posting("actual", a, 100), posting("actual", b, 0)];
  const idle = rows.filter(r => r.Kind !== "opening" || r.Data.Account !== b);
  const idleActual = idle.find(r => r.Kind === "actual" && r.Data.Account === b);
  delete idleActual.Data.BalanceOrder;
  const bankLine = () => closure(idle,true,true)["report.closing"].account_lines.find(line => line.account_id === b);
  assert.equal(bankLine().actual_status, "partial");
  idleActual.Data.BalanceOrder = String(++order);
  assert.equal(bankLine().actual_status, "confirmed");
  assert.equal(bankLine().theoretical_cents, 0);
  assert.equal(bankLine().difference_cents, 0);
  const idleClosing = closure(idle, true, true);
  assert.equal(idleClosing["report.closing"].book_balance_cents, 100);
  assert.equal(idleClosing["report.export_set"].completeness_status, "complete");
  for (const extra of [posting("income", a, 50, "2026-06-06"), posting("actual", a, 200)]) {
    for (const sorted of [[...rows, extra], [extra, ...rows]]) {
      const result = closure(sorted, true, true);
      const closing = result["report.closing"];
      assert.equal(result["report.review"].status, "preparation");
      assert.equal(closing.actual_status, "partial");
      assert.equal(closing.difference_cents, null);
      assert.equal(closing.account_lines.find((line) => line.account_id === a).actual_cents, null);
      assert.equal(closing.account_lines.find((line) => line.account_id === b).difference_cents, 0);
    }
  }
});

test("period statements and evidence exclude future accounts and later postings", async () => {
  const bank = "10000000-0000-4000-8000-000000000004";
  const date = "2026-02-01";
  const records = [
    row("account", { Label: "Operating account" }, bank),
    row("wallet", { Label: "Earlier wallet", Date: "2026-01-01" }, "old-wallet"),
    row("actual", { Label: "Wallet observation", Account: "old-wallet", Amount: 0, Date: date, BalanceOrder: "4" }),
    row("account", { Label: "March account", Date: "2026-03-01" }, "march"),
    row("period", { Label: "February", Date: date, To: "2026-02-28" }, "feb"),
    row("opening", { Label: "Opening bank balance", Account: bank, Amount: 875, Date: date, BalanceOrder: "1" }),
    row("actual", { Label: "Bank observation", Account: bank, Amount: 875, Date: date, BalanceOrder: "2" }),
    row("income", { Account: bank, Amount: 5200, Date: "2026-03-01", BalanceOrder: "3" }),
  ];
  const table = tablesFor(9, { event: "Exercise" }, records, "", { period: "feb", accounts: true });
  const [line] = table.blocks[0].rows;
  assert.equal(line[0], "Operating account");
  assert.match(line[1], /8,75/);
  assert.equal(line[1], line[2]);
  assert.match(line[3], /0,00/);
  assert.deepEqual(table.blocks[0].rows.map(r => r[0]), ["Operating account", "Earlier wallet"]);
  const workspace = {event: {Name: "Exercise", Accounts: true}, ops: [], conflicts: []};
  const context = exportContext(9, workspace, records, {period: "feb"});
  const balance = context["report.closing"];
  assert.equal(balance.actual_closing_cents, 875);
  const selected = records.filter(r => r.Data.Date >= date && r.Data.Date <= "2026-02-28");
  const archive = await evidence(workspace, selected, {}, {period: "feb", ends: "2026-02-28", accountDefinitions: records});
  const files = unzipSync(new Uint8Array(await archive.arrayBuffer()));
  assert.deepEqual(JSON.parse(strFromU8(files["manifest.json"])).reconciliation, balance);
});

test("closing templates accept provisional and stale observations for legacy wallet IDs", () => {
  const validator = new Ajv({ strict: false });
  addFormats(validator);
  const validate = validator.compile(schemas.T10);
  const account = "practice:wallet";
  const config = row("wallet", { Label: "Practice till" }, account);
  const values = [
    row("opening", { Account: account, Date: "2026-02-01", Amount: 500, BalanceOrder: "1" }),
    row("actual", { Account: account, Date: "2026-02-01", Amount: 500, BalanceOrder: "2" }),
    row("expense", { Account: account, Date: "2026-02-01", Amount: 25, BalanceOrder: "3" }),
  ];
  for (const [postings, status] of [[[], "missing"], [values.slice(0, 2), "confirmed"], [values, "partial"]]) {
    const report = closure([config, ...postings], true, false);
    const line = report["report.closing"].account_lines[0];
    assert.equal(line.account_id, account);
    assert.equal(line.actual_status, status);
    assert.equal(validate(report), true, JSON.stringify(validate.errors));
  }
  const unassigned = values.slice(0, 2).map(r => ({...r, Data: {...r.Data, Account: ""}}));
  const report = closure(unassigned, true, true);
  const [line] = report["report.closing"].account_lines;
  assert.deepEqual(line, {account_id: null, label: "Unassigned", actual_status: "confirmed",
    theoretical_cents: null, actual_cents: 500, difference_cents: null});
  assert.equal(report["report.export_set"].completeness_status, "incomplete");
  assert.equal(validate(report), true, JSON.stringify(validate.errors));
  const [printed] = tablesFor(9, {event: "Exercise"}, unassigned, "", {accounts: true}).blocks[0].rows;
  assert.equal(printed[0], "Unassigned");
  assert.match(printed[2], /5,00/);
});

test("equal and opposite postings require a new same-day observation", () => {
  const movement=(k,n,order)=>row(k,{Date:"2026-06-11",Amount:n,BalanceOrder:order});
  const values=[movement("opening",100,"1"),movement("actual",100,"2"),movement("income",25,"3"),movement("expense",25,"4")];
  assert.equal(closure(values,false,true)["report.review"].status,"preparation");
  values[2].Data.Date = values[3].Data.Date = "2026-06-10";
  assert.equal(closure(values,false,true)["report.review"].status,"preparation");
  values[1].Data.BalanceOrder="5";
  assert.equal(closure(values,false,true)["report.export_set"].completeness_status,"complete");
  values[2].Data.Date = "2026-06-10";
  delete values[2].Data.BalanceOrder;
  assert.equal(closure(values,false,true)["report.export_set"].completeness_status,"incomplete");
});
