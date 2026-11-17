"""
Checks that Config.gs matches an invoice template, using LibreOffice instead of Google.

    python3 tests/verify_template.py path/to/template.xlsx [out_dir]

Fills a copy with a sample invoice, recalculates, then reports: writes into
non-anchor merged cells, leftover <placeholders>, total vs expected, and the
payment-terms text. Writes a PDF/PNG of the result so you can look at it.
Run it again whenever you change the template layout or Config.gs.
"""
import datetime, json, os, subprocess, sys, shutil, tempfile
import openpyxl

tpl = sys.argv[1]
out = sys.argv[2] if len(sys.argv) > 2 else tempfile.mkdtemp(prefix="inv_verify_")
os.makedirs(out, exist_ok=True)
here = os.path.dirname(os.path.abspath(__file__))
data = json.loads(subprocess.check_output(["node", os.path.join(here, "dump_writes.js")]))

wb = openpyxl.load_workbook(tpl)
ws = wb[data["sheet"]]
anchors = {}
for rng in ws.merged_cells.ranges:
    for row in ws.iter_rows(min_row=rng.min_row, max_row=rng.max_row, min_col=rng.min_col, max_col=rng.max_col):
        for c in row:
            anchors[c.coordinate] = rng.start_cell.coordinate if hasattr(rng, "start_cell") else ws.cell(rng.min_row, rng.min_col).coordinate

problems = []
for w in data["writes"]:
    cell = w["cell"]
    if cell in anchors and anchors[cell] != cell:
        problems.append(f"{cell} is inside merged range anchored at {anchors[cell]}")
        continue
    c = ws[cell]
    k, v = w["kind"], w["value"]
    if k == "blank" or (k == "text" and v == ""):
        c.value = None
    elif k == "text":
        c.number_format = "@"; c.value = v
    elif k == "date":
        c.value = datetime.date.fromisoformat(v)
        c.number_format = "mmmm dd yyyy"
    elif k == "number":
        c.value = v
        if w.get("numberFormat"): c.number_format = '[$£]#,##0.00'
    elif k == "formula":
        c.value = v

filled = os.path.join(out, "filled.xlsx")
wb.save(filled)
soffice = shutil.which("soffice") or shutil.which("libreoffice")
recalc_dir = os.path.join(out, "recalc"); os.makedirs(recalc_dir, exist_ok=True)
subprocess.run([soffice, "--headless", "--convert-to", "xlsx", "--outdir", recalc_dir, filled], check=True, capture_output=True)
subprocess.run([soffice, "--headless", "--convert-to", "pdf", "--outdir", out, filled], check=True, capture_output=True)
if shutil.which("pdftoppm"):
    subprocess.run(["pdftoppm", "-r", "70", "-png", os.path.join(out, "filled.pdf"), os.path.join(out, "page")], check=False)

calc = openpyxl.load_workbook(os.path.join(recalc_dir, "filled.xlsx"), data_only=True)[data["sheet"]]
total = calc[data["cells"]["total"]].value
if total is None or abs(total - data["subtotal"]) > 0.02:
    problems.append(f"total in sheet {total} != script total {data['subtotal']}")
for row in calc.iter_rows():
    for c in row:
        if isinstance(c.value, str) and c.value.strip().startswith("<") and c.value.strip().endswith(">"):
            problems.append(f"placeholder left in {c.coordinate}: {c.value!r}")
print("payment terms :", calc[data["cells"]["paymentTerms"]].value)
print("invoice no    :", calc[data["cells"]["invoiceNo"]].value)
print("total         :", total, "(script:", data["subtotal"], ")")
print("output folder :", out)
print("RESULT        :", "PROBLEMS" if problems else "OK")
for p in problems: print("  -", p)
sys.exit(1 if problems else 0)
