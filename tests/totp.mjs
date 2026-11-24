import { createHmac } from "node:crypto";
export function totp(secret, offset = 0) {
  const bits = [...secret]
    .map((c) =>
      "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
        .indexOf(c)
        .toString(2)
        .padStart(5, "0"),
    )
    .join("");
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const step = Buffer.alloc(8);
  step.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + offset));
  const bytes = createHmac("sha1", key).update(step).digest();
  return String(
    (bytes.readUInt32BE(bytes.at(-1) & 15) & 0x7fffffff) % 1000000,
  ).padStart(6, "0");
}
