#!/usr/bin/env node
/* Photo selection rules (js/photos.js) against REAL Wikimedia data.
 *
 *   node test/photo-check.js
 *
 * test/fixtures/photo-pools.json holds real Commons geosearch results around
 * Zermatt trails and Austin's Barton Creek, plus real Wikipedia geosearch
 * results — captured with the same queries the app makes. The earlier
 * version of the filter was only tested against invented, keyword-rich
 * titles, and rejected most real photos. This test keeps it honest. */
'use strict';
const path = require('path');
const P = require(path.join(__dirname, '..', 'js', 'photos.js'));
const F = require(path.join(__dirname, 'fixtures', 'photo-pools.json'));

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✘ ' + name + (detail ? '  — ' + detail : '')); }
}

/* ---------- thumbnail widths ---------- */
console.log('Wikimedia thumbnail sizes');
const base = 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/2f/Zermatt_2019.jpg/';
check('640px → 960px (640 is refused by Wikimedia)', P.stdThumb(base + '640px-Zermatt_2019.jpg') === base + '960px-Zermatt_2019.jpg');
check('960px kept', P.stdThumb(base + '960px-Zermatt_2019.jpg') === base + '960px-Zermatt_2019.jpg');
check('1000px → 1280px', P.stdThumb(base + '1000px-Zermatt_2019.jpg') === base + '1280px-Zermatt_2019.jpg');
check('5000px → 3840px (largest served)', P.stdThumb(base + '5000px-Zermatt_2019.jpg') === base + '3840px-Zermatt_2019.jpg');
const q = '?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail';
check('query string kept', P.stdThumb('https://thumb.wikimedia.org/wikipedia/commons/thumb/2/2f/Zermatt_2019.jpg/800px-Zermatt_2019.jpg' + q) ===
  'https://thumb.wikimedia.org/wikipedia/commons/thumb/2/2f/Zermatt_2019.jpg/960px-Zermatt_2019.jpg' + q);
check('originals (no /thumb/) untouched', P.stdThumb('https://upload.wikimedia.org/wikipedia/commons/2/2f/Zermatt_2019.jpg' + q) ===
  'https://upload.wikimedia.org/wikipedia/commons/2/2f/Zermatt_2019.jpg' + q);
check('title-only score: TIFF survey scans never even get looked up', P.titleScore('File:St. Niklaus - Galenhorn - Swisstopo 350291.tif', {}) === -99);
check('title-only score: astronaut photos never', P.titleScore('File:ISS065-E-351508 - View of Earth.jpg', {}) === -99);
check('title-only score: fighter jets never', P.titleScore('File:F 18 in the mountains (7795771960).jpg', {}) === -99);
check('…but camera settings are not aircraft', P.titleScore('File:Matterhorn at f 1.8 sunrise.jpg', {}) > 0);
check('every standard width is a real Wikimedia size', JSON.stringify(P.STD_WIDTHS) === '[20,40,60,120,250,330,500,960,1280,1920,3840]');

/* ---------- helpers ---------- */
console.log('Helpers');
check('ß → ss (Bahnhofstraße = Bahnhofstrasse)', P.words('Bahnhofstraße').join() === 'bahnhofstrasse');
check('same photo id for Commons title and Wikipedia pageimage', P.photoId('File:Zermatt 2019.jpg') === P.photoId('Zermatt_2019.jpg'));
check('area = the town, not the country', JSON.stringify(P.areaTokens('Austin, Texas, United States')) === '["austin"]');
check('“your location (…)” is not an area name', P.areaTokens('your location (30.267, -97.743)').length === 0);
check('trail-name tokens skip generic words and the town', JSON.stringify(P.nameTokens('Zermatt Panorama Trail Findeln', ['zermatt'])) === '["findeln"]');
let crashed = false, s0 = 0;
try { s0 = P.score('File:Constructor toString view.jpg', 3000, 2000, 'image/jpeg', {}); } catch (e) { crashed = true; }
check('words like “constructor” don’t hit Object prototype keys', !crashed && s0 > 0, String(s0));

