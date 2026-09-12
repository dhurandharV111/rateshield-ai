'use strict';
// Loads ONLY the CONFIG/Model block from index.html (between the @@MODEL-START and
// @@MODEL-END markers) into a bare Node VM context. Model functions are pure, so
// no DOM is needed — if this loader ever fails because the block touched
// `document` or `window`, that is itself a test failure.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML_PATH = path.join(__dirname, '..', '..', 'index.html');

function extractModelSource() {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const start = html.indexOf('// @@MODEL-START');
  const end = html.indexOf('// @@MODEL-END');
  if (start === -1 || end === -1) throw new Error('@@MODEL-START/@@MODEL-END markers not found in index.html');
  return html.slice(start, end);
}

function loadModel() {
  const src = extractModelSource();
  const sandbox = { Math, Infinity, NaN, isFinite, isNaN, parseFloat, parseInt, Number };
  vm.createContext(sandbox);
  vm.runInContext(src + '\n;this.__exports = { CONFIG: CONFIG, Model: Model };', sandbox, { filename: 'index.html#model' });
  return sandbox.__exports;
}

module.exports = { loadModel, extractModelSource, HTML_PATH };
