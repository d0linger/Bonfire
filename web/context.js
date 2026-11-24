import { types, denom, today } from "./domain.js";
import { lineCents } from "./positions.js";
import registry from "./variables.json" with { type: "json" };

export function invoiceReference(bill, number) {
  return (
    bill.Fields?.paymentRef?.trim() ||
    bill.Reference?.trim() ||
    (number ? "Rechnung " + number : bill.Label)
  );
}

export function closure(rows, accounts, approved) {
  const expected = new Map(),
    observed = new Map();
  let date = null,
    opening = false,
    doubled = false;
  for (const { Kind: k, Data: d } of rows) {
    if (d.Amount == null) continue;
    const id = accounts ? d.Account || "" : "Gesamt";
    if (k === "opening") opening = true;
    if (k === "actual") {
      if (observed.has(id)) doubled = true;
      observed.set(id, d.Amount);
      if (!date || d.Date > date) date = d.Date;
      continue;
    }
    const sign = [
      "income",
      "donation",
      "payment",
      "presale",
      "card",
      "opening",
      "deposit",
    ].includes(k)
      ? 1
      : [
            "expense",
            "fee",
            "reimbursement",
            "refund",
            "deposit-return",
          ].includes(k)
        ? -1
        : 0;
    if (sign) expected.set(id, (expected.get(id) || 0) + d.Amount * sign);
    if (
      accounts &&
      ["transfer", "payout", "supply", "skim", "return", "cashback"].includes(k)
    ) {
      expected.set(id, (expected.get(id) || 0) - d.Amount);
      expected.set(d.To, (expected.get(d.To) || 0) + d.Amount);
    }
  }
  const ids = new Set([...expected.keys(), ...observed.keys()]);
  const complete =
    accounts &&
    ids.size > 0 &&
    [...ids].every((k) =>
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(k),
    );
  const known =
    opening &&
    !doubled &&
    observed.size > 0 &&
    [...ids].every((k) => observed.has(k) && expected.has(k)) &&
    (!accounts || complete);
  const status = known ? "confirmed" : observed.size ? "partial" : "missing";
  const add = (m) => [...m.values()].reduce((a, b) => a + b, 0);
  const lines = accounts
    ? [...ids]
        .filter((k) => /^[a-f0-9-]{36}$/.test(k))
        .map((k) => ({
          account_id: k,
          label: rows.find((r) => r.ID === k)?.Data.Label || k,
          actual_status: observed.has(k) ? "confirmed" : "missing",
          theoretical_cents: complete ? (expected.get(k) ?? 0) : null,
          actual_cents: observed.get(k) ?? null,
          difference_cents:
            complete && observed.has(k)
              ? observed.get(k) - (expected.get(k) ?? 0)
              : null,
        }))
    : null;
  return {
    "report.closing": {
      actual_status: status,
      actual_closing_cents: known ? add(observed) : null,
      difference_cents: known ? add(observed) - add(expected) : null,
      actual_as_of: known ? date : null,
      account_allocation_enabled: accounts,
      account_allocation_complete: complete,
      account_lines: lines,
    },
    "report.review": { status: known && approved ? "approved" : "preparation" },
    "report.export_set": {
      completeness_status: known && approved ? "complete" : "incomplete",
    },
  };
}

