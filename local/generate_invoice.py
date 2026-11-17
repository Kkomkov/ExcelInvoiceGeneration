"""
Create an invoice locally (no Google): filled .xlsx + .pdf + a row in the tracker workbook.

    python local/generate_invoice.py --form              # read the NewInvoice tab of the tracker
    python local/generate_invoice.py --input invoice.json # or read a JSON file
    options: [--config local/local_config.json] [--dry-run] [--keep-form]

Needs: Python 3 + openpyxl, Node.js (runs the shared logic from apps-script/Logic.gs),
and LibreOffice (makes the PDF and double-checks the total).
Usually started through new-invoice.ps1.
"""
import argparse, datetime, json, os, shutil, subprocess, sys, tempfile
from copy import copy
from pathlib import Path

try:
    import openpyxl
    from openpyxl.cell.cell import MergedCell
except ImportError:
    sys.exit("ERROR: openpyxl is missing. Run:  python -m pip install openpyxl")

HERE = Path(__file__).resolve().parent


def die(msg):
    print("ERROR: " + str(msg), file=sys.stderr)
    sys.exit(1)


def load_config(path):
    p = Path(path).resolve()
    if not p.exists():
        die(f"Config file not found: {p}\nCopy local_config.example.json to local_config.json and edit the paths.")
    cfg = json.loads(p.read_text(encoding="utf-8-sig"))

    def res(key):
        v = cfg.get(key, "")
        if not v:
            die(f'"{key}" is missing in {p}')
        q = Path(v)
        return q if q.is_absolute() else (p.parent / q).resolve()

    return {"tracker": res("tracker"), "template": res("template"), "outputDir": res("outputDir"),
            "soffice": cfg.get("soffice", "")}


def find_soffice(configured):
    cands = [configured, os.environ.get("LIBREOFFICE_PATH", ""), shutil.which("soffice") or "",
             shutil.which("libreoffice") or "",
             r"C:\Program Files\LibreOffice\program\soffice.exe",
             r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
             "/Applications/LibreOffice.app/Contents/MacOS/soffice"]
    for c in cands:
        if c and Path(c).exists():
            return c
    die("LibreOffice not found. Install it, or put the full path to soffice.exe in local_config.json (\"soffice\").")


def lo_convert(soffice, src, fmt, outdir):
    """Convert with LibreOffice using a private profile so an open LibreOffice window cannot block it."""
    outdir.mkdir(parents=True, exist_ok=True)
    profile = Path(tempfile.mkdtemp(prefix="lo_profile_"))
    try:
        r = subprocess.run([soffice, f"-env:UserInstallation={profile.as_uri()}", "--headless",
                            "--convert-to", fmt, "--outdir", str(outdir), str(src)],
                           capture_output=True, text=True, timeout=180)
    except subprocess.TimeoutExpired:
        die("LibreOffice took too long. Close any LibreOffice windows and try again.")
    finally:
        shutil.rmtree(profile, ignore_errors=True)
    out = outdir / (Path(src).stem + "." + fmt.split(":")[0])
    if not out.exists():
        die("LibreOffice did not produce the " + fmt + " file.\n" + (r.stderr or r.stdout))
    return out


def read_form(tracker_wb, form_cfg):
    """Reads the NewInvoice tab (cell addresses come from Config.gs) into the same shape as the JSON input."""
    ws = tracker_wb["NewInvoice"]
    c = form_cfg["cells"]
    table = form_cfg["jobTable"]

    def v(key):
        x = ws[c[key]].value
        if isinstance(x, datetime.datetime):
            return x.date().isoformat()
        if isinstance(x, datetime.date):
            return x.isoformat()
        return "" if x is None else x

    jobs = []
    for row in ws.iter_rows(min_row=table["startRow"], max_row=table["startRow"] + table["rowCount"] - 1,
                            min_col=table["startColumn"], max_col=table["startColumn"] + table["columnCount"] - 1,
                            values_only=True):
        cols = table["columns"]
        job = {"title": row[cols["title"] - 1], "workQty": row[cols["workQty"] - 1],
               "workPrice": row[cols["workPrice"] - 1], "materialsQty": row[cols["materialsQty"] - 1],
               "materialsPrice": row[cols["materialsPrice"] - 1],
               "materialsDetail": row[cols["materialsDetail"] - 1]}
        if any(value not in (None, "") for value in job.values()):
            jobs.append(job)
    return {"clientId": v("clientId"), "issueDate": v("issueDate"), "paymentTermsDays": v("paymentTermsDays") or None,
            "jobs": jobs, "postagePrice": v("postagePrice"), "notes": v("notes")}


