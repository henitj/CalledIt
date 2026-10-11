/* Minimal headless DOM smoke test for CalledIt (no external deps).
   Simulates the parts of the browser we use, loads the page scripts,
   and exercises the shared shell + helpers. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function makeEl(tag) {
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    children: [], attrs: {}, style: {}, dataset: {},
    _innerHTML: '', _textContent: '',
    classList: {
      _set: new Set(),
      add(...c) { c.forEach(x => this._set.add(x)); },
      remove(...c) { c.forEach(x => this._set.delete(x)); },
      toggle(c, force) {
        if (force === undefined) { this._set.has(c) ? this._set.delete(c) : this._set.add(c); }
        else if (force) this._set.add(c); else this._set.delete(c);
        return this._set.has(c);
      },
      contains(c) { return this._set.has(c); }
    },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k]; },
    appendChild(c) { this.children.push(c); return c; },
    insertBefore(c) { this.children.unshift(c); return c; },
    remove() {},
    addEventListener() {},
    set innerHTML(v) { this._innerHTML = String(v); this.children = []; },
    get innerHTML() { return this._innerHTML; },
    set textContent(v) { this._textContent = String(v); },
    get textContent() { return this._textContent; },
    /* fake-DOM: any querySelector returns a stub (marked as synthetic) */
    querySelector(sel) { const s = makeEl('div'); s._synthetic = sel; return s; },
    querySelectorAll() { return []; }
  };
  return el;
}

function makeSandbox(ua, platform, maxTouch) {
  const body = makeEl('body');
  body.dataset.page = 'home';
  const head = makeEl('head');
  const store = {};
  const document = {
    body, head,
    documentElement: makeEl('html'),
    createElement: makeEl,
    addEventListener() {},
    querySelector(sel) { const s = makeEl('div'); s._synthetic = sel; return s; },
    querySelectorAll() { return []; }
  };
  const navigator = { userAgent: ua, platform, maxTouchPoints: maxTouch || 0 };
  const sandbox = {
    document, navigator,
    window: null,
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; }
    },
    location: { href: 'http://localhost:8000/index.html', search: '' },
    setTimeout, clearTimeout,
    URLSearchParams,
    requestAnimationFrame: fn => fn(),
    console
  };
  sandbox.window = sandbox;
  sandbox.window.scrollY = 0;
  sandbox.window.addEventListener = () => {};
  vm.createContext(sandbox);
  return sandbox;
}

const root = path.join(__dirname, '..');
const configSrc = fs.readFileSync(path.join(root, 'js/config.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');

let failures = 0;
function check(name, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name);
  if (!cond) failures++;
}

const cases = [
  ['iPhone Safari', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', 'iPhone', 5, 'ios', true, false],
  ['iPad (iPadOS desktop UA)', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15', 'MacIntel', 5, 'ios', true, true],
  ['Android phone Chrome', 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36', 'Linux armv8l', 5, 'android', false, true],
  ['Android tablet', 'Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36', 'Linux armv8l', 5, 'android', false, true],
  ['Windows desktop', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36', 'Win32', 0, 'windows', false, false],
  ['Mac desktop', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36', 'MacIntel', 0, 'macos', true, false]
];

for (const [label, ua, plat, touch, wantOs, wantApple, wantMobileFlag] of cases) {
  const sb = makeSandbox(ua, plat, touch);
  vm.runInContext(configSrc, sb);
  vm.runInContext(appSrc, sb);
  const C = sb.window.CalledIt;
  check(label + ' loads shell', !!C && typeof C.fmtKm === 'function');
  check(label + ' os=' + wantOs, C.device.os === wantOs);
  check(label + ' isApple=' + wantApple, C.device.isApple === wantApple);
  const links = C.directionsLinks(46.02, 7.74);
  const first = links[0].href;
  const wantFirst = wantApple ? 'maps.apple.com' : 'google.com/maps/dir';
  check(label + ' directions→' + wantFirst, first.indexOf(wantFirst) !== -1);
  check(label + ' header injected', sb.document.body.children[0] && sb.document.body.children[0].className.indexOf('site-header') !== -1);
  check(label + ' bottom nav injected', sb.document.body.children.some(c => (c.className || '').indexOf('bottom-nav') !== -1));
  check(label + ' reopen button injected', sb.document.body.children.some(c => (c.className || '').indexOf('nav-reopen') !== -1));
  check(label + ' coach hint injected', sb.document.body.children.some(c => (c.className || '').indexOf('nav-hint') !== -1));
}

/* formatting helpers on one extra instance */
const sb = makeSandbox(cases[0][1], cases[0][2], cases[0][3]);
vm.runInContext(configSrc, sb); vm.runInContext(appSrc, sb);
const C = sb.window.CalledIt;
check('fmtKm', C.fmtKm(12400) === '12 km' && C.fmtKm(3500) === '3.5 km');
check('fmtBoth', C.fmtBoth(10000).indexOf('km') !== -1 && C.fmtBoth(10000).indexOf('mi') !== -1);
check('fmtDuration', C.fmtDuration(200) === '~3 h 20 min' && C.fmtDuration(45) === '~45 min');
check('stars', C.stars(4) === '★★★★☆');
check('escapeHtml', C.escapeHtml('<b>&"') === '&lt;b&gt;&amp;&quot;');
check('haversine ~1.1km for 0.01° lat', Math.abs(C.haversineM(46, 7, 46.01, 7) - 1111) < 30);

console.log(failures ? '\n' + failures + ' FAILURES' : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
