import { jsPDF } from "jspdf";
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  WidthType,
  ImageRun,
  PageOrientation,
  Footer,
  Header,
  PageNumber,
} from "docx";
import { priceCategoryLabel, financialLabel, eur, types, eventStatementSummary, denom } from "./domain.js";
import { lineCents } from "./positions.js";
import { closure } from "./context.js";
const mm = (v) => Math.round((v * 1440) / 25.4);
export function tablesFor(i, s, rows, subject, opts) {
  const row = rows.find((r) => r.ID === subject),
    v = row?.Data || {},
    org = rows.find((r) => r.Kind === "organization")?.Data;
  const period = rows.find((r) => r.Kind === "period" && r.ID === opts.period);
  const list = rows.filter(
    (r) =>
      (!period ||
        (r.Data.Date >= period.Data.Date && r.Data.Date <= period.Data.To)) &&
      (!opts.bar || r.Data.Bar === opts.bar),
  );
  if (i === 0 || i === 1) {
    const parent = i === 1 ? rows.find((r) => r.ID === v.Reference) : row;
    const bill = parent?.Data || {};
    const contact = rows.find(
      (r) => r.ID === (bill.Contact || v.Contact),
    )?.Data;
    const amount = bill.Amount ?? 0;
    const paid = rows
      .filter((r) => r.Kind === "payment" && r.Data.Reference === parent?.ID)
      .reduce((n, r) => n + r.Data.Amount, 0);
    return {
      invoice: true,
      senderAddress: org?.Address,
      logo: org?.File || "",
      address: [
        contact?.Label || "Recipient pending",
        ...(contact?.Address || "Address pending").split(/\r?\n/),
      ],
      meta: [s.date, s.number ? (i === 0 ? "Invoice " : "Receipt ") + s.number : s.status],
      intro: bill.Fields?.service || bill.Label || v.Label,
      blocks: [
        {
          headers: ["Quantity", "Type", "Amount"],
          widths: [29, 93.5, 37.5],
          rows: (bill.Lines?.length
            ? bill.Lines
            : [
                {
                  Description: bill.Label || v.Label,
                  UnitCents: amount,
                  QuantityMilli: 1000,
                },
              ]
          )
            .map((l) => [
              String(l.QuantityMilli / 1000),
              l.Description,
              eur(lineCents(l)),
            ])
            .concat([["", "Total", eur(amount)]]),
        },
      ],
      after: [
        i === 1
          ? "Cash received on " + v.Date + ": " + eur(v.Amount)
          : "Already paid: " + eur(paid),
        ...(i === 1
          ? [
              "Cash wallet: " +
                (rows.find((r) => r.ID === v.Wallet)?.Data.Label ||
                  "Unassigned"),
            ]
          : []),
        "Outstanding amount: " + eur(amount - paid),
        ...(i === 0 && amount > paid
          ? [
              bill.Fields?.due
                ? "Due on " + bill.Fields.due
                : "Due date pending",
              org?.Fields?.holder,
              org?.Fields?.IBAN,
              "Payment reference: " + s.context["payment.reference"],
            ]
          : []),
        org?.Fields?.legal,
        s.note,
      ].filter(Boolean),
    };
  }
  if (i === 5) {
    const prices = rows.filter(
      (r) => r.Kind === "price" && r.Data.Status === "Freigegeben",
    );
    const blocks = [...new Set(prices.map((r) => r.Data.Category))].map(
      (category) => ({
        headers: [priceCategoryLabel(category), "Unit", "Price"],
        widths: [s.width - 105, 37, 38],
        rows: prices
          .filter((r) => r.Data.Category === category)
          .map(({ Data: d }) => [
            [d.Fields?.guest || d.Label, d.Variant, d.Fields?.allergens, d.Note]
              .filter(Boolean)
              .join(" · "),
            d.Unit,
            eur(d.Amount),
          ]),
      }),
    );
    return { intro: s.event, blocks, after: [s.note].filter(Boolean) };
  }
  if (i === 6) {
    const contact = rows.find((r) => r.ID === v.Contact)?.Data;
    return {
      letter: true,
      address: [
        contact?.Label,
        ...(contact?.Address || "").split(/\r?\n/),
      ].filter(Boolean),
      meta: [s.date],
      intro: contact?.Fields?.salutation || "Dear supporter,",
      blocks: [],
      after: [
        s.note ||
          "Thank you for your support " +
            (v.Amount != null ? "of " + eur(v.Amount) : "") +
            " at " +
            s.event +
            ". Your donation supports the work of our fire brigade.",
        "Yours sincerely",
        s.organization,
      ],
    };
  }
  if (i === 7) {
    const pooled = v.Fields?.countScope === "all";
    const related = rows.filter((r) =>
      pooled
        ? r.Kind === "count" && r.Data.Fields?.countScope === "all"
        : v.Wallet && r.Data.Wallet === v.Wallet,
    );
    const get = (kind, phase) =>
      related.find((r) => r.Kind === kind && r.Data.Phase === phase)?.Data;
    const plan = related.find((r) => r.Kind === "plan")?.Data,
      begin = get("count", "Anfang"),
      end = get("count", "Ende");
    const qty = (c, obj) => (obj?.Pieces ? String(obj.Pieces[c] ?? 0) : "");
    return {
      intro: row
        ? (pooled ? "All wallets · " : "") +
          financialLabel(v.Phase) +
          " · " +
          (financialLabel(v.Status) || "Unconfirmed")
        : "Blank cash count",
      blocks: [
        {
          headers: ["Denomination", "Planned", "Opening", "Closing", "Closing value", "Note"],
          widths: [30, 25, 30, 25, 30, 40],
          rows: denom.map((c) => [
            eur(c),
            qty(c, plan),
            qty(c, begin),
            qty(c, end),
            end?.Pieces ? eur((end.Pieces[c] || 0) * c) : "",
            "",
          ]),
        },
      ],
      after: [
        row
          ? "Counted total: " + eur(v.Amount)
          : "Wallet: ____________________",
        "Counted by: ____________________     Checked by: ____________________",
        v.Status === "Bestätigt"
          ? "Confirmed: " +
            v.Fields?.confirmedBy +
            " · " +
            v.Fields?.confirmedAt
          : "",
      ].filter(Boolean),
    };
  }
  if (i === 8) {
    const bar = rows.find((r) => r.ID === opts.bar);
    const groups = bar ? [bar] : rows.filter((r) => r.Kind === "bar");
    const detail = groups.map((b) => {
      const x = eventStatementSummary(list.filter((r) => r.Data.Bar === b.ID));
      return [b.Data.Label, eur(x.receipts), eur(x.costs), eur(x.result)];
    });
    const all = eventStatementSummary(list);
    if (!bar) {
      const common = eventStatementSummary(list.filter((r) => !r.Data.Bar));
      detail.push([
        "Shared costs",
        eur(common.receipts),
        eur(common.costs),
        eur(common.result),
      ]);
    }
    detail.push([
      bar ? "Direct surplus" : "Whole event",
      eur(all.receipts),
      eur(all.costs),
      eur(all.result),
    ]);
    return {
      intro: bar ? bar.Data.Label : s.event,
      blocks: [
        {
          headers: ["Area", "Receipts", "Costs", "Result"],
          widths: [54, 42, 42, 42],
          rows: detail,
        },
      ],
      after: [
        "Cash surplus: " + eur(all.ear),
        "Outstanding reimbursements: " + eur(all.outstanding),
      ],
    };
  }
  if (i === 9) {
    const result = closure(list, !!opts.accounts, opts.closed, rows)["report.closing"];
    const balances = result.account_lines || [{
      label: "Total balance", theoretical_cents: result.book_balance_cents,
      actual_cents: result.actual_closing_cents, difference_cents: result.difference_cents,
    }];
    const questions = list.filter(r => r.Kind === "source-question" && r.Data.Status !== "Resolved");
    const files = list.filter(r => ["attachment", "original"].includes(r.Kind));
    const complete = files.filter(r => r.Kind === "attachment" ? r.Data.File && !r.Data.uploadPending : r.Data.PDF && r.Data.DOCX);
    return {
      intro: [opts.workspaceName || s.event, period?.Data.Label, period?.Data.Date || opts.starts, period?.Data.To || opts.ends].filter(Boolean).join(" · "),
      blocks: [{
        headers: ["Balance", "Expected", "Actual", "Difference"], widths: [60, 38, 38, 38],
        rows: balances.map(b => [b.label, eur(b.theoretical_cents), eur(b.actual_cents), eur(b.difference_cents)]),
      }],
      after: [
        opts.closed ? "Workspace closed" : "Provisional statement",
        "Independent review: not recorded",
        "Registered documents with complete files: " + complete.length + " / " + files.length,
        "Open source questions in scope: " + questions.length,
        ...questions.map(r => r.Data.Label + " · " + r.Data.Reference),
        "Unresolved conflicts: " + opts.conflicts,
        "Devices awaiting confirmation: " + (opts.pending ?? "Unknown"),
      ],
    };
  }
  if (i === 10) {
    const dates = [period?.Data.Date || opts.starts, period?.Data.To || opts.ends]
      .filter(Boolean).join(" – ");
    return {
      intro: [opts.workspaceName || s.event, period?.Data.Label, dates].filter(Boolean).join(" · "),
      blocks: [
        {
          headers: ["Date", "Type", "Description", "Payment method", "Amount"],
          widths: [30, 46, 118, 44, 35],
          rows: list
            .filter((r) =>
              [
                "income",
                "expense",
                "refund",
                "deposit",
                "deposit-return",
                "transfer",
                "outlay",
                "reimbursement",
                "payment",
                "donation",
                "card",
                "fee",
                "presale",
                "payout",
              ].includes(r.Kind),
            )
            .sort((a, b) => (a.Data.Date || "").localeCompare(b.Data.Date || ""))
            .map((r) => [
              r.Data.Date,
              types[r.Kind],
              r.Data.Label,
              financialLabel(r.Data.Method) || "",
              eur(r.Data.Amount),
            ]),
        },
        {
          headers: ["Document", "Allocation", "Availability"],
          widths: [110, 90, 73],
          rows: list
            .filter((r) => r.Kind === "attachment")
            .map((r) => [
              r.Data.Filename || r.Data.Label,
              rows.find((x) => x.ID === r.Data.Reference)?.Data.Label ||
                "Outstanding",
              r.Data.uploadPending
                ? "Local file, upload pending"
                : r.Data.File
                  ? "Available locally"
                  : "Metadata available, file pending",
            ]),
        },
      ],
      after: [],
    };
  }
  return null;
}

