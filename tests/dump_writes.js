// Prints the cell writes for a sample invoice as JSON (used by verify_template.py).
const { L, CONFIG } = require('./load.js');
const jobs = [{
  title: 'Garden fence repair',
  workQty: 2.5,
  workPrice: 40,
  materialsQty: 1,
  materialsPrice: 18.5,
  materialsDetail: 'Timber panels, screws, preservative'
}];
const calc = L.calcInvoiceJobs(jobs, 4.2, CONFIG.template.lines);
const ctx = {
  settings: L.normalizeSettings({ CompanyName: 'Sample Trading Ltd', CompanyAddress: '12 Example Road, Livingston, EH54 1AA', CompanyPhone: '07700 900123', CompanyEmail: 'billing@example.com', BankHolder: 'Sample Trading Ltd', BankAccount: '01234567', BankSortCode: '04-00-04' }, 30),
  client: L.normalizeClient({ ClientId: 'C001', ContactNames: 'Jane Smith, Tom Brown', CompanyName: 'Example Client Ltd', RegNumber: '01234567', Address: '5 Sample Street, Edinburgh, EH1 1AA', Phones: '07700 900456', Emails: 'jane@example.com, tom@example.com' }),
  invoice: { invoiceNo: L.nextInvoiceNumber([], '2026-11-14'), issueDate: '2026-11-14', paymentTermsDays: 30, jobs, calc }
};
console.log(JSON.stringify({ writes: L.buildCellWrites(ctx, CONFIG), subtotal: calc.subtotal, sheet: CONFIG.template.sheetName, cells: CONFIG.template.cells }));
