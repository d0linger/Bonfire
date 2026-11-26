import test from "node:test";
import assert from "node:assert/strict";
import { cents } from "../web/domain.js";
import { csv, preview } from "../web/exchange.js";
import { mergeText } from "../web/templates.js";

test("generated receipt amounts, CSV labels and template values round-trip", async () => {
  // Reproducible synthetic cases include delimiters, quotes, newlines and Unicode.
  let seed = 7301;
  function next() {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  }
  const alphabet = ['"', ";", " ", "€", "\n", "Z", "{", "}", "ß", "'"];
  const rows = [];
  for (let i = 0; i < 256; i++) {
    const amount = next();
    const integer = Math.floor(amount / 100);
    const fraction = String(amount % 100).padStart(2, "0");
    assert.equal(cents(integer + (i % 2 ? "," : ".") + fraction), amount);
    const label = "Fixture " + i + Array.from({ length: next() % 23 }, () => alphabet[next() % alphabet.length]).join("");
    assert.equal(mergeText("Receipt {{label}} ({{amount}})", { label, amount }), "Receipt " + label + " (" + amount + ")");
    rows.push({ Kind: "income", Data: { Amount: amount, Label: label, Date: "2026-07-17" } });
  }
  const actual = await preview(new File([csv(rows)], "synthetic.csv"), []);
  assert.deepEqual(actual.map((r) => [r.amount, r.label]), rows.map((r) => [r.Data.Amount, r.Data.Label]));
  assert.throws(() => mergeText("{{missing}}", {}));
});

test("journal CSV escaping preserves spreadsheet-safe labels and real dates", async () => {
  const labels = ["- Main gate", "'- Main gate", "=1+1", "'ordinary", "@desk"];
  const rows = labels.map((Label) => ({ Kind: "income", Data: { Label, Date: "2028-02-29", Amount: 400 } }));
  const bad = { Kind: "income", Data: { Label: "Invalid date", Date: "2026-02-30", Amount: 100 } };
  const data = csv([...rows, bad]);
  assert.match(await data.text(), /"'=1\+1"/);
  const parsed = await preview(new File([data], "journal.csv"), rows);
  assert.deepEqual(parsed.slice(0, -1).map((r) => r.label), labels);
  assert.ok(parsed.slice(0, -1).every((r) => r.status === "Possible duplicate"));
  assert.equal(parsed.at(-1).status, "Needs review");
  const invalidKind = await preview(new File([csv([{ ...rows[0], Kind: "constructor" }])], "journal.csv"), []);
  assert.equal(invalidKind[0].status, "Needs review");
  assert.throws(() => mergeText("{{constructor}}", {}));
});

test("historical German journal headers retain their amount units", async () => {
  for (const [column, value] of [["Betrag_Cent", "305"], ["Betrag_EUR", "3,05"]]) {
    const source = `Datum;Art;Bezeichnung;${column}\n2026-11-26;income;Donation;${value}`;
    const rows = await preview(new File([source], "journal.csv"), []);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].amount, 305);
    assert.equal(rows[0].label, "Donation");
  }
  const mixed = new File(["Datum;Art;Description;Amount_Cents"], "journal.csv");
  await assert.rejects(preview(mixed, []), /Expected columns/);
});