export async function renderTables(s) {
  const spec = s.tables;
  const pdf = new jsPDF({
    unit: "mm",
    format: [s.width, s.height],
    orientation: s.width > s.height ? "landscape" : "portrait",
    compress: true,
  });
  const family = s.font || "helvetica";
  const word = [];
  const point = (size, text, bold = false) =>
    new Paragraph({
      spacing: { after: 60 },
      children: [
        new TextRun({
          text: String(text),
          size: Math.round(size * 2),
          bold,
          font: {
            helvetica: "Arial",
            times: "Times New Roman",
            courier: "Courier New",
          }[family],
        }),
      ],
    });
  const left =
    s.layoutMargin ??
    (spec.invoice || spec.letter ? 25 : s.index === 10 ? 12 : 15);
  const width = s.width - left * 2;
  const top = s.layoutMargin ?? 15,
    bottom = Math.max(17, s.layoutMargin ?? 17);
  let y = top + 3;
  function page() {
    pdf.addPage();
    y = top;
    const size = pdf.getFontSize(),
      face = pdf.getFont();
    pdf.setFont(family, "normal");
    pdf.setFontSize(9);
    const headerLines = pdf.splitTextToSize(
      s.organization + " · " + s.title + " · " + (s.number || s.status),
      width,
    );
    if (headerLines.length > 4)
      throw Error("The header exceeds the space on the following page.");
    pdf.text(headerLines, left, y);
    y += 5 * headerLines.length + 5;
    pdf.setFont(face.fontName, face.fontStyle);
    pdf.setFontSize(size);
  }
  function flow(t, size = 11, bold = false) {
    t = String(t);
    pdf.setFont(family, bold ? "bold" : "normal");
    pdf.setFontSize(size);
    const lines = pdf.splitTextToSize(t, width);
    for (const line of lines) {
      if (y > s.height - bottom - 1) page();
      pdf.text(line, left, y);
      y += size * 0.46 + 1.4;
    }
    word.push(point(size, t, bold));
  }
  if (spec.invoice || spec.letter) {
    if (spec.logo) {
      pdf.addImage(
        "data:image/png;base64," + spec.logo,
        "PNG",
        42,
        25,
        38,
        25,
        undefined,
        "FAST",
      );
      word.push(
        new Paragraph({
          children: [
            new ImageRun({
              type: "png",
              data: Uint8Array.from(atob(spec.logo), (c) => c.charCodeAt(0)),
              transformation: { width: 120, height: 79 },
            }),
          ],
        }),
      );
    }
    y = 66;
    flow(
      [s.organization, spec.senderAddress].filter(Boolean).join(" · "),
      10,
      true,
    );
    if (y > 78) throw Error("The sender address exceeds the address window.");
    const metaX = s.width - left - 60;
    pdf.setFont(family, "normal");
    pdf.setFontSize(12);
    const addressLines = spec.address.flatMap((line) =>
      pdf.splitTextToSize(String(line), metaX - left - 6),
    );
    if (addressLines.length > 6)
      throw Error(
        "The recipient address exceeds the address window. Check its length and line breaks.",
      );
    pdf.text(addressLines, left, 79, { lineHeightFactor: 1.13 });
    for (const line of spec.address) word.push(point(12, line));
    pdf.setFontSize(10);
    const metaLines = spec.meta.flatMap((line) =>
      pdf.splitTextToSize(String(line), 60),
    );
    if (metaLines.length > 7)
      throw Error("The receipt details exceed the address window.");
    pdf.text(metaLines, metaX, 79);
    word.push(point(10, spec.meta.join(" · ")));
    y = Math.max(
      113,
      79 + 5 * Math.max(addressLines.length, metaLines.length) + 6,
    );
    flow(s.title, 16, true);
    y = Math.max(y, 125);
    flow(spec.intro, 13);
    y = spec.letter ? y + 6 : Math.max(y + 6, 147);
  } else {
    flow(s.organization, 10);
    flow(s.title, 16, true);
    flow(spec.intro, 11);
    flow(s.date + " · " + s.status, 9);
    y += 4;
  }
  for (const block of spec.blocks) {
    const font = spec.invoice ? 12 : s.index === 10 ? 9 : 10;
    const tables = [];
    const total = block.widths.reduce((a, b) => a + b, 0);
    const widths = block.widths.map((w) => (w * width) / total);
    function grid(cells, header = false, record = true) {
      pdf.setFont(family, header ? "bold" : "normal");
      pdf.setFontSize(font);
      const lines = cells.map((v, i) =>
        pdf.splitTextToSize(String(v), widths[i] - 4),
      );
      const lh = font * 0.38 + 1;
      const height = Math.max(
        s.index === 7 ? 8 : 7,
        Math.max(...lines.map((l) => l.length)) * lh + 3,
      );
      if (height > s.height - 55)
        throw Error("A table row exceeds the page height.");
      if (y + height > s.height - bottom) {
        page();
        if (!header) grid(block.headers, true, false);
      }
      if (y + height > s.height - bottom)
        throw Error(
          "The table row and repeated header exceed the available page height.",
        );
      pdf.setFont(family, header ? "bold" : "normal");
      pdf.setFontSize(font);
      let x = left;
      for (let j = 0; j < cells.length; j++) {
        const width = widths[j];
        pdf.setDrawColor(155);
        pdf.setLineWidth(0.17);
        if (header) pdf.setFillColor(236, 238, 241);
        pdf.rect(x, y, width, height, header ? "FD" : "S");
        pdf.text(lines[j], x + 2, y + lh, { lineHeightFactor: 1.15 });
        x += width;
      }
      if (record)
        tables.push(
          new TableRow({
            tableHeader: header,
            cantSplit: true,
            children: cells.map(
              (v, i) =>
                new TableCell({
                  width: { size: mm(widths[i]), type: WidthType.DXA },
                  children: [point(font, v, header)],
                }),
            ),
          }),
        );
      y += height;
    }
    grid(block.headers, true);
    for (const row of block.rows) grid(row);
    word.push(
      new Table({
        width: {
          size: mm(width),
          type: WidthType.DXA,
        },
        rows: tables,
      }),
    );
    y += 6;
    word.push(point(4, ""));
  }
  for (const t of spec.after) flow(t, spec.invoice ? 11 : 10);
  for (let i = 1; i <= pdf.getNumberOfPages(); i++) {
    pdf.setPage(i);
    pdf.setFontSize(8);
    const footerLines = pdf.splitTextToSize(
      (s.footer || s.event) + " · " + i + " / " + pdf.getNumberOfPages(),
      width,
    );
    if (footerLines.length > 2)
      throw Error("The footer exceeds the available space.");
    pdf.text(footerLines, left, s.height - 6 - (footerLines.length - 1) * 3.4);
  }
  const wide = s.width > s.height;
  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            size: {
              width: mm(Math.min(s.width, s.height)),
              height: mm(Math.max(s.width, s.height)),
              orientation: wide
                ? PageOrientation.LANDSCAPE
                : PageOrientation.PORTRAIT,
            },
            margin: {
              left: mm(left),
              right: mm(left),
              top: mm(s.layoutMargin ?? (spec.invoice ? 25 : 15)),
              bottom: mm(s.layoutMargin ?? 15),
            },
          },
        },
        headers: {
          default: new Header({
            children: [point(8, s.cardHeader || s.organization)],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                children: [
                  new TextRun({
                    text: (s.footer || s.event) + " · ",
                    size: 16,
                  }),
                  new TextRun({
                    children: [
                      PageNumber.CURRENT,
                      " / ",
                      PageNumber.TOTAL_PAGES,
                    ],
                    size: 16,
                  }),
                ],
              }),
            ],
          }),
        },
        children: word,
      },
    ],
  });
  return { pdf: pdf.output("blob"), docx: await Packer.toBlob(doc) };
}
