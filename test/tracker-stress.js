/* Tracker stress test: phantom distance must stay ~0 on a desk, real
   movement must be counted. Drives the REAL trails.js in jsdom.
   Run:  NODE_PATH=/path/to/node_modules node test/tracker-stress.js */
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM, ResourceLoader, VirtualConsole } = require('jsdom');
const root = path.join(__dirname, '..');

class LocalLoader extends ResourceLoader {
  fetch(url) {
    if (url.startsWith('http://127.0.0.1:8765/')) {
      const file = path.join(root, decodeURIComponent(url.slice(22).split('?')[0]));
      if (fs.existsSync(file)) return Promise.resolve(fs.readFileSync(file));
    }
    return Promise.reject(new Error('blocked'));
  }
}
const watchers = {};
let nid = 1;
const geolocation = {
  getCurrentPosition() { }, clearWatch(id) { delete watchers[id]; },
  watchPosition(ok) { const id = nid++; watchers[id] = ok; return id; }
};
const emit = (lat, lng, acc, t, speed) => Object.values(watchers).forEach(fn => fn({ coords: { latitude: lat, longitude: lng, accuracy: acc, speed }, timestamp: t }));
const R = 111320, LAT0 = 46.02, LNG0 = 7.749, COS = Math.cos(LAT0 * Math.PI / 180);
const toLL = (x, y) => [LAT0 + y / R, LNG0 + x / (R * COS)];
function gauss(rnd) { let u = 0, v = 0; while (u === 0) u = rnd(); while (v === 0) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function rng(seed) { let s = seed; return () => (s = (s * 16807) % 2147483647) / 2147483647; }

(async function () {
  const vc = new VirtualConsole();
  const dom = new JSDOM(fs.readFileSync(path.join(root, 'trails.html'), 'utf8'), {
    url: 'http://127.0.0.1:8765/trails.html', runScripts: 'dangerously', resources: new LocalLoader(), pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(win) {
      win.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ features: [], elements: [], places: [] }) });
      Object.defineProperty(win.navigator, 'geolocation', { value: geolocation, configurable: true });
      win.Element.prototype.scrollIntoView = function () { };
    }
  });
  const win = dom.window, doc = win.document;
  await new Promise(r => setTimeout(r, 600));
  let t = Date.now();

  function session(fn, mode) {
    if (mode === 'bike') doc.querySelector('#modeBike').click(); else doc.querySelector('#modeHike').click();
    doc.querySelector('#trackBtn').click();
    fn();
    doc.querySelector('#trackStop').click();
    const logs = JSON.parse(win.localStorage.getItem('calledit_tracks_v1') || '[]');
    return (logs[0] && logs[0].km || 0) * 1000;   /* metres */
  }

  let fail = 0;
  const report = (name, ok, detail) => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + '  ' + detail); if (!ok) fail++; };

  /* 1) desk: 10 minutes, gaussian jitter (σ = acc/1.5 per axis), many accuracies + seeds */
  let worst = 0, worstCase = '';
  for (const acc of [4, 8, 12, 15, 18, 20]) {
    for (let seed = 1; seed <= 6; seed++) {
      const rnd = rng(seed * 7919 + acc);
      const m = session(() => {
        for (let i = 0; i < 600; i++) {
          const a = acc * (0.8 + rnd() * 0.4);
          const [la, ln] = toLL(gauss(rnd) * acc / 1.5, gauss(rnd) * acc / 1.5);
          emit(la, ln, a, t += 1000, rnd() < 0.3 ? 0 : null);
        }
      });
      if (m > worst) { worst = m; worstCase = 'acc ' + acc + ' seed ' + seed; }
    }
  }
  report('desk 10 min, 36 runs (±4…20 m)', worst <= 16, 'worst ' + worst.toFixed(1) + ' m (' + worstCase + ')');

  /* 2) desk with harsh uniform wander ±22 m at ±15 m accuracy (worse than real) */
  worst = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const rnd = rng(seed * 104729);
    const m = session(() => { for (let i = 0; i < 600; i++) { const [la, ln] = toLL((rnd() - .5) * 44, (rnd() - .5) * 44); emit(la, ln, 15, t += 1000, null); } });
    worst = Math.max(worst, m);
  }
  report('desk harsh wander 10 min ×6', worst <= 40, 'worst ' + worst.toFixed(1) + ' m  (old build: 0.2 mi = 320 m)');

  /* 3) slow multipath drift: 25 m out and back over 10 min + jitter, ±12 m */
  {
    const rnd = rng(42);
    const m = session(() => {
      for (let i = 0; i < 600; i++) {
        const off = 25 * Math.sin(Math.PI * i / 600);
        const [la, ln] = toLL(off + gauss(rnd) * 6, gauss(rnd) * 6);
        emit(la, ln, 12, t += 1000, null);
      }
    });
    report('slow 25 m drift (stationary phone)', m <= 50, m.toFixed(1) + ' m');
  }

  /* 4) walking straight at several speeds, ±5 m accuracy, σ 2.5 m noise */
  for (const v of [0.9, 1.4, 2.0]) {
    const rnd = rng(Math.round(v * 1000));
    let y = 0;
    const m = session(() => { for (let i = 0; i < 600; i++) { y += v; const [la, ln] = toLL(gauss(rnd) * 2.5, y + gauss(rnd) * 2.5); emit(la, ln, 5, t += 1000, v); } });
    const truth = v * 600;
    report('walk ' + v + ' m/s 10 min', m / truth > 0.9 && m / truth < 1.08, (m / truth * 100).toFixed(1) + '% of ' + truth + ' m');
  }

  /* 5) walk with stops: 60 s walk / 60 s stand, ×5, plus 90° turns */
  {
    const rnd = rng(9);
    let x = 0, y = 0, dir = 0, truth = 0;
    const m = session(() => {
      for (let k = 0; k < 5; k++) {
        for (let i = 0; i < 60; i++) {
          x += [0, 1.3, 0, -1.3][dir]; y += [1.3, 0, -1.3, 0][dir]; truth += 1.3;
          const [la, ln] = toLL(x + gauss(rnd) * 2.5, y + gauss(rnd) * 2.5); emit(la, ln, 6, t += 1000, 1.3);
        }
        for (let i = 0; i < 60; i++) { const [la, ln] = toLL(x + gauss(rnd) * 4, y + gauss(rnd) * 4); emit(la, ln, 8, t += 1000, 0); }
        dir = (dir + 1) % 4;
      }
    });
    report('walk/stop ×5 with turns', m / truth > 0.85 && m / truth < 1.08, (m / truth * 100).toFixed(1) + '% of ' + truth.toFixed(0) + ' m');
  }

  /* 6) bike 5.5 m/s for 10 min */
  {
    const rnd = rng(77);
    let y = 0;
    const m = session(() => { for (let i = 0; i < 600; i++) { y += 5.5; const [la, ln] = toLL(gauss(rnd) * 3, y + gauss(rnd) * 3); emit(la, ln, 6, t += 1000, 5.5); } }, 'bike');
    report('bike 5.5 m/s 10 min', m / 3300 > 0.93 && m / 3300 < 1.06, (m / 3300 * 100).toFixed(1) + '% of 3300 m');
  }

  /* 7) GPS spike while walking does not add distance */
  {
    const rnd = rng(5);
    let y = 0;
    const m = session(() => {
      for (let i = 0; i < 300; i++) {
        y += 1.4;
        let [la, ln] = toLL(gauss(rnd) * 2, y + gauss(rnd) * 2);
        if (i === 150 || i === 151) [la, ln] = toLL(900, y);
        emit(la, ln, 5, t += 1000, 1.4);
      }
    });
    report('walk with 900 m spike', m / 420 > 0.9 && m / 420 < 1.08, (m / 420 * 100).toFixed(1) + '% of 420 m');
  }

  console.log(fail ? '\n' + fail + ' FAILURES' : '\nTracker stress test passed.');
  win.close();
  process.exit(fail ? 1 : 0);
})();
