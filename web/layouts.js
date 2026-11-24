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
import { eur, types, summary, denom } from "./domain.js";
import { lineCents } from "./positions.js";
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
        contact?.Label || "Empfänger offen",
        contact?.Address || "Anschrift offen",
      ],
      meta: [s.date, s.number ? "Beleg " + s.number : s.status],
      intro: bill.Fields?.service || bill.Label || v.Label,
      blocks: [
        {
          headers: ["Anzahl", "Art", "Betrag"],
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
            .concat([["", "Gesamt", eur(amount)]]),
        },
      ],
      after: [
        i === 1
          ? "Bar erhalten am " + v.Date + ": " + eur(v.Amount)
          : "Bereits bezahlt: " + eur(paid),
        ...(i === 1
          ? [
              "Barkassa: " +
                (rows.find((r) => r.ID === v.Wallet)?.Data.Label ||
                  "Zuordnung offen"),
            ]
          : []),
        "Offener Betrag: " + eur(amount - paid),
        ...(i === 0 && amount > paid
          ? [
              bill.Fields?.due
                ? "Fällig am " + bill.Fields.due
                : "Fälligkeit offen",
              org?.Fields?.holder,
              org?.Fields?.IBAN,
              "Verwendungszweck: " + s.context["payment.reference"],
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
        headers: [category, "Einheit", "Preis"],
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
      address: [contact?.Label, contact?.Address].filter(Boolean),
      meta: [s.date],
      intro: contact?.Fields?.salutation || "Guten Tag,",
      blocks: [],
      after: [
        s.note ||
          "herzlichen Dank für Ihre Unterstützung " +
            (v.Amount != null ? "in Höhe von " + eur(v.Amount) : "") +
            " bei " +
            s.event +
            ". Ihre Spende unterstützt die Arbeit unserer Feuerwehr.",
        "Mit freundlichen Grüßen",
        s.organization,
      ],
    };
  }
  if (i === 7) {
    const related = rows.filter((r) => v.Wallet && r.Data.Wallet === v.Wallet);
    const get = (kind, phase) =>
      related.find((r) => r.Kind === kind && r.Data.Phase === phase)?.Data;
    const plan = related.find((r) => r.Kind === "plan")?.Data,
      begin = get("count", "Anfang"),
      end = get("count", "Ende");
    const qty = (c, obj) => (obj ? String(obj.Pieces?.[c] ?? 0) : "");
    return {
      intro: row
        ? v.Phase + " · " + (v.Status || "Unbestätigt")
        : "Leeres Zählblatt",
      blocks: [
        {
          headers: ["Nennwert", "Plan", "Anfang", "Ende", "Wert Ende", "Notiz"],
          widths: [30, 25, 30, 25, 30, 40],
          rows: denom.map((c) => [
            eur(c),
            qty(c, plan),
            qty(c, begin),
            qty(c, end),
            end ? eur((end.Pieces?.[c] || 0) * c) : "",
            "",
          ]),
        },
      ],
      after: [
        row
          ? "Erfasste Summe: " + eur(v.Amount)
          : "Geldtasche: ____________________",
        "Erfassung: ____________________     Gegenprüfung: ____________________",
        v.Status === "Bestätigt"
          ? "Bestätigt: " +
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
      const x = summary(list.filter((r) => r.Data.Bar === b.ID));
      return [b.Data.Label, eur(x.receipts), eur(x.costs), eur(x.result)];
    });
    const all = summary(list);
    if (!bar) {
      const common = summary(list.filter((r) => !r.Data.Bar));
      detail.push([
        "Gemeinsam",
        eur(common.receipts),
        eur(common.costs),
        eur(common.result),
      ]);
    }
    detail.push([
      bar ? "Direkter Überschuss" : "Gesamtveranstaltung",
      eur(all.receipts),
      eur(all.costs),
      eur(all.result),
    ]);
    return {
      intro: bar ? bar.Data.Label : s.event,
      blocks: [
        {
          headers: ["Bereich", "Eingänge", "Kosten", "Ergebnis"],
          widths: [54, 42, 42, 42],
          rows: detail,
        },
      ],
      after: [
        "Zahlungsüberschuss: " + eur(all.ear),
        "Offene Privatauslagen: " + eur(all.outstanding),
      ],
    };
  }
  if (i === 9) {
    const balance = new Map(),
      actual = new Map();
    for (const r of list) {
      const d = r.Data,
        k = opts.accounts ? d.Account || "Nicht zugeordnet" : "Gesamtbestand";
      if (d.Amount == null) continue;
      if (r.Kind === "actual") {
        actual.set(k, (actual.get(k) || 0) + d.Amount);
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
      ].includes(r.Kind)
        ? 1
        : [
              "expense",
              "reimbursement",
              "fee",
              "refund",
              "deposit-return",
            ].includes(r.Kind)
          ? -1
          : 0;
      if (sign) balance.set(k, (balance.get(k) || 0) + sign * d.Amount);
      if (
        opts.accounts &&
        ["transfer", "supply", "skim", "return", "payout"].includes(r.Kind)
      ) {
        balance.set(k, (balance.get(k) || 0) - d.Amount);
        balance.set(d.To, (balance.get(d.To) || 0) + d.Amount);
      }
    }
    const keys = new Set([...balance.keys(), ...actual.keys()]);
    if (!keys.size) keys.add("Gesamtbestand");
    const incomplete = keys.has("Nicht zugeordnet");
    return {
      intro: period ? period.Data.Label : s.event,
      blocks: [
        {
          headers: ["Bestand", "Soll", "Ist", "Differenz"],
          widths: [60, 38, 38, 38],
          rows: [...keys].map((k) => {
            const a = actual.get(k),
              b = incomplete ? null : balance.get(k);
            return [
              k,
              eur(b),
              eur(a),
              eur(a == null || b == null ? null : a - b),
            ];
          }),
        },
      ],
      after: [
        opts.closed
          ? "Veranstaltungsabschluss bestätigt"
          : "Vorläufiger Arbeitsstand",
        "Offene Konflikte im letzten Abgleich: " + opts.conflicts,
        "Geräte ohne bestätigtes Ende: " + (opts.pending ?? "Unbekannt"),
      ],
    };
  }
  if (i === 10) {
    return {
      intro: period
        ? period.Data.Label
        : "Gesamter lokaler Veranstaltungsstand",
      blocks: [
        {
          headers: ["Datum", "Art", "Beschreibung", "Zahlungsart", "Betrag"],
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
            .map((r) => [
              r.Data.Date,
              types[r.Kind],
              r.Data.Label,
              r.Data.Method || "",
              eur(r.Data.Amount),
            ]),
        },
        {
          headers: ["Beleg", "Zuordnung", "Verfügbarkeit"],
          widths: [110, 90, 73],
          rows: list
            .filter((r) => r.Kind === "attachment")
            .map((r) => [
              r.Data.Filename || r.Data.Label,
              rows.find((x) => x.ID === r.Data.Reference)?.Data.Label ||
                "Offen",
              r.Data.uploadPending
                ? "Lokal, Upload ausständig"
                : r.Data.File
                  ? "Lokal verfügbar"
                  : "Metadaten, Datei ausständig",
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
    bottom = s.layoutMargin ?? 17;
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
      throw Error("Kopfzeile zu lang für die Folgeseite.");
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
    if (y > 78) throw Error("Absender passt nicht in das Adressfenster.");
    const metaX = s.width - left - 60;
    pdf.setFont(family, "normal");
    pdf.setFontSize(12);
    const addressLines = spec.address.flatMap((line) =>
      pdf.splitTextToSize(String(line), metaX - left - 6),
    );
    if (addressLines.length > 6)
      throw Error(
        "Empfängeranschrift passt nicht in das Adressfenster. Zeilen und Länge vor Ausgabe prüfen.",
      );
    pdf.text(addressLines, left, 79, { lineHeightFactor: 1.13 });
    for (const line of spec.address) word.push(point(12, line));
    pdf.setFontSize(10);
    const metaLines = spec.meta.flatMap((line) =>
      pdf.splitTextToSize(String(line), 60),
    );
    if (metaLines.length > 7)
      throw Error("Belegangaben überschreiten das Adressfenster.");
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
        throw Error("Tabellenzeile überschreitet die Seitenhöhe.");
      if (y + height > s.height - bottom) {
        page();
        if (!header) grid(block.headers, true, false);
      }
      if (y + height > s.height - bottom)
        throw Error(
          "Tabellenzeile passt mit dem wiederholten Tabellenkopf auf keine Folgeseite.",
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
      throw Error("Fußzeile überschreitet den verfügbaren Platz.");
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