def finish_form(tracker_wb, form_cfg, text, keep):
    ws = tracker_wb["NewInvoice"]
    ws[form_cfg["lastResultCell"]].value = text
    if not keep:
        for key in ("clientId", "issueDate", "paymentTermsDays", "postagePrice", "imageFileIds", "notes"):
            ws[form_cfg["cells"][key]].value = None
        table = form_cfg["jobTable"]
        for row in ws.iter_rows(min_row=table["startRow"], max_row=table["startRow"] + table["rowCount"] - 1,
                                min_col=table["startColumn"], max_col=table["startColumn"] + table["columnCount"] - 1):
            for cell in row:
                cell.value = None


def read_settings(ws):
    raw = {}
    for key, val, *_ in ws.iter_rows(min_row=2, max_col=3, values_only=True):
        if key not in (None, ""):
            raw[str(key).strip()] = val
    return raw


def read_table(ws):
    headers = [str(c.value).strip() if c.value is not None else "" for c in ws[1]]
    rows = []
    for r in ws.iter_rows(min_row=2, values_only=True):
        if all(v in (None, "") for v in r):
            continue
        rows.append({h: v for h, v in zip(headers, r) if h})
    return rows


def next_row(ws):
    r = ws.max_row
    while r > 1 and all(c.value in (None, "") for c in ws[r]):
        r -= 1
    return r + 1


def append_record(ws, rec, fmts):
    headers = [str(c.value).strip() if c.value is not None else "" for c in ws[1]]
    row = next_row(ws)
    for i, h in enumerate(headers, 1):
        v = rec.get(h, "")
        cell = ws.cell(row, i)
        if h in fmts["textColumns"]:
            cell.number_format = "@"
        if h in fmts["dateColumns"]:
            cell.number_format = fmts["date"]
            v = datetime.date.fromisoformat(v) if v else None
        if h in fmts["moneyColumns"]:
            cell.number_format = fmts["money"]
        cell.value = None if v == "" else v


def expand_job_rows(ws, job_count, layout):
    extra_jobs = max(0, job_count - 1)
    if not extra_jobs:
        return
    first_row = layout["firstRow"]
    rows_per_job = layout["rowsPerJob"]
    insert_before = first_row + rows_per_job
    rows_to_insert = extra_jobs * rows_per_job
    original_merges = list(ws.merged_cells.ranges)
    block_merges = [r for r in original_merges
                    if r.min_row >= first_row and r.max_row < insert_before]
    moved_merges = [r for r in original_merges if r.min_row >= insert_before]

    for merged in original_merges:
        if merged in moved_merges:
            ws.unmerge_cells(str(merged))
    ws.insert_rows(insert_before, rows_to_insert)

    for merged in moved_merges:
        ws.merge_cells(start_row=merged.min_row + rows_to_insert, start_column=merged.min_col,
                       end_row=merged.max_row + rows_to_insert, end_column=merged.max_col)
    for index in range(1, extra_jobs + 1):
        offset = index * rows_per_job
        for merged in block_merges:
            ws.merge_cells(start_row=merged.min_row + offset, start_column=merged.min_col,
                           end_row=merged.max_row + offset, end_column=merged.max_col)
        for row_offset in range(rows_per_job):
            source_row = first_row + row_offset
            target_row = source_row + offset
            ws.row_dimensions[target_row].height = ws.row_dimensions[source_row].height
            for col in range(1, ws.max_column + 1):
                source = ws.cell(source_row, col)
                target = ws.cell(target_row, col)
                if source.has_style:
                    target._style = copy(source._style)
                if source.value is not None and not isinstance(target, MergedCell):
                    target.value = source.value


