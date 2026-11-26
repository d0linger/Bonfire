"""Inspect synthetic output files without printing recipient names or amounts."""
import re
from pathlib import Path
from docx import Document
from pypdf import PdfReader

root = Path("test-results/exports")
for index in range(1, 12):
    pdf = PdfReader(root / f"T{index}.pdf")
    word = Document(root / f"T{index}.docx")
    expected = {3: (148, 105), 6: (216, 279), 11: (297, 210)}.get(index, (210, 297))
    for page in pdf.pages:
        size = tuple(round(float(v) * 25.4 / 72) for v in (page.mediabox.width, page.mediabox.height))
        assert size == expected, (index, size)
        assert page.extract_text().strip(), index
    if index in (4, 5):
        assert len(word.tables) == {4: 3, 5: 7}[index]
    else:
        assert any(p.text.strip() for p in word.paragraphs)
    if index in (1, 2, 3, 7):
        pdf_text = " ".join(" ".join(page.extract_text() for page in pdf.pages).split())
        docx_text = " ".join(" ".join(word.element.body.xpath(".//w:t/text()")).split())
        expected_fields = {
            1: ("Musterplatz 8", "Übungsbanner", "€ 40,00", "Already paid: € 20,00", "Outstanding amount: € 20,00", "Due on 2026-12-01", "TESTKONTO", "Testweg 1", "Payment reference: SPONSOR-UEBUNG-42"),
            2: ("Musterplatz 8", "Übungsbanner", "€ 40,00", "Cash received on", "Outstanding amount: € 20,00", "Cash wallet: Kasse Blau", "Testweg 1"),
            3: ("Anonymous", "Testspende", "Testweg 1", "€ 5,50"),
            7: ("Thank-you letter", "€ 5,50", "Yours sincerely"),
        }[index]
        for field in expected_fields:
            assert field in pdf_text and field in docx_text, (index, "Business field mismatch")
        if index in (1, 2):
            recipient = r"Übungsfirma [0-9a-f]{8}"
            assert re.findall(recipient, pdf_text) == re.findall(recipient, docx_text) != [], index
        assert re.findall(r"€ [\d.,]+", pdf_text) == re.findall(r"€ [\d.,]+", docx_text), index
    print(f"T{index}: PDF {len(pdf.pages)} page(s), {expected}, DOCX opened")

# The synthetic imported letter contains the original colored flame in a Word image run.
journal = PdfReader(root / "Journal-lang.pdf")
assert len(journal.pages) > 2
for page in journal.pages:
    text = page.extract_text()
    assert "Payment method" in text and "Fiktive Prüffußzeile" in text
assert "Prüfzeile 160" in journal.pages[-1].extract_text()
print(f"Journal-Langtest: {len(journal.pages)} Seiten mit Spaltenkopf und Fußzeile")
letter = PdfReader(root / "Brief-Layout.pdf")
raster = letter.pages[0].images[0].image.convert("RGB")
colors = raster.getcolors(raster.width * raster.height)
brand_pixels = sum(count for count, (r, g, b) in colors if r - g > 30 and r - b > 30)
assert brand_pixels > 20, "Embedded Word image missing from PDF"
print(f"Letter layout: {brand_pixels} coloured brand pixels in PDF")
