import test from "node:test";
import assert from "node:assert/strict";
import { closure } from "../web/context.js";
import { denominationNeeds, summary } from "../web/domain.js";
import { donationReport } from "../web/donors.js";
import { tablesFor } from "../web/layouts.js";
const row = (Kind, Data, ID = Kind) => ({ ID, Kind, Data });
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
  const bar=rows.filter(r=>r.Data.Bar==="nord");
  assert.equal(summary(bar).ear,64500);
  const after=[...bar,row("reimbursement",{Amount:8000,Bar:"nord"})];
  assert.equal(summary(after).ear,56500);
  assert.equal(summary(after).result,56500);
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
