/**
 * GoogleAdapter.gs - EVERYTHING that touches Google services lives here.
 *
 * SpreadsheetApp, DriveApp, UrlFetchApp, ScriptApp, Utilities, LockService.
 * To move off Google, rewrite the functions in this file (same names, same
 * inputs/outputs) and Main.gs's workflow keeps working.
 */

// ------------------------------------------------------------- basics ----

function tz_() {
  return Session.getScriptTimeZone();
}

function todayIso_() {
  return Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd');
}

function nowStamp_() {
  return Utilities.formatDate(new Date(), tz_(), "yyyy-MM-dd'T'HH:mm:ss");
}

function isoToDate_(iso) {
  return Utilities.parseDate(iso, tz_(), 'yyyy-MM-dd');
}

/** Cell value from the sheet -> ISO date string, or '' if blank, or the raw text. */
function cellToIso_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, tz_(), 'yyyy-MM-dd');
  return v === null || v === undefined ? '' : String(v).trim();
}

function getSheet_(name) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error('Tab "' + name + '" not found. Run Invoices > Check setup.');
  return sh;
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    throw new Error('Another invoice is being generated right now. Try again in a moment.');
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// ----------------------------------------------------------- reading data ----

/** Whole tab -> [{Header: value}] keyed by the header row. Skips fully blank rows. */
function readTable_(sheetName) {
  var sh = getSheet_(sheetName);
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return [];
  var headers = data[0].map(function (h) { return String(h).trim(); });
  var rows = [];
  for (var i = 1; i < data.length; i++) {
    var obj = {};
    var any = false;
    for (var j = 0; j < headers.length; j++) {
      if (headers[j] === '') continue;
      obj[headers[j]] = data[i][j];
      if (data[i][j] !== '' && data[i][j] !== null) any = true;
    }
    if (any) rows.push(obj);
  }
  return rows;
}

function loadSettings() {
  var sh = getSheet_(CONFIG.sheets.settings);
  var data = sh.getDataRange().getValues();
  var raw = {};
  for (var i = 1; i < data.length; i++) {
    var k = String(data[i][0] === null ? '' : data[i][0]).trim();
    if (k) raw[k] = data[i][1];
  }
  return { raw: raw, settings: normalizeSettings(raw, CONFIG.defaultPaymentTermsDays) };
}

function loadClientById(clientId) {
  var rows = readTable_(CONFIG.sheets.clients);
  for (var i = 0; i < rows.length; i++) {
    if (str(rows[i].ClientId).toLowerCase() === str(clientId).toLowerCase()) {
      return normalizeClient(rows[i]);
    }
  }
  return null;
}

function loadExistingInvoiceNumbers() {
  return readTable_(CONFIG.sheets.invoices).map(function (r) { return r.InvoiceNo; });
}

/** Reads the NewInvoice form into a plain object. */
function readForm() {
  var sh = getSheet_(CONFIG.sheets.form);
  var c = CONFIG.form.cells;
  var v = function (key) { return sh.getRange(c[key]).getValue(); };

  var issueRaw = cellToIso_(v('issueDate'));
  var daysRaw = v('paymentTermsDays');
  var table = CONFIG.form.jobTable;
  var rows = sh.getRange(table.startRow, table.startColumn, table.rowCount, table.columnCount).getValues();
  var jobs = rows.map(function (row) {
    var col = table.columns;
    return {
      title: str(row[col.title - 1]),
      workQty: row[col.workQty - 1],
      workPrice: row[col.workPrice - 1],
      materialsQty: row[col.materialsQty - 1],
      materialsPrice: row[col.materialsPrice - 1],
      materialsDetail: str(row[col.materialsDetail - 1])
    };
  }).filter(function (job) {
    return job.title || job.workQty !== '' || job.workPrice !== '' ||
      job.materialsQty !== '' || job.materialsPrice !== '' || job.materialsDetail;
  });
  return {
    clientId: str(v('clientId')),
    issueDateRaw: issueRaw,
    issueDate: issueRaw === '' ? '' : parseDateLoose(issueRaw),
    paymentTermsDays: (daysRaw === '' || daysRaw === null) ? null : toNumber(daysRaw),
    jobs: jobs,
    postagePrice: v('postagePrice'),
    imageFileIds: parseFileIds(v('imageFileIds')),
    notes: str(v('notes'))
  };
}

