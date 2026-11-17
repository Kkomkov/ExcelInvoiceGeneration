/**
 * Main.gs - menu and the invoice workflow.
 *
 * Uses Logic.gs for decisions and GoogleAdapter.gs for anything Google-specific.
 * Workflow for "Generate invoice":
 *   read form -> validate -> number -> build cell writes -> copy template -> fill
 *   -> check total + placeholders -> export .xlsx and .pdf -> save to Drive
 *   -> log in Invoices + InvoiceLines -> delete the temporary Sheet copy.
 */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Invoices')
    .addItem('Generate invoice from NewInvoice tab', 'generateInvoice')
    .addItem('Clear NewInvoice form', 'clearForm')
    .addSeparator()
    .addItem('Mark selected invoice row(s) as paid', 'markSelectedPaid')
    .addItem('Refresh overdue statuses', 'refreshOverdue')
    .addSeparator()
    .addItem('Check setup', 'checkSetup')
    .addToUi();
}

/** Main entry point. Safe to click twice: a lock stops overlapping runs. */
function generateInvoice() {
  var created = [];       // Drive file IDs to remove again if something fails
  var tempId = null;
  try {
    var result = withLock_(function () {
      // 1. Settings and input
      var loaded = loadSettings();
      var settings = loaded.settings;
      var settingsErrors = validateSettings(loaded.raw, CONFIG.requiredSettings);
      if (settingsErrors.length) throw new Error(settingsErrors.join('\n'));

      var input = readForm();
      var inputErrors = validateInvoiceInput(input, CONFIG.template.lines);
      if (inputErrors.length) throw new Error(inputErrors.join('\n'));

      var client = loadClientById(input.clientId);
      if (!client) throw new Error('Client ID "' + input.clientId + '" is not in the Clients tab.');

      // 2. Business decisions (pure logic)
      var issueIso = input.issueDate || todayIso_();
      var days = resolvePaymentTerms(input.paymentTermsDays, client, settings);
      var invoiceNo = nextInvoiceNumber(loadExistingInvoiceNumbers(), issueIso);
      var calc = calcInvoiceJobs(input.jobs, input.postagePrice, CONFIG.template.lines);
      var ctx = {
        settings: settings,
        client: client,
        invoice: {
          invoiceNo: invoiceNo,
          issueDate: issueIso,
          paymentTermsDays: days,
          jobs: input.jobs,
          calc: calc
        }
      };
      var baseName = buildFileBaseName(invoiceNo, client.companyName);
      var writes = buildCellWrites(ctx, CONFIG);

      // 3. Fill a copy of the template
      var folder = getOutputFolder(settings, issueIso);
      var copy = copyTemplate(settings.templateFileId, baseName, folder);
      tempId = copy.file.getId();
      prepareInvoiceRows(copy.sheet, input.jobs.length);
      applyWrites(copy.sheet, writes);
      if (input.imageFileIds.length) insertImages(copy.sheet, input.imageFileIds, input.jobs.length);

      // 4. Safety checks before anything is exported
      var sheetTotal = readSheetTotal(copy.sheet, ctx.invoice.totalCell);
      if (!totalsMatch(sheetTotal, calc.subtotal, CONFIG.totalTolerance)) {
        throw new Error('Total mismatch: the template shows ' + sheetTotal + ' but the script ' +
          'calculated ' + calc.subtotal + '. Check the formulas in the invoice item rows and total.');
      }
      var leftovers = scanPlaceholders(copy.sheet);
      if (leftovers.length) {
        throw new Error('The template still contains placeholder text in: ' + leftovers.join(', ') +
          '. Add those cells to Config.gs / Logic.gs or clear them in the template.');
      }

      // 5. Export and save
      var xlsxBlob = exportBlob(copy.ss.getId(), 'xlsx');
      var pdfBlob = exportBlob(copy.ss.getId(), 'pdf', copy.sheet.getSheetId());
      var xlsx = saveBlob(folder, xlsxBlob, baseName + '.xlsx');
      created.push(xlsx.id);
      var pdf = saveBlob(folder, pdfBlob, baseName + '.pdf');
      created.push(pdf.id);

      // 6. Log (last, so a failure above never leaves a log row without files)
      var record = buildInvoiceRecord(ctx, { xlsx: xlsx.url, pdf: pdf.url }, nowStamp_(), input.notes, CONFIG);
      appendInvoiceRow(record);
      appendLineRows(buildLineRecords(ctx));

      // 7. Clean up
      if (!CONFIG.keepGoogleSheetCopy) trashFile(tempId);
      tempId = null;
      return { invoiceNo: invoiceNo, total: calc.subtotal, pdfUrl: pdf.url, xlsxUrl: xlsx.url };
    });

    showFormResult(result.invoiceNo + '  |  £' + result.total.toFixed(2) + '  |  ' + result.pdfUrl);
    alertUi('Invoice ' + result.invoiceNo + ' created',
      'Total: £' + result.total.toFixed(2) + '\n\nPDF: ' + result.pdfUrl + '\n\nXLSX: ' + result.xlsxUrl +
      '\n\nIt is logged on the Invoices tab. Use "Clear NewInvoice form" when ready for the next one.');
  } catch (e) {
    created.forEach(trashFile);
    if (tempId) trashFile(tempId);
    alertUi('Invoice not created', String(e.message || e));
  }
}

