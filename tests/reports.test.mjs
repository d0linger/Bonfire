import test from "node:test";
import assert from "node:assert/strict";
import { closure, invoiceReference } from "../web/context.js";
import { denominationNeeds, summary } from "../web/domain.js";
import { donationReport } from "../web/donors.js";
import { sponsorshipStatus } from "../web/sponsorship.js";
import { tablesFor } from "../web/layouts.js";
const row = (Kind, Data, ID = Kind) => ({ ID, Kind, Data });
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
  assert.equal(invoiceReference(bill, 73), "Rechnung 73");
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
      (s) => s.includes("Payment reference") || s.includes("Fällig"),
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
  assert.deepEqual(got[1].fehlendeAngaben, ["Geburtsdatum"]);
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
  const rows = [row("opening", { Amount: 0, Date: "2026-06-01" })];
  const unknown = closure(rows, false, false)["report.closing"];
  assert.equal(unknown.actual_closing_cents, null);
  assert.equal(unknown.difference_cents, null);
  const confirmed = closure(
    [...rows, row("actual", { Amount: 0, Date: "2026-06-30" })],
    false,
    true,
  );
  assert.equal(confirmed["report.closing"].difference_cents, 0);
  assert.equal(confirmed["report.review"].status, "approved");
});

test("closing comparisons require a current, unambiguous observation per account", () => {
  const a = "10000000-0000-4000-8000-000000000001";
  const b = "10000000-0000-4000-8000-000000000002";
  const day = "2026-06-05";
  const posting = (kind, account, amount, date = day) =>
    row(kind, { Account: account, Amount: amount, Date: date });
  const rows = [row("account", { Label: "Bank" }, a), row("account", { Label: "Cash" }, b),
    posting("opening", a, 100), posting("opening", b, 0), posting("actual", a, 100), posting("actual", b, 0)];
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
