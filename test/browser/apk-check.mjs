#!/usr/bin/env node
/* Tests the website exactly as it ships INSIDE the Android APK:
 *   1. extracts assets/ from the APK and checks every bundled page/script/style
 *      is byte-identical to the repo (no stale or missing files),
 *   2. serves those extracted files with the app's own Java LocalServer on
 *      http://127.0.0.1:8765 — the origin the app really uses,
 *   3. runs the full browser suite against it as an Android WebView, with the
 *      app's window.CalledItAndroid bridge (native location prompt).
 *
 *   node test/browser/apk-check.mjs [path/to/CalledIt.apk]
 * Needs: unzip, a JDK (javac) — or JAVA + ECJ_JAR + ANDROID_JAR — and the
 * browser deps from test/browser/README.md.
 */
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { ROOT } from './harness.mjs';

const dist = path.join(ROOT, 'android', 'dist');
const apk = process.argv[2] || path.join(dist, fs.readdirSync(dist).filter(f => /^CalledIt-.*\.apk$/.test(f))
  .sort((a, b) => fs.statSync(path.join(dist, b)).mtimeMs - fs.statSync(path.join(dist, a)).mtimeMs)[0]);
console.log('APK: ' + path.relative(ROOT, apk));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'calledit-apk-'));
let fail = 0;
const check = (name, ok, detail) => { console.log((ok ? '  \u2713 ' : '  \u2717 ') + name + (ok || !detail ? '' : '  -> ' + detail)); if (!ok) fail++; };

/* 1. extract + compare */
const unz = spawnSync('unzip', ['-q', '-o', apk, 'assets/*', '-d', tmp]);
if (unz.status !== 0) { console.error(String(unz.stderr)); process.exit(2); }
const www = path.join(tmp, 'assets', 'www');
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const files = walk(www).map(f => path.relative(www, f));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const differ = files.filter(f => !fs.existsSync(path.join(ROOT, f)) || sha(fs.readFileSync(path.join(ROOT, f))) !== sha(fs.readFileSync(path.join(www, f))));
console.log('\nAPK contents');
check(files.length + ' bundled files identical to the repo', differ.length === 0, differ.join(', '));
const must = ['index.html', 'start.html', 'trails.html', 'social.html', 'js/app.js', 'js/config.js', 'js/trails.js', 'js/start.js', 'js/social.js', 'css/styles.css', 'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css', 'assets/icon.png'];
const missing = must.filter(f => !files.includes(f));
check('all pages, scripts, styles and the offline map library are inside', missing.length === 0, missing.join(', '));
const repoPages = ['js', 'css'].flatMap(d => fs.readdirSync(path.join(ROOT, d)).map(f => d + '/' + f)).filter(f => /\.(js|css)$/.test(f));
const notShipped = repoPages.filter(f => !files.includes(f));
check('every site script/style in the repo is shipped', notShipped.length === 0, notShipped.join(', '));

/* 2. compile + start the app's LocalServer */
const out = path.join(tmp, 'classes');
fs.mkdirSync(out);
const srcs = [path.join(ROOT, 'android/app/src/main/java/com/calledit/app/LocalServer.java'), path.join(ROOT, 'android/ci/ServeAssets.java')];
const JAVA = process.env.JAVA || 'java';
let comp;
if (process.env.ECJ_JAR) {
  comp = spawnSync(JAVA, ['-jar', process.env.ECJ_JAR, '-source', '1.8', '-target', '1.8', '-nowarn', ...(process.env.ANDROID_JAR ? ['-bootclasspath', process.env.ANDROID_JAR] : []), '-d', out, ...srcs]);
} else {
  comp = spawnSync('javac', ['-nowarn', '-d', out, ...srcs]);
}
if (comp.status !== 0) { console.error(String(comp.stdout) + String(comp.stderr)); process.exit(2); }
const portFree = await new Promise(r => { const s = net.createServer().once('error', () => r(false)).once('listening', () => s.close(() => r(true))).listen(8765, '127.0.0.1'); });
if (!portFree) { console.error('port 8765 is busy'); process.exit(2); }
const server = spawn(JAVA, ['-cp', out, 'com.calledit.app.ServeAssets', path.join(tmp, 'assets'), '8765'], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('LocalServer did not start')), 15000);
  server.stdout.on('data', d => { if (/LISTENING/.test(String(d))) { clearTimeout(t); resolve(); } });
  server.on('exit', c => reject(new Error('LocalServer exited ' + c)));
});
console.log('\nApp LocalServer (from the APK source) serving the extracted APK assets on http://127.0.0.1:8765');
const r = await fetch('http://127.0.0.1:8765/');
check('GET / → index.html (200, text/html)', r.status === 200 && /text\/html/.test(r.headers.get('content-type') || '') && /CalledIt/.test(await r.text()));
const r404 = await fetch('http://127.0.0.1:8765/nope.html');
check('unknown file → 404', r404.status === 404);

/* 3. full browser suite as the Android WebView */
const suite = spawnSync(process.execPath, [path.join(ROOT, 'test/browser/site-check.mjs')], {
  env: Object.assign({}, process.env, { BASE_URL: 'http://127.0.0.1:8765', APK: '1' }), stdio: 'inherit'
});
server.kill();
fs.rmSync(tmp, { recursive: true, force: true });
if (suite.status !== 0) fail++;
console.log('\n' + (fail ? '\u2717 APK check failed' : '\u2713 APK check passed'));
process.exit(fail ? 1 : 0);
