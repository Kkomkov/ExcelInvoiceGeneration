// node tests/run_tests.js   - no dependencies
const assert = require('assert');
const { L, CONFIG } = require('./load.js');
let passed = 0;
// arrays made inside the vm sandbox have a different prototype, so compare as JSON
function eq(a, b) { assert.strictEqual(JSON.stringify(a), JSON.stringify(b)); }
function test(name, fn) { try { fn(); passed++; console.log('ok   ' + name); } catch (e) { console.log('FAIL ' + name + '\n     ' + e.message); process.exitCode = 1; } }

test('round2 handles float noise', () => { assert.strictEqual(L.round2(1.005), 1.01); assert.strictEqual(L.round2(0.1 + 0.2), 0.3); });
test('toNumber', () => {
  assert.strictEqual(L.toNumber(''), null); assert.strictEqual(L.toNumber(null), null);
  assert.strictEqual(L.toNumber('£1,234.50'), 1234.5); assert.strictEqual(L.toNumber(7), 7);
  assert.ok(isNaN(L.toNumber('abc'))); assert.ok(isNaN(L.toNumber('12.')));
});
test('dates: parse, rollover, leap year, invalid', () => {
  assert.strictEqual(L.addDaysIso('2026-11-14', 30), '2026-12-14');
  assert.strictEqual(L.addDaysIso('2026-12-20', 30), '2027-01-19');
  assert.strictEqual(L.addDaysIso('2028-02-28', 1), '2028-02-29');
  assert.strictEqual(L.addDaysIso('2027-02-28', 1), '2027-03-01');
  assert.strictEqual(L.parseIso('2026-02-30'), null);
  assert.strictEqual(L.parseDateLoose('14/11/2026'), '2026-11-14');
  assert.strictEqual(L.parseDateLoose('4/1/2026'), '2026-01-04');
  assert.strictEqual(L.parseDateLoose('31/02/2026'), null);
  assert.strictEqual(L.parseDateLoose('nonsense'), null);
});
test('invoice number: ddmmyyyy-NN', () => {
  assert.strictEqual(L.nextInvoiceNumber([], '2026-11-14'), '14112026-01');
  assert.strictEqual(L.nextInvoiceNumber(['14112026-01'], '2026-11-14'), '14112026-02');
  assert.strictEqual(L.nextInvoiceNumber(['14112026-01', '14112026-03'], '2026-11-14'), '14112026-04'); // max, not count
  assert.strictEqual(L.nextInvoiceNumber(['13112026-07', '14112025-05'], '2026-11-14'), '14112026-01'); // other dates ignored
  assert.strictEqual(L.nextInvoiceNumber([null, '', 5], '2026-11-14'), '14112026-01');
  assert.strictEqual(L.nextInvoiceNumber(['14112026-99'], '2026-11-14'), '14112026-100');
});
test('calcLines: totals, default qty, unused lines', () => {
  const r = L.calcLines([
    { key: 'work', qty: 2.5, price: 40 },
    { key: 'materials', qty: '', price: '£12.345' },
    { key: 'postage', qty: null, price: '' }], CONFIG.template.lines);
  assert.strictEqual(r.lines[0].total, 100);
  assert.strictEqual(r.lines[1].qty, 1); assert.strictEqual(r.lines[1].total, 12.35);
  assert.strictEqual(r.lines[2].used, false);
  assert.strictEqual(r.subtotal, 112.35);
});
test('calcLines: discount (negative price) allowed, zero price unused', () => {
  const r = L.calcLines([{ key: 'work', qty: 1, price: 50 }, { key: 'postage', price: -5 }, { key: 'materials', price: 0 }], CONFIG.template.lines);
  assert.strictEqual(r.subtotal, 45); assert.strictEqual(r.lines[1].used, false);
});
test('calcInvoiceJobs: totals multiple jobs and one invoice-level postage line', () => {
  const r = L.calcInvoiceJobs([
    { title: 'Repair', workQty: 2, workPrice: 30, materialsQty: 1, materialsPrice: 10, materialsDetail: 'Paint' },
    { title: 'Installation', workQty: '', workPrice: '', materialsQty: 3, materialsPrice: 5, materialsDetail: 'Screws' }
  ], 2, CONFIG.template.lines);
  assert.strictEqual(r.jobs.length, 2);
  assert.strictEqual(r.jobs[0].lines[0].total, 60);
  assert.strictEqual(r.jobs[1].lines[1].total, 15);
  assert.strictEqual(r.postage.total, 2);
  assert.strictEqual(r.subtotal, 87);
});
test('validateInvoiceInput', () => {
  const T = CONFIG.template.lines;
  const ok = { clientId: 'C001', issueDateRaw: '', issueDate: '', title: 'Job', paymentTermsDays: null, lines: [{ key: 'work', qty: 1, price: 10 }] };
  eq(L.validateInvoiceInput(ok, T), []);
  assert.ok(L.validateInvoiceInput({ ...ok, clientId: '' }, T).length === 1);
  assert.ok(L.validateInvoiceInput({ ...ok, title: '' }, T).length === 1);
  assert.ok(L.validateInvoiceInput({ ...ok, issueDateRaw: 'x', issueDate: null }, T).length === 1);
  assert.ok(L.validateInvoiceInput({ ...ok, paymentTermsDays: 400 }, T).length === 1);
  assert.ok(L.validateInvoiceInput({ ...ok, paymentTermsDays: 2.5 }, T).length === 1);
  assert.ok(L.validateInvoiceInput({ ...ok, lines: [] }, T).length === 1);
  assert.ok(L.validateInvoiceInput({ ...ok, lines: [{ key: 'work', qty: 'abc', price: 10 }] }, T).length === 1);
  assert.ok(L.validateInvoiceInput({ ...ok, lines: [{ key: 'work', qty: -1, price: 10 }] }, T).length === 1);
  assert.ok(L.validateInvoiceInput({ ...ok, lines: [{ key: 'work', qty: 3, price: '' }, { key: 'postage', price: 4 }] }, T).length === 1);
});
test('validateInvoiceInput accepts separately priced jobs and rejects incomplete rows', () => {
  const input = {
    clientId: 'C001', issueDateRaw: '', issueDate: '', paymentTermsDays: null, postagePrice: '',
    jobs: [
      { title: 'Repair', workQty: 2, workPrice: 30 },
      { title: 'Materials only', materialsQty: 1, materialsPrice: 12 }
    ]
  };
  eq(L.validateInvoiceInput(input, CONFIG.template.lines), []);
  assert.ok(L.validateInvoiceInput({ ...input, jobs: [{ title: 'No price' }] }, CONFIG.template.lines).length > 0);
  assert.ok(L.validateInvoiceInput({ ...input, jobs: [{ title: '', workQty: 1, workPrice: 5 }] }, CONFIG.template.lines).length > 0);
});
test('settings / client normalisation and payment terms precedence', () => {
  const s = L.normalizeSettings({ CompanyName: ' ACME ', PaymentTermsDays: '14', BankSortCode: '04-00-04' }, 30);
  assert.strictEqual(s.companyName, 'ACME'); assert.strictEqual(s.paymentTermsDays, 14); assert.strictEqual(s.bankSortCode, '04-00-04');
  assert.strictEqual(L.normalizeSettings({}, 30).paymentTermsDays, 30);
  const c = L.normalizeClient({ ClientId: 'C1', PaymentTermsDays: '', Phones: 7700900123 });
  assert.strictEqual(c.paymentTermsDays, null); assert.strictEqual(c.phones, '7700900123');
  assert.strictEqual(L.resolvePaymentTerms(7, { paymentTermsDays: 14 }, { paymentTermsDays: 30 }), 7);
  assert.strictEqual(L.resolvePaymentTerms(null, { paymentTermsDays: 14 }, { paymentTermsDays: 30 }), 14);
  assert.strictEqual(L.resolvePaymentTerms(null, { paymentTermsDays: null }, { paymentTermsDays: 30 }), 30);
  eq(L.validateSettings({ A: 'x', B: ' ' }, ['A', 'B', 'C']).length, 2);
});
test('file names are Drive-safe', () => {
  assert.strictEqual(L.buildFileBaseName('14112026-01', 'A/B: "Co" Ltd?'), 'Invoice 14112026-01 - A B Co Ltd');
  assert.ok(L.sanitizeFileName('x'.repeat(300)).length <= 100);
});
function sampleCtx(over) {
  const calc = L.calcLines([{ key: 'work', qty: 2, price: 50 }, { key: 'materials', price: 20 }, { key: 'postage', price: '' }], CONFIG.template.lines);
  return Object.assign({
    settings: L.normalizeSettings({ CompanyName: 'Test Co', CompanyAddress: '1 High St, Livingston EH54 1AA', CompanyPhone: '07700900123', CompanyEmail: 'a@b.co', BankHolder: 'T Co', BankAccount: '01234567', BankSortCode: '04-00-04' }, 30),
    client: L.normalizeClient({ ClientId: 'C001', ContactNames: 'Jane Smith', CompanyName: 'Client Ltd', RegNumber: '01234567', Address: '2 Low Rd', Phones: '07700900456', Emails: 'j@c.co' }),
    invoice: { invoiceNo: '14112026-01', issueDate: '2026-11-14', paymentTermsDays: 30, title: 'Repairs', materialsDetail: 'Paint, screws', calc }
  }, over || {});
}
test('buildCellWrites: covers every template placeholder, no duplicate cells', () => {
  const w = L.buildCellWrites(sampleCtx(), CONFIG);
  const cells = w.map(x => x.cell);
  assert.strictEqual(new Set(cells).size, cells.length, 'duplicate target cell');
  ['D4','D5','H5','D6','H6','D7','H9','H10','H11','D14','D15','F15','D16','D17','D18','B22','B25','A41','E12'].forEach(c => assert.ok(cells.includes(c), 'not covered: ' + c));
});
test('buildCellWrites: values', () => {
  const w = Object.fromEntries(L.buildCellWrites(sampleCtx(), CONFIG).map(x => [x.cell, x]));
  assert.strictEqual(w.H6.value, '14112026-01');
  assert.strictEqual(w.H5.kind, 'date'); assert.strictEqual(w.H5.value, '2026-11-14');
  assert.strictEqual(w.F15.value, '01234567'); assert.strictEqual(typeof w.F15.value, 'string');   // leading zero survives
  assert.strictEqual(w.H11.value, '04-00-04'); assert.strictEqual(w.D6.value, '07700900123');
  assert.ok(w.E12.value.includes('H5+30') && w.E12.kind === 'formula' && w.E12.value.startsWith('='));
  assert.strictEqual(w.E23.value, 2); assert.strictEqual(w.F23.value, 50);
  assert.strictEqual(w.E24.value, 1); assert.strictEqual(w.F24.value, 20);
  assert.strictEqual(w.E26.kind, 'blank'); assert.strictEqual(w.F26.kind, 'blank');   // unused postage cleared
  assert.strictEqual(w.A41.kind, 'blank');
});
test('buildCellWrites: empty client fields clear the placeholder', () => {
  const ctx = sampleCtx(); ctx.client.regNumber = ''; ctx.invoice.materialsDetail = '';
  const w = Object.fromEntries(L.buildCellWrites(ctx, CONFIG).map(x => [x.cell, x]));
  eq([w.F15.kind, w.F15.value, w.B25.value], ['text', '', '']);
});
test('buildCellWrites: repeats job blocks and moves postage, total and image placeholder', () => {
  const ctx = sampleCtx();
  ctx.invoice.jobs = [
    { title: 'Repair', workQty: 2, workPrice: 50, materialsQty: 1, materialsPrice: 20, materialsDetail: 'Paint' },
    { title: 'Installation', workQty: 1, workPrice: 25, materialsQty: '', materialsPrice: '', materialsDetail: '' }
  ];
  ctx.invoice.calc = L.calcInvoiceJobs(ctx.invoice.jobs, 4, CONFIG.template.lines);
  const w = Object.fromEntries(L.buildCellWrites(ctx, CONFIG).map(x => [x.cell, x]));
  assert.strictEqual(w.B22.value, 'Repair');
  assert.strictEqual(w.B26.value, 'Installation');
  assert.strictEqual(w.E27.value, 1);
  assert.strictEqual(w.F27.value, 25);
  assert.strictEqual(w.E30.value, 1);
  assert.strictEqual(w.F30.value, 4);
  assert.strictEqual(w.G31.value, '=SUM(G22:G30)');
  assert.strictEqual(w.A45.kind, 'blank');
});
test('invoice + line records', () => {
  const ctx = sampleCtx();
  const rec = L.buildInvoiceRecord(ctx, { xlsx: 'x', pdf: 'p' }, '2026-11-14T10:00:00', 'n', CONFIG);
  assert.strictEqual(rec.DueDate, '2026-12-14'); assert.strictEqual(rec.Total, 120); assert.strictEqual(rec.Status, 'Issued');
  const lines = L.buildLineRecords(ctx);
  eq(lines.map(l => [l.LineNo, l.Item, l.LineTotal]), [[1, 'Work', 100], [2, 'Materials', 20]]);
  assert.strictEqual(lines[1].Description, 'Paint, screws');
  CONFIG.columns.invoices.forEach(h => assert.ok(h in rec, 'record lacks ' + h));
  CONFIG.columns.lines.forEach(h => assert.ok(h in lines[0], 'line record lacks ' + h));
});
test('multi-job records preserve job titles in the invoice and line ledger', () => {
  const ctx = sampleCtx();
  ctx.invoice.jobs = [
    { title: 'Repair', workQty: 2, workPrice: 30, materialsQty: 1, materialsPrice: 10, materialsDetail: 'Paint' },
    { title: 'Installation', workQty: '', workPrice: '', materialsQty: 3, materialsPrice: 5, materialsDetail: 'Screws' }
  ];
  ctx.invoice.calc = L.calcInvoiceJobs(ctx.invoice.jobs, 2, CONFIG.template.lines);
  const invoice = L.buildInvoiceRecord(ctx, { xlsx: 'x', pdf: 'p' }, '2026-11-14T10:00:00', '', CONFIG);
  assert.strictEqual(invoice.JobTitle, 'Repair; Installation');
  eq(L.buildLineRecords(ctx).map(line => [line.Item, line.Description, line.Qty, line.UnitPrice]), [
    ['Work', 'Repair', 2, 30],
    ['Materials', 'Repair - Paint', 1, 10],
    ['Materials', 'Installation - Screws', 3, 5],
    ['Postage', 'Postage', 1, 2]
  ]);
});
test('rowFromHeaders follows any column order', () => {
  eq(L.rowFromHeaders(['B', ' A ', 'Z'], { A: 1, B: 2 }), [2, 1, '']);
});
test('totals check, placeholders, file ids, overdue', () => {
  assert.ok(L.totalsMatch(120.004, 120, 0.02)); assert.ok(!L.totalsMatch(121, 120, 0.02));
  eq(L.findPlaceholderCells({ D6: '<mobile>', D7: 'a@b.co', G4: 'INVOICE', B1: ' <x y> ' }), ['D6', 'B1']);
  eq(L.parseFileIds('a1, b2;  c3\nd4'), ['a1', 'b2', 'c3', 'd4']);
  eq(L.parseFileIds(''), []);
  const S = CONFIG.statuses;
  assert.ok(L.isOverdue('Issued', '2026-11-01', '2026-11-14', S));
  assert.ok(!L.isOverdue('Paid', '2026-11-01', '2026-11-14', S));
  assert.ok(!L.isOverdue('Issued', '2026-11-14', '2026-11-14', S));
});
test('Config sanity: distinct template cells, form cells', () => {
  const t = Object.values(CONFIG.template.cells);
  assert.strictEqual(new Set(t).size, t.length);
  const lc = CONFIG.template.lines.flatMap(l => [l.qty, l.price, l.total]);
  assert.strictEqual(new Set(lc).size, lc.length);
  const f = Object.values(CONFIG.form.cells);
  assert.strictEqual(new Set(f).size, f.length);
});
console.log('\n' + passed + ' passed' + (process.exitCode ? ', SOME FAILED' : ''));
