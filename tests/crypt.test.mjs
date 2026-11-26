import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
test("Sicherung verschlüsseln, entschlüsseln und Manipulation erkennen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bonfire-crypto-"));
  const path = (n) => join(dir, n);
  const call = (...args) => {
    const result = spawnSync(process.execPath, ["ops/crypt.mjs", ...args], { timeout: 10000 });
    if (result.error) throw result.error;
    assert.equal(result.signal, null);
    assert.ok(Number.isInteger(result.status));
    return result.status;
  };
  try {
    const sample = randomBytes(200000);
    await writeFile(path("dump"), sample);
    assert.equal(call("keygen", path("key")), 0);
    assert.equal(
      call("encrypt", path("key"), path("dump"), path("archive")),
      0,
    );
    assert.equal(call("decrypt", path("key"), path("archive"), path("out")), 0);
    assert.deepEqual(await readFile(path("out")), sample);
    const archive = await readFile(path("archive"));
    archive[50] ^= 1;
    await writeFile(path("tampered"), archive);
    assert.notEqual(
      call("decrypt", path("key"), path("tampered"), path("bad")),
      0,
    );
    await assert.rejects(access(path("bad")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
