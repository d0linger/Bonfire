export const types = {
  account: "Account",
  "import-source": "Import source",
  handover: "Confirmed handover",
  paper: "Record paper receipt",
  organization: "Organization profile",
  income: "Income",
  expense: "Expense",
  refund: "Customer refund",
  deposit: "Deposit received",
  "deposit-return": "Deposit returned",
  transfer: "Internal transfer",
  outlay: "Personal advance",
  reimbursement: "Reimbursement",
  card: "Gross card sales",
  cashback: "Cashback to guest",
  fee: "Provider fee",
  payout: "Provider payout",
  presale: "Advance sale",
  opening: "Opening balance",
  actual: "Actual balance",
  period: "Accounting period",
  bar: "Bar",
  wallet: "Wallet",
  shift: "Shift",
  count: "Cash count",
  plan: "Change float plan",
  reserve: "Available change",
  supply: "Change top-up",
  skim: "Cash collection",
  return: "Closing cash return",
  contact: "Contact",
  sponsorship: "Sponsorship receivable",
  payment: "Sponsorship payment",
  donation: "Donation",
  price: "Item price",
  attachment: "Supporting document",
  template: "Template version",
  original: "Original document",
  dispatch: "Document dispatch record",
};
// Persisted method and count values are shared with older installations.
const financialLabels = {
  Bar: "Cash", Überweisung: "Bank transfer", Karte: "Card",
  Anfang: "Opening", Ende: "Closing", Zwischenstand: "Interim",
  Bestätigt: "Confirmed", Offen: "Open", Freigegeben: "Approved",
};
export const financialLabel = (value) => Object.hasOwn(financialLabels, value) ? financialLabels[value] : value;

