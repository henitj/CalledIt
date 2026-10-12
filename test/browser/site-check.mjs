#!/usr/bin/env node
/* Real-browser end-to-end checks for CalledIt (headless Chromium).
 *
 *   node test/browser/site-check.mjs
 *       serves the repo itself and tests the website like a phone browser
 *   BASE_URL=http://127.0.0.1:8765 APK=1 node test/browser/site-check.mjs
 *       tests the copy of the site that ships INSIDE the APK (see apk-check.mjs),
 *       with an Android WebView user agent and the app's CalledItAndroid bridge
 *
 * All third-party APIs are mocked (see harness.mjs), so the run is offline
 * and deterministic. SHOTS=/some/dir saves screenshots.
 */
import path from 'node:path';
import { launch, openPage, serveStatic, brokenImages, waitFor, sleep, makeRunner, ROOT } from './harness.mjs';

const APK = process.env.APK === '1';
const WV_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/153.0.0.0 Mobile Safari/537.36';
const SHOTS = process.env.SHOTS || '';
const T = makeRunner();
let srv = null;
const BASE = process.env.BASE_URL || (srv = await serveStatic(ROOT)).origin;
const browser = await launch();
console.log((APK ? 'APK build (Android WebView)' : 'Website') + ' at ' + BASE);

