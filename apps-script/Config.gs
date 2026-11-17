/**
 * Config.gs - the ONE place that knows the layout of your files.
 *
 * If you move a cell in the invoice template, rename a tab, or add a column,
 * change it here. Logic.gs and Main.gs never contain cell addresses.
 * (No Google calls in this file, so it also loads unchanged in Node.js.)
 */
var CONFIG = {

  // ---- Tabs in the tracker workbook (the Google Sheet this script is bound to) ----
  sheets: {
    settings: 'Settings',
    clients: 'Clients',
    form: 'NewInvoice',
    invoices: 'Invoices',
    lines: 'InvoiceLines'
  },

  // ---- Column headers of the flat tables. Order in the sheet does not matter: ----
  // ---- the script finds columns by header name. Do not rename a header without ----
  // ---- renaming it here SupplierCodetoo.                                                    ----
  columns: {
    clients: ['ClientId', 'ContactNames', 'CompanyName', 'RegNumber', 'Address',
              'Phones', 'Emails', 'PaymentTermsDays','SupplierCode' ,'Notes'],
    invoices: ['InvoiceNo', 'IssueDate', 'DueDate', 'ClientId', 'ClientCompany',
               'JobTitle', 'Total', 'Status', 'PaidDate', 'XlsxLink', 'PdfLink',
               'CreatedAt', 'Notes'],
    lines: ['InvoiceNo', 'LineNo', 'Item', 'Description', 'Qty', 'UnitPrice', 'LineTotal']
  },
  textColumns: ['InvoiceNo', 'ClientId', 'RegNumber', 'Phones'],  // always stored as text
  dateColumns: ['IssueDate', 'DueDate', 'PaidDate'],
  moneyColumns: ['Total', 'UnitPrice', 'LineTotal'],
  dateFormatSheet: 'dd/mm/yyyy',
  moneyFormatSheet: '£#,##0.00',

  statuses: { issued: 'Issued', paid: 'Paid', overdue: 'Overdue', voided: 'Void' },

  // ---- The input form tab (NewInvoice) ----
  form: {
    cells: {
      clientId: 'B4',
      clientLookup: 'B5',      // formula, read-only
      issueDate: 'B6',         // blank = today
      paymentTermsDays: 'B7',  // blank = client's value, else Settings default
      postagePrice: 'B30',
      imageFileIds: 'B31',     // optional, comma-separated Drive file IDs
      notes: 'B32'             // internal, logged but not printed
    },
    jobTable: {
      headerRow: 8,
      startRow: 9,
      rowCount: 20,
      startColumn: 1,
      columnCount: 6,
      columns: { title: 1, workQty: 2, workPrice: 3, materialsQty: 4, materialsPrice: 5, materialsDetail: 6 }
    },
    lastResultCell: 'B34'
  },

  // ---- The invoice template (your .xlsx, converted once to a Google Sheet) ----
  template: {
    sheetName: 'Sheet1',
    removeSheets: ['Sheet2'],          // empty tabs deleted from each generated copy
    dateFormat: 'mmmm dd yyyy',
    supplierCodeLabelText: 'Supplier Code',
    currencyFormat: '£#,##0.00',
    cells: {
      companyName: 'D4',
      companyAddress: 'D5',
      companyPhone: 'D6',
      companyEmail: 'D7',
      issueDate: 'H5',
      invoiceNo: 'H6',
      bankHolder: 'H9',
      bankAccount: 'H10',
      bankSort: 'H11',
      paymentTerms: 'E12',
      clientContact: 'D14',
      clientCompany: 'D15',
      clientRegNo: 'F15',
      clientAddress: 'D16',
      clientPhones: 'D17',
      clientEmails: 'D18',
      supplierCodeLabel: 'C9',
      supplierCode: 'D9',
      total: 'G27',                    // formula in template: =SUM(G22:G26), read back and checked
      imagesPlaceholder: 'A41'         // "<optional items images>" text, cleared on every invoice
    },
    jobLayout: {
      firstRow: 22,
      rowsPerJob: 4,
      titleColumn: 'B',
      detailColumn: 'B',
      workRowOffset: 1,
      materialsRowOffset: 2,
      detailRowOffset: 3,
      qtyColumn: 'E',
      priceColumn: 'F',
      totalColumn: 'G',
      postageRowOffset: 4,
      totalRowOffset: 5
    },
    // Rewritten per invoice so the due date follows the invoice date, not TODAY().
    // {DATE} = issue-date cell, {DAYS} = payment terms in days.
    paymentTermsFormula:
      '="Payment terms (due in {DAYS} days, until "&TEXT({DATE}+{DAYS}, "mmmm dd, yyyy")&")"',
    // Priced rows. Labels ("Work", "Materials", "Postage") stay as typed in the template.
    lines: [
      { key: 'work',      label: 'Work',      qty: 'E23', price: 'F23', total: 'G23', defaultQty: 1 },
      { key: 'materials', label: 'Materials', qty: 'E24', price: 'F24', total: 'G24', defaultQty: 1 },
      { key: 'postage',   label: 'Postage',   qty: 'E26', price: 'F26', total: 'G26', defaultQty: 1 }
    ],
    imagesFirstRow: 42                 // optional images are stacked from here downwards
  },

  // ---- Settings tab keys (column A) that must be filled in ----
  requiredSettings: ['TemplateFileId', 'CompanyName', 'CompanyAddress', 'CompanyPhone',
                     'CompanyEmail', 'BankHolder', 'BankAccount', 'BankSortCode'],
  defaultPaymentTermsDays: 30,

  // Drive sub-folder for each invoice = a 12-month period starting in this month (1-12).
  // 5 -> "May 2025 - April 2026", 4 -> "April 2025 - March 2026", 1 -> calendar year.
  folderPeriodStartMonth: 5,

  // Keep the populated Google Sheet copy after exporting? Normally no.
  keepGoogleSheetCopy: false,
  // Sheet total vs script total may differ by rounding of unrounded quantities.
  totalTolerance: 0.02
};
