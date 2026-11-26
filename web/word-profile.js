import { zipSync, strFromU8, strToU8 } from "fflate";
import { officeFiles } from "./exchange.js";
import registry from "./variables.json" with { type: "json" };
import { eur } from "./domain.js";
const fields = new Map(registry.map((v) => [v.token.slice(2, -2), v.type]));
const letters = /^word\/(document|header\d+|footer\d+)\.xml$/;
const wordNS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
function xml(bytes) {
  const text = strFromU8(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw Error("The template contains a blocked XML declaration.");
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) throw Error("The template XML could not be read.");
  return doc;
}
function trustedParts(input) {
  if (input.length > 2 << 20) throw Error("Choose a Word layout of 2 MiB or less.");
  const files = officeFiles(input);
  if (!files["word/document.xml"] || !files["[Content_Types].xml"])
    throw Error("The DOCX file is incomplete.");
  const bad = Object.keys(files).find(
    (p) =>
      !(
        /^(\[Content_Types\]\.xml|_rels\/\.rels|docProps\/(app|core|custom)\.xml|word\/(document|footnotes|endnotes|styles|settings|webSettings|fontTable|numbering|header\d+|footer\d+)\.xml|word\/theme\/theme\d+\.xml|word\/_rels\/(document|header\d+|footer\d+|footnotes|endnotes|fontTable|settings|numbering)\.xml\.rels|word\/media\/[\w.-]+\.(png|jpe?g))$/i.test(
          p,
        ) || p.endsWith("/")
      ),
  );
  if (bad) throw Error("Unsupported Word component: " + bad);
  for (const [name, bytes] of Object.entries(files)) {
    if (name.endsWith(".rels")) {
      for (const node of xml(bytes).getElementsByTagNameNS(
        "*",
        "Relationship",
      )) {
        const target = node.getAttribute("Target") || "";
        if (
          node.getAttribute("TargetMode")?.toLowerCase() === "external" ||
          /^[a-z]+:|^\/\/|\\|(^|\/)\.\.(\/|$)/i.test(target)
        )
          throw Error("The Word document contains an external or unsafe link.");
      }
    }
    if (!letters.test(name)) continue;
    const doc = xml(bytes);
    for (const tag of [
      "altChunk",
      "object",
      "instrText",
      "fldSimple",
      "fldChar",
      "sdt",
      "ins",
      "del",
      "hyperlink",
      "pict",
      "commentRangeStart",
      "footnoteReference",
      "endnoteReference",
      "txbxContent",
    ]) {
      if (doc.getElementsByTagNameNS(wordNS, tag).length)
        throw Error("Unsupported Word feature: " + tag);
    }
  }
  return files;
}
export function mergeWord(input, values) {
  const files = trustedParts(input),
    tokens = new Set();
  for (const [name, bytes] of Object.entries(files)) {
    if (!letters.test(name)) continue;
    const doc = xml(bytes);
    for (const p of doc.getElementsByTagNameNS(wordNS, "p")) {
      const nodes = [...p.getElementsByTagNameNS(wordNS, "t")],
        runs = [];
      let text = "";
      for (const node of nodes) {
        const from = text.length;
        text += node.textContent;
        runs.push({ node, from, end: text.length });
      }
      const matches = [...text.matchAll(/\{\{([^{}]+)\}\}/g)];
      if (/[{}]{2}/.test(text.replace(/\{\{[^{}]+\}\}/g, "")))
        throw Error("The template contains an incomplete field.");
      for (const match of matches.reverse()) {
        const key = match[1];
        if (!fields.has(key)) throw Error("Unknown template field: " + key);
        tokens.add(key);
        if (!values) continue;
        const value = values[key];
        if (value == null || typeof value === "object")
          throw Error("Missing or unprintable template value: " + key);
        const formatted =
          key.endsWith("_cents") && typeof value === "number"
            ? eur(value)
            : String(value);
        const from = match.index,
          end = from + match[0].length;
        let inserted = false;
        for (const run of runs) {
          if (run.end <= from || run.from >= end) continue;
          const t = run.node.textContent;
          run.node.textContent =
            t.slice(0, Math.max(0, from - run.from)) +
            (inserted ? "" : formatted) +
            t.slice(Math.max(0, end - run.from));
          inserted = true;
        }
      }
    }
    files[name] = strToU8(new XMLSerializer().serializeToString(doc));
  }
  if (!tokens.size)
    throw Error("Add at least one BONFIRE field to the Word layout.");
  return { bytes: zipSync(files), tokens: [...tokens] };
}
export async function wordFiles(encoded, context) {
  const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  const merged = mergeWord(bytes, context);
  const docx = new Blob([merged.bytes], {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  const frame = document.createElement("iframe");
  frame.className = "word-preview-frame";
  frame.title = "Lokaler Dokumentexport";
  const request = crypto.randomUUID();
  const pdf = await new Promise((ok, no) => {
    const cleanup = () => {
      clearTimeout(timer);
      removeEventListener("message", response);
      frame.remove();
    };
    const response = (e) => {
      if (
        e.source !== frame.contentWindow ||
        e.origin !== location.origin ||
        e.data?.id !== request
      )
        return;
      cleanup();
      if (e.data.error) no(Error(e.data.error));
      else ok(new Blob([e.data.pdf], { type: "application/pdf" }));
    };
    const timer = setTimeout(() => {
      cleanup();
      no(Error("Zeitlimit für Word-Layout erreicht."));
    }, 60000);
    addEventListener("message", response);
    frame.onload = () =>
      frame.contentWindow.postMessage(
        { id: request, docx: merged.bytes },
        location.origin,
      );
    frame.src = "/word-renderer.html";
    document.body.append(frame);
  });
  return { pdf, docx };
}
