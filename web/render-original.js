import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { profileID, render, snapshot } from "./export.js";

async function main() {
  const { profile, event, rows, subject, number, device, user, previous, reason, donorAccess } =
    JSON.parse(readFileSync(0, "utf8"));
  const index = [0, 1, 2, 11, 12].find((item) => profileID(item) === profile);
  if (index === undefined) throw Error("Unsupported numbered document profile.");
  const snap = snapshot(index, { event, donorAccess, conflicts: [] }, rows, {
    subject,
    number,
  });
  if (previous) {
    snap.previousNumber = previous;
    snap.revisionReason = reason;
    (snap.tables?.after || snap.lines).push("Replacement for receipt " + previous + " · " + reason);
  }
  const files = await render(snap);
  const pdf = Buffer.from(await files.pdf.arrayBuffer());
  const docx = Buffer.from(await files.docx.arrayBuffer());
  if (pdf.length + docx.length > 8 * 1024 * 1024) {
    throw Error("The rendered original exceeds the archive size limit.");
  }
  const digest = (file) => createHash("sha256").update(file).digest("hex");
  snap.archive = {
    device,
    user,
    issuedAt: new Date().toISOString(),
    sourceRevision: rows.find((row) => row.ID === subject).Revision,
    renderBuild: __BONFIRE_RENDER_BUILD__,
    pdfSHA256: digest(pdf),
    docxSHA256: digest(docx),
  };
  process.stdout.write(JSON.stringify({
    PDF: pdf.toString("base64"),
    DOCX: docx.toString("base64"),
    Note: JSON.stringify(snap),
    Date: snap.date,
    Label: snap.title,
  }));
}
main().catch(() => {
  process.stdout.write(JSON.stringify({
    error: "The stored posting and approved template could not produce an original. Check the addresses, payment details and template.",
  }));
});
