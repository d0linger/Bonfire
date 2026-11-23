export const types = {
  account: "Konto",
  "import-source": "Importquelle",
  handover: "Bestätigte Übergabe",
  paper: "Papierbeleg nacherfassen",
  organization: "Organisationsprofil",
  income: "Einnahme",
  expense: "Ausgabe",
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
  "income expense transfer outlay reimbursement card fee payout presale opening actual supply skim return sponsorship payment donation price".split(
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
  for (const o of s.ops)
    if (o.Kind !== "template")
      m.set(o.Target, {
        ID: o.Target,
        Revision: o.Base + 1,
        Kind: o.Kind,
        Device: s.device,
        Data: o.Data,
      });
  return [...m.values()];
}
export function sum(rows, kinds) {
  return rows
    .filter((r) => kinds.includes(r.Kind))
    .reduce((n, r) => n + (r.Data.Amount ?? 0), 0);
}
export function summary(rows) {
  const receipts = sum(rows, [
    "income",
    "donation",
    "payment",
    "presale",
    "card",
  ]);
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
export function counted(rows, wallet) {
  const list = rows.filter((r) => r.Data.Wallet === wallet);
  const count = (p) =>
    list.find((r) => r.Kind === "count" && r.Data.Phase === p)?.Data.Amount;
  const start = count("Anfang"),
    end = count("Ende");
  if (start == null || end == null) return null;
  return (
    end -
    start -
    sum(list, ["supply"]) +
    sum(list, ["skim", "expense"]) -
    sum(list, ["donation", "payment", "income", "presale"])
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
