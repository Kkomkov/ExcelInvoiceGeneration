// Local "brain": reuses Config.gs + Logic.gs (the same code the Google version uses).
// Reads one JSON request on stdin, prints one JSON plan on stdout. No file or network access.
const { L, CONFIG } = require('../tests/load.js');
if (process.argv.includes('--form-cells')) { process.stdout.write(JSON.stringify(CONFIG.form)); process.exit(0); }
const req = JSON.parse(require('fs').readFileSync(0, 'utf8').replace(/^\uFEFF/, ''));

const out = { errors: [] };
const inp = req.input || {};

// settings (TemplateFileId is a Google-only setting, not needed locally)
const required = CONFIG.requiredSettings.filter(k => k !== 'TemplateFileId');
L.validateSettings(req.settingsRaw || {}, required).forEach(e => out.errors.push(e));
const settings = L.normalizeSettings(req.settingsRaw || {}, CONFIG.defaultPaymentTermsDays);

// invoice input, same shape the Google form produces
const issueRaw = L.str(inp.issueDate);
const daysRaw = inp.paymentTermsDays;
const rawJobs = Array.isArray(inp.jobs) ? inp.jobs : [{
  title: inp.title,
  workQty: (inp.work || {}).qty,
  workPrice: (inp.work || {}).price,
  materialsQty: (inp.materials || {}).qty,
  materialsPrice: (inp.materials || {}).price,
  materialsDetail: (inp.materials || {}).detail
}];
const jobs = rawJobs.filter(job => job && [job.title, job.workQty, job.workPrice,
  job.materialsQty, job.materialsPrice, job.materialsDetail].some(value => value !== null && value !== undefined && value !== ''));
const postagePrice = inp.postagePrice !== undefined ? inp.postagePrice : ((inp.postage || {}).price);
const input = {
  clientId: L.str(inp.clientId),
  issueDateRaw: issueRaw,
  issueDate: issueRaw === '' ? '' : L.parseDateLoose(issueRaw),
  paymentTermsDays: (daysRaw === null || daysRaw === undefined || daysRaw === '') ? null : L.toNumber(daysRaw),
  jobs: jobs.map(job => ({
    title: L.str(job.title),
    workQty: job.workQty,
    workPrice: job.workPrice,
    materialsQty: job.materialsQty,
    materialsPrice: job.materialsPrice,
    materialsDetail: L.str(job.materialsDetail)
  })),
  postagePrice,
  notes: L.str(inp.notes),
};
L.validateInvoiceInput(input, CONFIG.template.lines).forEach(e => out.errors.push(e));

const client = req.clientRow ? L.normalizeClient(req.clientRow) : null;
if (input.clientId && !client) out.errors.push('Client ID "' + input.clientId + '" is not in the Clients tab.');

if (!out.errors.length) {
  const issueIso = input.issueDate || req.todayIso;
  const days = L.resolvePaymentTerms(input.paymentTermsDays, client, settings);
  const invoiceNo = L.nextInvoiceNumber(req.existingNumbers || [], issueIso);
  const calc = L.calcInvoiceJobs(input.jobs, input.postagePrice, CONFIG.template.lines);
  const ctx = { settings, client, invoice: { invoiceNo, issueDate: issueIso, paymentTermsDays: days, jobs: input.jobs, calc } };
  out.invoiceNo = invoiceNo;
  out.issueDate = issueIso;
  out.dueDate = L.calcDueDate(issueIso, days);
  out.total = calc.subtotal;
  out.baseName = L.buildFileBaseName(invoiceNo, client.companyName);
  out.writes = L.buildCellWrites(ctx, CONFIG);
  out.record = L.buildInvoiceRecord(ctx, { xlsx: '', pdf: '' }, req.nowStamp, input.notes, CONFIG);
  out.lines = L.buildLineRecords(ctx);
  out.template = {
    sheetName: CONFIG.template.sheetName,
    removeSheets: CONFIG.template.removeSheets,
    totalCell: ctx.invoice.totalCell,
    jobCount: input.jobs.length,
    jobLayout: CONFIG.template.jobLayout,
    tolerance: CONFIG.totalTolerance
  };
  out.formats = { date: CONFIG.dateFormatSheet, money: CONFIG.moneyFormatSheet, textColumns: CONFIG.textColumns, dateColumns: CONFIG.dateColumns, moneyColumns: CONFIG.moneyColumns };
}
process.stdout.write(JSON.stringify(out));
