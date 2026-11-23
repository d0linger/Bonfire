import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
const content = await readFile("web/store.js");
const server = http.createServer((req, res) => {
  res.setHeader(
    "Content-Type",
    req.url === "/store.js" ? "text/javascript" : "text/html",
  );
  res.end(
    req.url === "/store.js"
      ? content
      : "<!doctype html><title>Speichertest</title>",
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
let browser;
try {
  browser = await chromium.launchPersistentContext("", {
    headless: true,
    executablePath: process.env.BONFIRE_BROWSER || undefined,
  });
  const context = browser,
    page = await context.newPage(),
    origin = "http://127.0.0.1:" + server.address().port;
  await page.goto(origin);
  const id = crypto.randomUUID();
  await page.evaluate(async (id) => {
    const store = await import("/store.js");
    await store.createVault(id, {
      seq: 1,
      token: "nur-uebung",
      ops: [{ test: 1 }],
      limit: 1200,
    });
  }, id);
  const other = await context.newPage();
  await other.goto(origin);
  await other.evaluate(async (id) => {
    const store = await import("/store.js");
    await store.unlock(id);
  }, id);
  await page.evaluate(async (id) => {
    const store = await import("/store.js");
    const s = await store.unlock(id);
    await store.save({ ...s, seq: 2, ops: [...s.ops, { test: 2 }] });
  }, id);
  const conflict = await other.evaluate(async () => {
    const store = await import("/store.js");
    try {
      await store.save({ seq: 99 });
      return false;
    } catch {
      return true;
    }
  });
  assert.ok(conflict);
  // Force a failed write after IndexedDB has received the new record. The native transaction must roll back.
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      const request = original.apply(this, args);
      IDBObjectStore.prototype.put = original;
      this.transaction.abort();
      return request;
    };
  });
  const result = await page.evaluate(async (id) => {
    const store = await import("/store.js"),
      s = await store.unlock(id);
    let quota = false,
      wrong = false;
    try {
      await store.save({ ...s, large: "x".repeat(20000) });
    } catch {
      quota = true;
    }
    const same = await store.unlock(id);
    const vault = await store.readVault();
    const file = new Blob([
      JSON.stringify({
        version: 1,
        iv: [...vault.iv],
        salt: [...vault.salt],
        ciphertext: await store.b64(new Blob([vault.bytes])),
      }),
    ]);
    try {
      await store.recoverReadOnly(file, id + "x");
    } catch {
      wrong = true;
    }
    const recovered = await store.recoverReadOnly(file, id);
    return {
      quota,
      wrong,
      seq: same.seq,
      ops: same.ops.length,
      large: !!same.large,
      archived:
        recovered.recovery &&
        !recovered.token &&
        recovered.sealed &&
        recovered.limit < 0,
    };
  }, id);
  assert.deepEqual(result, {
    quota: true,
    wrong: true,
    seq: 2,
    ops: 2,
    large: false,
    archived: true,
  });
  console.log(
    "PASS: forced browser transaction abort preserves outbox, concurrent tab is rejected, protected recovery rejects wrong password and has no issuance token",
  );
} finally {
  await browser?.close();
  await new Promise((r) => server.close(r));
}