export function exportContext(i, s, rows, opts) {
  const r = rows.find((r) => r.ID === opts.subject),
    v = r?.Data || {},
    p = i === 1 ? rows.find((x) => x.ID === v.Reference) : r,
    bill = p?.Data || {},
    org = rows.find((x) => x.Kind === "organization")?.Data || {},
    recipient =
      rows.find((x) => x.ID === (bill.Contact || v.Contact))?.Data || {},
    period = rows.find((x) => x.ID === opts.period)?.Data;
  const selected = period
    ? rows.filter((x) => x.Data.Date >= period.Date && x.Data.Date <= period.To)
    : rows;
  const prices = rows
    .filter((x) => x.Kind === "price")
    .map((x) => ({
      internal_label: x.Data.Label,
      guest_label: x.Data.Fields?.guest || x.Data.Label,
      variant: x.Data.Variant,
      unit: x.Data.Unit,
      price_cents: x.Data.Amount,
      allergens: x.Data.Fields?.allergens || "",
      side_or_supplier_note: x.Data.Note || "",
    }));
  const lines = bill.Lines?.length
    ? bill.Lines.map((l) => ({
        quantity: l.QuantityMilli / 1000,
        description: l.Description,
        unit_price_cents: l.UnitCents,
        amount_cents: lineCents(l),
      }))
    : [
        {
          quantity: 1,
          description: bill.Label,
          unit_price_cents: bill.Amount,
          amount_cents: bill.Amount,
        },
      ];
  const mode =
    i === 7
      ? !r
        ? "blank"
        : r.Kind === "plan"
          ? "plan"
          : v.Status === "Bestätigt"
            ? "confirmed"
            : "unconfirmed"
      : i === 8
        ? opts.bar
          ? "bar"
          : "event"
        : undefined;
  const result = Object.fromEntries(
    registry.map((x) => [x.token.slice(2, -2), null]),
  );
  Object.assign(result, {
    "organization.name": org.Label || opts.organization || "Feuerwehr",
    "organization.address": org.Address,
    "organization.logo_asset_id": org.File ? "organization" : null,
    "organization.contact": org.Fields?.contact,
    "recipient.display_name": recipient.Label,
    "recipient.address": recipient.Address,
    "recipient.salutation": recipient.Fields?.salutation,
    "document.id": opts.documentID || crypto.randomUUID(),
    "document.number": opts.number || null,
    "document.issue_date": today(),
    "document.issue_place": org.Fields?.place,
    "document.service_date_or_period": bill.Fields?.service,
    "document.title": opts.title,
    "document.notes": v.Note,
    "document.predecessor_id": v.Fields?.predecessor,
    "event.id": s.event.ID,
    "event.name": s.event.Name,
    "event.date_or_period": [s.event.Starts, s.event.Ends],
    "event.template_bundle_version_id": opts.versionID,
    "invoice.lines": lines,
    "invoice.total_cents": bill.Amount,
    "invoice.due_date": bill.Fields?.due,
    "payment.mode": v.Method,
    "payment.confirmation_id": ["payment", "donation"].includes(r?.Kind)
      ? r.ID
      : null,
    "payment.received_date": v.Date,
    "payment.received_cents": v.Amount,
    "payment.cash_account_id": v.Wallet,
    "payment.account_holder": org.Fields?.holder,
    "payment.bank_name": org.Fields?.bank,
    "payment.iban": org.Fields?.IBAN,
    "payment.reference":
      i === 0 ? invoiceReference(bill, opts.number) : v.Reference,
    "donation.id": r?.Kind === "donation" ? r.ID : null,
    "donation.amount_cents": r?.Kind === "donation" ? v.Amount : null,
    "donor.given_name": recipient.Fields?.given,
    "donor.family_name": recipient.Fields?.family,
    "donor.address": recipient.Address,
    "donation.reporting_status": v.Status,
    "collector.display_name":
      mode === "confirmed" ? v.Fields?.confirmedBy : v.Reference,
    "collector.signature": v.Fields?.signature,
    "legal.invoice_tax_block_id": org.Fields?.legal,
    "legal.donation_receipt_block_id": org.Fields?.donationLegal,
    "purpose.text_block_id": org.Fields?.purpose,
    "price_list.version_id": rows
      .filter((x) => x.Kind === "price")
      .map((x) => x.ID + "@" + x.Revision)
      .join(","),
    "price_list.sections": [
      ...new Set(
        rows.filter((x) => x.Kind === "price").map((x) => x.Data.Category),
      ),
    ],
    "print_batch.copies":
      i === 3
        ? 3
        : i === 4
          ? 7
          : i === 5 && Number(opts.guestCopies) === 2
            ? 2
            : 1,
    "print_batch.header_label": opts.title,
    "print_batch.header_value": s.event.Name,
    "print_batch.third_column_label": "",
    "wallet.id": v.Wallet || null,
    "bar.id": i === 8 ? opts.bar || null : v.Bar || null,
    "cash_count.lines":
      i === 7 && r && v.Pieces
        ? denom.map((n) => ({
            denomination_cents: n,
            count: v.Pieces?.[n] ?? 0,
          }))
        : [],
    "cash_count.manual_total_cents": v.Amount,
    "cash_count.phase": v.Phase || null,
    "cash_count.confirmed_at":
      mode === "confirmed" ? v.Fields?.confirmedAt : null,
    cash_movements: selected
      .filter((x) =>
        ["supply", "skim", "return", "cashback", "transfer"].includes(x.Kind),
      )
      .map((x) => ({ id: x.ID, kind: x.Kind, cents: x.Data.Amount })),
    "report.period": period
      ? { start: period.Date, end: period.To }
      : { start: s.event.Starts, end: s.event.Ends },
    "report.journal_rows": selected
      .filter((x) => x.Data.Amount != null)
      .map((x) => ({
        id: x.ID,
        art: types[x.Kind],
        datum: x.Data.Date,
        betrag: x.Data.Amount,
      })),
    "report.evidence_items": selected
      .filter((x) => x.Kind === "attachment")
      .map((x) => ({ id: x.ID, name: x.Data.Filename })),
    ...closure(selected, s.event.Accounts, !!s.closed && !period),
    render_mode: mode,
  });
  if (i === 2 && s.donorAccess)
    result["donor.birth_date"] = recipient.Fields?.birth;
  for (const key of [
    "quantity",
    "description",
    "unit_price_cents",
    "amount_cents",
  ])
    result["invoice.lines[]." + key] = lines.map((l) => l[key]);
  for (const key of [
    "internal_label",
    "guest_label",
    "variant",
    "unit",
    "price_cents",
    "allergens",
    "side_or_supplier_note",
  ])
    result["price_list.items[]." + key] = prices.map((p) => p[key]);
  return result;
}
