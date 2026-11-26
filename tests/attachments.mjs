import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { jsPDF } from "jspdf";
import { onlineClient, practiceEvent } from "./local-api.mjs";
import { countID } from "../web/domain.js";
const day = "2701-05-02";
const uploader = await onlineClient();
const peer = await onlineClient();
const event = await practiceEvent(uploader, "Receipt file exercise", day);
const send = (client, data, status) => client("online?event=" + event.ID, data, status);
const doc = new jsPDF();
doc.text("Reine Testrechnung", 10, 15);
const bytes = Buffer.from(doc.output("arraybuffer")),
  digest = createHash("sha256").update(bytes).digest("hex");
const rec = (Seq, Kind, Data, Target = randomUUID()) => ({
  ID: randomUUID(),
  Seq,
  Kind,
  Target,
  Base: 0,
  Data: { Date: day, Label: "Übungsbeleg", ...Data },
});
const payment = rec(1, "expense", { Amount: 900 });
const meta = rec(2, "attachment", {
  Reference: payment.Target,
  Filename: "uebung.pdf",
  Fields: { sha256: digest, size: String(bytes.length) },
});
const body = rec(
  3,
  "attachment-file",
  {
    Reference: meta.Target,
    File: bytes.toString("base64"),
    Fields: { ...meta.Data.Fields, revision: "1" },
  },
  await countID("file", meta.Target, "1"),
);
await send(uploader, { Ops: [payment, meta] });
let out = await send(peer, {});
assert.equal(out.entries.find((r) => r.ID === meta.Target).Data.File, "");
await send(uploader, { Action: "Abschluss" }, 422);
const altered = Buffer.from(bytes);
altered[altered.length - 1] ^= 1;
await send(uploader, { Ops: [{ ...body, Data: { ...body.Data, File: altered.toString("base64") } }] }, 422);
await send(
  uploader,
  {
    Ops: [
      {
        ...body,
        Data: {
          ...body.Data,
          File: Buffer.concat([bytes, Buffer.from("x")]).toString("base64"),
        },
      },
    ],
  },
  422,
);
await send(
  uploader,
  {
    Ops: [
      {
        ...body,
        Data: {
          ...body.Data,
          Fields: { ...body.Data.Fields, sha256: "1".repeat(64) },
        },
      },
    ],
  },
  422,
);
for (const result of await Promise.all([
  send(uploader, { Ops: [body] }),
  send(uploader, { Ops: [body] }),
]))
  assert.equal(result.last, 3);
out = await send(peer, {});
assert.equal(out.entries.filter((r) => r.Kind === "expense").length, 1);
assert.equal(out.entries.filter((r) => r.Kind === "attachment").length, 1);
assert.equal(
  out.entries.find((r) => r.ID === meta.Target).Data.File,
  body.Data.File,
);
assert.equal(createHash("sha256").update(Buffer.from(
  out.entries.find((r) => r.ID === meta.Target).Data.File, "base64")).digest("hex"), digest);
console.log("PASS online attachment integrity, interrupted upload, retry and single financial posting");
