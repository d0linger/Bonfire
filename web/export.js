import { wordFiles } from "./word-profile.js";
import { invoiceReference, exportContext } from "./context.js";
import { t8, t9, t10 } from "bonfire:validators";
import { tablesFor, renderTables } from "./layouts.js";
import { lineCents } from "./positions.js";
import { fillBackground } from "./lfk.js";
import { mergeText } from "./templates.js";
import { jsPDF } from "jspdf";
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  PageOrientation,
  Table,
  TableRow,
  TableCell,
  WidthType,
  HeightRule,
} from "docx";
import { denom, eur, summary, types, today } from "./domain.js";
import contracts from "./contracts.json" with { type: "json" };
export const profiles = [
  "Werberechnung · Überweisung",
  "Werberechnung · Barzahlung",
  "Spendenbeleg · A6",
  "Getränkekarten · 3 je Seite",
  "Essenskarten · 7 je Seite",
  "Gästepreisliste · Letter",
  "Dankesbrief",
  "Stückelung und Zählung",
  "Veranstaltungsergebnis",
  "Abschlussprüfung",
  "Journal und Belegliste",
];
export const profileID = (i) => contracts[i].id;
const fmt = (value) => (value == null ? "Offen" : String(value));
import { pricesAt } from "./price-history.js";
export function snapshot(index, s, rows, opts) {
  if (index >= 3 && index <= 5) {
    rows = pricesAt(rows, s.priceHistory, opts.priceVersion).filter(
      (r) => r.Kind !== "price" || r.Data.Status === "Freigegeben",
    );
  }
  const chosen = rows.find((r) => r.ID === opts.subject);
  const v = chosen?.Data || {};
  const tpl = (s.pinnedTemplates || rows).find(
    (r) => r.Kind === "template" && r.Data.Reference === profileID(index),
  );
  const config =
    (opts.version === "draft" ? s.drafts?.[profileID(index)] : null) ||
    tpl?.Data ||
    {};
  const org = rows.find((r) => r.Kind === "organization")?.Data;
  const title = config.Label || profiles[index];
  const [width, height] =
    index === 2
      ? [148, 105]
      : index === 5 &&
          (opts.paper === "Profil" || !opts.paper
            ? config.Fields?.paper
            : opts.paper) !== "A4"
        ? [215.9, 279.4]
        : index === 10
          ? [297, 210]
          : [210, 297];
  const lines = [];
  const add = (...parts) => lines.push(parts.map(fmt).join("   "));
  const data = opts.bar ? rows.filter((r) => r.Data.Bar === opts.bar) : rows;
  const money = summary(data);
  const recipientID =
    index === 1
      ? rows.find((r) => r.ID === v.Reference)?.Data.Contact || v.Contact
      : v.Contact;
  const contact = rows.find((r) => r.ID === recipientID)?.Data;
  if (index <= 2 || index === 6) {
    if (!chosen) throw Error("Zugehörigen Fachvorgang auswählen.");
    const allowed =
      index === 0 ? ["sponsorship"] : index === 1 ? ["payment"] : ["donation"];
    if (!allowed.includes(chosen.Kind))
      throw Error("Der Vorgang passt nicht zum gewählten Dokument.");
    if (index === 1 && v.Method !== "Bar")
      throw Error("Barbestätigung erfordert einen erfassten Bareingang.");
    if (index === 2 && (v.Method !== "Bar" || !v.Wallet))
      throw Error(
        "Für einen Barspendenbeleg Geldtasche und Barzahlung erfassen.",
      );
    if (
      opts.number &&
      (!org?.Label || !org.Address || !contact?.Address || !contact?.Label)
    )
      throw Error(
        "Organisation und Empfänger mit Anschrift sind für die Originalausgabe erforderlich.",
      );
    if (org?.Address) add(org.Address);
    add(contact?.Label || "Anonym");
    if (contact?.Address) add(contact.Address);
    add(v.Label);
    add(index === 0 ? "Rechnungsbetrag" : "Eingang", eur(v.Amount));
    add("Datum", v.Date);
    if (index === 0) {
      for (const l of v.Lines || [])
        add(
          l.Description,
          String(l.QuantityMilli / 1000) + " × " + eur(l.UnitCents),
          eur(lineCents(l)),
        );
      if (
        opts.number &&
        (!org.Fields?.IBAN ||
          !org.Fields?.holder ||
          !org.Fields?.legal ||
          !v.Fields?.due ||
          !v.Fields?.service)
      )
        throw Error(
          "Für das Rechnungsoriginal fehlen Kontodaten, Rechtstext, Leistung oder Fälligkeit.",
        );
      if (v.Fields?.service) add("Leistung", v.Fields.service);
      if (v.Fields?.due) add("Fällig am", v.Fields.due);
      if (org?.Fields?.IBAN) add(org.Fields.holder, org.Fields.IBAN);
      if (org?.Fields?.legal) add(org.Fields.legal);
      const paid = rows
        .filter((r) => r.Kind === "payment" && r.Data.Reference === chosen.ID)
        .reduce((n, r) => n + r.Data.Amount, 0);
      add("Bereits bezahlt", eur(paid));
      add("Offen", eur(v.Amount - paid));
      if (paid < v.Amount)
        add("Zahlungsreferenz", invoiceReference(v, opts.number));
    }
    if (index === 1) {
      const parent = rows.find((r) => r.ID === v.Reference);
      if (!parent || !v.Wallet)
        throw Error("Forderung und tatsächliche Barkassa angeben.");
      if (opts.number && (!org.Fields?.legal || !parent.Data.Fields?.service))
        throw Error(
          "Für den Barbeleg fehlen freigegebener Rechtstext oder Leistungszeitraum.",
        );
      const paid = rows
        .filter((r) => r.Kind === "payment" && r.Data.Reference === v.Reference)
        .reduce((n, r) => n + r.Data.Amount, 0);
      add("Bar erhalten", eur(v.Amount));
      add("Verbleibend", eur(parent.Data.Amount - paid));
    }
    if (index === 2 && opts.number && !config.File)
      throw Error("Freigegebener LFK-Druckhintergrund fehlt.");
    if (
      index === 2 &&
      opts.number &&
      (!org?.Fields?.donationLegal || !contact?.Fields?.birth || !v.Reference)
    )
      throw Error(
        "Freigegebener Belegtext, Spenderdaten oder Sammlung fehlen.",
      );
    if (index === 2 && contact?.Fields?.birth)
      add("Geburtsdatum", contact.Fields.birth);
    if (index === 2 && org?.Fields?.donationLegal)
      add(org.Fields.donationLegal);
    if (index === 2) add("Sammlung", v.Reference || "Nicht erfasst");
    if (index === 6) add("Vielen Dank für Ihre Unterstützung.");
  } else if (index >= 3 && index <= 5) {
    const prices = rows.filter(
      (r) =>
        r.Kind === "price" &&
        (index === 5 ||
          r.Data.Category === (index === 3 ? "Getränk" : "Essen")),
    );
    if (!prices.length)
      throw Error("Freigegebene Veranstaltungspreise fehlen.");
    for (const r of prices)
      add(
        [r.Data.Label, r.Data.Variant, r.Data.Unit].filter(Boolean).join(" · "),
        eur(r.Data.Amount),
      );
  } else if (index === 7) {
    if (chosen && !["count", "plan"].includes(chosen.Kind))
      throw Error("Zählung oder Wechselgeldplan auswählen.");
    add(
      chosen
        ? chosen.Kind === "plan"
          ? "Plan"
          : "Erfasste Zählung"
        : "Leeres Zählblatt",
    );
    if (chosen)
      add(
        v.Fields?.countScope === "all" ? "Alle Geldtaschen" : v.Wallet,
        v.Phase,
      );
    if (!chosen || v.Pieces)
      for (const d of denom)
        add(eur(d), chosen ? String(v.Pieces[String(d)] ?? 0) : "________");
    if (chosen) add("Summe", eur(v.Amount));
  } else if (index === 8) {
    add(opts.bar ? "Bar " + opts.bar : "Gesamtveranstaltung");
    add("Erfasste Einnahmen", eur(money.receipts));
    add("Direkte Kosten", eur(money.costs));
    add("Ergebnis aus erfassten Vorgängen", eur(money.result));
  } else if (index === 9) {
    add("Status", s.closed ? "Freigegeben" : "Vorläufig");
    add("Eröffnung", eur(rows.find((r) => r.Kind === "opening")?.Data.Amount));
    add("Zahlungsüberschuss", eur(money.ear));
    const actuals = rows.filter((r) => r.Kind === "actual");
    if (!actuals.length) add("Istbestand", "Offen");
    for (const a of actuals)
      add(a.Data.Account || "Gesamtbestand", eur(a.Data.Amount));
    add("Offene Konflikte im letzten Abgleich", s.conflicts.length);
  } else {
    for (const r of data.filter((r) =>
      [
        "income",
        "expense",
        "transfer",
        "outlay",
        "reimbursement",
        "donation",
        "payment",
        "card",
        "fee",
        "payout",
        "presale",
        "attachment",
      ].includes(r.Kind),
    ))
      add(
        r.Data.Date,
        types[r.Kind],
        r.Data.Label,
        r.Data.Amount == null ? "" : eur(r.Data.Amount),
      );
  }
  const versionID =
    profileID(index) +
    "@" +
    (opts.version === "draft" ? "entwurf" : (tpl?.Revision ?? "standard"));
  const context = exportContext(index, s, rows, {
    ...opts,
    title,
    versionID,
  });
  const validate = { 7: t8, 8: t9, 9: t10 }[index];
  if (validate && !validate(context))
    throw Error(
      "Exportdaten unvollständig: " +
        validate.errors.map((e) => e.instancePath + " " + e.message).join(", "),
    );
  const result = {
    lfk:
      index === 2 && config.File
        ? {
            file: config.File,
            values: [
              eur(v.Amount),
              opts.number || "Entwurf",
              [org?.Label, org?.Address].filter(Boolean).join(", "),
              [contact?.Label, contact?.Address].filter(Boolean).join(", "),
              contact?.Fields?.birth || "",
              today(),
            ],
          }
        : null,
    profile: profileID(index),
    index,
    width,
    height,
    title,
    organization: org?.Label || opts.organization || "Feuerwehr",
    event: s.event.General ? "Allgemeines Kassenbuch" : s.event.Name,
    date: today(),
    number: opts.number || null,
    status: opts.number ? "Original" : "Arbeitsfassung",
    subject: chosen?.ID || null,
    templateVersion: tpl?.Revision ?? 0,
    templateVersionID: versionID,
    font: config.Fields?.font || "helvetica",
    margin: Math.max(8, Math.min(35, Number(config.Fields?.margin) || 15)),
    layoutMargin: config.Fields?.margin
      ? Math.max(8, Math.min(35, Number(config.Fields.margin) || 15))
      : null,
    footer: config.Fields?.footer || "",
    wordLayout: index === 6 ? config.File || null : null,
    cardHeader: config.Fields?.header || s.event.Name,
    copies: Math.min(
      index === 3 ? 3 : 7,
      Math.max(1, Number(config.Fields?.copies) || (index === 3 ? 3 : 7)),
    ),
    firstColumn: Math.min(
      75,
      Math.max(40, Number(config.Fields?.firstColumn) || 60),
    ),
    note: mergeText(config.Note, context),
    context: Object.fromEntries(
      [...contracts[index].required, ...(contracts[index].optional || [])].map(
        (key) => [key, context[key] ?? null],
      ),
    ),
    lines,
  };
  result.tables = tablesFor(index, result, rows, opts.subject, {
    ...opts,
    closed: s.closed,
    accounts: s.event.Accounts,
    pending: s.pending,
    conflicts: s.conflicts.length,
  });
  return result;
}
export async function render(s) {
  if (s.wordLayout) return wordFiles(s.wordLayout, s.context);
  if (s.tables) return renderTables(s);
  const pdf = new jsPDF({
    unit: "mm",
    format: [s.width, s.height],
    orientation: s.width > s.height ? "landscape" : "portrait",
    compress: true,
  });
  const header = [
    s.organization,
    s.title,
    s.event + " · " + s.date,
    s.status + (s.number ? " " + s.number : ""),
  ];
  const doc = [];
  let y = 14;
  function line(text, size = 10, bold = false) {
    pdf.setFont(s.font, bold ? "bold" : "normal");
    pdf.setFontSize(size);
    for (const l of pdf.splitTextToSize(text, s.width - 2 * s.margin)) {
      if (y > s.height - 13) {
        pdf.addPage();
        y = 14;
      }
      pdf.text(l, s.margin, y);
      y += size * 0.48 + 1;
    }
    doc.push(
      new Paragraph({
        children: [
          new TextRun({
            text,
            bold,
            font: {
              helvetica: "Arial",
              times: "Times New Roman",
              courier: "Courier New",
            }[s.font],
            size: size * 2,
          }),
        ],
        spacing: { after: 70 },
      }),
    );
  }
  const card = s.index === 3 || s.index === 4;
  if (!card) {
    header.forEach((t, i) => line(t, i === 1 ? 16 : 10, i === 1));
    if (s.note) line(s.note);
    y += 3;
  }
  const per = s.index === 3 ? 3 : s.index === 4 ? 7 : 0;
  for (const [i, text] of s.lines.entries()) {
    if (per) {
      continue;
    }
    line(text, per ? 15 : 10, !!per);
  }
  const mm = (v) => Math.round((v * 1440) / 25.4);
  if (per) {
    const cap = per === 3 ? 12 : 4,
      top = per === 3 ? 15 : 12.5,
      gap = per === 3 ? 14 : 5.5,
      h = per === 3 ? 74 : 33,
      w = per === 3 ? 125 : 130,
      rh = h / (cap + 1);
    for (let offset = 0; offset < s.lines.length; offset += cap) {
      if (offset) {
        pdf.addPage();
        doc.push(new Paragraph({ pageBreakBefore: true }));
      }
      const content = s.lines
        .slice(offset, offset + cap)
        .map((l) => l.split("   "));
      while (content.length < cap) content.push(["", ""]);
      for (let slot = 0; slot < Math.min(per, s.copies || per); slot++) {
        let cy = top + slot * (h + gap);
        const lines = [
          [s.cardHeader || s.event, "Preis", ""],
          ...content.map(([text, price]) => [text, price, ""]),
        ];
        const wordRows = [];
        for (const cells of lines) {
          let x = 25;
          pdf.setFontSize(9);
          const first = s.firstColumn || 60;
          const widths = [first, 25, w - first - 25];
          const wordCells = [];
          for (let j = 0; j < 3; j++) {
            const text = cells[j] || "";
            if (pdf.getTextWidth(text) > widths[j] - 3)
              throw Error(
                "Kartentext zu lang für die gewählte Spalte: " + text,
              );
            pdf.rect(x, cy, widths[j], rh);
            pdf.text(
              text,
              j === 1 ? x + widths[j] - 1.5 : x + 1.5,
              cy + rh * 0.69,
              { align: j === 1 ? "right" : "left" },
            );
            x += widths[j];
            wordCells.push(
              new TableCell({
                width: { size: mm(widths[j]), type: WidthType.DXA },
                children: [
                  new Paragraph({
                    spacing: { before: 0, after: 0 },
                    children: [new TextRun({ text, size: 18 })],
                  }),
                ],
              }),
            );
          }
          wordRows.push(
            new TableRow({
              height: { value: mm(rh), rule: HeightRule.EXACT },
              children: wordCells,
            }),
          );
          cy += rh;
        }
        doc.push(
          new Table({
            width: { size: mm(w), type: WidthType.DXA },
            rows: wordRows,
          }),
        );
        if (slot < Math.min(per, s.copies || per) - 1)
          doc.push(
            new Paragraph({
              spacing: { line: mm(gap), lineRule: "exact" },
              text: "",
            }),
          );
      }
    }
  }
  if (s.footer && !per) line(s.footer, 9);
  const horizontal = s.width > s.height;
  const word = new Document({
    sections: [
      {
        properties: {
          page: {
            size: {
              width: mm(Math.min(s.width, s.height)),
              height: mm(Math.max(s.width, s.height)),
              orientation: horizontal
                ? PageOrientation.LANDSCAPE
                : PageOrientation.PORTRAIT,
            },
            margin: {
              left: mm(per ? 25 : s.margin),
              right: mm(per ? 15 : s.margin),
              top: mm(per === 3 ? 15 : 12),
              bottom: mm(per ? 7 : 12),
            },
          },
        },
        children: doc,
      },
    ],
  });
  return {
    pdf: s.lfk
      ? await fillBackground(s.lfk.file, s.lfk.values)
      : pdf.output("blob"),
    docx: await Packer.toBlob(word),
  };
}