console.log('Photos named after a trail are kept for that trail');
check('“Hörnliweg, Zermatt.jpg” names the Hörnliweg', P.namesTrail('File:Hörnliweg, Zermatt.jpg', ['hornliweg']));
check('“Matterhorn Glacier Trail 6.jpg” names the Matterhorn glacier trail', P.namesTrail('File:Matterhorn Glacier Trail 6.jpg', ['matterhorn', 'glacier']));
check('“Glacier in Zermatt.jpg” doesn’t (needs every word)', !P.namesTrail('File:Glacier in Zermatt.jpg', ['matterhorn', 'glacier']));
check('“Matterhorn 10.jpg” isn’t reserved by a one-word generic name', !P.namesTrail('File:Matterhorn 10.jpg', ['matterhorn']));
check('no name, no claim', !P.namesTrail('File:Hörnliweg.jpg', []));

/* ---------- Commons scoring on real pools ---------- */
const TRAIL = {
  'zermatt-centre': ['Kulturweg', 'Zermatt, Valais, Switzerland'],
  hornliweg: ['Hörnliweg', 'Zermatt, Valais, Switzerland'],
  'five-lakes': ['5-Seenweg', 'Zermatt, Valais, Switzerland'],
  'glacier-trail': ['Matterhorn glacier trail', 'Zermatt, Valais, Switzerland'],
  'austin-barton-creek': ['Barton Creek Greenbelt', 'Austin, Texas, United States'],
  'randa-st-niklaus': ['Randa Hängebrückenweg', 'Zermatt, Valais, Switzerland'],
  'saas-almagell': ['Saas-Fee - Saas-Almagell', 'Zermatt, Valais, Switzerland'],
  'saas-balen': ['Saas-Balen - Heimsichgarten', 'Zermatt, Valais, Switzerland'],
  'breuil-cervinia': ["Sentier de l'Abbé Gorret", 'Zermatt, Valais, Switzerland'],
  alagna: ['Tour Monte Rosa tappa 5', 'Zermatt, Valais, Switzerland']
};
/* junk that must never reach a card */
const JUNK = {
  'zermatt-centre': ['Wanderwegweiser', 'Hotel vehicle', 'Bahnhofstrasse', 'police vehicle', 'Cor des alpes', 'panoramio (56)'],
  hornliweg: ['Erinus alpinus', 'Euphydryas', 'Flower in Zermatt', 'Flowers in Zermatt', 'Hiking sign', 'Swisstopo'],
  'five-lakes': ['Malacosoma', 'Euphorbia', 'Lotus alpinus', 'Alyssum montanum', 'Flower in Zermatt 3', 'Plant in Zermatt',
    'Jakob und Linda', 'Zermatt Tour 11', 'wooden cottages'],
  'glacier-trail': ['Schwarzsee station', 'White stripe on rock', 'panoramio (21)'],
  'austin-barton-creek': ['Zilker elementary', 'Risk Legacy', 'Argemone', 'Gaillardia', 'Monarda', 'Dungeon Map', 'Number 1',
    'CVC - South Lamar', 'Voting Machine', 'Child with head bump', 'Candied Ginger', 'Neighborhood ATX', 'Aerial view',
    'Pseudouroctonus', 'Nanteuil', 'Leroux', 'frontispiece', 'Downtown from Zilker Park'],
  'randa-st-niklaus': ['Swisstopo'],
  'saas-almagell': ['Polemonium', 'F 18 in the mountains', 'Entry to recycling', 'Plattjen Bergstation', 'Swisstopo'],
  'saas-balen': ['Skilift Bodu', 'Pistenfahrzeug', 'Swisstopo'],
  'breuil-cervinia': ['View of Earth', 'Bar Igloo', 'Bar Baitta', 'Ristorante'],
  alagna: ['View of Earth']
};
/* real scenery that must be usable */
const GOODIES = {
  'zermatt-centre': ['panoramio (53)', 'panoramio (55)', 'Zermatt 2019', 'Ansichten von Zermatt'],
  hornliweg: ['Hörnliweg, Zermatt', 'Hörnliweg - Matterhorn', 'Trail near Matterhorn', 'Trail to Matterhorn', 'Dent Blanche',
    'Matterhorn 10', 'Zmutttal', 'Zermatt 20190717 113158'],
  'five-lakes': ['Trail between Blauherd and Stellisee', 'Grindjisee hiking trail', 'Findelgletscher', 'Unterrothorn 2019',
    'mountain view', 'Glassy Grindjisee', 'Zermatt (5064621225)'],
  'glacier-trail': ['Matterhorn Glacier Trail.jpg', 'Matterhorn Glacier Trail 7', 'Schwarzsee and trail', 'Furgg Glacier',
    'Wanderweg am Schwarzsee', 'View direction Zermatt'],
  'austin-barton-creek': ['Kayaking in Barton Springs', 'Gus Fruh - panoramio.jpg', 'Barton Creek Greenbelt - Gus Fruh Park - panoramio (1)'],
  'randa-st-niklaus': ['Aerial image of Weisshorn'],
  'saas-almagell': ['Blick nach Saas-Almagell', 'Saas-Fee mountains', 'Almagellerhorn im Herbst', 'Saas-Fee mit Mischabelgruppe'],
  'saas-balen': ['Saas-Balen 2019'],
  'breuil-cervinia': ['Sua Maestà il Cervino', "Dent d'Herens", 'Matterhorn Cervino 4478 m - panoramio (4)', 'View direction Valtourenche'],
  alagna: ['Salita al Rifugio Zamboni', 'Catena del Monte Rosa 10', 'Cima Jazzi', 'Montagne (19474195869)', 'Monte Rosa east face']
};
const MIN_USABLE = { 'zermatt-centre': 4, hornliweg: 12, 'five-lakes': 20, 'glacier-trail': 26, 'austin-barton-creek': 11,
  'randa-st-niklaus': 1, 'saas-almagell': 5, 'saas-balen': 1, 'breuil-cervinia': 4, alagna: 6 };
