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
      ["Opening change float", "Anfang"],
      ["Counted closing balance", "Ende"],
    ].map(([t, p]) => {
      const found = counts.filter((r) => r.Data.Phase === p);
      return { ...line(t, found), value: found.length ? amount(found) : null };
    }),
    ...[
      ["Change top-ups", "supply"],
      ["Cash collections", "skim"],
      ["Cashback to guests", "cashback"],
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
      title: "Cash takings from counts",
      value: derived,
      details: countedRows,
    },
    line(
      "Other income",
      by("income").filter((r) => !settlement(r)),
    ),
    line("Advance sales", by("presale")),
    line(
      "Sponsorship payments",
      by("payment").filter((r) => !ordinary(r)),
    ),
    line("Invoice payments", by("payment").filter(ordinary)),
    line("Donations", by("donation")),
    line("Card sales", by("card")),
    ...[
      ["Refunds", "refund"],
      ["Direct expenses", "expense"],
      ["Personal advances", "outlay"],
      ["Provider fees", "fee"],
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
          (l.value == null ? "Count outstanding" : eur(l.value)) +
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
            .join("") || "<p>No postings.</p>") +
          "</details>",
      )
      .join("");
  return (
    "<section><h2>Event financial statement</h2>" +
    block("Cash", f.cash) +
    block("Event result", f.result) +
    "<p><strong>Result · " +
    (f.total == null ? "Count outstanding" : eur(f.total)) +
    "</strong></p></section>"
  );
}
