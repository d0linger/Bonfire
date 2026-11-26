import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { Document, Packer, Paragraph } from "docx";
import { jsPDF } from "jspdf";
import { api, admin, auth } from "./local-api.mjs";
const day = "2034-09-08",
  matter = "TEST-" + randomUUID();
const event = await api("events", admin, {
  Name: "Erfundene Doppelspende " + matter,
  Starts: day,
  Ends: day,
});
const prep = (Name, Donor) =>
  api("prepare", admin, { Name, Donor, Event: event.ID });
const a = await prep("Nord", true),
  b = await prep("Süd", true),
  normal = await prep("Allgemeines Gerät", false);
const sync = (d, body) => api("sync", auth(d), body);
const manage = (d, Action, Target, status = 200) =>
  api("manage", auth(d), { Action, Target }, status);
const hash = (b) => createHash("sha256").update(b).digest("hex");
async function issue(d) {
  const target = randomUUID();
  const donation = {
    ID: randomUUID(),
    Seq: 1,
    Base: 0,
    Target: target,
    Kind: "donation",
    Data: {
      Label: "Fiktive Spende",
      Date: day,
      Method: "Bar",
      Amount: 2500,
      Fields: { matter },
    },
  };
  const pdf = new jsPDF();
  pdf.text("Fiktiver Beleg " + d.first, 10, 10);
  const bytes = Buffer.from(pdf.output("arraybuffer"));
  const doc = await Packer.toBuffer(
    new Document({
      sections: [{ children: [new Paragraph("Fiktiver Beleg " + d.first)] }],
    }),
  );
  const data = {
    Label: "Testoriginal",
    Reference: target,
    Date: day,
    Number: d.first,
    PDF: bytes.toString("base64"),
    DOCX: doc.toString("base64"),
    Note: JSON.stringify({
      profile: "donation_lfk_a6",
      subject: target,
      date: day,
      number: d.first,
      archive: {
        device: d.device,
        pdfsha256: hash(bytes),
        docxsha256: hash(doc),
      },
    }),
  };
  return [
    donation,
    {
      ID: randomUUID(),
      Seq: 2,
      Base: 0,
      Target: "original:" + target,
      Kind: "original",
      Data: data,
    },
  ];
}
const one = await issue(a),
  two = await issue(b);
assert.equal((await sync(a, { Ops: one })).conflicts.length, 0);
let out = await sync(b, { Ops: two });
assert.equal(out.conflicts.length, 2);
assert.equal(out.entries.filter((x) => x.Kind === "donation").length, 1);
const list = await manage(a, "conflict-originals");
assert.ok(list.some((x) => x.id === two[1].ID && Number(x.number) === b.first));
await manage(normal, "conflict-file", two[1].ID, 403);
for (const o of two)
  await sync(a, {
    Resolve: o.ID,
    Choice: "beibehalten",
    Reason: "Zahlung bereits einmal belegt",
  });
const file = await manage(a, "conflict-file", two[1].ID);
assert.equal(file.pdf, two[1].Data.PDF);
assert.equal(file.docx, two[1].Data.DOCX);
out = await sync(a, {});
assert.equal(out.conflicts.length, 0);
assert.equal(
  out.entries.find((x) => x.ID === one[1].Target).Data.PDF,
  one[1].Data.PDF,
);
const log = {
  ID: randomUUID(),
  Subject: two[0].Target,
  At: new Date().toISOString(),
};
assert.deepEqual((await sync(b, { Prints: [log] })).acknowledgedPrints, [
  log.ID,
]);
const ranges = await manage(a, "numbers");
assert.ok(ranges.find((x) => x.name === "Süd").used.includes(b.first));
const third = {
  ...two[0],
  ID: randomUUID(),
  Target: randomUUID(),
  Seq: 1,
  Kind: "income",
};
assert.equal((await sync(normal, { Ops: [third] })).conflicts.length, 1);
console.log(
  "PASS unabhängige nummerierte Originale, eine Zahlung, beide Dateien bytegleich verfügbar, Nummer und Nachdruck belegt",
);
