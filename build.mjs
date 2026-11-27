import { build, transform } from "esbuild";
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
const brandHash = createHash("sha256").update(svg).digest("hex");
if (
  brandHash !==
  "f12b47ae30d1c088420b3407eae7ad912218208440d851c8c848772ec7f46119"
)
  throw Error(
    "Die aus der Designübergabe übernommene Flamme hat sich verändert.",
  );
await mkdir("dist", { recursive: true });
await writeFile("dist/logo-original.svg", svg);
await copyFile("node_modules/lucide/LICENSE", "dist/lucide-license.txt");
const iconSizes = [32, 192, 512];
for (const size of iconSizes) {
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
const staticFiles = [
  "index.html",
  "word-renderer.html",
  "manifest.webmanifest",
];
for (const file of staticFiles)
  await copyFile("web/" + file, "dist/" + file);
const styles = [
  "app.css",
  ...(await readdir("web"))
    .filter((name) => /^admin-.*\.css$/.test(name))
    .sort(),
];
await writeFile(
  "dist/app.css",
  (
    await Promise.all(styles.map((name) => readFile("web/" + name, "utf8")))
  ).join("\n"),
);
const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
const inputHash = createHash("sha256");
const inputs = (await readdir("web"))
  .filter((name) => /\.(js|html|json|css|webmanifest)$/.test(name))
  .sort()
  .map((name) => "web/" + name);
for (const path of ["build.mjs", "package-lock.json", ...inputs]) {
  inputHash
    .update(path)
    .update("\0")
    .update(
      createHash("sha256")
        .update(await readFile(path))
        .digest(),
    );
}
const renderBuild = {
  sourceSHA256: inputHash.digest("hex"),
  brandSHA256: brandHash,
  libraries: Object.fromEntries(
    ["jspdf", "docx", "pdf-lib", "docx-preview", "html2canvas"].map((name) => [
      name,
      lock.packages["node_modules/" + name].version,
    ]),
  ),
};
await build({
  define: { __BONFIRE_RENDER_BUILD__: JSON.stringify(renderBuild) },
  plugins: [validators],
  entryPoints: ["web/app.js"],
  bundle: true,
  minify: true,
  format: "esm",
  target: "es2022",
  outfile: "dist/app.js",
});
await build({
  entryPoints: ["web/word-renderer.js", "web/theme.js"],
  bundle: true,
  minify: true,
  target: "es2022",
  outdir: "dist",
});
await build({
  define: { __BONFIRE_RENDER_BUILD__: JSON.stringify(renderBuild) },
  plugins: [validators],
  entryPoints: ["web/render-original.js"],
  platform: "node",
  format: "cjs",
  bundle: true,
  minify: true,
  outfile: "render-original.cjs",
});
const files = [...staticFiles, ...iconSizes.map((n) => "icon-" + n + ".png"),
  "app.css", "app.js", "theme.js", "word-renderer.js", "lucide-license.txt", "logo-original.svg"].sort();
const hash = createHash("sha256");
for (const f of files) hash.update(await readFile("dist/" + f));
hash.update(await readFile("web/sw.js"));
hash.update(JSON.stringify(files));
const version = "bonfire-" + hash.digest("hex").slice(0, 16);
const sw = await readFile("web/sw.js", "utf8");
const shellPaths = files.map((file) => file === "index.html" ? "/" : "/" + file);
const workerSource = "const CACHE=" + JSON.stringify(version) +
  ",FILES=" + JSON.stringify(shellPaths) + ";\n" + sw;
const worker = await transform(workerSource, { minify: true, target: "es2022" });
await writeFile("dist/sw.js", worker.code);
console.log("Web-Build", version, "Logo SHA-256", brandHash);
