import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import { types, eur, cents } from "./domain.js";
const XML = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c],
  );
const ct = "http://schemas.openxmlformats.org/package/2006/content-types",
  rel = "http://schemas.openxmlformats.org/package/2006/relationships",
  doc = "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  ss = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const columns = [
  "Datum",
  "Art",
  "Bezeichnung",
  "Betrag_Cent",
  "Konto",
  "Ziel",
  "Kategorie",
  "Bezug",
  "Formatversion",
];
function table(rows) {
  return [
    columns,
    ...rows
      .filter((r) => r.Data.Amount != null)
      .map(({ Kind, Data: d }) => [
        d.Date,
        Kind,
        d.Label,
        String(d.Amount),
        d.Account || "",
        d.To || "",
        d.Category || "",
        d.Reference || "",
        "1",
      ]),
  ];
}
export function csv(rows) {
  const safe = (s) =>
    '"' + (/^[=+@\-\t\r]/.test(s) ? "'" : "") + s.replaceAll('"', '""') + '"';
  return new Blob(
    [
      "\ufeff" +
        table(rows)
          .map((r) => r.map(safe).join(";"))
          .join("\r\n"),
    ],
    { type: "text/csv;charset=utf-8" },
  );
}
export function workbook(rows) {
  const files = {
    "[Content_Types].xml":
      '<Types xmlns="' +
      ct +
      '"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    "_rels/.rels":
      '<Relationships xmlns="' +
      rel +
      '"><Relationship Id="book" Type="' +
      doc +
      '/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    "xl/workbook.xml":
      '<workbook xmlns="' +
      ss +
      '" xmlns:r="' +
      doc +
      '"><sheets><sheet name="Journal" sheetId="1" r:id="s1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels":
      '<Relationships xmlns="' +
      rel +
      '"><Relationship Id="s1" Type="' +
      doc +
      '/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/worksheets/sheet1.xml":
      '<worksheet xmlns="' +
      ss +
      '"><sheetData>' +
      table(rows)
        .map(
          (r, i) =>
            '<row r="' +
            (i + 1) +
            '">' +
            r
              .map(
                (v, j) =>
                  '<c r="' +
                  String.fromCharCode(65 + j) +
                  (i + 1) +
                  '" ' +
                  (i && j === 0
                    ? 't="d"><v>' + XML(v) + "</v>"
                    : i && j === 3
                      ? 't="n"><v>' + v + "</v>"
                      : 't="inlineStr"><is><t>' + XML(v) + "</t></is>") +
                  "</c>",
              )
              .join("") +
            "</row>",
        )
        .join("") +
      "</sheetData></worksheet>",
  };
  return new Blob(
    [
      zipSync(
        Object.fromEntries(
          Object.entries(files).map(([k, v]) => [k, strToU8(v)]),
        ),
      ),
    ],
    {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
  );
}
function csvRows(text) {
  const result = [];
  let row = [],
    v = "",
    quoted = false;
  text = text.replace(/^\ufeff/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        v += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === ";" && !quoted) {
      row.push(v);
      v = "";
    } else if (c === "\n" && !quoted) {
      row.push(v.replace(/\r$/, ""));
      result.push(row);
      row = [];
      v = "";
    } else v += c;
  }
  if (quoted) throw Error("CSV-Anführungszeichen unvollständig.");
  if (v || row.length) {
    row.push(v.replace(/\r$/, ""));
    result.push(row);
  }
  return result;
}
function xml(file) {
  const text = strFromU8(file);
  if (/<!DOCTYPE|<!ENTITY/i.test(text))
    throw Error("Nicht zugelassene XML-Deklaration.");
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) throw Error("XML-Datei ungültig.");
  return doc;
}
export function officeFiles(buf) {
  let expanded = 0;
  const files = unzipSync(buf, {
    filter(f) {
      expanded += f.originalSize;
      if (
        expanded > 20 << 20 ||
        f.originalSize > 8 << 20 ||
        /vbaProject|activeX|embeddings|externalLinks|\.\.\//i.test(f.name)
      )
        throw Error("Nicht zugelassener Office-Inhalt oder Größenlimit.");
      return true;
    },
  });
  for (const [n, f] of Object.entries(files))
    if (
      n.endsWith(".rels") &&
      /TargetMode\s*=\s*["']External/i.test(strFromU8(f))
    )
      throw Error("Externe Dateibeziehung unzulässig.");
  return files;
}
export async function preview(file, existing) {
  if (file.size > 4 << 20) throw Error("Importvorschau bis 4 MiB.");
  const buf = new Uint8Array(await file.arrayBuffer());
  let records;
  if (file.name.toLowerCase().endsWith(".xlsx")) {
    const files = officeFiles(buf),
      sheet = files["xl/worksheets/sheet1.xml"];
    if (!sheet) throw Error("Erstes Tabellenblatt fehlt.");
    const strings = files["xl/sharedStrings.xml"]
      ? [...xml(files["xl/sharedStrings.xml"]).querySelectorAll("si")].map(
          (si) => si.textContent,
        )
      : [];
    records = [...xml(sheet).querySelectorAll("sheetData row")].map((row) => {
      const values = [];
      for (const c of row.children) {
        const i = (c.getAttribute("r") || "A").charCodeAt(0) - 65;
        values[i] = c.querySelector("f")
          ? "[Formel prüfen]"
          : c.getAttribute("t") === "s"
            ? strings[Number(c.textContent)]
            : c.textContent;
      }
      return values;
    });
  } else records = csvRows(new TextDecoder().decode(buf));
  if (
    !records.length ||
    columns
      .slice(0, 4)
      .some(
        (v, i) =>
          records[0][i] !== v && !(i === 3 && records[0][i] === "Betrag_EUR"),
      )
  )
    throw Error("Erwartete Spalten: " + columns.slice(0, 4).join(", "));
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", buf)),
    (v) => v.toString(16).padStart(2, "0"),
  ).join("");
  const seen = new Set();
  return records.slice(1).map((r, i) => {
    let Amount = null;
    try {
      Amount =
        records[0][3] === "Betrag_EUR"
          ? cents(r[3])
          : /^\d{1,12}$/.test(r[3])
            ? Number(r[3])
            : null;
    } catch {}
    const sig = [r[0], r[1], r[2], Amount].join("|");
    const dup =
      seen.has(sig) ||
      existing.some(
        (x) =>
          x.Data.Date === r[0] &&
          x.Kind === r[1] &&
          x.Data.Label === r[2] &&
          x.Data.Amount === Amount,
      );
    seen.add(sig);
    return {
      source: hash,
      row: i + 2,
      label: r[2],
      date: r[0],
      kind: r[1],
      amount: Amount,
      status:
        Amount == null || !types[r[1]] || !/^\d{4}-\d{2}-\d{2}$/.test(r[0])
          ? "Klärung"
          : dup
            ? "Mögliche Dublette"
            : "Prüfbar",
    };
  });
}
export async function evidence(s, rows, reports = {}) {
  const files = {
    "Journal.csv": new Uint8Array(await csv(rows).arrayBuffer()),
    "Journal.xlsx": new Uint8Array(await workbook(rows).arrayBuffer()),
  };
  for (const [name, blob] of Object.entries(reports))
    files[name] = new Uint8Array(await blob.arrayBuffer());
  const names = [];
  for (const r of rows) {
    const d = r.Data;
    for (const [k, ext] of [
      ["PDF", "pdf"],
      ["DOCX", "docx"],
      ["File", "bin"],
    ])
      if (d[k]) {
        const path = "dateien/" + r.ID.replace(/[^a-z0-9-]/gi, "_") + "." + ext;
        files[path] = Uint8Array.from(atob(d[k]), (c) => c.charCodeAt(0));
        names.push({
          id: r.ID,
          path,
          sha256: Array.from(
            new Uint8Array(await crypto.subtle.digest("SHA-256", files[path])),
            (v) => v.toString(16).padStart(2, "0"),
          ).join(""),
        });
      }
  }
  files["manifest.json"] = strToU8(
    JSON.stringify(
      {
        stand: s.synced || null,
        geraet: s.device,
        vorgaenge: rows.map((r) => ({
          id: r.ID,
          revision: r.Revision,
          art: r.Kind,
        })),
        geraeteOhneEnde: s.pending ?? null,
        ausstehend: s.ops.length,
        konflikte: s.conflicts.length,
        freigegeben: s.closed === true,
        dateien: names,
      },
      null,
      2,
    ),
  );
  return new Blob([zipSync(files)], { type: "application/zip" });
}
