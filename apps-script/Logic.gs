/**
 * Logic.gs - pure business logic. NO Google services are called here.
 *
 * Everything in this file takes plain data in and returns plain data out, so it
 * runs unchanged in Node.js, AWS Lambda, Azure Functions, etc. If you ever leave
 * Google, this file and Config.gs come with you untouched; only GoogleAdapter.gs
 * and Main.gs are rewritten.
 *
 * Dates are passed around as ISO strings ('2026-11-14'), never Date objects,
 * so time zones cannot shift an invoice date by a day.
 */

// ---------------------------------------------------------------- numbers ----

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** null = blank, NaN = not a number, otherwise the number. Accepts "£1,234.50". */
function toNumber(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return isFinite(v) ? v : NaN;
  var s = String(v).replace(/[£,\s]/g, '');
  if (s === '') return null;
  if (!/^-?\d*\.?\d+$/.test(s)) return NaN;
  return parseFloat(s);
}

function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

// ------------------------------------------------------------------ dates ----

/** '2026-11-14' -> Date (UTC midnight), or null if invalid. */
function parseIso(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  if (!m) return null;
  var y = +m[1], mo = +m[2], d = +m[3];
  var dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}

function toIso(dt) {
  return dt.getUTCFullYear() + '-' + pad2(dt.getUTCMonth() + 1) + '-' + pad2(dt.getUTCDate());
}

/** Accepts '2026-11-14' or UK style '14/11/2026'. Returns ISO string or null. */
function parseDateLoose(s) {
  if (s === null || s === undefined) return null;
  var str = String(s).trim();
  if (parseIso(str)) return str;
  var m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(str);
  if (!m) return null;
  var iso = m[3] + '-' + pad2(+m[2]) + '-' + pad2(+m[1]);
  return parseIso(iso) ? iso : null;
}

function addDaysIso(iso, n) {
  var dt = parseIso(iso);
  if (!dt) throw new Error('Invalid date: ' + iso);
  dt.setUTCDate(dt.getUTCDate() + n);
  return toIso(dt);
}

function calcDueDate(issueIso, termsDays) {
  return addDaysIso(issueIso, termsDays);
}

function isOverdue(status, dueIso, todayIso, statuses) {
  return status === statuses.issued && !!dueIso && dueIso < todayIso;
}

// --------------------------------------------------------- invoice number ----

/** ddmmyyyy of the invoice date, e.g. '2026-11-14' -> '14112026' */
function invoiceDatePart(iso) {
  return iso.slice(8, 10) + iso.slice(5, 7) + iso.slice(0, 4);
}

function formatInvoiceNumber(iso, seq) {
  return invoiceDatePart(iso) + '-' + pad2(seq);
}

/**
 * Format: ddmmyyyy-NN where NN counts invoices issued with the same date.
 * Uses the highest existing NN (not a count) so deleting a row never causes a clash.
 */
function nextInvoiceNumber(existingNumbers, iso) {
  var prefix = invoiceDatePart(iso) + '-';
  var max = 0;
  (existingNumbers || []).forEach(function (n) {
    n = String(n === null || n === undefined ? '' : n).trim();
    if (n.indexOf(prefix) === 0) {
      var k = parseInt(n.slice(prefix.length), 10);
      if (k > max) max = k;
    }
  });
  return formatInvoiceNumber(iso, max + 1);
}

// ------------------------------------------------------------------ lines ----

/**
 * rawLines: [{key, qty, price}] straight from the form.
 * A line is "used" when it has a price. Quantity falls back to its default (1).
 * Returns {lines: [{key, used, qty, price, total}], subtotal}
 */
function calcLines(rawLines, templateLines) {
  var out = [];
  var subtotal = 0;
  templateLines.forEach(function (tl) {
    var raw = null;
    (rawLines || []).forEach(function (r) { if (r.key === tl.key) raw = r; });
    var qty = raw ? toNumber(raw.qty) : null;
    var price = raw ? toNumber(raw.price) : null;
    var used = price !== null && !isNaN(price) && price !== 0;
    if (!used) {
      out.push({ key: tl.key, label: tl.label, used: false, qty: null, price: null, total: 0 });
      return;
    }
    if (qty === null) qty = tl.defaultQty;
    var total = round2(qty * price);
    subtotal += total;
    out.push({ key: tl.key, label: tl.label, used: true, qty: qty, price: price, total: total });
  });
  return { lines: out, subtotal: round2(subtotal) };
}

