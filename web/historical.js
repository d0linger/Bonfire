import { officeFiles } from "./exchange.js";
import { cents } from "./domain.js";
const parse = (bytes) => {
  const source = new TextDecoder().decode(bytes);
  if (/<!ENTITY|<!DOCTYPE/i.test(source))
    throw Error("Ungültige XML-Deklaration.");
  const doc = new DOMParser().parseFromString(source, "application/xml");
  if (doc.querySelector("parsererror")) throw Error("Ungültiges XML.");
  return doc;
};
const all = (node, name) => [...node.getElementsByTagNameNS("*", name)];
export async function historyPreview(file, role, year) {
  if (file.size > 4 << 20) throw Error("Datei übersteigt 4 MiB.");
  if (!/^\d{4}$/.test(year))
    throw Error("Jahr des historischen Bestands angeben.");
  const bytes = new Uint8Array(await file.arrayBuffer()),
    files = officeFiles(bytes);
  const book = parse(files["xl/workbook.xml"]),
    rels = parse(files["xl/_rels/workbook.xml.rels"]);
  const epoch =
    all(book, "workbookPr")[0]?.getAttribute("date1904") === "1"
      ? Date.UTC(1904, 0, 1)
      : Date.UTC(1899, 11, 30);
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
    if (!files[path]) throw Error("Tabellenblatt fehlt.");
    for (const r of all(parse(files[path]), "row")) {
      const cells = all(r, "c").map((c) => {
        const t = c.getAttribute("t"),
          raw = all(c, "v")[0]?.textContent ?? c.textContent,
          formula = all(c, "f")[0]?.textContent;
        return {
          ref: c.getAttribute("r"),
          type: t,
          value:
            t === "s"
              ? strings[Number(raw)]
              : t === "inlineStr"
                ? all(c, "t")
                    .map((n) => n.textContent)
                    .join("")
                : raw,
          formula,
        };
      });
      const labels = cells
        .filter((c) => ["s", "inlineStr", "str"].includes(c.type))
        .map((c) => c.value);
      if (!labels.length) continue;
      const title = labels.join(" · ").slice(0, 195);
      if (/gemeinde|globalbudget/i.test(title)) continue;
      let date = "",
        origin = "Datum prüfen";
      for (const c of cells) {
        const m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})?$/.exec(c.value);
        if (m) {
          date =
            (m[3] || year) +
            "-" +
            m[2].padStart(2, "0") +
            "-" +
            m[1].padStart(2, "0");
          origin = m[3] ? "Zelldatum" : "Manuell gewähltes Quellenjahr";
          break;
        }
        if (
          /datum/i.test(name) &&
          !c.type &&
          +c.value > 30000 &&
          +c.value < 70000
        ) {
          date = new Date(epoch + Number(c.value) * 86400000)
            .toISOString()
            .slice(0, 10);
          origin = "Excel-Datum, bitte bestätigen";
        }
      }
      for (const c of cells.filter(
        (c) => !c.type || c.type === "n" || c.formula,
      )) {
        if (c.value === "" && !c.formula) continue;
        let amount = null;
        try {
          amount = cents(String(c.value).replace(/^-/, ""));
        } catch {}
        const blocked =
          role === "D8" ||
          !!c.formula ||
          /summe|ergebnis|übertrag|gesamt|saldo/i.test(title);
        result.push({
          source: sha,
          sheet: name,
          cell: c.ref,
          row: Number(r.getAttribute("r")),
          key: ix + "-" + c.ref,
          label: title,
          raw: c.formula ? "=" + c.formula : c.value,
          yearOrigin: origin,
          date,
          amount,
          kind: "",
          status: blocked ? "Nur Vergleich / Summenzeile" : "Zuordnung offen",
          blocked,
        });
      }
    }
  }
  return result;
}
