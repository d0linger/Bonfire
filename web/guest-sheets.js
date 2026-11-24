import { jsPDF } from "jspdf";
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableCell,
  TableRow,
  WidthType,
  HeightRule,
  BorderStyle,
  AlignmentType,
  TableLayoutType,
} from "docx";

// The two copies use the same wrapped lines and the same physical line height.
export async function guestSheets(s) {
  const pdf = new jsPDF({ unit: "mm", format: [s.width, s.height] });
  const left = 15,
    top = 12,
    lineHeight = 6,
    half = s.height / 2;
  const cap = Math.floor((half - 2 * top) / lineHeight) - 2,
    groups = [[]],
    width = s.width - 2 * left;
  pdf.setFont(s.font, "normal");
  pdf.setFontSize(10);
  for (const block of s.tables.blocks) {
    let heading = true;
    for (const [item, unit, price] of block.rows) {
      const names = pdf.splitTextToSize(item, width * 0.61),
        units = pdf.splitTextToSize(unit || "", width * 0.18);
      const count = Math.max(names.length, units.length, 1);
      if (count + 1 > cap)
        throw Error("Ein Preislisteneintrag ist länger als ein halbes Blatt.");
      if (groups.at(-1).length + count + Number(heading) > cap) {
        groups.push([]);
        heading = true;
      }
      if (heading)
        groups
          .at(-1)
          .push({
            name: block.headers[0],
            unit: "Einheit",
            price: "Preis",
            bold: true,
          });
      heading = false;
      for (let i = 0; i < count; i++)
        groups
          .at(-1)
          .push({
            name: names[i] || "",
            unit: units[i] || "",
            price: i === 0 ? price : "",
          });
    }
  }
  const mm = (n) => Math.round((n * 1440) / 25.4),
    children = [];
  for (const [page, group] of groups.entries()) {
    if (page) pdf.addPage();
    pdf.setDrawColor(190);
    pdf.setLineDashPattern([2, 2]);
    pdf.line(left, half, s.width - left, half);
    for (let copy = 0; copy < 2; copy++) {
      const lines = [
        { name: s.title, bold: true },
        { name: s.event + " · " + (page + 1) + " / " + groups.length },
        ...group,
      ];
      const wordRows = [],
        columns = [0.65, 0.19, 0.16].map((n) => mm(width * n));
      if (page > 0 && copy === 0)
        children.push(
          new Paragraph({
            pageBreakBefore: true,
            spacing: { line: 1, lineRule: "exact", after: 0 },
          }),
        );
      lines.forEach((line, i) => {
        pdf.setFont(s.font, line.bold ? "bold" : "normal");
        pdf.setFontSize(i === 0 ? 14 : 10);
        const y = top + copy * half + i * lineHeight;
        pdf.text(line.name, left, y);
        if (line.unit) pdf.text(line.unit, left + width * 0.65, y);
        if (line.price)
          pdf.text(line.price, left + width, y, { align: "right" });
        const cells = i < 2 ? [line.name] : [line.name, line.unit, line.price];
        wordRows.push(
          new TableRow({
            height: { value: mm(lineHeight), rule: HeightRule.EXACT },
            children: cells.map(
              (text, j) =>
                new TableCell({
                  width: {
                    size: i < 2 ? mm(width) : columns[j],
                    type: WidthType.DXA,
                  },
                  columnSpan: i < 2 ? 3 : 1,
                  children: [
                    new Paragraph({
                      alignment:
                        j === 2 ? AlignmentType.RIGHT : AlignmentType.LEFT,
                      spacing: { before: 0, after: 0 },
                      children: [
                        new TextRun({
                          text: text || "",
                          bold: line.bold,
                          size: i === 0 ? 28 : 20,
                          font:
                            {
                              times: "Times New Roman",
                              courier: "Courier New",
                            }[s.font] || "Arial",
                        }),
                      ],
                    }),
                  ],
                }),
            ),
          }),
        );
      });
      const borders = Object.fromEntries(
        [
          "top",
          "bottom",
          "left",
          "right",
          "insideHorizontal",
          "insideVertical",
        ].map((edge) => [edge, { style: BorderStyle.NONE, size: 0 }]),
      );
      children.push(
        new Table({
          layout: TableLayoutType.FIXED,
          width: { size: mm(width), type: WidthType.DXA },
          columnWidths: columns,
          borders,
          rows: wordRows,
        }),
      );
      if (copy === 0)
        children.push(
          new Paragraph({
            spacing: {
              line: mm(half - lines.length * lineHeight),
              lineRule: "exact",
              before: 0,
              after: 0,
            },
          }),
        );
    }
  }
  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            size: { width: mm(s.width), height: mm(s.height) },
            margin: {
              left: mm(left),
              right: mm(left),
              top: mm(top - 3),
              bottom: mm(6),
            },
          },
        },
        children,
      },
    ],
  });
  return { pdf: pdf.output("blob"), docx: await Packer.toBlob(doc) };
}