function calcInvoiceJobs(jobs, postagePrice, templateLines) {
  var jobTemplates = templateLines.filter(function (line) {
    return line.key === 'work' || line.key === 'materials';
  });
  var postageTemplate = templateLines.filter(function (line) { return line.key === 'postage'; });
  var total = 0;
  var calculatedJobs = (jobs || []).map(function (job) {
    var result = calcLines([
      { key: 'work', qty: job.workQty, price: job.workPrice },
      { key: 'materials', qty: job.materialsQty, price: job.materialsPrice }
    ], jobTemplates);
    total += result.subtotal;
    return {
      title: str(job.title),
      materialsDetail: str(job.materialsDetail),
      lines: result.lines
    };
  });
  var postageResult = calcLines([{ key: 'postage', qty: null, price: postagePrice }], postageTemplate);
  total += postageResult.subtotal;
  return {
    jobs: calculatedJobs,
    postage: postageResult.lines[0],
    subtotal: round2(total)
  };
}

// ------------------------------------------------------------- validation ----

function validateSettings(settings, required) {
  var errors = [];
  required.forEach(function (key) {
    var v = settings[key];
    if (v === undefined || v === null || String(v).trim() === '') {
      errors.push('Settings: "' + key + '" is empty.');
    }
  });
  return errors;
}

/** input: see Main.generateInvoice. Returns a list of human-readable problems. */
function validateInvoiceInput(input, templateLines) {
  var errors = [];
  if (!input.clientId) errors.push('Choose a client (Client ID).');
  if (input.issueDateRaw !== '' && input.issueDateRaw !== null && input.issueDateRaw !== undefined && !input.issueDate) {
    errors.push('Issue date is not a valid date (use dd/mm/yyyy).');
  }
  if (!Array.isArray(input.jobs) && !input.title) errors.push('Job title / item name is empty.');

  if (input.paymentTermsDays !== null && input.paymentTermsDays !== undefined) {
    var d = input.paymentTermsDays;
    if (isNaN(d) || d < 0 || d > 365 || Math.floor(d) !== d) {
      errors.push('Payment terms must be a whole number of days between 0 and 365.');
    }
  }

  var jobs = input.jobs;
  var postagePrice = input.postagePrice;
  if (!Array.isArray(jobs)) {
    jobs = [{
      title: input.title,
      workQty: null,
      workPrice: null,
      materialsQty: null,
      materialsPrice: null,
      materialsDetail: ''
    }];
    (input.lines || []).forEach(function (line) {
      if (line.key === 'work') {
        jobs[0].workQty = line.qty;
        jobs[0].workPrice = line.price;
      } else if (line.key === 'materials') {
        jobs[0].materialsQty = line.qty;
        jobs[0].materialsPrice = line.price;
      } else if (line.key === 'postage') {
        postagePrice = line.price;
      }
    });
  }

  var anyPriced = false;
  if (!jobs.length) errors.push('Enter at least one job title.');
  jobs.forEach(function (job, index) {
    var title = str(job.title);
    var hasValues = title || str(job.workQty) || str(job.workPrice) ||
      str(job.materialsQty) || str(job.materialsPrice) || str(job.materialsDetail);
    if (!hasValues) return;
    var prefix = 'Job ' + (index + 1) + ': ';
    if (!title && Array.isArray(input.jobs)) errors.push(prefix + 'enter a job title / item name.');
    var hasJobPrice = false;
    [
      { label: 'Work', qty: job.workQty, price: job.workPrice },
      { label: 'Materials', qty: job.materialsQty, price: job.materialsPrice }
    ].forEach(function (line) {
      var qty = toNumber(line.qty);
      var price = toNumber(line.price);
      if (typeof qty === 'number' && isNaN(qty)) errors.push(prefix + line.label + ': quantity is not a number.');
      if (typeof price === 'number' && isNaN(price)) errors.push(prefix + line.label + ': unit price is not a number.');
      if (typeof qty === 'number' && !isNaN(qty) && qty < 0) errors.push(prefix + line.label + ': quantity cannot be negative.');
      if (typeof price === 'number' && !isNaN(price) && price !== 0) {
        anyPriced = true;
        hasJobPrice = true;
      }
      if (price === null && qty !== null) errors.push(prefix + line.label + ': quantity given but no unit price.');
    });
    if (Array.isArray(input.jobs) && title && !hasJobPrice) {
      errors.push(prefix + 'enter a price for Work or Materials.');
    }
  });
  var postage = toNumber(postagePrice);
  if (typeof postage === 'number' && isNaN(postage)) errors.push('Postage: unit price is not a number.');
  if (typeof postage === 'number' && !isNaN(postage) && postage !== 0) anyPriced = true;
  if (!anyPriced) errors.push('Enter a price for at least one Work, Materials or Postage line.');
  return errors;
}

