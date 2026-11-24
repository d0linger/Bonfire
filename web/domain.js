export const types = {
  account: "Konto",
  "import-source": "Importquelle",
  handover: "Bestätigte Übergabe",
  paper: "Papierbeleg nacherfassen",
  organization: "Organisationsprofil",
  income: "Einnahme",
  expense: "Ausgabe",
  refund: "Kundenrückzahlung",
  deposit: "Fremd- oder Pfandgeld erhalten",
  "deposit-return": "Fremd- oder Pfandgeld zurückgeben",
  transfer: "Interner Transfer",
  outlay: "Privatauslage",
  reimbursement: "Erstattung",
  card: "Kartenumsatz brutto",
  fee: "Anbietergebühr",
  payout: "Anbieterauszahlung",
  presale: "Vorverkauf",
  opening: "Eröffnungsbestand",
  actual: "Istbestand",
  period: "Abrechnungsperiode",
  bar: "Bar",
  wallet: "Geldtasche",
  shift: "Schicht",
  count: "Zählung",
  plan: "Wechselgeldplan",
  reserve: "Verfügbarer Wechselgeldbestand",
  supply: "Nachversorgung",
  skim: "Abschöpfung",
  return: "Schlussrückgabe",
  contact: "Kontakt",
  sponsorship: "Sponsoringforderung",
  payment: "Sponsoringzahlung",
  donation: "Spende",
  price: "Artikelpreis",
  attachment: "Belegdatei",
  template: "Vorlagenfassung",
  original: "Originalbeleg",
};
export const groups = {
  Journal: [
    "income",
    "expense",
    "refund",
    "deposit",
    "deposit-return",
    "transfer",
    "outlay",
    "reimbursement",
    "card",
    "fee",
    "payout",
    "presale",
    "attachment",
    "paper",
  ],
  Geldtaschen: [
    "bar",
    "wallet",
    "shift",
    "plan",
    "reserve",
    "count",
    "supply",
    "skim",
    "return",
  ],
  "Kontakte & Preise": [
    "contact",
    "organization",
    "sponsorship",
    "payment",
    "donation",
    "price",
  ],
  Perioden: ["period", "account", "opening", "actual"],
};
export const denom = [
  20000, 10000, 5000, 2000, 1000, 500, 200, 100, 50, 20, 10, 5, 2, 1,
];
export const monetary = new Set(
  "income expense refund deposit deposit-return transfer outlay reimbursement card fee payout presale opening actual supply skim return sponsorship payment donation price".split(
    " ",
  ),
);
export const eur = (n) =>
  n == null
    ? "Offen"
    : new Intl.NumberFormat("de-AT", {
        style: "currency",
        currency: "EUR",
      }).format(n / 100);
export function cents(s) {
  const m = /^(\d{1,10})(?:[,.](\d{1,2}))?$/.exec(String(s).trim());
  if (!m)
    throw Error("Betrag in EUR mit höchstens zwei Nachkommastellen eingeben.");
  return Number(m[1]) * 100 + Number((m[2] || "").padEnd(2, "0"));
}
export function totalPieces(p) {
  return Object.entries(p).reduce((sum, [k, n]) => {
    if (!denom.includes(+k) || !Number.isSafeInteger(n) || n < 0 || n > 1000000)
      throw Error("Gültige ganze Stückzahlen eingeben.");
    return sum + n * +k;
  }, 0);
}
export function visible(s) {
  const m = new Map(s.entries.map((r) => [r.ID, r]));
  for (const o of s.ops) {
    if (o.Kind === "attachment-file") {
      const record = m.get(o.Data.Reference);
      if (
        record &&
        String(record.Revision) === o.Data.Fields.revision &&
        record.Data.Fields?.sha256 === o.Data.Fields.sha256
      )
        m.set(record.ID, {
          ...record,
          Data: { ...record.Data, File: o.Data.File, uploadPending: true },
        });
    } else if (o.Kind !== "template")
      m.set(o.Target, {
        ID: o.Target,
        Revision: o.Base + 1,
        Kind: o.Kind,
        Device: s.device,
        Data: o.Data,
      });
  }
  return [...m.values()];
}
export function sum(rows, kinds) {
  return rows
    .filter((r) => kinds.includes(r.Kind))
    .reduce((n, r) => n + (r.Data.Amount ?? 0), 0);
}
export function summary(rows) {
  const receipts =
    sum(rows, ["income", "donation", "payment", "presale", "card"]) -
    sum(rows, ["refund"]);
  const paid = sum(rows, ["expense", "reimbursement", "fee"]);
  const costs = sum(rows, ["expense", "outlay", "fee"]);
  return {
    receipts,
    paid,
    costs,
    ear: receipts - paid,
    result: receipts - costs,
    outstanding: sum(rows, ["outlay"]) - sum(rows, ["reimbursement"]),
  };
}
export function availableNumbers(s) {
  if (
    ![s.first, s.nextNumber, s.limit].every(Number.isSafeInteger) ||
    s.first <= 0 ||
    s.nextNumber < s.first ||
    s.nextNumber > s.limit ||
    s.limit - s.first >= 1000
  )
    return 0;
  return s.limit - s.nextNumber + 1;
}
export function journalMatches(row, filters) {
  const data = row.Data;
  return (
    (!filters.from || data.Date >= filters.from) &&
    (!filters.until || data.Date <= filters.until) &&
    (!filters.kind || row.Kind === filters.kind) &&
    (!filters.category || data.Category === filters.category) &&
    (!filters.method || data.Method === filters.method) &&
    (!filters.account || data.Account === filters.account) &&
    (!filters.bar || data.Bar === filters.bar)
  );
}
export function counted(rows, wallet) {
  const list = rows.filter(
    (r) =>
      r.Data.Wallet === wallet && (!r.Data.Method || r.Data.Method === "Bar"),
  );
  const count = (p) =>
    list.find((r) => r.Kind === "count" && r.Data.Phase === p)?.Data.Amount;
  const start = count("Anfang"),
    end = count("Ende");
  if (start == null || end == null) return null;
  return (
    end -
    start -
    sum(list, ["supply"]) +
    sum(list, ["skim", "expense", "refund", "deposit-return"]) -
    sum(list, ["donation", "payment", "income", "presale", "deposit"])
  );
}
export async function countID(kind, wallet, phase) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(wallet + "|" + phase),
  );
  return (
    kind +
    ":" +
    Array.from(new Uint8Array(bytes).slice(0, 16), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("")
  );
}
export function denominationNeeds(rows) {
  const stock = rows.find((r) => r.Kind === "reserve")?.Data.Pieces;
  const plans = rows.filter(
    (r) => r.Kind === "plan" && r.Data.Phase === "Anfang",
  );
  return denom.map((cent) => {
    const need = plans.reduce(
      (sum, r) => sum + (r.Data.Pieces?.[cent] || 0),
      0,
    );
    return {
      cent,
      need,
      stock: stock ? stock[cent] || 0 : null,
      missing: stock ? Math.max(0, need - (stock[cent] || 0)) : null,
    };
  });
}
export function today() {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Vienna" }).format(
    new Date(),
  );
}
