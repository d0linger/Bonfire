import { cents } from "./domain.js";
export function positions(input) {
  return input
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((row) => {
      const [quantity, description, price, ...extra] = row
        .split("|")
        .map((v) => v.trim());
      const matched = /^(\d{1,5})(?:[,.](\d{1,3}))?$/.exec(quantity);
      if (extra.length || !matched || !description)
        throw Error("Position als Menge | Leistung | Einzelpreis eingeben.");
      const QuantityMilli =
        Number(matched[1]) * 1000 + Number((matched[2] || "").padEnd(3, "0"));
      const UnitCents = cents(price);
      if (
        QuantityMilli < 1 ||
        QuantityMilli > 10000000 ||
        UnitCents > 999999999
      )
        throw Error("Positionsgrenze überschritten.");
      return { Description: description, QuantityMilli, UnitCents };
    });
}
export const lineCents = (l) =>
  Number((BigInt(l.QuantityMilli) * BigInt(l.UnitCents) + 500n) / 1000n);
