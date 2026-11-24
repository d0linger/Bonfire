import { counted, pooledRevenue, eur, summary } from "./domain.js";
import { esc } from "./workplace.js";

const amount = (rows) => rows.reduce((n, r) => n + (r.Data.Amount ?? 0), 0);
const settlement = (r) =>
  r.ID === "settlement-total" || r.ID.startsWith("settlement:");

export function festivalStatement(rows) {
  const wallets = rows.filter((r) => r.Kind === "wallet" && !r.Data.Retired);
  const counts = rows.filter((r) => r.Kind === "count");
  const separate = wallets.map((w) =>
    counted(
      rows.filter((r) => !settlement(r)),
      w.ID,
    ),
  );
  const together = counts.some(
    (r) => r.Data.Fields?.countScope === "all" && r.Data.Phase === "Ende",
  );
  const derived = together
    ? pooledRevenue(rows.filter((r) => !settlement(r)))
    : wallets.length && separate.every((v) => v != null)
      ? separate.reduce((a, b) => a + b, 0)
      : null;
  const line = (title, details) => ({ title, details, value: amount(details) });
  const by = (k) => rows.filter((r) => r.Kind === k);
  const cash = [
    ...[
      ["Anfangswechselgeld", "Anfang"],
      ["Gezählter Endbestand", "Ende"],
    ].map(([t, p]) => {
      const found = counts.filter((r) => r.Data.Phase === p);
      return { ...line(t, found), value: found.length ? amount(found) : null };
    }),
    ...[
      ["Nachgelegtes Wechselgeld", "supply"],
      ["Abschöpfungen", "skim"],
      ["Bargeld an Gäste", "cashback"],
    ].map(([t, k]) => line(t, by(k))),
  ];
  const claims = new Map(by("sponsorship").map((r) => [r.ID, r]));
  const ordinary = (r) =>
    claims.get(r.Data.Reference)?.Data.Fields?.claimType === "invoice";
  const countedRows = rows.filter(
    (r) =>
      ["count", "supply", "skim", "cashback", "transfer"].includes(r.Kind) ||
      (r.Data.Method === "Bar" && !settlement(r)),
  );
  const result = [
    {
      title: "Bareinnahmen aus der Zählung",
      value: derived,
      details: countedRows,
    },
    line(
      "Weitere Einnahmen",
      by("income").filter((r) => !settlement(r)),
    ),
    line("Vorverkauf", by("presale")),
    line(
      "Bezahltes Sponsoring",
      by("payment").filter((r) => !ordinary(r)),
    ),
    line("Bezahlte Rechnungen", by("payment").filter(ordinary)),
    line("Spenden", by("donation")),
    line("Kartenumsatz", by("card")),
    ...[
      ["Rückzahlungen", "refund"],
      ["Direkte Ausgaben", "expense"],
      ["Privatauslagen", "outlay"],
      ["Anbietergebühren", "fee"],
    ].map(([t, k]) => ({ ...line(t, by(k)), value: -amount(by(k)) })),
  ];
  const booked = rows.filter((r) => !settlement(r));
  const total =
    derived == null && (wallets.length || counts.length)
      ? null
      : (derived ?? 0) + summary(booked).result;
  return { cash, result, total, together };
}

export function festivalPanel(rows) {
  const f = festivalStatement(rows);
  const block = (title, lines) =>
    "<h3>" +
    title +
    "</h3>" +
    lines
      .map(
        (l) =>
          '<details class="filter-box"><summary>' +
          esc(l.title) +
          " · " +
          (l.value == null ? "Zählung offen" : eur(l.value)) +
          "</summary>" +
          (l.details
            .map(
              (r) =>
                "<p>" +
                esc(r.Data.Date) +
                " · " +
                esc(r.Data.Label) +
                " · " +
                eur(r.Data.Amount ?? 0) +
                "</p>",
            )
            .join("") || "<p>Keine Buchungen.</p>") +
          "</details>",
      )
      .join("");
  return (
    "<section><h2>Festabrechnung</h2>" +
    block("Bargeld", f.cash) +
    block("Festergebnis", f.result) +
    "<p><strong>Ergebnis · " +
    (f.total == null ? "Zählung offen" : eur(f.total)) +
    "</strong></p></section>"
  );
}