def apply_writes(wb, plan):
    ws = wb[plan["template"]["sheetName"]]
    expand_job_rows(ws, plan["template"]["jobCount"], plan["template"]["jobLayout"])
    non_anchor = set()
    for rng in ws.merged_cells.ranges:
        for row in ws.iter_rows(min_row=rng.min_row, max_row=rng.max_row, min_col=rng.min_col, max_col=rng.max_col):
            for c in row:
                if (c.row, c.column) != (rng.min_row, rng.min_col):
                    non_anchor.add(c.coordinate)
    for w in plan["writes"]:
        if w["cell"] in non_anchor:
            die(f'Config maps a value to {w["cell"]}, which is inside a merged cell (not its top-left cell).')
        c = ws[w["cell"]]
        k, v = w["kind"], w["value"]
        if k == "blank" or (k == "text" and v == ""):
            c.value = None
        elif k == "text":
            c.number_format = "@"
            c.value = v
        elif k == "date":
            c.value = datetime.date.fromisoformat(v)
            c.number_format = w.get("numberFormat", "dd/mm/yyyy")
        elif k == "number":
            c.value = v
            if w.get("numberFormat"):
                c.number_format = "[$£]#,##0.00"
        elif k == "formula":
            c.value = v
        else:
            die("Unknown write kind: " + k)
    for name in plan["template"]["removeSheets"]:
        if name in wb.sheetnames and len(wb.sheetnames) > 1:
            del wb[name]
    wb.calculation.fullCalcOnLoad = True   # Excel recalculates formulas when the file is opened


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--input", help="JSON file describing the invoice")
    ap.add_argument("--form", action="store_true", help="read the NewInvoice tab of the tracker instead")
    ap.add_argument("--keep-form", action="store_true", help="do not clear the NewInvoice tab after success")
    ap.add_argument("--config", default=str(HERE / "local_config.json"))
    ap.add_argument("--dry-run", action="store_true", help="show number and total, create nothing")
    a = ap.parse_args()

    cfg = load_config(a.config)
    for key in ("tracker", "template"):
        if not cfg[key].exists():
            die(f"{key} file not found: {cfg[key]}")
    if not a.form and not a.input:
        die("Use --form (NewInvoice tab) or --input invoice.json")

    # tracker (read)
    tracker_wb = openpyxl.load_workbook(cfg["tracker"])
    for name in ("Settings", "Clients", "Invoices", "InvoiceLines", "NewInvoice"):
        if name not in tracker_wb.sheetnames:
            die(f'Tracker has no "{name}" tab.')
    form_cfg = None
    if a.form:
        try:
            form_cfg = json.loads(subprocess.run(["node", str(HERE / "plan_invoice.js"), "--form-cells"],
                                                 capture_output=True, text=True, encoding="utf-8", check=True).stdout)
        except FileNotFoundError:
            die("Node.js was not found. Install it from https://nodejs.org (it runs the shared invoice logic).")
        inp = read_form(tracker_wb, form_cfg)
    else:
        inp = json.loads(Path(a.input).read_text(encoding="utf-8-sig"))
    settings_raw = read_settings(tracker_wb["Settings"])
    clients = read_table(tracker_wb["Clients"])
    want = str(inp.get("clientId", "")).strip().lower()
    client_row = next((c for c in clients if str(c.get("ClientId", "")).strip().lower() == want), None)
    existing = [r.get("InvoiceNo") for r in read_table(tracker_wb["Invoices"])]

    # plan (shared logic, run by Node)
    now = datetime.datetime.now()
    req = {"settingsRaw": settings_raw, "clientRow": client_row, "existingNumbers": existing, "input": inp,
           "todayIso": now.date().isoformat(), "nowStamp": now.strftime("%Y-%m-%dT%H:%M:%S")}
    try:
        r = subprocess.run(["node", str(HERE / "plan_invoice.js")], input=json.dumps(req, default=str),
                           capture_output=True, text=True, encoding="utf-8")
    except FileNotFoundError:
        die("Node.js was not found. Install it from https://nodejs.org (it runs the shared invoice logic).")
    if r.returncode != 0:
        die("Planner failed:\n" + r.stderr)
    plan = json.loads(r.stdout)
    if plan["errors"]:
        print("Invoice not created:", file=sys.stderr)
        for e in plan["errors"]:
            print("  - " + e, file=sys.stderr)
        sys.exit(1)

    print(f"Invoice {plan['invoiceNo']}  |  {plan['record']['ClientCompany']}  |  total £{plan['total']:.2f}  |  due {plan['dueDate']}")
    if a.dry_run:
        print("Dry run: nothing created.")
        return

    # make sure the tracker can be saved BEFORE creating any files
    try:
        with open(cfg["tracker"], "r+b"):
            pass
    except OSError:
        die(f"Cannot write to the tracker. Close it in LibreOffice first:\n  {cfg['tracker']}")

    soffice = find_soffice(cfg["soffice"])
    out_dir = cfg["outputDir"] / plan["issueDate"][:4]
    out_dir.mkdir(parents=True, exist_ok=True)
    xlsx_path = out_dir / (plan["baseName"] + ".xlsx")
    pdf_path = out_dir / (plan["baseName"] + ".pdf")
    if xlsx_path.exists() or pdf_path.exists():
        die(f"Output file already exists: {xlsx_path.name}. Check the Invoices tab for a duplicate number.")

    created = []
    try:
        wb = openpyxl.load_workbook(cfg["template"])
        apply_writes(wb, plan)
        wb.save(xlsx_path)
        created.append(xlsx_path)

        # recalculate with LibreOffice to check the total and leftover placeholders
        tmp = Path(tempfile.mkdtemp(prefix="inv_check_"))
        try:
            calc_ws = openpyxl.load_workbook(lo_convert(soffice, xlsx_path, "xlsx", tmp / "recalc"),
                                             data_only=True)[plan["template"]["sheetName"]]
            total = calc_ws[plan["template"]["totalCell"]].value
            if total is None or abs(float(total) - plan["total"]) > plan["template"]["tolerance"]:
                die(f"Total mismatch: template shows {total}, calculated {plan['total']}. Check formulas in the template.")
            left = [c.coordinate for row in calc_ws.iter_rows() for c in row
                    if isinstance(c.value, str) and c.value.strip().startswith("<") and c.value.strip().endswith(">")]
            if left:
                die("Template still contains placeholder text in: " + ", ".join(left))
            pdf_tmp = lo_convert(soffice, xlsx_path, "pdf", tmp / "pdf")
            shutil.move(str(pdf_tmp), str(pdf_path))
            created.append(pdf_path)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

        # log last, so a failure never leaves a log row without files
        rec = dict(plan["record"], XlsxLink=str(xlsx_path), PdfLink=str(pdf_path))
        append_record(tracker_wb["Invoices"], rec, plan["formats"])
        for line in plan["lines"]:
            append_record(tracker_wb["InvoiceLines"], line, plan["formats"])
        if form_cfg:
            finish_form(tracker_wb, form_cfg, f"{plan['invoiceNo']} | £{plan['total']:.2f} | {pdf_path}", a.keep_form)
        tracker_wb.calculation.fullCalcOnLoad = True
        tracker_wb.save(cfg["tracker"])
    except SystemExit:
        for f in created:
            f.unlink(missing_ok=True)
        raise
    except Exception as e:
        for f in created:
            f.unlink(missing_ok=True)
        die(e)

    print("Created:")
    print("  " + str(xlsx_path))
    print("  " + str(pdf_path))
    print("Logged in: " + str(cfg["tracker"]))


if __name__ == "__main__":
    main()
