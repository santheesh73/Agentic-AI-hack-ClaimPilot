# Generates PDF fixtures for the ingest audit. Run: python3 -I audit/repro/make_fixtures.py
import io, os, sys, zlib
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
from pypdf import PdfReader, PdfWriter
out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")
os.makedirs(out, exist_ok=True)
def save(name, data): open(os.path.join(out, name), "wb").write(data); print(name, len(data), "bytes")

# image-only: a page with only a filled rectangle drawn (no text objects)
b = io.BytesIO(); c = canvas.Canvas(b, pagesize=A4)
for _ in range(2):
    c.setFillGray(0.3); c.rect(50, 50, 400, 600, fill=1); c.showPage()
c.save(); save("image_only.pdf", b.getvalue())

# 3-page text PDF with distinct page markers (page numbering check)
b = io.BytesIO(); c = canvas.Canvas(b, pagesize=A4)
for i in range(1, 4):
    c.drawString(72, 750, f"PAGE MARKER {i} -- Clause {i}.1 shall apply to this policy."); c.showPage()
c.save(); text3 = b.getvalue(); save("three_pages.pdf", text3)

# password-protected copy of the 3-page PDF
r = PdfReader(io.BytesIO(text3)); w = PdfWriter()
for p in r.pages: w.add_page(p)
w.encrypt(user_password="secret", owner_password="owner")
b = io.BytesIO(); w.write(b); save("encrypted.pdf", b.getvalue())

# corrupt: valid header, truncated garbage body
save("corrupt.pdf", text3[:300] + b"\x00garbage" * 50)

# zero-page PDF (pypdf writer with no pages)
b = io.BytesIO(); PdfWriter().write(b); save("zero_pages.pdf", b.getvalue())

# large: 250 text pages (exceeds UPLOAD_MAX_PAGES=200)
b = io.BytesIO(); c = canvas.Canvas(b, pagesize=A4)
for i in range(1, 251):
    c.drawString(72, 750, f"Large document page {i}. Expenses shall be excluded until the expiry of the waiting period."); c.showPage()
c.save(); save("large_250_pages.pdf", b.getvalue())

# PDF with embedded JavaScript (OpenAction)
r = PdfReader(io.BytesIO(text3)); w = PdfWriter()
for p in r.pages: w.add_page(p)
w.add_js("app.alert('audit-js-payload');")
b = io.BytesIO(); w.write(b); save("with_javascript.pdf", b.getvalue())

# decompression bomb: one page whose content stream inflates to ~200 MB
bomb_raw = b"q " + b"0 0 m 1 1 l S " * (200 * 1024 * 1024 // 14) + b"Q"
comp = zlib.compress(bomb_raw, 9)
objs = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
        b"<< /Length %d /Filter /FlateDecode >>stream\n" % len(comp) + comp + b"\nendstream"]
pdf = b"%PDF-1.4\n"; offs = []
for i, o in enumerate(objs, 1):
    offs.append(len(pdf)); pdf += b"%d 0 obj\n" % i + o + b"\nendobj\n"
xref = len(pdf); pdf += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
for o in offs: pdf += b"%010d 00000 n \n" % o
pdf += b"trailer << /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)
save("decompression_bomb.pdf", pdf)
