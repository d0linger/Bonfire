"""Inspect synthetic output files without printing recipient names or amounts."""
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
    print(f"T{index}: PDF {len(pdf.pages)} Seite(n), {expected}, DOCX geoeffnet")
