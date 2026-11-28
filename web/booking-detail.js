import { eur, financialLabel, summary, types } from "./domain.js";
import { dat, esc } from "./workplace.js";

export const isImportedBooking = (r) => r?.ID.startsWith("import:") && ["income", "expense"].includes(r.Kind);

const pair = (title, value) => "<dt>" + esc(title) + "</dt><dd>" + esc(value || "Not assigned") + "</dd>";

export function sourceDetails(row, entries) {
  if (!isImportedBooking(row)) return "";
  const v = row.Data, fields = v.Fields || {};
  const source = entries.find(r => r.Kind === "import-source" && r.ID === v.Reference);
  const position = row.ID.split(":").at(-1);
  const workbook = /^(\d+)-[A-Z]+(\d+)$/.exec(position);
  const locator = workbook ? "Sheet " + (Number(workbook[1]) + 1) + " · row " + workbook[2] : "Row " + position;
  return '<section class="booking-source"><h3>Import evidence</h3><dl class="booking-facts">' +
    pair("Journal position", locator) + pair("Sheet / cell", [fields.sheet, fields.cell].filter(Boolean).join(" · ")) +
    (source?.Data.Filename ? pair("Source file", source.Data.Filename) : "") +
    (fields.original ? pair("Original value", fields.original) : "") +
    (fields.sourceColumn ? pair("Source column", fields.sourceColumn) : "") +
    (fields.dateOrigin ? pair("Date source", fields.dateOrigin) : "") +
    pair("Original import note", v.ImportNote ?? (row.Revision === 1 ? v.Note : "Original note unavailable")) +
    "</dl></section>";
}

export function bookingDetail(row, entries, event, workspace) {
  const v = row.Data, lookup = new Map(entries.map(item => [item.ID, item]));
  const related = entries.filter(item => item.Data.Reference === row.ID);
  const hasEventAllocations = event.General && row.Kind === "income";
  const contact = lookup.get(v.Contact);
  const effect = summary([row]);
  const docs = related.filter(item => item.Kind === "attachment").map(item => {
    const file = item.Data;
    const url = "/api/booking-evidence?" + new URLSearchParams({event: event.ID, booking: row.ID, file: item.ID});
    return "<li><strong>" + esc(file.Filename || file.Label) + "</strong>" +
      (file.File ? '<div class="actions"><a target="_blank" rel="noopener" href="' + esc(url) +
        '">Open receipt</a><a download href="' + esc(url + "&download=1") + '">Download</a></div>' : " · File pending") + "</li>";
  });
  for (const item of related.filter(item => item.Kind === "original" && item.Data.PDF)) {
    docs.push("<li><strong>" + esc(item.Data.Label) + " · " + esc(item.Data.Number) +
      '</strong> <button type="button" class="secondary" data-format="PDF" data-file="' + esc(item.ID) + '">Save original PDF</button></li>');
  }
  const linked = lookup.get(v.Reference);
  const allocations = Object.entries(v.Allocations || {}).map(([id, n]) =>
    (lookup.get(id)?.Data.Label || "Linked entry") + " · " + eur(n));
  return "<p><strong>" + esc(v.Label) + '</strong></p><dl class="booking-facts">' +
    pair("Date", dat(v.Date)) + pair("Transaction", types[row.Kind]) + pair("Amount", eur(v.Amount)) +
    pair("Net receipts less payments", eur(effect.ear)) + pair("Effect on result", eur(effect.result)) +
    pair("Source workspace", workspace) + pair("Category", v.Category) +
    (v.Method ? pair("Payment method", financialLabel(v.Method)) : "") +
    pair("Account / source", lookup.get(v.Account)?.Data.Label || v.Account) +
    (v.To ? pair("Destination", lookup.get(v.To)?.Data.Label || v.To) : "") +
    pair("Contact", contact?.Kind === "contact" ? contact.Data.Label : v.Contact ? "Linked contact" : "") +
    (hasEventAllocations ? "" : pair("Event", event.General ? "" : event.Name)) +
    (v.Wallet ? pair("Wallet", lookup.get(v.Wallet)?.Data.Label) : "") +
    (v.Bar ? pair("Bar", lookup.get(v.Bar)?.Data.Label) : "") +
    (v.Reference && !isImportedBooking(row) ? pair("Reference", linked?.Data.Label || v.Reference) : "") +
    (allocations.length ? pair("Allocation", allocations.join(" · ")) : "") +
    (v.Note && (!isImportedBooking(row) || row.Revision > 1) ? pair(row.Revision > 1 ? "Correction reason" : "Note", v.Note) : "") +
    "</dl>" + sourceDetails(row, entries) +
    (hasEventAllocations ? '<section><h3>Event allocations</h3><div data-receipt-links role="status">Loading…</div></section>' : "") +
    "<section><h3>Supporting documents</h3>" + (docs.length ? '<ul class="booking-documents">' + docs.join("") + "</ul>" : "<p>No linked documents.</p>") + "</section>";
}
