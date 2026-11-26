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
      nextToken: "nur-uebung-zweiter-schluessel",
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
      globalThis.injectedAbort = true;
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
      quota = globalThis.injectedAbort === true;
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
        !recovered.nextToken &&
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
  const migrated = await context.newPage();
  await migrated.goto(origin + "?profil=" + crypto.randomUUID());
  const migrationPassed = await migrated.evaluate(async (pass) => {
    const store = await import("/store.js");
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const base = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(pass),
      "PBKDF2",
      false,
      ["deriveKey"],
    );
    const key = await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: 600000, hash: "SHA-256" },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt"],
    );
    const op = {
      ID: crypto.randomUUID(),
      Seq: 1,
      Kind: "original",
      Data: { Number: 7999, PDF: "fiktive Bytes" },
    };
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("bonfire-v1", 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    async function fixture(state) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const bytes = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        new TextEncoder().encode(JSON.stringify(state)),
      );
      await new Promise((resolve, reject) => {
        const t = db.transaction("vault", "readwrite");
        t.objectStore("vault").put(
          { rev: 1, iv, salt, bytes },
          new URLSearchParams(location.search).get("profil"),
        );
        t.oncomplete = resolve;
        t.onerror = reject;
      });
    }
    const legacy = {
      role: "Kassa",
      seq: 1,
      last: 0,
      ops: [op],
      nextNumber: 8000,
      limit: 8999,
    };
    await fixture(legacy);
    const vault = await store.readVault();
    const archive = new Blob([
      JSON.stringify({
        version: 1,
        salt: [...vault.salt],
        iv: [...vault.iv],
        ciphertext: await store.b64(new Blob([vault.bytes])),
      }),
    ]);
    const recovered = await store.recoverReadOnly(archive, pass);
    const upgraded = await store.unlock(pass);
    if (
      upgraded.role !== "Write" ||
      recovered.role !== "Write" ||
      !recovered.recovery ||
      !recovered.sealed
    )
      return false;
    await store.save(upgraded);
    const persisted = await store.unlock(pass);
    if (
      persisted.role !== "Write" ||
      persisted.schemaVersion !== 2 ||
      persisted.preparedOrigin !== location.origin ||
      persisted.nextNumber !== 8000 ||
      JSON.stringify(persisted.ops) !== JSON.stringify(legacy.ops)
    )
      return false;
    for (const extra of [
      { schemaVersion: 88 },
      {
        schemaVersion: 2,
        preparedOrigin: "https://anderer-uebungsserver.invalid",
      },
    ]) {
      await fixture({ ...legacy, ...extra });
      const before = await store.readVault();
      let blocked = false;
      try {
        await store.unlock(pass);
      } catch {
        blocked = true;
      }
      const after = await store.readVault();
      if (
        !blocked ||
        before.rev !== after.rev ||
        (await store.b64(new Blob([before.bytes]))) !==
          (await store.b64(new Blob([after.bytes])))
      )
        return false;
    }
    db.close();
    return true;
  }, id);
  assert.equal(migrationPassed, true);
  console.log(
    "PASS Profilmigration Kassa zu Write beim Entsperren und Lesen der Sicherung, mit ausstehender Originalausgabe, unveränderten Nummern und Schutz bei unbekanntem Schema oder anderer Serveradresse",
  );
  console.log(
    "PASS: forced browser transaction abort preserves outbox, concurrent tab is rejected, protected recovery rejects wrong password and has no issuance token",
  );
} finally {
  await browser?.close();
  await new Promise((r) => server.close(r));
}