function clearFormInputs() {
  var sh = getSheet_(CONFIG.sheets.form);
  var c = CONFIG.form.cells;
  ['clientId', 'issueDate', 'paymentTermsDays', 'postagePrice', 'imageFileIds', 'notes'].forEach(function (key) {
    sh.getRange(c[key]).clearContent();
  });
  var table = CONFIG.form.jobTable;
  sh.getRange(table.startRow, table.startColumn, table.rowCount, table.columnCount).clearContent();
}

function showFormResult(text) {
  getSheet_(CONFIG.sheets.form).getRange(CONFIG.form.lastResultCell).setValue(text);
}

// ------------------------------------------------------ template + export ----

function getTrackerParentFolder_() {
  var file = DriveApp.getFileById(SpreadsheetApp.getActiveSpreadsheet().getId());
  var parents = file.getParents();
  return parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
}

/** Output folder for an invoice date: <root>/<period>, e.g. "May 2025 - April 2026". Root = Settings or "Invoices" next to the tracker. */
function getOutputFolder(settings, issueIso) {
  var root;
  if (settings.outputFolderId) {
    root = DriveApp.getFolderById(settings.outputFolderId);
  } else {
    var parent = getTrackerParentFolder_();
    var it = parent.getFoldersByName('Invoices');
    root = it.hasNext() ? it.next() : parent.createFolder('Invoices');
  }
  var periodName = periodFolderName(issueIso, CONFIG.folderPeriodStartMonth);  // e.g. "May 2025 - April 2026"
  var pit = root.getFoldersByName(periodName);                  // look for an existing period folder
  return pit.hasNext() ? pit.next() : root.createFolder(periodName);   // otherwise create it
}

/** The template must be a native Google Sheet (convert the .xlsx once). */
function assertTemplateIsGoogleSheet(templateFileId) {
  var f;
  try {
    f = DriveApp.getFileById(templateFileId);
  } catch (e) {
    throw new Error('Cannot open the template (TemplateFileId in Settings). Check the ID and your access.');
  }
  if (f.getMimeType() !== MimeType.GOOGLE_SHEETS) {
    throw new Error('The template is still an .xlsx file. Open it in Google Drive, choose ' +
      'File > Save as Google Sheets, and put the NEW file\'s ID in Settings > TemplateFileId.');
  }
}

/** Copies the template into the output folder. Returns {file, ss, sheet}. */
function copyTemplate(templateFileId, copyName, folder) {
  assertTemplateIsGoogleSheet(templateFileId);
  var file = DriveApp.getFileById(templateFileId).makeCopy('TEMP ' + copyName, folder);
  var ss = SpreadsheetApp.openById(file.getId());
  var sheet = ss.getSheetByName(CONFIG.template.sheetName);
  if (!sheet) {
    file.setTrashed(true);
    throw new Error('Template tab "' + CONFIG.template.sheetName + '" not found.');
  }
  CONFIG.template.removeSheets.forEach(function (name) {
    var extra = ss.getSheetByName(name);
    if (extra && ss.getSheets().length > 1) ss.deleteSheet(extra);
  });
  return { file: file, ss: ss, sheet: sheet };
}

function prepareInvoiceRows(sheet, jobCount) {
  var layout = CONFIG.template.jobLayout;
  var extraJobs = jobCount - 1;
  if (extraJobs <= 0) return;
  var rowsToInsert = extraJobs * layout.rowsPerJob;
  var insertBefore = layout.firstRow + layout.rowsPerJob;
  sheet.insertRowsBefore(insertBefore, rowsToInsert);
  var source = sheet.getRange(layout.firstRow, 1, layout.rowsPerJob, sheet.getMaxColumns());
  for (var i = 1; i <= extraJobs; i++) {
    source.copyTo(sheet.getRange(layout.firstRow + i * layout.rowsPerJob, 1,
      layout.rowsPerJob, sheet.getMaxColumns()));
  }
}