export const groups = {
  Journal: [
    "income",
    "expense",
    "refund",
    "deposit",
    "deposit-return",
    "transfer",
    "supply",
    "skim",
    "return",
    "outlay",
    "reimbursement",
    "card",
    "fee",
    "payout",
    "cashback",
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
  "income expense refund deposit deposit-return transfer outlay reimbursement card fee payout cashback presale opening actual supply skim return sponsorship payment donation price".split(
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
    if (String(+k) !== k || !denom.includes(+k) || !Number.isSafeInteger(n) || n < 0 || n > 1000000)
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
function cashAdjustment({ Kind, Data: v }, includes, pooled = false) {
  if (v.Amount == null || (v.Method && v.Method !== "Bar")) return 0;
  if (["supply", "skim", "transfer", "cashback"].includes(Kind)) {
    const from = Kind === "skim" || Kind === "cashback" ? v.Wallet : v.Account;
    const to = Kind === "supply" ? v.Wallet : v.To;
    return v.Amount * (Number(includes(from)) - Number(includes(to)));
  }
  const assigned =
    !v.Wallet && v.Method === "Bar"
      ? includes(v.Account) || (pooled && !v.Account)
      : includes(v.Wallet);
  if (!assigned) return 0;
  if (["expense", "refund", "deposit-return"].includes(Kind)) return v.Amount;
  if (["income", "payment", "donation", "presale", "deposit"].includes(Kind))
    return -v.Amount;
  return 0;
}
function withinCount(movement, closing) {
  if (!closing?.Date || movement.Date !== closing.Date)
    return !closing?.Date || movement.Date < closing.Date;
  return !movement.PostingOrder || !closing.PostingOrder ||
    BigInt(movement.PostingOrder) <= BigInt(closing.PostingOrder);
}
function unknownOrder(movement, boundary) {
  return !!boundary?.Date && movement.Date === boundary.Date && (!movement.PostingOrder || !boundary.PostingOrder || BigInt(movement.PostingOrder) === 0n || BigInt(boundary.PostingOrder) === 0n);
}
function afterOpening(movement, opening) {
  if (!opening?.Date || movement.Date !== opening.Date) return !opening?.Date || movement.Date > opening.Date;
  return !movement.PostingOrder || !opening.PostingOrder || BigInt(movement.PostingOrder) > BigInt(opening.PostingOrder);
}
export function counted(rows, wallet) {
  const list = rows.filter(
    (r) =>
      r.Data.Wallet === wallet && (!r.Data.Method || r.Data.Method === "Bar"),
  );
  const count = (p) =>
    list.find((r) => r.Kind === "count" && r.Data.Phase === p)?.Data.Amount;
  const opening = list.find(r => r.Kind === "count" && r.Data.Phase === "Anfang")?.Data;
  const cutoff=list.find(r=>r.Kind==="count" && r.Data.Phase==="Ende")?.Data;
  const start = count("Anfang"),
    end = count("Ende");
  if (start == null || end == null) return null;
  let total = end - start;
  for (const r of rows) {
    if (!afterOpening(r.Data, opening) || !withinCount(r.Data, cutoff)) continue;
    const adjustment = cashAdjustment(r, id => id === wallet);
    if (adjustment && (unknownOrder(r.Data, opening) || unknownOrder(r.Data, cutoff))) return null;
    total += adjustment;
  }
  return total;
}
export function poolCount(rows, phase) {
  return rows.find(
    (r) =>
      r.Kind === "count" &&
      r.Data.Fields?.countScope === "all" &&
      r.Data.Phase === phase,
  );
}
export function pooledRevenue(rows) {
  const wallets = new Set(
    rows.filter((r) => r.Kind === "wallet").map((r) => r.ID),
  );
  const separate = rows.filter((r) => r.Kind === "count" && r.Data.Wallet);
  const closing = poolCount(rows, "Ende")?.Data;
  const end = closing?.Amount;
  const opening = poolCount(rows, "Anfang")?.Data;
  let start = opening?.Amount;
  if (
    end == null ||
    separate.some((r) => r.Data.Phase === "Ende") ||
    rows.some((r) => r.ID?.startsWith("settlement:"))
  )
    return null;
  const openings = separate.filter((r) => r.Data.Phase === "Anfang");
  if (start == null) {
    if (
      !wallets.size ||
      [...wallets].some((id) => !openings.some((r) => r.Data.Wallet === id))
    )
      return null;
    start = openings.reduce((n, r) => n + r.Data.Amount, 0);
  } else if (openings.length) return null;
  const perWallet = new Map(openings.map(r => [r.Data.Wallet, r.Data]));
  let total = end - start;
  for (const r of rows) {
    if (r.ID === "settlement-total" || !withinCount(r.Data, closing) || !afterOpening(r.Data, opening)) continue;
    let unassigned = true;
    if (!opening && !r.Data.Wallet && !r.Data.Account && cashAdjustment(r, () => false, true)) {
      if (openings.some(o => unknownOrder(r.Data, o.Data))) return null;
      const active = openings.filter(o => afterOpening(r.Data, o.Data)).length;
      if (active && active < openings.length) return null;
      unassigned = active === openings.length;
    }
    let uncertain = false;
    const adjustment = cashAdjustment(r, id => {
      if (!wallets.has(id)) return false;
      if (unknownOrder(r.Data, perWallet.get(id)) && cashAdjustment(r, candidate => candidate === id)) uncertain = true;
      return afterOpening(r.Data, perWallet.get(id));
    }, unassigned);
    if (uncertain || adjustment && (unknownOrder(r.Data, opening) || unknownOrder(r.Data, closing))) return null;
    total += adjustment;
  }
  return total;
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
  const withCounts = [
    ...plans,
    ...rows.filter(
      (r) =>
        r.Kind === "count" &&
        r.Data.Phase === "Anfang" &&
        !plans.some((p) => p.Data.Wallet === r.Data.Wallet) &&
        (!plans.length || r.Data.Fields?.countScope !== "all"),
    ),
  ];
  return denom.map((cent) => {
    const need = withCounts.reduce(
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
