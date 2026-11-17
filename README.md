# Invoice generator for Google Sheets / Drive

**You get per invoice:** a populated `.xlsx` (your template, formulas intact), a `.pdf` made from it, and a log row in the tracker. Files go to Drive in `Invoices/<year>/`.

## Files
| File | What it is |
|---|---|
| `Invoice_Tracker.xlsx` | Tracking workbook: Settings, Clients, NewInvoice (form), Invoices, InvoiceLines, Summary |
| `apps-script/Config.gs` | Every cell address, tab name and column header |
| `apps-script/Logic.gs` | Pure logic, no Google calls (portable) |
| `apps-script/GoogleAdapter.gs` | All Google calls (the only part to rewrite when moving) |
| `apps-script/Main.gs` | Menu and the generate workflow |
| `apps-script/appsscript.json` | Manifest (time zone, permissions) |
| `tests/` | Node tests and a template checker (no Google needed) |
| `PLAN.md` | To-do list with progress |

## Setup
1. **Tracker:** upload `Invoice_Tracker.xlsx` to Drive, open it with Google Sheets, then **File > Save as Google Sheets**. Use that Google Sheet from now on.
2. **Template:** upload your invoice `.xlsx`, open it, **File > Save as Google Sheets**. Copy the new file's ID (the long text between `/d/` and `/edit` in its URL).
3. **Settings tab:** paste the ID into `TemplateFileId` and fill the yellow cells (company and bank details).
4. **Script:** in the tracker, **Extensions > Apps Script**.
   - Create four script files named `Config`, `Logic`, `GoogleAdapter`, `Main` and paste the matching `.gs` contents.
   - Project Settings > tick "Show appsscript.json manifest file", then paste `appsscript.json` over it.
   - (Alternative: `clasp clone <scriptId>`, copy the files in, `clasp push`.)
5. Reload the Google Sheet. Menu **Invoices > Check setup**. Approve the permissions when asked.
6. Add a client on `Clients`, fill `NewInvoice`, run **Invoices > Generate invoice from NewInvoice tab**. Check the PDF against your template.

## Daily use
- New client: one row on `Clients` with a unique `ClientId`.
- New invoice: fill the invoice details and one or more rows in the `NewInvoice` job table, run the menu item, then **Clear NewInvoice form**. Each job row supports its own Work and Materials amounts and materials detail (up to 20 jobs per invoice).
- Payment: select the row(s) on `Invoices`, **Invoices > Mark selected invoice row(s) as paid**. **Refresh overdue statuses** turns late `Issued` invoices into `Overdue`.
- Local LibreOffice workflow: save and close the tracker, then run `python local/generate_invoice.py --form`. Reopen the tracker after it finishes; the generated files and log rows are added locally.

## How it behaves
- Invoice number is `ddmmyyyy-NN` (NN counts invoices with the same date: `14112026-01`, `-02`...). It uses the highest existing number, so deleting a row never causes a clash.
- Payment terms: form value, else the client's `PaymentTermsDays`, else the Settings default (30).
- The `E12` text is rewritten per invoice so the due date follows the **invoice date** (the template version uses `TODAY()`, which would change every time the file is opened).
- Lines: each job title is printed above its own Work and Materials subrows. Either subrow can be omitted; blank quantity = 1. Postage is a single optional invoice-level line.
- The generated invoice expands the template's item area to fit all jobs; invoice total and image placement move down with it.
- Before exporting, the script checks the template's total (`G27`) against its own calculation and that no `<placeholder>` text is left. If either fails nothing is saved and you get a message.
- Two clicks at once cannot create duplicate numbers (script lock).

## Updating an existing Google Sheet
The revised local tracker workbook uses a job table on `NewInvoice` (headers on row 8, up to 20 entries on rows 9-28, and invoice-level fields below it). Updating the `.xlsx` file does not change a tracker already converted to Google Sheets. Copy this revised form layout into the existing Google Sheet, then update its Apps Script files from `apps-script/`.

## Template notes (from reading your file)
- `D17` (phones) is one column wide because `E17:G17` is a separate merged cell, so a long phone list wraps. Merge `D17:G17` in the template if you need more room, then run `tests/verify_template.py`.
- `H2` (`=TODAY()`) is no longer used by the payment-terms text. Leave it or delete it.
- The empty `Sheet2` is removed from every generated copy.
- The small image next to "Company Name" should survive the Google conversion; check it on the first test PDF.

## Moving off Google later
- Rewrite only `GoogleAdapter.gs` (and the menu wiring in `Main.gs`). `Config.gs` and `Logic.gs` run unchanged in Node.js.
- The template stays a normal `.xlsx` with plain formulas: fill it with `openpyxl` or Node and convert to PDF with headless LibreOffice (`tests/verify_template.py` already does exactly that).
- Tracker tabs are flat tables with one header row, so each exports to CSV or imports into a database as-is.
- Avoid Google-only functions (`QUERY`, `ARRAYFORMULA`, `IMPORTRANGE`) in the template.

## Troubleshooting
| Message | Fix |
|---|---|
| "The template is still an .xlsx file" | Template must be a Google Sheet: File > Save as Google Sheets, use the new ID |
| "Cannot open the template" | Wrong `TemplateFileId` or the file is not shared with your account |
| "Total mismatch" | Formulas in template rows 22-27 changed; check them |
| "placeholder text in: ..." | Template has a new `<...>` cell; add it to `Config.gs` + `Logic.gs` `buildCellWrites` or clear it |
| "Client ID ... is not in the Clients tab" | Typo, or the row is below a blank gap |
| Export failed (HTTP 4xx) | Re-run Check setup and re-approve permissions |

## Not verified here
`GoogleAdapter.gs` and `Main.gs` call Google services and could not be run outside your account. Logic and template mapping were tested; the first real invoice is the test for the rest (see PLAN.md, Phase 5). The picture feature (`insertImages`) is the least certain part.