function clearForm() {
  clearFormInputs();
}

function markSelectedPaid() {
  try {
    var sheet = SpreadsheetApp.getActiveSheet();
    if (sheet.getName() !== CONFIG.sheets.invoices) {
      throw new Error('Select the invoice row(s) on the "' + CONFIG.sheets.invoices + '" tab first.');
    }
    var range = sheet.getActiveRange();
    var rows = [];
    for (var r = range.getRow(); r < range.getRow() + range.getNumRows(); r++) rows.push(r);
    var n = setRowsPaid(rows, todayIso_());
    if (!n) throw new Error('Select at least one invoice row below the header.');
    alertUi('Done', n + ' invoice(s) marked as paid today.');
  } catch (e) {
    alertUi('Not changed', String(e.message || e));
  }
}

function refreshOverdue() {
  try {
    var n = refreshOverdueStatuses();
    alertUi('Overdue check', n + ' invoice(s) changed to Overdue.');
  } catch (e) {
    alertUi('Not changed', String(e.message || e));
  }
}

/** Verifies tabs, headers, settings and the template, and explains anything missing. */
function checkSetup() {
  var problems = [];
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(CONFIG.sheets).forEach(function (k) {
    if (!ss.getSheetByName(CONFIG.sheets[k])) problems.push('Missing tab: ' + CONFIG.sheets[k]);
  });
  if (!problems.length) {
    ['clients', 'invoices', 'lines'].forEach(function (k) {
      var sh = ss.getSheetByName(CONFIG.sheets[k]);
      var headers = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0]
        .map(function (h) { return String(h).trim(); });
      CONFIG.columns[k].forEach(function (h) {
        if (headers.indexOf(h) < 0) problems.push(CONFIG.sheets[k] + ': missing column "' + h + '"');
      });
    });
    var loaded = loadSettings();
    problems = problems.concat(validateSettings(loaded.raw, CONFIG.requiredSettings));
    if (loaded.settings.templateFileId) {
      try {
        assertTemplateIsGoogleSheet(loaded.settings.templateFileId);
        var t = SpreadsheetApp.openById(loaded.settings.templateFileId);
        if (!t.getSheetByName(CONFIG.template.sheetName)) {
          problems.push('Template has no tab named "' + CONFIG.template.sheetName + '".');
        }
      } catch (e) {
        problems.push(String(e.message || e));
      }
    }
    if (loaded.settings.outputFolderId) {
      try { DriveApp.getFolderById(loaded.settings.outputFolderId); }
      catch (e2) { problems.push('Settings: OutputFolderId is not a folder you can access.'); }
    }
  }
  alertUi(problems.length ? 'Setup needs attention' : 'Setup OK',
    problems.length ? problems.join('\n') : 'All tabs, columns, settings and the template look good.');
}
