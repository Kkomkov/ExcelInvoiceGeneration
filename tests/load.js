// Loads Config.gs + Logic.gs (pure code, no Google services) into Node for testing.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const dir = path.join(__dirname, '..', 'apps-script');
const ctx = { module: { exports: {} }, console };
vm.createContext(ctx);
for (const f of ['Config.gs', 'Logic.gs']) {
  vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f });
}
module.exports = { L: ctx.module.exports, CONFIG: vm.runInContext('CONFIG', ctx) };