// -------------------------------------------------------- normalisation ----

function str(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

function normalizeSettings(raw, defaultDays) {
  var days = toNumber(raw.PaymentTermsDays);
  return {
    templateFileId: str(raw.TemplateFileId),
    outputFolderId: str(raw.OutputFolderId),
    companyName: str(raw.CompanyName),
    companyAddress: str(raw.CompanyAddress),
    companyPhone: str(raw.CompanyPhone),
    companyEmail: str(raw.CompanyEmail),
    bankHolder: str(raw.BankHolder),
    bankAccount: str(raw.BankAccount),
    bankSortCode: str(raw.BankSortCode),
    paymentTermsDays: (typeof days === 'number' && !isNaN(days)) ? days : defaultDays
  };
}

function normalizeClient(row) {
  var days = toNumber(row.PaymentTermsDays);
  return {
    clientId: str(row.ClientId),
    contactNames: str(row.ContactNames),
    companyName: str(row.CompanyName),
    regNumber: str(row.RegNumber),
    address: str(row.Address),
    phones: str(row.Phones),
    emails: str(row.Emails),
    supplierCode: str(row.SupplierCode),
    paymentTermsDays: (typeof days === 'number' && !isNaN(days)) ? days : null
  };
}

function resolvePaymentTerms(inputDays, client, settings) {
  if (typeof inputDays === 'number' && !isNaN(inputDays)) return inputDays;
  if (client && client.paymentTermsDays !== null) return client.paymentTermsDays;
  return settings.paymentTermsDays;
}

// ---------------------------------------------------------- period folder ----

var MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                   'August', 'September', 'October', 'November', 'December'];

/**
 * Folder name for the 12-month period (starting in startMonth) that contains the invoice date.
 * periodFolderName('2026-02-10', 5) -> 'May 2025 - April 2026'
 * periodFolderName('2026-05-01', 5) -> 'May 2026 - April 2027'
 */
function periodFolderName(iso, startMonth) {
  var y = parseInt(iso.slice(0, 4), 10);
  var m = parseInt(iso.slice(5, 7), 10);
  var startYear = m >= startMonth ? y : y - 1;
  var endMonth = startMonth === 1 ? 12 : startMonth - 1;
  var endYear = startMonth === 1 ? startYear : startYear + 1;
  return MONTH_NAMES[startMonth - 1] + ' ' + startYear + ' - ' + MONTH_NAMES[endMonth - 1] + ' ' + endYear;
}

// ------------------------------------------------------------- file names ----

