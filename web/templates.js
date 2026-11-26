import { officeFiles } from "./exchange.js";
import registry from "./variables.json" with { type: "json" };
const known = new Set(registry.map((v) => v.token));
// A paragraph property overrides its style, then its base styles and document defaults.
function checkParagraphBreaks(doc, styles) {
  const ns = doc.documentElement.namespaceURI;
  const child = (parent, name) => parent && Array.from(parent.children).find(el => el.namespaceURI === ns && el.localName === name);
  const attr = (element, key) => element?.getAttributeNS(ns, key);
  const enabled = value => !["0", "false", "off"].includes(value);
  const flag = properties => {
    const el = child(properties, "pageBreakBefore");
    return el ? enabled(attr(el, "val")) : undefined;
  };
  const definitions = new Map();
  let defaultStyle;
  for (const style of styles?.getElementsByTagNameNS(ns, "style") || []) {
    if (attr(style, "type") !== "paragraph") continue;
    const id = attr(style, "styleId");
    definitions.set(id, style);
    if (["1", "on", "true"].includes(attr(style, "default"))) defaultStyle = id;
  }
  const defaults = child(styles?.documentElement, "docDefaults");
  const documentBreak = flag(child(child(defaults, "pPrDefault"), "pPr")) ?? false;
  const resolved = new Map();
  function styleBreak(id) {
    const seen = new Set();
    let value;
    while (id && definitions.has(id)) {
      if (seen.has(id)) throw Error("The Word document contains circular paragraph styles.");
      if (resolved.has(id)) { value = resolved.get(id); break; }
      seen.add(id);
      const style = definitions.get(id);
      value = flag(child(style, "pPr"));
      if (value !== undefined) break;
      id = attr(child(style, "basedOn"), "val");
    }
    value ??= documentBreak;
    for (const visited of seen) resolved.set(visited, value);
    return value;
  }
  for (const paragraph of doc.getElementsByTagNameNS(ns, "p")) {
    const properties = child(paragraph, "pPr");
    const id = attr(child(properties, "pStyle"), "val");
    if (flag(properties) ?? styleBreak(definitions.has(id) ? id : defaultStyle)) throw Error("Unsupported Word break: pageBreakBefore");
  }
}
export async function importTemplate(file) {
  if (file.size > 2 << 20) throw Error("Choose a DOCX template of 2 MiB or less.");
  const files = officeFiles(new Uint8Array(await file.arrayBuffer()));
  const read = (f) => {
    const text = new TextDecoder().decode(f);
    if (/<!DOCTYPE|<!ENTITY/i.test(text))
      throw Error("External XML declarations are blocked.");
    const xml = new DOMParser().parseFromString(text, "application/xml");
    if (xml.getElementsByTagName("parsererror").length) throw Error("The Word document contains invalid XML.");
    return xml;
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
  const relationships = files["word/_rels/document.xml.rels"];
  if (relationships) {
    const declared = [...read(relationships).getElementsByTagNameNS("*", "Relationship")]
      .filter(link => link.getAttribute("Type")?.endsWith("/styles"));
    if (declared.length > 1) throw Error("The Word document declares multiple styles parts.");
    if (declared.length) {
      const link = declared[0];
      const target = link.getAttribute("Target");
      if (link.getAttribute("TargetMode") === "External" || !["styles.xml", "/word/styles.xml"].includes(target))
        throw Error("Text import requires styles in word/styles.xml.");
      if (!files["word/styles.xml"]) throw Error("The Word styles part is missing.");
    }
  }
  const styles = files["word/styles.xml"] ? read(files["word/styles.xml"]) : null;
  checkParagraphBreaks(doc, styles);
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