/** Applies the list built by Logic.buildCellWrites(). */
function applyWrites(sheet, writes) {
  writes.forEach(function (w) {
    var r = sheet.getRange(w.cell);
    if (w.kind === 'blank' || (w.kind === 'text' && w.value === '')) {
      r.clearContent();
    } else if (w.kind === 'text') {
      r.setNumberFormat('@');          // text first: keeps 07xxx, 0123, 04-00-04 intact
      r.setValue(w.value);
    } else if (w.kind === 'date') {
      if (w.numberFormat) r.setNumberFormat(w.numberFormat);
      r.setValue(isoToDate_(w.value));
    } else if (w.kind === 'number') {
      if (w.numberFormat) r.setNumberFormat(w.numberFormat);
      r.setValue(w.value);
    } else if (w.kind === 'formula') {
      r.setFormula(w.value);
    } else {
      throw new Error('Unknown write kind: ' + w.kind);
    }
  });
  SpreadsheetApp.flush();
}

function readSheetTotal(sheet, totalCell) {
  return Number(sheet.getRange(totalCell || CONFIG.template.cells.total).getValue());
}

/** Any "<...>" template placeholder still left on the sheet, as A1 addresses. */
function scanPlaceholders(sheet) {
  var range = sheet.getDataRange();
  var values = range.getValues();
  var found = {};
  for (var r = 0; r < values.length; r++) {
    for (var c = 0; c < values[r].length; c++) {
      if (typeof values[r][c] === 'string') {
        found[sheet.getRange(r + 1, c + 1).getA1Notation()] = values[r][c];
      }
    }
  }
  return findPlaceholderCells(found);
}

/** Optional pictures from Drive, stacked under the invoice (row config.imagesFirstRow). */
function insertImages(sheet, fileIds, jobCount) {
  var row = CONFIG.template.imagesFirstRow +
    Math.max(0, (jobCount || 1) - 1) * CONFIG.template.jobLayout.rowsPerJob;
  var maxWidth = 600;
  var used = 0;
  fileIds.forEach(function (id) {
    var blob = DriveApp.getFileById(id).getBlob();
    var needRows = row + 40;
    if (sheet.getMaxRows() < needRows) sheet.insertRowsAfter(sheet.getMaxRows(), needRows - sheet.getMaxRows());
    var img = sheet.insertImage(blob, 1, row);
    var w = img.getWidth(), h = img.getHeight();
    if (w > maxWidth) {
      img.setHeight(Math.round(h * maxWidth / w));
      img.setWidth(maxWidth);
      h = img.getHeight();
    }
    row += Math.ceil(h / 21) + 2;      // default row height is 21 px
    used += 1;
  });
  SpreadsheetApp.flush();
  return used;
}

