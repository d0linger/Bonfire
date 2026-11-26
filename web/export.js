import { guestSheets } from "./guest-sheets.js";
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
import { financialLabel, denom, eur, summary, types, today } from "./domain.js";
import contracts from "./contracts.json" with { type: "json" };
export const profiles = [
  "Sponsorship invoice · bank transfer",
  "Sponsorship invoice · cash",
  "Donation receipt · A6",
  "Drinks price cards · 3 per page",
  "Food price cards · 7 per page",
  "Guest price list · Letter",
  "Thank-you letter",
  "Cash denomination count",
  "Event financial statement",
  "Closing reconciliation",
  "Journal and supporting documents",
];
export const profileID = (i) =>
  i === 11
    ? "payment_confirmation_a4"
    : i === 12
      ? "donation_confirmation_a4"
      : contracts[i].id;
const fmt = (value) => (value == null ? "Outstanding" : String(value));
import { pricesAt } from "./price-history.js";
export function snapshot(index, s, rows, opts) {
  if (index >= 3 && index <= 5) {
    rows = pricesAt(rows, s.priceHistory, opts.priceVersion).filter(
      (r) => r.Kind !== "price" || r.Data.Status === "Freigegeben",
    );
  }
  const chosen = rows.find((r) => r.ID === opts.subject);
  const v = chosen?.Data || {};
  if (index === 11 || index === 12) {
    if (chosen?.Kind !== (index === 11 ? "payment" : "donation"))
      throw Error("Choose the corresponding payment.");
    const org = rows.find((r) => r.Kind === "organization")?.Data;
    const recipient = rows.find(
      (r) =>
        r.Kind === "contact" &&
        r.ID ===
          (opts.recipient ||
            v.Contact ||
            rows.find((p) => p.ID === v.Reference)?.Data.Contact),
    )?.Data;
    if (
      opts.number &&
      (!org?.Label || !org.Address || !recipient?.Label || !recipient.Address)
    )
      throw Error("Enter the addresses of the fire brigade and the recipient.");
    const title = index === 11 ? "Payment confirmation" : "Donation confirmation";
    return {
      index,
      profile: profileID(index),
      title,
      width: 210,
      height: 297,
      organization: org?.Label || "Fire brigade",
      event: s.event.Name,
      subject: chosen.ID,
      date: today(),
      number: opts.number || null,
      status: opts.number ? "Original" : "Working copy",
      font: "helvetica",
      margin: 20,
      lines: [],
      context: {},
      receivedCents: v.Amount,
      tables: {
        letter: true,
        senderAddress: org?.Address || "",
        address: [
          recipient?.Label,
          ...(recipient?.Address || "").split(/\r?\n/),
        ].filter(Boolean),
        meta: [today(), opts.number ? "Receipt " + opts.number : "Preview"],
        intro: "We acknowledge receipt of " + eur(v.Amount) + ".",
        blocks: [
          {
            headers: ["Date", "Payment method", "Payment reference", "Received"],
            widths: [30, 32, 76, 32],
            rows: [[v.Date, financialLabel(v.Method) || "—", v.Label, eur(v.Amount)]],
          },
        ],
        after: [org?.Label || "Fire brigade"],
      },
    };
  }
  const tpl = (s.pinnedTemplates || rows).find(
    (r) => r.Kind === "template" && r.Data.Reference === profileID(index),
  );
  const config =
    (opts.version === "draft" ? s.drafts?.[profileID(index)] : null) ||
    tpl?.Data ||
    {};
  const org = rows.find((r) => r.Kind === "organization")?.Data;
  const title =
    index === 0 && v.Fields?.claimType === "invoice"
      ? "Invoice"
      : config.Label || profiles[index];
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
  const priceCards = [];
  const add = (...parts) => lines.push(parts.map(fmt).join("   "));
  const data = opts.bar ? rows.filter((r) => r.Data.Bar === opts.bar) : rows;
  const money = summary(data);
  const recipientID =
    index === 1
      ? rows.find((r) => r.ID === v.Reference)?.Data.Contact || v.Contact
      : v.Contact;
  const contact = rows.find((r) => r.ID === recipientID)?.Data;
  if (index <= 2 || index === 6) {
    if (!chosen) throw Error("Choose the related transaction.");
    const allowed =
      index === 0 ? ["sponsorship"] : index === 1 ? ["payment"] : ["donation"];
    if (!allowed.includes(chosen.Kind))
      throw Error("The transaction does not match the selected document.");
    if (index === 1 && v.Method !== "Bar")
      throw Error("A cash receipt requires a recorded cash payment.");
    if (index === 2 && (v.Method !== "Bar" || !v.Wallet))
      throw Error(
        "Record the cash donation and its wallet before issuing a receipt.",
      );
    if (
      opts.number &&
      (!org?.Label || !org.Address || !contact?.Address || !contact?.Label)
    )
      throw Error(
        "Enter the organization and recipient addresses before issuing the original.",
      );
    if (org?.Address) add(org.Address);
    add(contact?.Label || "Anonymous");
    if (contact?.Address) add(contact.Address);
    add(v.Label);
    add(index === 0 ? "Invoice amount" : "Received", eur(v.Amount));
    add("Date", v.Date);
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
          "Enter the account details, legal text, service and due date before issuing the invoice.",
        );
      if (v.Fields?.service) add("Service", v.Fields.service);
      if (v.Fields?.due) add("Due on", v.Fields.due);
      if (org?.Fields?.IBAN) add(org.Fields.holder, org.Fields.IBAN);
      if (org?.Fields?.legal) add(org.Fields.legal);
      const paid = rows
        .filter((r) => r.Kind === "payment" && r.Data.Reference === chosen.ID)
        .reduce((n, r) => n + r.Data.Amount, 0);
      add("Already paid", eur(paid));
      add("Outstanding", eur(v.Amount - paid));
      if (paid < v.Amount)
        add("Payment reference", invoiceReference(v, opts.number));
    }
    if (index === 1) {
      const parent = rows.find((r) => r.ID === v.Reference);
      if (!parent || !v.Wallet)
        throw Error("Choose the receivable and the cash register that received the payment.");
      if (opts.number && (!org.Fields?.legal || !parent.Data.Fields?.service))
        throw Error(
          "Enter the approved legal text and service period for the cash receipt.",
        );
      const paid = rows
        .filter((r) => r.Kind === "payment" && r.Data.Reference === v.Reference)
        .reduce((n, r) => n + r.Data.Amount, 0);
      add("Cash received", eur(v.Amount));
      add("Remaining", eur(parent.Data.Amount - paid));
    }
    if (index === 2 && opts.number && !config.File)
      throw Error("Add the approved LFK print background.");
    if (
      index === 2 &&
      opts.number &&
      (!org?.Fields?.donationLegal || !contact?.Fields?.birth || !v.Reference)
    )
      throw Error(
        "Enter the approved receipt text, donor details and collection.",
      );
    if (index === 2 && s.donorAccess && contact?.Fields?.birth)
      add("Date of birth", contact.Fields.birth);
    if (index === 2 && org?.Fields?.donationLegal)
      add(org.Fields.donationLegal);
    if (index === 2) add("Collection", v.Reference || "Unrecorded");
    if (index === 6) add("Thank you for your support.");
  } else if (index >= 3 && index <= 5) {
    const prices = rows.filter(
      (r) =>
        r.Kind === "price" &&
        (index === 5 ||
          r.Data.Category === (index === 3 ? "Getränk" : "Essen")),
    );
    if (!prices.length)
      throw Error("Approve event prices before generating a price list.");
    for (const r of prices) {
      const label = [r.Data.Label, r.Data.Variant, r.Data.Unit].filter(Boolean).join(" · ");
      const price = eur(r.Data.Amount);
      priceCards.push([label, price]);
      add(label, price);
    }
  } else if (index === 7) {
    if (chosen && !["count", "plan"].includes(chosen.Kind))
      throw Error("Select a cash count or change float plan.");
    add(
      chosen
        ? chosen.Kind === "plan"
          ? "Plan"
          : "Recorded count"
        : "Blank cash count",
    );
    if (chosen)
      add(
        v.Fields?.countScope === "all" ? "All wallets" : v.Wallet,
        financialLabel(v.Phase),
      );
    if (!chosen || v.Pieces)
      for (const d of denom)
        add(eur(d), chosen ? String(v.Pieces[String(d)] ?? 0) : "________");
    if (chosen) add("Total", eur(v.Amount));
  } else if (index === 8) {
    add(opts.bar ? "Bar " + opts.bar : "Whole event");
    add("Recorded income", eur(money.receipts));
    add("Direct costs", eur(money.costs));
    add("Net result from recorded entries", eur(money.result));
  } else if (index === 9) {
    add("Status", s.closed ? "Approved" : "Provisional");
    add("Opening balance", eur(rows.find((r) => r.Kind === "opening")?.Data.Amount));
    add("Cash surplus", eur(money.ear));
    const actuals = rows.filter((r) => r.Kind === "actual");
    if (!actuals.length) add("Actual balance", "Outstanding");
    for (const a of actuals)
      add(a.Data.Account || "Total balance", eur(a.Data.Amount));
    add("Unresolved conflicts", s.conflicts.length);
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
  const copies = Math.min(index === 3 ? 3 : 7, Math.max(1, Math.trunc(Number(config.Fields?.copies)) || (index === 3 ? 3 : 7)));
  const context = exportContext(index, s, rows, {
    copies,
    ...opts,
    title,
    versionID,
  });
  const validate = { 7: t8, 8: t9, 9: t10 }[index];
  if (validate && !validate(context))
    throw Error(
      "Incomplete export data: " +
        validate.errors.map((e) => e.instancePath + " " + e.message).join(", "),
    );
  const result = {
    lfk:
      index === 2 && config.File
        ? {
            file: config.File,
            values: [
              eur(v.Amount),
              opts.number || "Draft",
              [org?.Label, org?.Address].filter(Boolean).join(", "),
              [contact?.Label, contact?.Address].filter(Boolean).join(", "),
              s.donorAccess ? contact?.Fields?.birth || "" : "",
              today(),
            ],
          }
        : null,
    profile: profileID(index),
    index,
    width,
    height,
    title,
    organization: org?.Label || opts.organization || "Fire brigade",
    event: s.event.General ? "General cashbook" : s.event.Name,
    date: today(),
    number: opts.number || null,
    status: opts.number ? "Original" : "Working copy",
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
    guestCopies: index === 5 && Number(opts.guestCopies) === 2 ? 2 : 1,
    copies,
    priceCards,
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
    workspaceName: s.event.Name,
    starts: s.event.Starts,
    ends: s.event.Ends,
    closed: s.closed,
    accounts: s.event.Accounts,
    pending: s.pending,
    conflicts: s.conflicts.length,
  });
  return result;
}
export async function render(s) {
  if (s.index === 5 && s.guestCopies === 2) return guestSheets(s);
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
  if (!per) {
    for (const text of s.lines) line(text, 10, false);
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
      const content = s.priceCards
        ? s.priceCards.slice(offset, offset + cap)
        : s.lines.slice(offset, offset + cap).map((line) => {
            const split = line.lastIndexOf("   ");
            return split < 0 ? [line, ""] : [line.slice(0, split), line.slice(split + 3)];
          });
      while (content.length < cap) content.push(["", ""]);
      for (let slot = 0; slot < Math.min(per, s.copies || per); slot++) {
        let cy = top + slot * (h + gap);
        const lines = [
          [s.cardHeader || s.event, "Price", ""],
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
                "Card text exceeds the column width: " + text,
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
