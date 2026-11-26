import { officeFiles } from "./exchange.js";
import { cents } from "./domain.js";
const parse = (bytes) => {
  const source = new TextDecoder().decode(bytes);
  if (/<!ENTITY|<!DOCTYPE/i.test(source))
    throw Error("Invalid XML declaration.");
  const doc = new DOMParser().parseFromString(source, "application/xml");
  if (doc.querySelector("parsererror")) throw Error("Invalid XML.");
  return doc;
};
const all = (node, name) => [...node.getElementsByTagNameNS("*", name)];
const excluded = (text) => /gemeinde|globalbudget/i.test(text);
function sourceCents(value) {
  if (!/^-?\d+(?:[.,]\d{1,2})?$/.test(value)) return null;
  try {
    return (value.startsWith("-") ? -1 : 1) * cents(value.replace(/^-/, ""));
  } catch {
    return null;
  }
}
function simpleSum(formula, cells) {
  const m = /^(?:SUM|SUMME)\(\$?([A-Z]+)\$?(\d+):\$?([A-Z]+)\$?(\d+)\)$/i.exec(
    formula.trim(),
  );
  if (!m || m[1] !== m[3]) return null;
  const start = Number(m[2]), end = Number(m[4]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
      start < 1 || end > 1048576 || start > end || end - start > 10000) return null;
  let total = 0n;
  for (let i = start; i <= end; i++) {
    const cell = cells.get(m[1].toUpperCase() + i);
    if (!cell || (cell.value === "" && cell.formula === null)) continue;
    if (cell.formula !== null || cell.type !== "n") return null;
    const n = sourceCents(cell.value);
    if (n === null) return null;
    total += BigInt(n);
  }
  return Number.isSafeInteger(Number(total)) ? Number(total) : null;
}
export async function historyPreview(file, role, year) {
  if (file.size > 4 << 20) throw Error("The file exceeds 4 MiB.");
  if (!/^\d{4}$/.test(year))
    throw Error("Enter the year of the historical records.");
  const bytes = new Uint8Array(await file.arrayBuffer()),
    files = officeFiles(bytes);
  const book = parse(files["xl/workbook.xml"]),
    rels = parse(files["xl/_rels/workbook.xml.rels"]);
  if (!["D1", "D8"].includes(role)) throw Error("Unknown source role.");
  const date1904 = ["1", "true"].includes(
    all(book, "workbookPr")[0]?.getAttribute("date1904"),
  );
  const dateStyle = new Set();
  if (files["xl/styles.xml"]) {
    const styles = parse(files["xl/styles.xml"]);
    const custom = new Map(
      all(styles, "numFmt").map((f) => [
        Number(f.getAttribute("numFmtId")),
        f.getAttribute("formatCode") || "",
      ]),
    );
    const xfs = all(styles, "cellXfs")[0];
    if (xfs)
      all(xfs, "xf").forEach((xf, i) => {
        const n = Number(xf.getAttribute("numFmtId"));
        const pattern = (custom.get(n) || "").replace(
          /"[^"]*"|\[[^\]]*\]|\\./g,
          "",
        );
        if ((n >= 14 && n <= 17) || n === 22 || /[yd]/i.test(pattern))
          dateStyle.add(i);
      });
  }
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const strings = files["xl/sharedStrings.xml"]
    ? all(parse(files["xl/sharedStrings.xml"]), "si").map((n) => n.textContent)
    : [];
  const sha = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (v) => v.toString(16).padStart(2, "0"),
  ).join("");
  const result = [];
  for (const [ix, sheet] of all(book, "sheet").entries()) {
    const name = sheet.getAttribute("name");
    if (/gemeinde|globalbudget/i.test(name)) continue;
    const id = sheet.getAttributeNS(
      "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
      "id",
    );
    const target = all(rels, "Relationship")
      .find((r) => r.getAttribute("Id") === id)
      ?.getAttribute("Target");
    if (!target) continue;
    const path = target.startsWith("/") ? target.slice(1) : "xl/" + target;
    if (!files[path]) throw Error("The worksheet is missing.");
    const sheetRows = all(parse(files[path]), "row").map((row) => ({
      number: Number(row.getAttribute("r")),
      cells: all(row, "c").map((c) => {
        const type = c.getAttribute("t") || "n",
          ref = c.getAttribute("r") || "";
        const raw = all(c, "v")[0]?.textContent ?? "";
        const value =
          type === "s" && raw !== ""
            ? (strings[Number(raw)] ?? "")
            : type === "inlineStr"
              ? all(c, "t")
                  .map((n) => n.textContent)
                  .join("")
              : raw;
        return {
          ref,
          col: ref.replace(/\d+$/, ""),
          type,
          value,
          formula: all(c, "f")[0]?.textContent ?? null,
          style: Number(c.getAttribute("s") || 0),
        };
      }),
    }));
    const byRef = new Map(
      sheetRows.flatMap((r) => r.cells.map((c) => [c.ref, c])),
    );
    let headings = new Map();
    for (const row of sheetRows) {
      const texts = row.cells.filter(
        (c) => ["s", "inlineStr", "str"].includes(c.type) && c.value.trim(),
      );
      const header =
        !row.cells.some((c) => headings.has(c.col) &&
          (c.formula !== null || (c.type === "n" && c.value !== "") || c.type === "d")) &&
        texts.some((c) =>
          /^(datum|buchungsdatum|bezeichnung|beschreibung|buchungstext)$/i.test(
            c.value.trim(),
          ),
        ) &&
        texts.some((c) =>
          /^(einnahmen?|ausgaben?|betrag|soll|haben|eingang|ausgang)$/i.test(
            c.value.trim(),
          ) || /^(?:gemeinde(?:\s+\d{4})?$|globalbudget\b)/i.test(c.value.trim()),
        );
      if (header) {
        headings = new Map(texts.map((c) => [c.col, c.value.trim()]));
        continue;
      }
      const cells = row.cells.filter(
        (c) => !excluded(headings.get(c.col) || ""),
      );
      const label = cells
        .filter((c) => texts.includes(c))
        .map((c) => c.value)
        .join(" · ")
        .slice(0, 195);
      if (!label && !headings.size) continue;
      let date = "",
        origin = "Check the date";
      const dates = new Set();
      for (const c of cells) {
        const isDate =
          /datum/i.test(headings.get(c.col) || "") ||
          dateStyle.has(c.style) ||
          c.type === "d";
        const match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})?$/.exec(c.value);
        let day = "",
          source = "";
        if (match) {
          day =
            (match[3] || year) +
            "-" +
            match[2].padStart(2, "0") +
            "-" +
            match[1].padStart(2, "0");
          source = match[3] ? "Cell date" : "Manually selected source year";
        } else if (c.type === "d") {
          day = c.value.slice(0, 10);
          source = "ISO cell date";
        } else if (
          isDate &&
          c.type === "n" &&
          /^\d+(\.\d+)?$/.test(c.value) &&
          Number(c.value) < 2958466
        ) {
          const serial = Math.floor(Number(c.value));
          if (serial === 60 && !date1904) {
            dates.add(c.ref);
            continue;
          }
          day = new Date(
            epoch + (serial + (!date1904 && serial < 60 ? 1 : 0)) * 86400000,
          )
            .toISOString()
            .slice(0, 10);
          source = "Excel date";
        }
        if (isDate || match) dates.add(c.ref);
        if (
          !date &&
          day &&
          /^\d{4}-\d{2}-\d{2}$/.test(day) &&
          !isNaN(Date.parse(day)) &&
          new Date(day).toISOString().slice(0, 10) === day
        ) {
          date = day;
          origin = source;
        }
      }
      for (const c of cells) {
        if (dates.has(c.ref) || (c.type !== "n" && c.formula === null))
          continue;
        const heading = headings.get(c.col) || "";
        if (
          /^(lfd\.?\s*nr\.?|nummer|anzahl|menge|jahr|belegnummer)$/i.test(
            heading,
          )
        )
          continue;
        if (
          c.value === "" &&
          c.formula === null &&
          !/betrag|einnahme|ausgabe|soll|haben/i.test(heading)
        )
          continue;
        const signed = sourceCents(c.value),
          amount = signed === null ? null : Math.abs(signed);
        const aggregate = /summe|ergebnis|übertrag|gesamt|saldo/i.test(
          label + " " + heading,
        );
        const check = c.formula !== null ? simpleSum(c.formula, byRef) : null;
        const blocked =
          role === "D8" || c.formula !== null || aggregate || signed === null || signed < 0;
        const kind = /einnahm|eingang/i.test(heading)
          ? "income"
          : /ausgab|ausgang/i.test(heading)
            ? "expense"
            : "";
        const mismatch = check !== null && signed !== null && check !== signed;
        result.push({
          source: sha,
          sheet: name,
          cell: c.ref,
          row: row.number,
          key: ix + "-" + c.ref,
          label: label || heading,
          raw: c.formula === null ? c.value : "=" + c.formula,
          cached: c.formula === null ? null : c.value,
          calculatedCent: check,
          differenceCent:
            check === null || signed === null ? null : signed - check,
          column: heading,
          yearOrigin: origin,
          date,
          amount,
          kind,
          status:
            role === "D8"
              ? "Subsequent template · comparison only"
              : mismatch
                ? "The formula and cached result differ"
                : c.formula !== null
                  ? "Formula · comparison only"
                  : aggregate
                    ? "Total or carry-forward row"
                    : amount === null
                      ? "Missing or unreadable amount"
                      : signed < 0 ? "Negative source amount requires manual reconciliation" : "Review individual booking",
          blocked,
        });
      }
    }
  }
  return result;
}
