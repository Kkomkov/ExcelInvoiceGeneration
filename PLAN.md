# Invoice automation (Google Apps Script) - plan and to-do

Goal: one click turns a form row into a populated **.xlsx** invoice (from your template) plus a **.pdf**, and logs it in a tracking workbook (clients, invoices, lines, payment status). Logic is kept separate from Google calls so it can move to another cloud later.

## Status legend
`[x]` done and checked here - `[ ]` still to do - `[g]` can only be done/checked inside your Google account

## Phase 1 - Understand the template
- [x] Read the template: sheet `Sheet1`, placeholders, merged cells, formulas (`G23/G24/G26 = E*F`, `G27 = SUM(G22:G26)`, `E12` payment-terms text)
- [x] Map every placeholder cell to an input (company, bank, client, dates, invoice no, items) - all in `Config.gs`
- [x] Decide: template formulas stay as they are; the script only fills inputs

## Phase 2 - Apps Script project (`apps-script/`)
- [x] `appsscript.json` (Europe/London, V8, minimum scopes)
- [x] `Config.gs` - tabs, column headers, template cell map, settings keys
- [x] `Logic.gs` - pure logic: invoice number `ddmmyyyy-NN`, due date, totals, validation, cell-write list, log records
- [x] `GoogleAdapter.gs` - all Google calls: read tabs, copy template, fill, export xlsx/pdf, save to Drive, log, status updates
- [x] `Main.gs` - menu `Invoices`: Generate, Clear form, Mark paid, Refresh overdue, Check setup

## Phase 3 - Tracking workbook
- [x] `Invoice_Tracker.xlsx`: ReadMe, Settings, Clients, NewInvoice (form), Invoices, InvoiceLines, Summary
- [x] Dropdown of clients, status dropdown, text columns for IDs/phones (leading zeros kept), £ and dd/mm/yyyy formats
- [x] Summary formulas (outstanding, overdue, paid) checked with sample rows

## Phase 4 - Checks done here
- [x] 16 Node tests for the pure logic (`node tests/run_tests.js`)
- [x] Template mapping verified in LibreOffice with a sample invoice: no placeholders left, total = £122.70 matches, payment-terms date follows the invoice date (`python3 tests/verify_template.py <template.xlsx>`)
- [x] Tracker headers match `Config.gs` exactly; client lookup formula works
- [ ] NOT run here: `GoogleAdapter.gs` / `Main.gs` need your Google account (see Phase 5)

## Phase 5 - Your setup in Google (about 15 minutes; details in README.md)
- [g] Upload `Invoice_Tracker.xlsx` to Drive, open it, **File > Save as Google Sheets**
- [g] Upload your invoice template, **Save as Google Sheets**, copy its file ID into `Settings > TemplateFileId`
- [g] Fill the yellow cells in `Settings` (company + bank details)
- [g] Extensions > Apps Script: add the 4 `.gs` files and the manifest
- [g] Reload the sheet, run `Invoices > Check setup`, approve permissions
- [g] Add one real client, generate a **test invoice**, open the PDF and compare with your template
- [g] Test: unused line (leave Postage blank), a client with its own payment terms, two invoices on the same day (`-01`, `-02`)
- [g] Optional: try the picture feature with one Drive image ID

## Phase 6 - Later (not built, easy to add)
- [x] Multiple jobs per invoice: each NewInvoice table row has its own title, Work and Materials subrows; postage remains invoice-level
- [ ] Email the PDF to the client's address (adapter function `sendEmail`)
- [ ] Batch mode: several invoices from rows instead of the single form
- [ ] Auto-convert the .xlsx template via the Drive advanced service
- [ ] Python/Node adapter to run the same logic outside Google (`Logic.gs` + `Config.gs` are reused as-is)
