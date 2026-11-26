import { officeFiles } from "./exchange.js";
import registry from "./variables.json" with { type: "json" };
const known = new Set(registry.map((v) => v.token));
export async function importTemplate(file) {
  if (file.size > 2 << 20) throw Error("DOCX-Vorlage maximal 2 MiB.");
  const files = officeFiles(new Uint8Array(await file.arrayBuffer()));
  const read = (f) => {
    const text = new TextDecoder().decode(f);
    if (/<!DOCTYPE|<!ENTITY/i.test(text))
      throw Error("Externe XML-Deklaration gesperrt.");
    return new DOMParser().parseFromString(text, "application/xml");
  };
  const root = files["word/document.xml"];
  if (!root) throw Error("Kein Word-Dokument.");
  if (
    Object.keys(files).some((n) =>
      /word\/(media|header|footer)|customXml\//.test(n),
    )
  )
    throw Error(
      "Dieser Textimport unterstützt keine Bilder, Kopf- oder Fußteile und keine Datenbindungen.",
    );
  const doc = read(root);
  if (doc.getElementsByTagName("parsererror").length)
    throw Error("Ungültiges Word-XML.");
  for (const tag of [
    "tbl",
    "drawing",
    "pict",
    "object",
    "altChunk",
    "instrText",
    "fldSimple",
    "ins",
    "del",
    "sdt",
    "hyperlink",
  ])
    if (doc.getElementsByTagNameNS("*", tag).length)
      throw Error("Nicht unterstützter Word-Inhalt: " + tag);
  for (const lineBreak of doc.getElementsByTagNameNS("*", "br")) {
    const type = lineBreak.getAttributeNS(lineBreak.namespaceURI, "type");
    if (type && type !== "textWrapping") throw Error("Unsupported Word break: " + type);
  }
  const body = [...doc.getElementsByTagNameNS("*", "p")]
    .map((p) =>
      [...p.getElementsByTagNameNS("*", "*")]
        .map((t) => t.localName === "t" ? t.textContent : t.localName === "tab" ? "\t" : ["br", "cr"].includes(t.localName) ? "\n" : "")
        .join(""),
    )
    .join("\n")
    .trim();
  if (!body || body.length > 8000)
    throw Error("Die Textvorlage muss 1 bis 8.000 Zeichen enthalten.");
  const matches = body.match(/\{\{[^{}]+\}\}/g) || [];
  const unknown = matches.filter((t) => !known.has(t));
  if (unknown.length)
    throw Error("Unbekannte Vorlagenfelder: " + unknown.join(", "));
  return body;
}
export function mergeText(text, values) {
  return (text || "").replace(/\{\{([^{}]+)\}\}/g, (_, k) => {
    if (!Object.hasOwn(values, k) || values[k] == null) throw Error("Vorlagenwert fehlt: " + k);
    return String(values[k]);
  });
}