function sanitizeFileName(s) {
  return String(s || '')
    .replace(/[\\\/:*?"<>|%#\[\]\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

function buildFileBaseName(invoiceNo, clientCompany) {
  return sanitizeFileName('Invoice ' + invoiceNo + ' - ' + (clientCompany || 'client'));
}

// ------------------------------------------------------ template mapping ----

function textWrite(cell, value) {
  return { cell: cell, kind: 'text', value: str(value) };
}

/**
 * Turns an invoice into a flat list of cell writes for the template:
 *   {cell, kind: 'text'|'date'|'number'|'formula'|'blank', value, numberFormat?}
 * The adapter applies them. Every placeholder cell in the template is covered,
 * either with a value or with a 'blank' / empty text (which clears it).
 *
 * ctx = {settings, client, invoice: {invoiceNo, issueDate, paymentTermsDays,
 *        jobs, calc}}
 */
function buildCellWrites(ctx, cfg) {
  var c = cfg.template.cells;
  var s = ctx.settings, cl = ctx.client, inv = ctx.invoice;
  var layout = cfg.template.jobLayout;
  var w = [];

  // Business details (from Settings tab)
  w.push(textWrite(c.companyName, s.companyName));
  w.push(textWrite(c.companyAddress, s.companyAddress));
  w.push(textWrite(c.companyPhone, s.companyPhone));
  w.push(textWrite(c.companyEmail, s.companyEmail));
  w.push(textWrite(c.bankHolder, s.bankHolder));
  w.push(textWrite(c.bankAccount, s.bankAccount));
  w.push(textWrite(c.bankSort, s.bankSortCode));

  // Invoice header
  w.push({ cell: c.issueDate, kind: 'date', value: inv.issueDate, numberFormat: cfg.template.dateFormat });
  w.push(textWrite(c.invoiceNo, inv.invoiceNo));
  w.push({
    cell: c.paymentTerms,
    kind: 'formula',
    value: cfg.template.paymentTermsFormula
      .split('{DATE}').join(c.issueDate)
      .split('{DAYS}').join(String(inv.paymentTermsDays))
  });

  // Client
  w.push(textWrite(c.clientContact, cl.contactNames));
  w.push(textWrite(c.clientCompany, cl.companyName));
  w.push(textWrite(c.clientRegNo, cl.regNumber));
  w.push(textWrite(c.clientAddress, cl.address));
  w.push(textWrite(c.clientPhones, cl.phones));
  w.push(textWrite(c.clientEmails, cl.emails));
  w.push(textWrite(c.supplierCodeLabel, cl.supplierCode ? cfg.template.supplierCodeLabelText : ''));
w.push(textWrite(c.supplierCode, cl.supplierCode));

  // Job titles and their Work / Materials subrows
  var jobs = inv.calc.jobs || [{
    title: inv.title,
    materialsDetail: inv.materialsDetail,
    lines: inv.calc.lines.filter(function (line) { return line.key !== 'postage'; })
  }];
  function writePricedLine(line, row) {
    var qtyCell = layout.qtyColumn + row;
    var priceCell = layout.priceColumn + row;
    var totalCell = layout.totalColumn + row;
    if (line && line.used) {
      w.push({ cell: qtyCell, kind: 'number', value: line.qty });
      w.push({ cell: priceCell, kind: 'number', value: line.price, numberFormat: cfg.template.currencyFormat });
    } else {
      w.push({ cell: qtyCell, kind: 'blank', value: '' });
      w.push({ cell: priceCell, kind: 'blank', value: '' });
    }
    w.push({ cell: totalCell, kind: 'formula',
      value: '=' + qtyCell + '*' + priceCell });
  }
  jobs.forEach(function (job, index) {
    var firstRow = layout.firstRow + index * layout.rowsPerJob;
    w.push(textWrite(layout.titleColumn + firstRow, job.title));
    w.push(textWrite(layout.detailColumn + (firstRow + layout.detailRowOffset), job.materialsDetail));
    var work = null, materials = null;
    job.lines.forEach(function (line) {
      if (line.key === 'work') work = line;
      if (line.key === 'materials') materials = line;
    });
    writePricedLine(work, firstRow + layout.workRowOffset);
    writePricedLine(materials, firstRow + layout.materialsRowOffset);
  });
  var repeatedRowOffset = Math.max(0, jobs.length - 1) * layout.rowsPerJob;
  var postageRow = layout.firstRow + repeatedRowOffset + layout.postageRowOffset;
  writePricedLine(inv.calc.postage || inv.calc.lines.filter(function (line) {
    return line.key === 'postage';
  })[0], postageRow);
  var totalRow = layout.firstRow + repeatedRowOffset + layout.totalRowOffset;
  w.push({ cell: layout.totalColumn + totalRow, kind: 'formula',
    value: '=SUM(' + layout.totalColumn + layout.firstRow + ':' + layout.totalColumn + postageRow + ')' });
  inv.totalCell = layout.totalColumn + totalRow;

  // The invoice rows inserted above also shift the optional-images placeholder.
  var imagePlaceholderRow = parseInt(c.imagesPlaceholder.replace(/^[A-Z]+/i, ''), 10) +
    Math.max(0, jobs.length - 1) * layout.rowsPerJob;
  w.push({ cell: c.imagesPlaceholder.replace(/\d+$/, '') + imagePlaceholderRow, kind: 'blank', value: '' });
  return w;
}

/** Row objects keyed by header name, for the Invoices and InvoiceLines tables. */
function buildInvoiceRecord(ctx, links, nowIso, notes, cfg) {
  var inv = ctx.invoice;
  return {
    InvoiceNo: inv.invoiceNo,
    IssueDate: inv.issueDate,
    DueDate: calcDueDate(inv.issueDate, inv.paymentTermsDays),
    ClientId: ctx.client.clientId,
    ClientCompany: ctx.client.companyName,
    JobTitle: (inv.jobs || [{ title: inv.title }]).map(function (job) { return str(job.title); }).join('; '),
    //Total: inv.calc.subtotal, // not caclulated 
    Status: cfg.statuses.issued,
    PaidDate: '',
    XlsxLink: links.xlsx,
    PdfLink: links.pdf,
    CreatedAt: nowIso,
    Notes: notes || ''
  };
}

function buildLineRecords(ctx) {
  var inv = ctx.invoice;
  var rows = [];
  var n = 0;
  var legacyInput = !inv.calc.jobs;
  var jobs = inv.calc.jobs || [{
    title: inv.title,
    materialsDetail: inv.materialsDetail,
    lines: inv.calc.lines.filter(function (line) { return line.key !== 'postage'; })
  }];
  jobs.forEach(function (job) {
    job.lines.forEach(function (line) {
      if (!line.used) return;
      n += 1;
      var detail = legacyInput
        ? (line.key === 'materials' && job.materialsDetail ? job.materialsDetail : line.label)
        : (line.key === 'materials' && job.materialsDetail
          ? job.title + ' - ' + job.materialsDetail
          : job.title);
      rows.push({
        InvoiceNo: inv.invoiceNo,
        LineNo: n,
        Item: line.label,
        Description: detail || line.label,
        Qty: line.qty,
        UnitPrice: line.price//,
        //LineTotal: line.total
      });
    });
  });
  if (inv.calc.postage && inv.calc.postage.used) {
    n += 1;
    rows.push({
      InvoiceNo: inv.invoiceNo,
      LineNo: n,
      Item: inv.calc.postage.label,
      Description: inv.calc.postage.label,
      Qty: inv.calc.postage.qty,
      UnitPrice: inv.calc.postage.price
    });
  }
  return rows;
}

/** Align an object to a header row, so users can reorder columns freely. */
function rowFromHeaders(headers, obj) {
  return headers.map(function (h) {
    var v = obj[String(h).trim()];
    return v === undefined || v === null ? '' : v;
  });
}

/** Total shown by the sheet must match what the script calculated. */
function totalsMatch(sheetTotal, scriptTotal, tolerance) {
  return Math.abs(sheetTotal - scriptTotal) <= tolerance;
}

/** Cells that still contain template placeholders such as "<mobile>". */
function findPlaceholderCells(cellValues) {
  var bad = [];
  Object.keys(cellValues).forEach(function (a1) {
    var v = cellValues[a1];
    if (typeof v === 'string' && /^\s*<[^<>]+>\s*$/.test(v)) bad.push(a1);
  });
  return bad;
}

/** Splits "id1, id2 ; id3" into clean Drive file IDs. */
function parseFileIds(s) {
  return str(s).split(/[\s,;]+/).filter(function (x) { return x.length > 0; });
}

// Node.js export (ignored by Apps Script, which has no `module`).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    round2: round2, toNumber: toNumber, pad2: pad2, parseIso: parseIso, toIso: toIso,
    parseDateLoose: parseDateLoose, addDaysIso: addDaysIso, calcDueDate: calcDueDate,
    isOverdue: isOverdue, invoiceDatePart: invoiceDatePart, formatInvoiceNumber: formatInvoiceNumber,
    nextInvoiceNumber: nextInvoiceNumber, calcLines: calcLines, calcInvoiceJobs: calcInvoiceJobs,
    validateSettings: validateSettings,
    validateInvoiceInput: validateInvoiceInput, normalizeSettings: normalizeSettings,
    normalizeClient: normalizeClient, resolvePaymentTerms: resolvePaymentTerms,
    periodFolderName: periodFolderName, sanitizeFileName: sanitizeFileName, buildFileBaseName: buildFileBaseName,
    buildCellWrites: buildCellWrites, buildInvoiceRecord: buildInvoiceRecord,
    buildLineRecords: buildLineRecords, rowFromHeaders: rowFromHeaders, totalsMatch: totalsMatch,
    findPlaceholderCells: findPlaceholderCells, parseFileIds: parseFileIds, str: str
  };
}