const BEST = { hornliweg: /Hörnliweg/, 'glacier-trail': /Matterhorn Glacier Trail/, 'austin-barton-creek': /Barton Creek Greenbelt/,
  'five-lakes': /Stellisee|Grindjisee|Seen/, alagna: /Monte Rosa/, 'saas-almagell': /Saas-Almagell|Saas-Fee/ };

for (const pool of F.commons) {
  const [trail, label] = TRAIL[pool.name];
  console.log('Commons around ' + pool.name + ' (trail “' + trail + '”)');
  const area = P.areaTokens(label);
  const ctx = { area, name: P.nameTokens(trail, area) };
  const scored = pool.items.map(([t, w, h, m], i) => ({ t, s: P.score(t, w, h, m, ctx), i }));
  const find = frag => scored.filter(x => x.t.includes(frag));
  const leaked = JUNK[pool.name].filter(f => { const m = find(f); return !m.length || m.some(x => x.s >= P.MIN_SCORE); });
  check('junk rejected: ' + JUNK[pool.name].length + ' kinds', leaked.length === 0, 'leaked/missing: ' + leaked.join(', '));
  const missed = GOODIES[pool.name].filter(f => { const m = find(f); return !m.length || m.some(x => x.s < P.MIN_SCORE); });
  check('real scenery accepted', missed.length === 0, 'rejected/missing: ' + missed.join(', '));
  const usable = scored.filter(x => x.s >= P.MIN_SCORE).length;
  check('usable photos: ' + usable + '/' + scored.length + ' (≥ ' + MIN_USABLE[pool.name] + ')', usable >= MIN_USABLE[pool.name]);
  if (BEST[pool.name]) {
    const best = scored.slice().sort((a, b) => (b.s - a.s) || (a.i - b.i))[0];
    check('best match shows the trail itself: ' + best.t.replace(/^File:/, ''), BEST[pool.name].test(best.t));
  }
}

/* ---------- Wikipedia lead photos ---------- */
const WIKI_OK = {
  zermatt: ['Ober Gabelhorn', 'Zinalrothorn', 'Zmutt', 'Gornergrat', 'Mettelhorn', 'Oberrothorn', 'Trifthorn', 'Unter Gabelhorn'],
  austin: ['Zilker Park', 'Barton Springs', 'Barton Springs Pool', 'Barton Creek']
};
for (const pool of F.wikipedia) {
  console.log('Wikipedia around ' + pool.name);
  const ok = pool.pages.filter(([t, d, la, lo, f, w, h]) => P.wikiScore(t, d, f, w, h) >= P.MIN_SCORE).map(p => p[0]);
  check('only lakes / peaks / parks / villages kept: ' + ok.join(', '), JSON.stringify(ok) === JSON.stringify(WIKI_OK[pool.name]),
    'expected ' + WIKI_OK[pool.name].join(', '));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
