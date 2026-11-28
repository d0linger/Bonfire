import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import { closure } from "./context.js";
import { types, cents } from "./domain.js";
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
const columns = ["Date", "Type", "Description", "Amount_Cents", "Account", "Destination", "Category", "Reference", "FormatVersion"];
const legacyColumns = [
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
function table(rows, version = "1") {
  return [
    columns,
    ...rows
      .filter((r) => r.Data.Amount != null && r.Kind !== "wallet-link")
      .map(({ Kind, Data: d }) => [
        d.Date,
        Kind,
        d.Label,
        String(d.Amount),
        d.Account || "",
        d.To || "",
        d.Category || "",
        d.Reference || "",
        version,
      ]),
  ];
}
export function csv(rows) {
  const safe = (s) =>
    '"' + (/^['=+@\-\t\r]/.test(s) ? "'" : "") + s.replaceAll('"', '""') + '"';
  return new Blob(
    [
      "\ufeff" +
        table(rows, "2")
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
  if (quoted) throw Error("Unclosed quotation marks in the CSV file.");
  if (v || row.length) {
    row.push(v.replace(/\r$/, ""));
    result.push(row);
  }
  return result;
}
function xml(file) {
  const text = strFromU8(file);
  if (/<!DOCTYPE|<!ENTITY/i.test(text))
    throw Error("Unsupported XML declaration.");
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) throw Error("Invalid XML file.");
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
        throw Error("Unsupported Office content or file size.");
      return true;
    },
  });
  for (const [n, f] of Object.entries(files))
    if (
      n.endsWith(".rels") &&
      /TargetMode\s*=\s*["']External/i.test(strFromU8(f))
    )
      throw Error("External file relationships are not supported.");
  return files;
}
export async function preview(file, existing) {
  if (file.size > 4 << 20) throw Error("Choose a file of up to 4 MiB for the import preview.");
  const buf = new Uint8Array(await file.arrayBuffer());
  let records;
  if (file.name.toLowerCase().endsWith(".xlsx")) {
    const files = officeFiles(buf),
      sheet = files["xl/worksheets/sheet1.xml"];
    if (!sheet) throw Error("The first worksheet is missing.");
    const strings = files["xl/sharedStrings.xml"]
      ? [...xml(files["xl/sharedStrings.xml"]).querySelectorAll("si")].map(
          (si) => si.textContent,
        )
      : [];
    records = [...xml(sheet).querySelectorAll("sheetData row")].map((row) => {
      const values = [];
      for (const c of row.children) {
        const ref = /^([A-I])[1-9]\d*$/.exec(c.getAttribute("r") || "");
        if (!ref) continue;
        const i = ref[1].charCodeAt(0) - 65;
        values[i] = c.querySelector("f")
          ? "[Review formula]"
          : c.getAttribute("t") === "s"
            ? strings[Number(c.textContent)]
            : c.textContent;
      }
      return values;
    });
  } else {
    records = csvRows(new TextDecoder().decode(buf));
    for (const r of records) {
      if (r[8] === "2") {
        for (let i = 0; i < 8; i++) if (/^'['=+@\-\t\r]/.test(r[i])) r[i] = r[i].slice(1);
      }
    }
  }
  if (
    !records.length ||
    ![columns, legacyColumns].some(headers => headers
      .slice(0, 4)
      .every((v, i) => records[0][i] === v || (i === 3 && records[0][i] === (headers === columns ? "Amount_EUR" : "Betrag_EUR"))))
  )
    throw Error("Expected columns: " + columns.slice(0, 4).join(", "));
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", buf)),
    (v) => v.toString(16).padStart(2, "0"),
  ).join("");
  const existingKeys = new Set(existing.map(({ Kind, Data: d }) => JSON.stringify([d.Date, Kind, d.Label, d.Amount])));
  const seen = new Set();
  return records.slice(1).map((r, i) => {
    let Amount = null;
    try {
      Amount =
        ["Amount_EUR", "Betrag_EUR"].includes(records[0][3])
          ? cents(r[3])
          : /^\d{1,12}$/.test(r[3])
            ? Number(r[3])
            : null;
    } catch {
      // Keep invalid amounts null for the import review.
    }
    const sig = JSON.stringify([r[0], r[1], r[2], Amount]);
    const dup = seen.has(sig) || existingKeys.has(sig);
    const day = new Date(r[0] + "T00:00:00Z");
    const validDay = /^\d{4}-\d{2}-\d{2}$/.test(r[0]) && Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === r[0];
    seen.add(sig);
    return {
      source: hash,
      row: i + 2,
      label: r[2],
      date: r[0],
      kind: r[1],
      amount: Amount,
      status:
        Amount == null || !Object.hasOwn(types, r[1]) || !validDay
          ? "Needs review"
          : dup
            ? "Possible duplicate"
            : "Ready for review",
    };
  });
}
async function fileDigest(bytes) {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}
export async function evidence(s, rows, reports = {}, scope = {}) {
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
        const entryKey = Array.from(new TextEncoder().encode(r.ID),
          (byte) => byte.toString(16).padStart(2, "0")).join("");
        const path = "dateien/" + entryKey + "." + ext;
        if (Object.hasOwn(files, path)) throw Error("Duplicate document identity in the evidence export.");
        files[path] = Uint8Array.from(atob(d[k]), (c) => c.charCodeAt(0));
        names.push({
          id: r.ID,
          path,
          sha256: await fileDigest(files[path]),
        });
      }
  }
  const requiredReports = [
    "Review-report.pdf",
    "Review-report.docx",
    "Document-register.pdf",
    "Document-register.docx",
  ];
  const missingReports = requiredReports.filter((name) => !files[name]?.length);
  const missingFiles = rows.flatMap((r) => {
    if (r.Kind === "attachment" && (!r.Data.File || r.Data.uploadPending))
      return [{ id: r.ID, format: "Supporting document" }];
    if (r.Kind === "original")
      return ["PDF", "DOCX"]
        .filter((k) => !r.Data[k])
        .map((format) => ({ id: r.ID, format }));
    return [];
  });
  const closing = closure(rows, !!s.event?.Accounts, s.closed, scope.accountDefinitions);
  const technicallyComplete =
    closing["report.export_set"].completeness_status === "complete" &&
    s.closed === true &&
    !scope.period &&
    s.pending === 0 &&
    !s.ops.length &&
    !s.conflicts.length &&
    !missingFiles.length &&
    !missingReports.length;
  const outputs = await Promise.all(
    Object.keys(files)
      .filter((path) => !path.startsWith("dateien/"))
      .map(async (path) => ({ path, sha256: await fileDigest(files[path]) })),
  );
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
        belegdateienAusstaendig: rows
          .filter(
            (r) =>
              r.Kind === "attachment" && (!r.Data.File || r.Data.uploadPending),
          )
          .map((r) => r.ID),
        geraeteOhneEnde: s.pending ?? null,
        geraetevorfaelle: (s.devices || [])
          .filter((d) => d.IncidentState)
          .map((d) => ({
            geraet: d.ID,
            status: d.IncidentState,
            letzteFolge: d.Last,
          })),
        ausstehend: s.ops.length,
        konflikte: s.conflicts.length,
        manifestVersion: 3,
        walletReceiptAllocations: scope.allocations || [],
        workspace: { id: s.event?.ID, name: s.event?.Name, fiscalYear: s.event?.Year,
          starts: scope.starts || s.event?.Starts, ends: scope.ends || s.event?.Ends },
        reconciliation: closing["report.closing"],
        independentReview: "not_recorded",
        sourceQuestions: rows.filter(r => r.Kind === "source-question").map(r => ({
          id: r.ID, revision: r.Revision, question: r.Data.Label, source: r.Data.Reference,
          status: r.Data.Status, note: r.Data.Note || "",
        })),
        registeredFilesComplete: !missingFiles.length,
        technicallyComplete,
        veranstaltung: s.event?.ID || null,
        periode: scope.period || null,
        veranstaltungAbgeschlossen: s.closed === true,
        freigegeben: false,
        paketstatus: technicallyComplete
          ? "Technically complete · independent review not recorded"
          : "In preparation / incomplete",
        fehlendeDateien: missingFiles,
        fehlendeBerichte: missingReports,
        offeneGeraete: (s.devices || [])
          .filter((d) => !d.Sealed)
          .map((d) => ({ id: d.ID, name: d.Name })),
        vorlagenstaende: scope.templates || {},
        exportdateien: outputs,
        dateien: names,
      },
      null,
      2,
    ),
  );
  return new Blob([zipSync(files)], { type: "application/zip" });
}