/** Exports one format ('xlsx' | 'pdf') of a spreadsheet. Returns a Blob. */
function exportBlob(ssId, format, sheetGid) {
  var url = 'https://docs.google.com/spreadsheets/d/' + ssId + '/export?';
  var params = (format === 'pdf')
    ? ['format=pdf', 'size=A4', 'portrait=true', 'fitw=true', 'gridlines=false',
       'printtitle=false', 'sheetnames=false', 'pagenum=UNDEFINED', 'attachment=false',
       'gid=' + sheetGid]
    : ['format=xlsx'];
  var res = UrlFetchApp.fetch(url + params.join('&'), {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('Export to ' + format + ' failed (HTTP ' + res.getResponseCode() + ').');
  }
  return res.getBlob();
}

/** Saves a blob into a folder. Returns {id, url}. */
function saveBlob(folder, blob, fileName) {
  blob.setName(fileName);
  var f = folder.createFile(blob);
  return { id: f.getId(), url: f.getUrl(), name: f.getName() };
}

/** Readable path of a Drive folder, e.g. "My Drive / Invoices / 2026". */
function getFolderPath(folder) {
  var parts = [folder.getName()];
  var cur = folder;
  while (true) {
    var parents = cur.getParents();
    if (!parents.hasNext()) break;
    cur = parents.next();
    parts.unshift(cur.getName());
  }
  return parts.join(' / ');
}

function trashFile(fileId) {
  try { DriveApp.getFileById(fileId).setTrashed(true); } catch (e) { /* already gone */ }
}

// ------------------------------------------------------------- logging ----
/** First row whose key column is empty. Rows that only hold formulas do not count as used. */
function nextFreeRow_(sh, headers, keyHeader) {
  var keyCol = headers.indexOf(keyHeader) + 1;
  if (!keyCol) throw new Error('Tab "' + sh.getName() + '" needs a "' + keyHeader + '" column.');
  var last = sh.getLastRow();
  if (last < 2) return 2;
  var keys = sh.getRange(2, keyCol, last - 1, 1).getValues();
  for (var i = 0; i < keys.length; i++) {
    if (keys[i][0] === '' || keys[i][0] === null) return i + 2;
  }
  return last + 1;
}
function appendByHeaders_(sheetName, obj) {
  var sh = getSheet_(sheetName);
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(function (h) { return String(h).trim(); });
  var rowIdx = nextFreeRow_(sh, headers, 'InvoiceNo');
  headers.forEach(function (h, i) {
    if (!Object.prototype.hasOwnProperty.call(obj, h)) return;   // not in the record: leave the cell (formula) alone
    var cell = sh.getRange(rowIdx, i + 1);
    var v = obj[h];
    if (CONFIG.textColumns.indexOf(h) >= 0) cell.setNumberFormat('@');
    if (CONFIG.dateColumns.indexOf(h) >= 0) { cell.setNumberFormat(CONFIG.dateFormatSheet); if (v !== '') v = isoToDate_(v); }
    if (CONFIG.moneyColumns.indexOf(h) >= 0) cell.setNumberFormat(CONFIG.moneyFormatSheet);
    cell.setValue(v === null || v === undefined ? '' : v);
  });
  return rowIdx;
}

function appendInvoiceRow(record) {
  return appendByHeaders_(CONFIG.sheets.invoices, record);
}

function appendLineRows(records) {
  records.forEach(function (r) { appendByHeaders_(CONFIG.sheets.lines, r); });
}

/** Marks rows of the Invoices tab as paid. rows = 1-based row numbers (>= 2). */
function setRowsPaid(rows, paidIso) {
  var sh = getSheet_(CONFIG.sheets.invoices);
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(function (h) { return String(h).trim(); });
  var statusCol = headers.indexOf('Status') + 1;
  var paidCol = headers.indexOf('PaidDate') + 1;
  if (!statusCol || !paidCol) throw new Error('Invoices tab needs Status and PaidDate columns.');
  var count = 0;
  rows.forEach(function (r) {
    if (r < 2) return;
    sh.getRange(r, statusCol).setValue(CONFIG.statuses.paid);
    var pc = sh.getRange(r, paidCol);
    pc.setNumberFormat(CONFIG.dateFormatSheet);
    pc.setValue(isoToDate_(paidIso));
    count += 1;
  });
  return count;
}

/** Issued invoices whose due date has passed become Overdue. Returns how many changed. */
function refreshOverdueStatuses() {
  var sh = getSheet_(CONFIG.sheets.invoices);
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return 0;
  var headers = data[0].map(function (h) { return String(h).trim(); });
  var statusCol = headers.indexOf('Status');
  var dueCol = headers.indexOf('DueDate');
  if (statusCol < 0 || dueCol < 0) throw new Error('Invoices tab needs Status and DueDate columns.');
  var today = todayIso_();
  var changed = 0;
  for (var i = 1; i < data.length; i++) {
    var due = cellToIso_(data[i][dueCol]);
    if (isOverdue(String(data[i][statusCol]).trim(), parseDateLoose(due), today, CONFIG.statuses)) {
      sh.getRange(i + 1, statusCol + 1).setValue(CONFIG.statuses.overdue);
      changed += 1;
    }
  }
  return changed;
}

// ------------------------------------------------------------------ UI ----

function alertUi(title, message) {
  SpreadsheetApp.getUi().alert(title, message, SpreadsheetApp.getUi().ButtonSet.OK);
}