const opts = (o = {}) => Object.assign(APK ? { userAgent: WV_UA, bridge: true } : {}, o);
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, (APK ? 'apk-' : 'web-') + name + '.png') }); };
async function gotIt(page) {
  await page.evaluate(() => { const b = document.querySelector('#navHintOk'); if (b) b.click(); });
  await waitFor(page, () => !document.querySelector('.nav-hint'), 5000);
}
async function scrollThrough(page, step = 650) {
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < h + step; y += step) { await page.evaluate(y => window.scrollTo(0, y), y); await sleep(160); }
}
/* the page must never scroll sideways on a phone (it did on Home at 360 px) */
async function sidewaysOverflow(page) {
  const bad = [];
  for (const w of [320, 360, 412]) {
    await page.setViewport({ width: w, height: 800, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await sleep(350);
    const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    if (r.sw > r.cw + 1) bad.push(w + 'px: ' + r.sw + ' > ' + r.cw);
  }
  await page.setViewport({ width: 412, height: 915, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  return bad;
}
/* swipe the top-rated strip card by card, the way a person looks through it */
async function swipeStrip(page, until = 'photo|map') {
  await page.$eval('#highlights', h => h.scrollIntoView({ block: 'center' }));
  const n = await page.$$eval('.hl-card', c => c.length);
  for (let i = 0; i < n; i++) {
    await page.evaluate(i => document.querySelectorAll('.hl-card')[i].scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'instant' }), i);
    await waitFor(page, i => !!document.querySelectorAll('.hl-media')[i].dataset.filled, 3000, i);
  }
  return waitFor(page, re => [...document.querySelectorAll('.hl-media')].every(b => new RegExp('^(' + re + ')$').test(b.dataset.kind || '')), 12000, until);
}
async function cardsReady(page, n = 30) { return waitFor(page, n => document.querySelectorAll('.trail-card').length >= n, 20000, n); }
async function allMediaFilled(page, timeout = 15000) {
  await scrollThrough(page, 500);
  return waitFor(page, () => [...document.querySelectorAll('.trail-card .trail-media')].every(b => b.dataset.kind === 'photo' || b.dataset.kind === 'map'), timeout);
}
const cardMedia = page => page.$$eval('.trail-card', cards => cards.map(c => {
  const box = c.querySelector('.trail-media'), img = box.querySelector('.trail-photo'), r = box.getBoundingClientRect();
  return {
    name: c.querySelector('.trail-card__name').textContent, meta: c.querySelector('.trail-card__meta span').textContent,
    kind: box.dataset.kind, w: r.width, h: r.height, src: img ? img.getAttribute('src') : '',
    loaded: img ? img.complete && img.naturalWidth > 0 : null, credit: (box.querySelector('.photo-credit') || {}).textContent || '',
    tiles: box.querySelectorAll('.map-thumb .tile').length,
    tilesOk: [...box.querySelectorAll('.map-thumb .tile')].every(t => t.complete && t.naturalWidth > 0),
    pin: (() => { const p = box.querySelector('.map-thumb__pin'); if (!p) return null; const pr = p.getBoundingClientRect(); return pr.left >= r.left - 2 && pr.right <= r.right + 2 && pr.top >= r.top - 2 && pr.bottom <= r.bottom + 2; })()
  };
}));
/* junk that really comes back from Commons around Zermatt and Austin */
const JUNK_RE = /Wanderwegweiser|Hotel_vehicle|Bahnhofstrasse|police_vehicle|Cor_des_alpes|Erinus|Euphydryas|Flowers?_in_Zermatt|Hiking_sign|Swisstopo|Malacosoma|Euphorbia|Lotus_alpinus|Alyssum|Plant_in_Zermatt|Jakob_und_Linda|station|White_stripe|Zilker_elementary|Risk_Legacy|Argemone|Gaillardia|Monarda|Dungeon|Number_1|Voting|Child_with|Candied|Neighborhood|Texas_Aerial|Pseudouroctonus|View_of_Earth|F_18|Bergstation|Skilift|Pistenfahrzeug|recycling|Ristorante|Bar_Igloo|Bar_Baitta|Downtown|Nanteuil|Leroux|frontispiece|Telescope|railway|Museum|Funivia|Hotel|School|Amtrak|TXMap/i;
const photoName = src => decodeURIComponent(String(src).split('?')[0].split('/').pop()).replace(/^\d+px-/, '');
const lastBot = page => page.evaluate(() => { const m = [...document.querySelectorAll('#assistantLog .msg--bot:not(.msg--typing)')]; return m.length ? m[m.length - 1].textContent : ''; });
async function ask(page, text, expect) {
  const before = await page.$$eval('#assistantLog .msg--bot:not(.msg--typing)', m => m.length);
  await page.$eval('#assistantText', (el, t) => { el.value = t; el.dispatchEvent(new Event('input', { bubbles: true })); }, text);
  await page.$eval('#assistantForm', f => f.requestSubmit());
  const ok = await waitFor(page, (n, re) => {
    const m = [...document.querySelectorAll('#assistantLog .msg--bot:not(.msg--typing)')];
    return m.length > n && new RegExp(re, 'i').test(m[m.length - 1].textContent);
  }, 12000, before, expect.source);
  return { ok, reply: await lastBot(page) };
}
const nearAustin = c => {
  if (!c.path.startsWith('/trails/v1/bbox')) return false;
  const q = new URLSearchParams(c.query);
  const lon = (parseFloat(q.get('min_lng')) + parseFloat(q.get('max_lng'))) / 2, lat = (parseFloat(q.get('min_lat')) + parseFloat(q.get('max_lat'))) / 2;
  return Math.abs(lon - -97.7431) < 0.01 && Math.abs(lat - 30.2672) < 0.01;
};
async function linkStatus(href) {
  try { const r = await fetch(new URL(href, BASE + '/').href); return r.status; } catch (e) { return 'ERR ' + e.message; }
}

/* ============ 1. every page: loads clean, images, links ============ */
for (const name of ['index.html', 'start.html', 'social.html']) {
  await T.section('Page ' + name, async () => {
    const { page, context, errors, failedLocal, router } = await openPage(browser, BASE + '/' + name, opts());
    await page.waitForSelector('.bottom-nav .bn-item', { timeout: 10000 });
    await scrollThrough(page);
    await sleep(600);
    await page.evaluate(() => window.scrollTo(0, 0));
    T.check('no JavaScript errors', errors.length === 0, errors.join(' | '));
    T.check('no missing local files', failedLocal.length === 0, failedLocal.join(' | '));
    const side = await sidewaysOverflow(page);
    T.check('fits small phones — never scrolls sideways (320 / 360 / 412 px)', side.length === 0, side.join(', '));
    const broken = await brokenImages(page);
    T.check('no broken images', broken.length === 0, broken.join(', '));
    const imgs = await page.$$eval('img', els => els.filter(i => i.offsetParent !== null).map(i => ({ src: i.getAttribute('src'), ok: i.complete && i.naturalWidth > 0 })));
    T.check('every visible image decoded (' + imgs.length + ')', imgs.length > 0 && imgs.every(i => i.ok), JSON.stringify(imgs.filter(i => !i.ok)));
    const links = await page.$$eval('a[href]', as => [...new Set(as.map(a => a.getAttribute('href')).filter(h => /\.html(\?|#|$)/.test(h) && !/^https?:/.test(h)))]);
    const bad = [];
    for (const l of links) { const st = await linkStatus(l); if (st !== 200) bad.push(l + ' → ' + st); }
    T.check('all ' + links.length + ' internal links resolve', bad.length === 0, bad.join(', '));
    const nav = await page.$$eval('.bottom-nav .bn-item', a => a.map(x => x.getAttribute('href')));
    T.check('bottom navigation has Home/Start/Trails/Community', ['index.html', 'start.html', 'trails.html', 'social.html'].every(h => nav.includes(h)), nav.join(','));
    T.check('no AI assistant here (Trails page only)', !(await page.$('#assistantFab')) && !router.log.external.some(u => /puter\.com/.test(u)));

    if (name === 'start.html') {
      const logos = await page.$$eval('.mode-card img', i => i.map(x => x.getAttribute('src')));
      T.check('cartoon walker + biker on the mode cards', logos.includes('assets/cartoon-walker.jpg') && logos.includes('assets/cartoon-biker.jpg'), logos.join(','));
      T.check('first tip is open by default', (await page.$eval('.accordion__btn', b => b.getAttribute('aria-expanded'))) === 'true');
      const second = (await page.$$('.accordion__btn'))[1];
      await second.click();
      await sleep(400);
      T.check('tapping another tip opens it', await page.evaluate(() => { const b = document.querySelectorAll('.accordion__btn')[1]; return b.getAttribute('aria-expanded') === 'true' && b.parentElement.querySelector('.accordion__panel').getBoundingClientRect().height > 20; }));
      await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.click('.mode-card[data-mode="bike"]')]);
      T.check('biking card opens Trails in bike mode', /trails\.html\?mode=bike/.test(page.url()) && (await page.evaluate(() => localStorage.getItem('calledit_mode'))) === 'bike');
      await waitFor(page, () => document.querySelector('#modeBike') && document.querySelector('#modeBike').classList.contains('is-active'), 8000);
      T.check('Trails shows the bike toggle active', await page.$eval('#modeBike', b => b.classList.contains('is-active')));
    }

    if (name === 'social.html') {
      const input = await page.$('#avatarInput');
      await input.uploadFile(path.join(ROOT, 'assets', 'hiker.jpg'));
      const up = await waitFor(page, () => { const i = document.querySelector('#avatarImg'); return i && !i.hidden && /^data:image\/jpeg/.test(i.src) && i.naturalWidth > 0; }, 8000);
      T.check('profile photo upload works', up);
      const dims = await page.$eval('#avatarImg', i => [i.naturalWidth, i.naturalHeight]);
      T.check('photo downscaled to ≤256 px for storage', Math.max(...dims) <= 256, dims.join('x'));
      await page.type('#profileName', 'Sam');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#avatarImg');
      await sleep(400);
      T.check('photo + name survive a reload', await page.evaluate(() => !document.querySelector('#avatarImg').hidden && document.querySelector('#profileName').value === 'Sam'));
      for (let i = 0; i < 4; i++) {
        await page.select('#litterBags', '3');
        await page.$eval('#litterForm', f => f.requestSubmit());
        await sleep(250);
      }
      const pts = await page.$eval('#karmaPoints', e => e.textContent);
      T.check('litter points: 15 per log, capped at 3 logs/day (45 pts)', pts === '45', 'points=' + pts);
      const toast = await page.$eval('.toast', t => t.textContent).catch(() => '');
      T.check('4th log today politely refused', /3 logs today/.test(toast), toast);
      await page.type('#reportTrail', 'Hörnliweg');
      await page.select('#reportType', 'Muddy');
      await page.type('#reportText', 'Muddy section after the second bridge.');
      await page.$eval('#reportForm', f => f.requestSubmit());
      await sleep(300);
      T.check('trail report appears in the list', /second bridge/.test(await page.$eval('#reportList', e => e.textContent)));
      const c0 = await page.$eval('#pledgeCount', e => e.textContent);
      await page.click('#pledgeBtn');
      await sleep(300);
      const c1 = await page.$eval('#pledgeCount', e => e.textContent);
      T.check('pledge counter goes up', parseInt(c1.replace(/\D/g, ''), 10) === parseInt(c0.replace(/\D/g, ''), 10) + 1, c0 + ' → ' + c1);
      await shot(page, 'social');
    }
    if (name === 'index.html') await shot(page, 'home');
    await context.close();
  });
}

/* ============ 2. Trails page: list, photos, map, weather, details ============ */
await T.section('Trails page (phone)', async () => {
  const { page, context, errors, failedLocal, router } = await openPage(browser, BASE + '/trails.html', opts());
  T.check('40 trails listed', await cardsReady(page, 40), String(await page.$$eval('.trail-card', c => c.length)));
  await gotIt(page);
  T.check('all trail photos/maps filled in', await allMediaFilled(page));
  await sleep(1200);
  const cards = await cardMedia(page);

  /* lengths */
  const zero = cards.filter(c => /(^|[^\d.])0\.0 km|~0 min/.test(c.meta));
  T.check('no “0.0 km · ~0 min” lengths', zero.length === 0, zero.map(c => c.name + ': ' + c.meta).join(' | '));
  const tappa6 = cards.find(c => c.name === 'Tour Monte Rosa tappa 6');
  T.check('km-tagged route fixed (TMR tappa 6 = 24.5 km)', tappa6 && /24\.5 km|25 km/.test(tappa6.meta) && /h/.test(tappa6.meta), tappa6 && tappa6.meta);
  const tmr = cards.find(c => c.name === 'Tour Monte Rosa');
  T.check('stub of a long-distance tour says “Multi-stage route”, not 1.0 km', tmr && /Multi-stage/.test(tmr.meta), tmr && tmr.meta);
  const cervin = cards.find(c => c.name === 'Tour du Cervin');
  T.check('multi-day trek shows days (Tour du Cervin)', cervin && /days/.test(cervin.meta), cervin && cervin.meta);

  /* photos — the mocks replay REAL Commons/Wikipedia results, and Google
     sends no photos (exactly what the real API does for this key) */
  const photos = cards.filter(c => c.kind === 'photo'), maps = cards.filter(c => c.kind === 'map');
  console.log('    (' + photos.length + ' photos, ' + maps.length + ' trail-area maps)');
  T.check('every card has an image (photo or trail map)', photos.length + maps.length === cards.length);
  T.check('most cards show a real photo although Google sends none (≥ 60%)', photos.length >= 0.6 * cards.length, photos.length + ' of ' + cards.length);
  T.check('no stock fallback pictures on trail cards', !cards.some(c => /assets\/fallback-/.test(c.src)));
  const srcs = photos.map(c => c.src);
  T.check('no photo repeated on two cards', new Set(srcs).size === srcs.length, srcs.length - new Set(srcs).size + ' duplicates');
  const junk = srcs.filter(s => JUNK_RE.test(photoName(s)));
  T.check('real Commons junk never shown (signposts, vehicles, streets, plants, insects, people, stations…)', junk.length === 0, junk.map(photoName).join(', '));
  T.check('all photos actually loaded', photos.every(c => c.loaded), photos.filter(c => !c.loaded).map(c => c.src).join(', '));
  T.check('only standard Wikimedia thumbnail widths requested (others are refused)', router.log.badThumbs.length === 0, router.log.badThumbs.slice(0, 3).join(', '));
  T.check('photos are 960 px thumbnails, never multi-MB originals', srcs.every(s => /\/960px-|thumbnail_unscaled/.test(s)), srcs.filter(s => !/\/960px-|thumbnail_unscaled/.test(s)).join(', '));
  const commons = photos.filter(c => /wikimedia/.test(c.src) && !/Wikipedia ·/.test(c.credit));
  T.check('Commons photos credited with author + licence (HTML stripped)', commons.length > 0 && commons.every(c => /^📷 .+ · (CC BY|Public domain)/.test(c.credit) && !/</.test(c.credit)), JSON.stringify(commons.slice(0, 3).map(c => c.credit)));
  T.check('no Google photo requests when Google sends no photos', !router.log.external.some(u => /places\.googleapis\.com\/v1\/places\/[^:]+\/media/.test(u)));
  const hornli = cards.find(c => c.name === 'Hörnliweg');
  T.check('Hörnliweg card shows a photo of the Hörnliweg itself', hornli && /Hörnliweg/.test(photoName(hornli.src)), hornli && photoName(hornli.src));
  const glacier = cards.find(c => /^Matterhorn glacier trail$/i.test(c.name));
  T.check('Matterhorn glacier trail card shows a “Matterhorn Glacier Trail” photo', glacier && /Matterhorn_Glacier_Trail/i.test(photoName(glacier.src)), glacier && photoName(glacier.src));
  T.check('Wikimedia lookups stay light (≤ 2 small requests per card, 1 per area)', router.log.wikimediaApi.length <= 2 * (cards.length + 8) + 2, router.log.wikimediaApi.length + ' calls for ' + cards.length + ' cards + 8 places');
  T.check('Swisstopo TIFF scans are never even looked up', !router.log.wikimediaApi.some(u => /pageids=/.test(u) && /Swisstopo/.test(decodeURIComponent(u))));
  T.check('phone layout: full-width 16:9 photos (not narrow strips)', cards.every(c => c.w >= 330 && Math.abs(c.h / c.w - 9 / 16) < 0.04), JSON.stringify(cards.slice(0, 3).map(c => [Math.round(c.w), Math.round(c.h)])));
  T.check('map thumbnails: tiles loaded and start pin inside the frame', maps.every(c => c.tiles > 0 && c.tilesOk && c.pin));
  T.check('no broken images anywhere', (await brokenImages(page)).length === 0, (await brokenImages(page)).join(', '));

  /* map, weather, highlights */
  T.check('backup map (Leaflet) shown when Google Maps JS is unavailable', await page.$eval('#leafletMap', m => m.classList.contains('leaflet-container') && !m.hidden && m.querySelectorAll('img.leaflet-tile-loaded').length > 0));
  T.check('5-day weather strip', (await page.$$('.weather-day')).length === 5);
  /* the strip loads lazily — places off to the right wait until swiped into view */
  await page.$eval('#highlights', h => h.scrollIntoView({ block: 'center' }));
  await sleep(1500);
  const filledBefore = await page.$$eval('.hl-media', b => b.filter(x => x.dataset.filled === '1').length);
  T.check('top-rated strip loads lazily (places swiped out of view aren’t fetched yet)', filledBefore >= 1 && filledBefore < 8, filledBefore + ' of 8 filled before swiping');
  await swipeStrip(page);
  await sleep(600);
  const hl = await page.$$eval('.hl-card', c => c.map(x => {
    const m = x.querySelector('.hl-media'), img = m.querySelector('.trail-photo');
    return { kind: m.dataset.kind, ok: [...x.querySelectorAll('img')].every(i => i.complete && i.naturalWidth > 0) && x.querySelectorAll('img').length > 0,
      credit: (x.querySelector('.photo-credit') || {}).textContent || '', nestedLink: !!x.querySelector('a.photo-credit'), src: img ? img.getAttribute('src') : '' };
  }));
  const hlPhotos = hl.filter(h => h.kind === 'photo');
  T.check('top-rated strip: 8 places, each with an image that loaded', hl.length === 8 && hl.every(h => h.ok), JSON.stringify(hl.filter(h => !h.ok)));
  T.check('…real photos for most of them although Google sends none (≥ 5 of 8)', hlPhotos.length >= 5, hl.map(h => h.kind).join(','));
  T.check('…credited, no junk, no link nested inside the card link', hlPhotos.every(h => /📷/.test(h.credit) && !JUNK_RE.test(photoName(h.src))) && !hl.some(h => h.nestedLink), JSON.stringify(hlPhotos.slice(0, 2)));
  const allSrcs = srcs.concat(hlPhotos.map(h => h.src));
  T.check('no photo appears twice on the page (cards + strip)', new Set(allSrcs).size === allSrcs.length);
  T.check('TrailSplits used for trails/weather', router.log.apiCalls.some(c => c.path.startsWith('/trails/v1/bbox')) && router.log.external.some(u => /trailsplits\.com\/api\/weather/.test(u)));

  /* details sheet */
  await page.evaluate(() => window.scrollTo(0, 0));
  const first = cards[0];
  await page.$eval('.trail-card .trail-card__media', b => b.scrollIntoView({ block: 'center' }));
  await page.click('.trail-card .trail-card__media');
  T.check('tapping a trail photo opens its details', await waitFor(page, () => document.querySelector('#modalBackdrop').classList.contains('is-open'), 4000));
  await waitFor(page, () => { const h = document.querySelector('.modal-hero'); return h && (h.dataset.kind === 'map' || (h.querySelector('.trail-photo') && h.querySelector('.trail-photo').naturalWidth > 0)); }, 8000);
  await sleep(500);
  const d = await page.evaluate(() => {
    const h = document.querySelector('.modal-hero'), r = h.getBoundingClientRect(), x = document.querySelector('#modalClose').getBoundingClientRect();
    return { title: document.querySelector('#modalTitle').textContent, kind: h.dataset.kind, w: r.width, h: r.height, src: (h.querySelector('.trail-photo') || {}).src || '',
      closeOnTop: x.top >= r.top && x.bottom <= r.bottom, facts: document.querySelector('#factGrid').textContent,
      chart: !!document.querySelector('#elevChart path'), elevShown: !document.querySelector('#elevSection').hidden };
  });
  T.check('details: title matches the card', d.title === first.name, d.title + ' vs ' + first.name);
  T.check('details: same photo of the trail as the card, full-width hero', d.kind === first.kind && (d.kind === 'map' || d.src === new URL(first.src, BASE).href || d.src === first.src) && d.h >= 180 && d.w >= 380, JSON.stringify(d).slice(0, 200));
  T.check('details: ✕ floats over the photo', d.closeOnTop);
  T.check('details: elevation profile drawn', d.chart && d.elevShown);
  T.check('details: climb shown', /512 m/.test(d.facts), d.facts);
  await waitFor(page, () => /Trailhead/.test((document.querySelector('#dirNote') || {}).textContent || ''), 5000);
  const dir = await page.evaluate(() => ({ note: document.querySelector('#dirNote').textContent, href: document.querySelector('#dirRow a.btn-primary').href }));
  const rel = await page.evaluate(async id => { const t = [...document.querySelectorAll('.trail-card')].find(c => c.querySelector('.trail-card__name').textContent === id); return t ? t.dataset.id : null; }, first.name);
  const relId = rel && rel.replace(/^\D+/, '');
  const geo = await page.evaluate(async id => (await (await fetch('https://api.trailsplits.com/trails/v1/relation/' + id)).json()).geometry.coordinates, relId);
  const ends = [geo[0], geo[geo.length - 1]].map(([lon, lat]) => (+lat.toFixed(6)) + ',' + (+lon.toFixed(6)));
  const dest = (dir.href.match(/destination=([^&]+)/) || dir.href.match(/daddr=([^&]+)/) || [])[1];
  T.check('details: Directions go to the trailhead (a route end), not the middle of the area', /Trailhead/.test(dir.note) && ends.includes(decodeURIComponent(dest || '')), dir.note + ' → ' + dest + ' vs ends ' + ends.join(' | '));
  const cardDir = await page.evaluate(n => { const c = [...document.querySelectorAll('.trail-card')].find(x => x.querySelector('.trail-card__name').textContent === n); return c && c.querySelector('a[data-dir]').href; }, first.name);
  T.check('…and the card’s Directions button follows', cardDir === dir.href, cardDir);
  await shot(page, 'details');
  await page.click('#modalClose');
  T.check('✕ closes details', await waitFor(page, () => !document.querySelector('#modalBackdrop').classList.contains('is-open'), 3000));
  await page.click('[data-details]');
  await waitFor(page, () => document.querySelector('#modalBackdrop').classList.contains('is-open'), 3000);
  await page.evaluate(() => history.back());
  T.check('back gesture closes details and stays on Trails', await waitFor(page, () => !document.querySelector('#modalBackdrop').classList.contains('is-open'), 3000) && /trails\.html/.test(page.url()));

  /* credit link must not open the details sheet */
  const creditOpens = await page.evaluate(() => {
    const a = document.querySelector('.trail-card a.photo-credit');
    if (!a) return 'none';
    a.addEventListener('click', e => e.preventDefault(), { once: true });
    a.click();
    return document.querySelector('#modalBackdrop').classList.contains('is-open');
  });
  T.check('photo credit link opens the source, not the details', creditOpens === false, String(creditOpens));

  /* bike mode + search */
  const n0 = router.log.apiCalls.length;
  await page.click('#modeBike');
  await waitFor(page, () => document.querySelector('#modeBike').classList.contains('is-active') && document.querySelectorAll('.trail-card').length > 0, 10000);
  T.check('bike toggle reloads routes', router.log.apiCalls.slice(n0).some(c => c.path.startsWith('/trails/v1/bbox')) && /Track ride/.test(await page.$eval('#trackBtnLabel', e => e.textContent)));
  await page.click('#modeHike');
  await cardsReady(page, 40);
  await page.$eval('#searchInput', e => { e.value = ''; });
  await page.type('#searchInput', 'Austin, Texas');
  await page.keyboard.press('Enter');
  T.check('search geocodes and loads the new area', await waitFor(page, () => /Austin/.test(document.querySelector('#statusLine').textContent), 10000), await page.$eval('#statusLine', e => e.textContent));
  await page.$eval('#searchInput', e => { e.value = ''; });
  await page.type('#searchInput', 'zzzz');
  await page.keyboard.press('Enter');
  T.check('unknown place → friendly message', await waitFor(page, () => /Couldn.t find/.test((document.querySelector('.toast') || {}).textContent || ''), 8000));
  const sideT = await sidewaysOverflow(page);
  T.check('Trails fits small phones — never scrolls sideways (320 / 360 / 412 px)', sideT.length === 0, sideT.join(', '));
  T.check('no JavaScript errors on Trails', errors.length === 0, errors.join(' | '));
  T.check('no missing local files on Trails', failedLocal.length === 0, failedLocal.join(' | '));
  await context.close();
});

await T.section('Trails page — when photo services fail', async () => {
  const { page, context, errors } = await openPage(browser, BASE + '/trails.html', opts({ googlePhotosFail: true, commonsEmpty: true }));
  await cardsReady(page, 40);
  await gotIt(page);
  T.check('cards still all get an image', await allMediaFilled(page, 20000));
  await sleep(1500);
  const cards = await cardMedia(page);
  T.check('…a map of the trail’s own area (tiles + start pin)', cards.every(c => c.kind === 'map' && c.tiles > 0 && c.tilesOk && c.pin), JSON.stringify(cards.filter(c => c.kind !== 'map').map(c => c.name)));
  await swipeStrip(page, 'map');
  const hl = await page.$$eval('.hl-card .hl-media', b => b.map(x => x.dataset.kind));
  T.check('highlights fall back to maps too', hl.length > 0 && hl.every(k => k === 'map'), hl.join(','));
  T.check('no broken images', (await brokenImages(page)).length === 0, (await brokenImages(page)).join(', '));
  T.check('no JavaScript errors', errors.length === 0, errors.join(' | '));
  await shot(page, 'maps-fallback');
  await context.close();
});

await T.section('Trails page — Wikimedia refuses every image (rate limit)', async () => {
  const { page, context, errors } = await openPage(browser, BASE + '/trails.html', opts({ wikimediaImagesFail: true }));
  await cardsReady(page, 40);
  await gotIt(page);
  T.check('cards still all get an image', await allMediaFilled(page, 25000));
  await sleep(1500);
  const cards = await cardMedia(page);
  T.check('…after trying other photos, the trail-area map', cards.every(c => c.kind === 'map' && c.tilesOk), JSON.stringify(cards.filter(c => c.kind !== 'map').map(c => c.name + ':' + c.kind)));
  T.check('no broken images', (await brokenImages(page)).length === 0, (await brokenImages(page)).join(', '));
  T.check('no JavaScript errors', errors.length === 0, errors.join(' | '));
  await context.close();
});

await T.section('Trails page — Wikimedia “too busy” at first', async () => {
  const { page, context, errors, router } = await openPage(browser, BASE + '/trails.html', opts({ wikimediaBusyFirst: true }));
  await cardsReady(page, 40);
  await gotIt(page);
  await allMediaFilled(page, 25000);
  await sleep(3000);
  const cards = await cardMedia(page);
  const photos = cards.filter(c => c.kind === 'photo');
  T.check('the “too busy” answer is retried, so photos still arrive', photos.length >= 12, photos.length + ' photos');
  T.check('…and was not cached as “no photos”', await page.evaluate(() => { const c = JSON.parse(localStorage.getItem('calledit_photos_v3') || '{}'); return Object.keys(c).filter(k => k.startsWith('c:')).some(k => c[k].c && c[k].c.length > 0); }));
  T.check('no broken images, no JavaScript errors', (await brokenImages(page)).length === 0 && errors.length === 0, errors.join(' | '));
  await context.close();
});

await T.section('Trails page — when Google does send photos', async () => {
  const { page, context, errors } = await openPage(browser, BASE + '/trails.html', opts({ googlePhotos: true }));
  await cardsReady(page, 40);
  await gotIt(page);
  await allMediaFilled(page);
  await sleep(1000);
  const cards = await cardMedia(page);
  const goog = cards.filter(c => c.kind === 'photo' && /googleapis/.test(c.src));
  T.check('Google photos used for trails Google knows, credited with the author', goog.length >= 3 && goog.every(c => /^Photo: Lena K\. · Google Maps$/.test(c.credit) && c.loaded), goog.length + ' ' + JSON.stringify(goog.slice(0, 2).map(c => c.credit)));
  const gPlaces = goog.map(c => (c.src.match(/places\/([^/]+)\//) || [])[1]);
  T.check('each Google place used for one trail only', new Set(gPlaces).size === gPlaces.length, gPlaces.join(','));
  const swissTop = cards.find(c => c.name === 'Swiss Top Walk');
  T.check('“Swiss Top Walk” doesn’t borrow the “5 Lakes Walk” photo', swissTop && !/five_lakes/.test(swissTop.src), swissTop && swissTop.src);
  await swipeStrip(page);
  const hl = await page.$$eval('.hl-media', b => b.map(x => (x.querySelector('.trail-photo') || {}).src || ''));
  T.check('top-rated strip uses Google’s photos', hl.length === 8 && hl.every(s => /googleapis/.test(s)), hl.filter(s => !/googleapis/.test(s)).join(', '));
  T.check('no JavaScript errors', errors.length === 0, errors.join(' | '));
  await context.close();
});

await T.section('Trails page — Austin (few signed routes, Google places as trails)', async () => {
  const { page, context, errors, router } = await openPage(browser, BASE + '/trails.html', opts({ scenario: 'austin' }));
  await waitFor(page, () => document.querySelectorAll('.trail-card').length > 0, 20000);
  await gotIt(page);
  await page.$eval('#searchInput', e => { e.value = ''; });
  await page.type('#searchInput', 'Austin, Texas');
  await page.keyboard.press('Enter');
  await waitFor(page, () => /Austin/.test(document.querySelector('#statusLine').textContent) && [...document.querySelectorAll('.trail-card__name')].some(n => /Barton Creek/.test(n.textContent)), 15000);
  await allMediaFilled(page, 20000);
  await sleep(1200);
  const cards = await cardMedia(page);
  const photos = cards.filter(c => c.kind === 'photo');
  console.log('    (' + photos.length + ' photos, ' + (cards.length - photos.length) + ' maps: ' + cards.map(c => c.name + '=' + c.kind).join(', ') + ')');
  const barton = cards.find(c => /Barton Creek/.test(c.name));
  T.check('Barton Creek Greenbelt card shows a real Barton Creek Greenbelt photo', barton && /Barton_Creek_Greenbelt/.test(photoName(barton.src)) && barton.loaded, barton && photoName(barton.src));
  const lady = cards.find(c => /Lady Bird/.test(c.name));
  T.check('Lady Bird Lake card gets a real photo too', lady && lady.kind === 'photo' && lady.loaded, lady && (lady.kind + ' ' + photoName(lady.src)));
  const junk = photos.filter(c => JUNK_RE.test(photoName(c.src)));
  T.check('Austin junk never shown (school, board game, wildflowers, scorpion, paintings, neighbourhoods…)', junk.length === 0, junk.map(c => photoName(c.src)).join(', '));
  T.check('places without nearby photos get their own map, nothing broken', cards.every(c => c.kind === 'photo' || (c.kind === 'map' && c.tilesOk)) && (await brokenImages(page)).length === 0);
  T.check('only standard Wikimedia widths requested', router.log.badThumbs.length === 0, router.log.badThumbs.join(', '));
  T.check('no JavaScript errors', errors.length === 0, errors.join(' | '));
  await shot(page, 'austin');
  await context.close();
});

if (!APK) await T.section('Trails page (desktop)', async () => {
  const { page, context, errors } = await openPage(browser, BASE + '/trails.html', { mobile: false });
  await cardsReady(page, 40);
  await gotIt(page);
  await allMediaFilled(page);
  await sleep(1000);
  const cards = await cardMedia(page);
  T.check('desktop: photo column beside the text (~200 px)', cards.every(c => c.w >= 190 && c.w <= 215 && c.h >= 160), JSON.stringify(cards.slice(0, 3).map(c => [Math.round(c.w), Math.round(c.h)])));
  T.check('desktop: map panel visible', await page.$eval('.map-panel', m => m.getBoundingClientRect().width > 300));
  T.check('no JavaScript errors', errors.length === 0, errors.join(' | '));
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, 'desktop');
  await context.close();
});

/* ============ 3. Trail assistant (Grok via Puter) ============ */
await T.section('Trail assistant (Grok via Puter, tool calling)', async () => {
  const { page, context, errors, router } = await openPage(browser, BASE + '/trails.html', opts());
  await cardsReady(page, 40);
  await gotIt(page);
  await page.click('#assistantFab');
  T.check('assistant opens from the Ask button', await waitFor(page, () => document.querySelector('#assistantSheet').classList.contains('is-open'), 3000));
  T.check('Puter.js loaded only now', router.log.external.some(u => /js\.puter\.com/.test(u)));
  let r = await ask(page, 'What is the easiest trail near me?', /Hörnliweg/);
  T.check('“easiest trail” → search_trails tool → real shortest trail (Hörnliweg, 5.5 km)', r.ok, r.reply.slice(0, 160));
  T.check('never suggests the 1 km stub of Tour Monte Rosa as easiest', !/Tour Monte Rosa\b(?! tappa)/.test(r.reply));
  T.check('signs in with a free temporary Puter account (no popup wall)', await page.evaluate(() => !!(window.__puterSignIn && window.__puterSignIn.attempt_temp_user_creation)));
  T.check('uses Grok 4.1 Fast by default', await page.evaluate(() => window.__puterCalls[0].model === 'x-ai/grok-4-1-fast-non-reasoning' && window.__puterCalls[0].tools));
  r = await ask(page, 'Plan me a 5 km loop from here', /loop/);
  T.check('“plan a loop” → plan_loop_route tool → reply', r.ok, r.reply.slice(0, 160));
  T.check('loop drawn on the map in purple', await waitFor(page, () => document.querySelectorAll('#leafletMap path[stroke="#7c3aed"]').length > 0, 4000));
  r = await ask(page, 'Where can I park?', /Park at .*Täsch Matterhorn Terminal.*Water: Brunnen/);
  T.check('“where can I park” → find_places_nearby tool', r.ok, r.reply.slice(0, 160));
  r = await ask(page, 'What should I pack for tomorrow?', /Pack water/);
  T.check('free-form question answered by Grok', r.ok, r.reply.slice(0, 160));
  await page.evaluate(() => history.back());
  T.check('back gesture closes the assistant', await waitFor(page, () => !document.querySelector('#assistantSheet').classList.contains('is-open'), 3000) && /trails\.html/.test(page.url()));
  T.check('no JavaScript errors', errors.length === 0, errors.join(' | '));
  await context.close();
});

await T.section('Settings: choose the Grok model', async () => {
  const { page, context, errors } = await openPage(browser, BASE + '/trails.html', opts());
  await cardsReady(page, 10);
  await gotIt(page);
  await page.$eval('#footerKeys', b => b.click());
  await page.waitForSelector('#setAiModel', { timeout: 4000 });
  const models = await page.$$eval('#setAiModel option', o => o.map(x => x.value));
  T.check('model list includes Grok 4.1 Fast and Grok 4.7', models.includes('x-ai/grok-4-1-fast-non-reasoning') && models.includes('x-ai/grok-4.7'), models.join(','));
  await page.select('#setAiModel', 'x-ai/grok-4.7');
  await page.evaluate(() => { window.__oldDocument = true; });
  await page.click('#settingsSave');
  let reloaded = false;
  for (let i = 0; i < 50 && !reloaded; i++) {
    await sleep(200);
    reloaded = await page.evaluate(() => !window.__oldDocument && document.readyState !== 'loading').catch(() => false);
  }
  T.check('saving reloads the page', reloaded);
  T.check('saved choice survives reload', (await page.evaluate(() => JSON.parse(localStorage.getItem('calledit_keys_v1')).aiModel)) === 'x-ai/grok-4.7');
  T.check('built-in Google key not wiped by saving blank fields', await page.evaluate(() => /^AIza/.test(window.CALLEDIT_CONFIG.googleMapsApiKey)));
  await cardsReady(page, 10);
  await gotIt(page);
  await page.click('#assistantFab');
  const r = await ask(page, 'What should I pack?', /Pack water/);
  const calls = await page.evaluate(() => window.__puterCalls || []);
  T.check('assistant now asks Grok 4.7', r.ok && calls.length > 0 && calls.every(c => c.model === 'x-ai/grok-4.7'), 'reply=' + r.reply.slice(0, 80) + ' calls=' + JSON.stringify(calls));
  T.check('no JavaScript errors', errors.length === 0, errors.join(' | '));
  await context.close();
});

/* ============ 4. GPS tracking + Near me + location switched off ============ */
await T.section('Tracking (no phantom distance) + Near me', async () => {
  const { page, context, errors, router } = await openPage(browser, BASE + '/trails.html', opts({ fakeGeo: true }));
  await cardsReady(page, 10);
  await gotIt(page);
  const run = async (kind) => {
    await page.evaluate(() => localStorage.removeItem('calledit_tracks_v1'));
    await page.click('#trackBtn');
    await waitFor(page, () => window.__geo.watchers() > 0, 3000);
    await page.evaluate(kind => {
      const R = 111320, lat0 = 30.2672, lon0 = -97.7431, cos = Math.cos(lat0 * Math.PI / 180);
      let s = 7; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
      const g = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
      const t0 = Date.now();
      if (kind === 'desk') for (let i = 0; i < 600; i++) window.__geo.emit(lat0 + g() * 7 / R, lon0 + g() * 7 / (R * cos), 9 + rnd() * 8, t0 + i * 1000);
      else for (let i = 0; i < 300; i++) window.__geo.emit(lat0 + (i * 1.4 + g() * 3) / R, lon0 + g() * 3 / (R * cos), 5 + rnd() * 3, t0 + i * 1000);
    }, kind);
    await sleep(300);
    const shown = await page.$eval('#trackDist', e => e.textContent);
    await page.click('#trackStop');
    await sleep(300);
    const logs = await page.evaluate(() => JSON.parse(localStorage.getItem('calledit_tracks_v1') || '[]'));
    return { m: (logs[0] && logs[0].km || 0) * 1000, shown };
  };
  const desk = await run('desk');
  T.check('10 min on a desk with GPS jitter → 0 m', desk.m === 0, desk.m + ' m, display ' + desk.shown);
  const walk = await run('walk');
  T.check('real 420 m walk counted (±12%)', Math.abs(walk.m - 420) <= 50, Math.round(walk.m) + ' m, display ' + walk.shown);
  const n0 = router.log.apiCalls.length;
  await page.click('#locateBtn');
  let near = false;
  for (let i = 0; i < 40 && !near; i++) { near = router.log.apiCalls.slice(n0).some(nearAustin); if (!near) await sleep(200); }
  T.check('Near me loads trails around the GPS position', near, JSON.stringify(router.log.apiCalls.slice(n0).map(c => c.path + c.query)));
  T.check('no JavaScript errors', errors.length === 0, errors.join(' | '));
  await context.close();
});

await T.section(APK ? 'Location switched off — native Android prompt' : 'Location switched off — in-page prompt', async () => {
  const { page, context, errors, router } = await openPage(browser, BASE + '/trails.html', opts({ fakeGeo: true }));
  await cardsReady(page, 10);
  await gotIt(page);
  await page.evaluate(() => window.__geo.set({ mode: 'err', code: 2 }));
  await page.click('#locateBtn');
  await sleep(600);
  await page.click('#locateBtn');
  await sleep(600);
  const n0 = router.log.apiCalls.length;
  if (APK) {
    const b = await page.evaluate(() => window.__bridge);
    T.check('APK: native “turn on location” prompt shown', b.prompts >= 1, JSON.stringify(b));
    T.check('APK: no extra web prompt stacked on top', (await page.$$('.loc-prompt')).length === 0);
    await page.evaluate(() => { window.__bridge.locationOn = true; window.__geo.set({ mode: 'ok' }); window.CalledIt.onNativeLocationOn(); });
    T.check('APK: coming back with location ON continues by itself', await waitFor(page, () => /Location is on/.test((document.querySelector('.toast') || {}).textContent || ''), 3000));
  } else {
    T.check('one prompt, never stacked', (await page.$$('.loc-prompt')).length === 1);
    await page.evaluate(() => window.__geo.set({ mode: 'ok' }));
    await page.click('#locPromptRetry');
    T.check('prompt closes on retry', await waitFor(page, () => !document.querySelector('.loc-prompt'), 3000));
  }
  let found = false;
  for (let i = 0; i < 40 && !found; i++) { found = router.log.apiCalls.slice(n0).some(nearAustin); if (!found) await sleep(200); }
  T.check('…then finds you and loads nearby trails', found);
  if (APK) {
    await page.evaluate(() => { window.__bridge.locationOn = true; window.__geo.set({ mode: 'err', code: 2 }); });
    await page.click('#locateBtn');
    T.check('APK: location ON but no fix → “no GPS fix yet”, no loop of prompts', await waitFor(page, () => /no GPS fix yet/.test((document.querySelector('.toast') || {}).textContent || ''), 3000));
  }
  T.check('no JavaScript errors', errors.length === 0, errors.join(' | '));
  await context.close();
});

/* ============ 5. back navigation between pages ============ */
await T.section('Back gesture walks history (never exits from inner pages)', async () => {
  const { page, context, errors } = await openPage(browser, BASE + '/index.html', opts());
  await page.waitForSelector('a[href="trails.html"]');
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.click('a.btn[href="trails.html"]')]);
  await cardsReady(page, 10);
  await gotIt(page);
  await page.click('[data-details]');
  await waitFor(page, () => document.querySelector('#modalBackdrop').classList.contains('is-open'), 3000);
  await page.evaluate(() => history.back());
  T.check('1st back: closes the open sheet', await waitFor(page, () => !document.querySelector('#modalBackdrop').classList.contains('is-open'), 3000) && /trails\.html/.test(page.url()));
  /* fire back() AFTER evaluate returns — otherwise the navigation can destroy the
     page context mid-call (a test race seen once in the APK run, not an app bug) */
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.evaluate(() => { setTimeout(() => history.back(), 0); })]);
  T.check('2nd back: returns to Home', /index\.html/.test(page.url()), page.url());
  T.check('no JavaScript errors', errors.length === 0, errors.join(' | '));
  await context.close();
});

await browser.close();
if (srv) await srv.close();
console.log('\n' + (T.fail ? '✗ ' : '✓ ') + T.pass + ' passed, ' + T.fail + ' failed' + (APK ? ' (APK build)' : ' (website)'));
if (T.fail) { console.log('Failures:\n  - ' + T.failures.join('\n  - ')); process.exit(1); }
