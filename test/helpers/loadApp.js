'use strict';
// Boots the whole single-file app headlessly in jsdom. External CDN scripts
// (Chart.js, Supabase) are stripped and Chart.js is replaced with a recording
// stub so business logic and chart *data* can be asserted without a canvas.
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const HTML_PATH = path.join(__dirname, '..', '..', 'index.html');
const SECTORS = ['manufacturing', 'technology', 'retail', 'restaurant', 'construction', 'healthcare', 'logistics', 'realestate', 'professional', 'consumer'];

let cachedHtml = null;
function loadHtml() {
  if (cachedHtml) return cachedHtml;
  let html = fs.readFileSync(HTML_PATH, 'utf8');
  html = html.replace(/<script src="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/Chart\.js[^"]*"><\/script>/, '');
  html = html.replace(/<script src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js[^"]*"><\/script>/, '');
  cachedHtml = html;
  return html;
}

function makeDom() {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push('jsdomError: ' + (e && e.message)));
  const dom = new JSDOM(loadHtml(), { url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc });
  const { window } = dom;
  window.onerror = (msg, src, line, col) => { errors.push('window.onerror: ' + msg + ' @' + line + ':' + col); return true; };
  const noop = () => {};
  window.HTMLCanvasElement.prototype.getContext = () => ({
    measureText: () => ({ width: 0 }), fillRect: noop, clearRect: noop, save: noop, fillText: noop, restore: noop,
    beginPath: noop, moveTo: noop, lineTo: noop, closePath: noop, stroke: noop, translate: noop, scale: noop,
    rotate: noop, arc: noop, fill: noop, transform: noop, rect: noop, clip: noop, drawImage: noop
  });
  window.Chart = function (ctx, cfg) {
    this.ctx = ctx; this.config = cfg; this.data = cfg.data;
    this.update = noop; this.destroy = noop; this.resize = noop;
  };
  // No network in tests: any fetch (FRED prefill, chat) must fail fast and be handled.
  window.fetch = () => Promise.reject(new Error('fetch disabled in tests'));
  return { dom, window, errors };
}

function boot(sector) {
  const ctx = makeDom();
  const { window } = ctx;
  window.launchApp('Test Co', sector || 'manufacturing', false);
  if (window.Chart) window.initCharts();
  window.applySector(sector || 'manufacturing');
  window.updateAll();
  window.updateCD();
  return ctx;
}

function setVal(window, id, val) {
  const el = window.document.getElementById(id);
  if (!el) throw new Error('missing input #' + id);
  el.value = String(val);
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
  el.dispatchEvent(new window.Event('change', { bubbles: true }));
}

function txt(window, id) {
  const el = window.document.getElementById(id);
  return el ? el.textContent : undefined;
}

// Every visible text node, excluding script/style — used to hunt for NaN/undefined/Infinity.
function badValues(window, label) {
  const bad = [];
  const doc = window.document;
  const walker = doc.createTreeWalker(doc.body, window.NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const tag = node.parentElement && node.parentElement.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE') continue;
    const t = node.nodeValue;
    if (!t) continue;
    if (/\bNaN\b/.test(t) || /\bundefined\b/.test(t) || /\bInfinity\b/.test(t)) {
      const parentId = node.parentElement ? (node.parentElement.id || node.parentElement.className) : '?';
      bad.push(`[${label}] <${parentId}>: "${t.trim().slice(0, 120)}"`);
    }
  }
  doc.querySelectorAll('input[type=number]').forEach((inp) => {
    if (/NaN|Infinity/.test(inp.value)) bad.push(`[${label}] input #${inp.id} = "${inp.value}"`);
  });
  return bad;
}

module.exports = { SECTORS, makeDom, boot, setVal, txt, badValues, HTML_PATH };
