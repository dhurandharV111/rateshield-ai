// Loads the CONFIG / Model block of index.html (between the @@MODEL-START and
// @@MODEL-END markers) into a bare VM so the serverless functions compute the
// same paths the browser shows — one source of truth, no copy of the model.
// The leading underscore keeps Vercel from exposing this file as an endpoint;
// vercel.json includes index.html in the function bundle.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CANDIDATES = [path.join(here, '..', 'index.html'), path.join(process.cwd(), 'index.html')];

let cached = null;
export function loadModel() {
  if (cached) return cached;
  const file = CANDIDATES.find((p) => fs.existsSync(p));
  if (!file) throw new Error('index.html not found next to api/ — Model block unavailable');
  const html = fs.readFileSync(file, 'utf8');
  const start = html.indexOf('// @@MODEL-START'), end = html.indexOf('// @@MODEL-END');
  if (start === -1 || end === -1) throw new Error('@@MODEL-START/@@MODEL-END markers not found in index.html');
  const sandbox = { Math, Infinity, NaN, isFinite, isNaN, parseFloat, parseInt, Number };
  vm.createContext(sandbox);
  vm.runInContext(html.slice(start, end) + '\n;this.__exports = { CONFIG: CONFIG, Model: Model };', sandbox, { filename: 'index.html#model' });
  cached = sandbox.__exports;
  return cached;
}
