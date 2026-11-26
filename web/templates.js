import { officeFiles } from "./exchange.js";
import registry from "./variables.json" with { type: "json" };
const known = new Set(registry.map((v) => v.token));
export async function importTemplate(file) {
  if (file.size > 2 << 20) throw Error("Choose a DOCX template of 2 MiB or less.");
  const files = officeFiles(new Uint8Array(await file.arrayBuffer()));
  const read = (f) => {
    const text = new TextDecoder().decode(f);
    if (/<!DOCTYPE|<!ENTITY/i.test(text))
      throw Error("External XML declarations are blocked.");
    return new DOMParser().parseFromString(text, "application/xml");
  };
  const root = files["word/document.xml"];
  if (!root) throw Error("Choose a Word document.");
  if (
    Object.keys(files).some((n) =>
      /word\/(media|header|footer)|customXml\//.test(n),
    )
  )
    throw Error(
      "Text import supports plain Word paragraphs. Remove images, headers, footers and data bindings before importing.",
    );
  const doc = read(root);
  if (doc.getElementsByTagName("parsererror").length)
    throw Error("The Word document contains invalid XML.");
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
      throw Error("Unsupported Word content: " + tag);
  for (const property of doc.getElementsByTagNameNS("*", "pageBreakBefore")) {
    const value = property.getAttributeNS(property.namespaceURI, "val");
    if (!["0", "false", "off"].includes(value)) throw Error("Unsupported Word break: pageBreakBefore");
  }
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
    throw Error("The text template must contain between 1 and 8,000 characters.");
  const matches = body.match(/\{\{[^{}]+\}\}/g) || [];
  const unknown = matches.filter((t) => !known.has(t));
  if (unknown.length)
    throw Error("Unknown template fields: " + unknown.join(", "));
  return body;
}
export function mergeText(text, values) {
  return (text || "").replace(/\{\{([^{}]+)\}\}/g, (_, k) => {
    if (!Object.hasOwn(values, k) || values[k] == null) throw Error("Missing template value: " + k);
    return String(values[k]);
  });
}
