import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { transform } from "esbuild";

const dist = new URL("../dist/", import.meta.url);
const files = await readdir(dist, { recursive: true });
const scripts = files.filter((file) => file.endsWith(".js"));
const entrypoints = new Set();
for (const page of ["index.html", "word-renderer.html"]) {
  const html = await readFile(new URL(page, dist), "utf8");
  for (const [, path] of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)) {
    assert.match(path, /^\/[\w./-]+\.js$/);
    assert.ok(scripts.includes(path.slice(1)), `${page} references missing ${path}`);
    entrypoints.add(path);
  }
}
for (const entry of ["/app.js", "/theme.js", "/word-renderer.js"]) {
  assert.ok(entrypoints.has(entry), `Missing production entry point ${entry}`);
}

for (const script of scripts) {
  const code = await readFile(new URL(script, dist), "utf8");
  const compact = await transform(code, {
    minifyWhitespace: true, target: "es2022", legalComments: "eof",
  });
  // Small differences come from printing an already compressed bundle a second time.
  assert.ok(Buffer.byteLength(compact.code) >= Buffer.byteLength(code) * 0.98,
    `${script} ships with removable whitespace`);
}

const handlers = new Map();
let cacheName;
let shell;
globalThis.self = { addEventListener: (name, handle) => handlers.set(name, handle) };
globalThis.caches = {
  async open(name) {
    cacheName = name;
    return { addAll: (paths) => { shell = paths; } };
  },
};
await import("../dist/sw.js");
let installed;
handlers.get("install")({ waitUntil: (promise) => { installed = promise; } });
await installed;
assert.match(cacheName, /^bonfire-[a-f0-9]{16}$/);
assert.equal(new Set(shell).size, shell.length, "Duplicate precache URL");
assert.ok(shell.includes("/"), "Missing application shell");
for (const path of shell) {
  assert.ok(path === "/" || files.includes(path.slice(1)), `Missing precache file ${path}`);
}
for (const script of scripts.filter((file) => file !== "sw.js")) {
  assert.ok(shell.includes("/" + script.replaceAll("\\", "/")), `Uncached script ${script}`);
}
globalThis.location = new URL("https://bonfire.example.test");
handlers.get("fetch")({
  request: { method: "GET", url: new URL("/api/session", location).href },
  respondWith: () => assert.fail("The service worker intercepted a private API request"),
});
console.log(`Verified ${scripts.length} production scripts and ${shell.length} precached URLs.`);
