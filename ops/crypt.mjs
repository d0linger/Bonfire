import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { open, readFile, link, unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { resolve } from "node:path";

const [mode, keyPath, source, target] = process.argv.slice(2);
const magic = Buffer.from("BONFIRE1");
async function run() {
  if (mode === "keygen") {
    const handle = await open(keyPath, "wx", 0o600);
    try {
      await handle.writeFile(randomBytes(32));
      await handle.sync();
    } finally {
      await handle.close();
    }
    return;
  }
  if (!["encrypt", "decrypt"].includes(mode) || !target || !keyPath || !source)
    throw Error(
      "Aufruf: keygen Schlüssel | encrypt/decrypt Schlüssel Quelle Ziel",
    );
  const key = await readFile(keyPath);
  if (key.length !== 32) throw Error("Schlüsseldatei muss 32 Bytes enthalten.");
  const input = await open(source, "r");
  const tmp = resolve(target) + "." + randomBytes(16).toString("hex") + ".part";
  let staged = false;
  try {
    const bytes = (await input.stat()).size;
    const out = await open(tmp, "wx", 0o600);
    staged = true;
    try {
      if (mode === "encrypt") {
        const iv = randomBytes(12),
          head = Buffer.concat([magic, iv]);
        const cipher = createCipheriv("aes-256-gcm", key, iv);
        cipher.setAAD(head);
        await out.write(head);
        await pipeline(
          createReadStream(source, { fd: input.fd, autoClose: false }),
          cipher,
          createWriteStream(tmp, {
            fd: out.fd,
            autoClose: false,
            start: head.length,
          }),
        );
        await out.write(cipher.getAuthTag(), 0, 16, head.length + bytes);
      } else {
        if (bytes < 36) throw Error("Sicherung unvollständig.");
        const head = Buffer.alloc(20),
          tag = Buffer.alloc(16);
        await input.read(head, 0, 20, 0);
        await input.read(tag, 0, 16, bytes - 16);
        if (!head.subarray(0, 8).equals(magic))
          throw Error("Unbekanntes Dateiformat.");
        const decipher = createDecipheriv("aes-256-gcm", key, head.subarray(8));
        decipher.setAAD(head);
        decipher.setAuthTag(tag);
        if (bytes === 36) decipher.final();
        else
          await pipeline(
            createReadStream(source, {
              fd: input.fd,
              autoClose: false,
              start: 20,
              end: bytes - 17,
            }),
            decipher,
            createWriteStream(tmp, { fd: out.fd, autoClose: false }),
          );
      }
      await out.sync();
    } finally {
      await out.close();
    }
    await link(tmp, resolve(target));
  } finally {
    await input.close();
    if (staged) await unlink(tmp);
    key.fill(0);
  }
}
try {
  await run();
} catch (error) {
  console.error("Sicherungsdatei:", error.message);
  process.exitCode = 1;
}
