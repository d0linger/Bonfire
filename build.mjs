import { build } from "esbuild";
import sharp from "sharp";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import {
  mkdir,
  writeFile,
  readFile,
  copyFile,
  readdir,
} from "node:fs/promises";
import Ajv from "ajv/dist/2020.js";
import formats from "ajv-formats";
import standalone from "ajv/dist/standalone/index.js";
const schemas = JSON.parse(await readFile("web/variants.json", "utf8"));
const ajv = new Ajv({ code: { source: true, esm: true }, strict: false });
formats(ajv);
for (const [key, schema] of Object.entries(schemas))
  ajv.addSchema(schema, "urn:bonfire:" + key);
const generated = standalone(ajv, {
  t8: "urn:bonfire:T8",
  t9: "urn:bonfire:T9",
  t10: "urn:bonfire:T10",
});
const validators = {
  name: "bonfire-validators",
  setup(b) {
    b.onResolve({ filter: /^bonfire:validators$/ }, () => ({
      path: "variants",
      namespace: "generated",
    }));
    b.onLoad({ filter: /.*/, namespace: "generated" }, () => ({
      contents: generated,
      resolveDir: process.cwd(),
    }));
  },
};
const require = createRequire(import.meta.url);
const { Flame } = require("lucide");
const path = Flame.map(
  ([tag, attrs]) =>
    "<" +
    tag +
    " " +
    Object.entries(attrs)
      .map(([k, v]) => k + '="' + v + '"')
      .join(" ") +
    "/>",
).join("");
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="29" height="29" viewBox="0 0 24 24" fill="none" stroke="#F08B64" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
  path +
  "</svg>";
await mkdir("dist", { recursive: true });
await writeFile("dist/logo-original.svg", svg);
await copyFile("node_modules/lucide/LICENSE", "dist/lucide-license.txt");
for (const size of [32, 192, 512]) {
  const inset = 5;
  const padded =
    '<svg xmlns="http://www.w3.org/2000/svg" width="' +
    size +
    '" height="' +
    size +
    '" viewBox="0 0 34 34"><rect width="34" height="34" fill="#20242B"/><g transform="translate(' +
    inset +
    " " +
    inset +
    ')" fill="none" stroke="#F08B64" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
    path +
    "</g></svg>";
  await sharp(Buffer.from(padded))
    .png()
    .toFile("dist/icon-" + size + ".png");
}
for (const file of ["index.html", "word-renderer.html", "app.css", "manifest.webmanifest"])
  await copyFile("web/" + file, "dist/" + file);
await build({
  plugins: [validators],
  entryPoints: ["web/app.js"],
  bundle: true,
  minify: true,
  format: "esm",
  target: "es2022",
  outfile: "dist/app.js",
});
await build({entryPoints:["web/word-renderer.js"],bundle:true,minify:true,target:"es2022",outfile:"dist/word-renderer.js"});
const files = (await readdir("dist")).filter((f) => f !== "sw.js").sort();
const hash = createHash("sha256");
for (const f of files) hash.update(await readFile("dist/" + f));
hash.update(await readFile("web/sw.js"));
hash.update(JSON.stringify(files));
const version = "bonfire-" + hash.digest("hex").slice(0, 16);
const sw = await readFile("web/sw.js", "utf8");
await writeFile(
  "dist/sw.js",
  "const CACHE=" +
    JSON.stringify(version) +
    ", FILES=" +
    JSON.stringify(files.map((f) => (f === "index.html" ? "/" : "/" + f))) +
    ";\n" +
    sw,
);
console.log(
  "Offlinepaket",
  version,
  "Logo SHA-256",
  createHash("sha256").update(svg).digest("hex"),
);
