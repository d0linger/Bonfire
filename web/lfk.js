import { PDFDocument, StandardFonts } from "pdf-lib";
const fields = [
  "Spendenbetrag",
  "Belegnummer",
  "Genaue Anschrift der Feuerwehr",
  "Name und Anschrift des Spenders",
  "Geburtsdatum des Spenders",
  "Ort un Datum der Ausstellung",
];
const boxes = [
  [64.958, 26.426, 97.973, 33.742],
  [112.295, 26.426, 142.86, 33.742],
  [5.005, 40.68, 143.021, 47.996],
  [5.004, 56.244, 143.02, 63.56],
  [4.951, 70.94, 51.703, 78.256],
  [5.057, 82.547, 69.594, 88.266],
];
export async function background(file) {
  if (file.size > 3 << 20) throw Error("LFK-Druckvorlage maximal 3 MiB.");
  const source = await PDFDocument.load(await file.arrayBuffer());
  const pages = source.getPages();
  if (
    pages.length !== 1 ||
    Math.abs(pages[0].getWidth() - 419.528) > 0.5 ||
    Math.abs(pages[0].getHeight() - 297.638) > 0.5
  )
    throw Error("Erwartet wird die einseitige A6-Quellvorlage.");
  for (const name of fields) source.getForm().getTextField(name);
  // Import only static page content. The new document has no form values, actions or annotations.
  const output = await PDFDocument.create();
  const page = await output.embedPage(pages[0]);
  output.addPage([page.width, page.height]).drawPage(page);
  return new Blob([await output.save()], { type: "application/pdf" });
}
export async function fillBackground(encoded, values) {
  const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  const output = await PDFDocument.load(bytes);
  const page = output.getPages()[0],
    font = await output.embedFont(StandardFonts.Helvetica);
  const unit = 72 / 25.4;
  for (const [i, value] of values.entries()) {
    const text = String(value ?? "").replace(/[\r\n]+/g, ", ");
    const [x, t, right, bottom] = boxes[i];
    if (font.widthOfTextAtSize(text, 10) > (right - x) * unit - 3)
      throw Error("LFK-Feld zu lang: " + fields[i]);
    page.drawText(text, {
      x: x * unit + 1.5,
      y: page.getHeight() - ((t + bottom) * unit) / 2 - 3,
      size: 10,
      font,
    });
  }
  return new Blob([await output.save()], { type: "application/pdf" });
}
