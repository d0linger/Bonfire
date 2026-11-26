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
