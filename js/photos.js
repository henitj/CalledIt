/* CalledIt — choosing REAL photos for trail cards.
 *
 * Why this exists: Google Places returns no photos for the configured key
 * (checked 2026-10-12 — even the Eiffel Tower comes back with every field
 * except `photos` and `reviews`), so cards can't rely on Google pictures.
 * Instead they use free, credited photos:
 *   1. Wikimedia Commons photos taken around the trail (geosearch), and
 *   2. the lead photo of a nearby lake / peak / park article on Wikipedia.
 *
 * Geotagged Commons photos are a mixed bag. Real results around Zermatt and
 * Austin include hotel vehicles, police cars, signposts, street scenes,
 * wildflower and insect close-ups (often titled with a Latin species name),
 * board games, museum paintings, neighbourhood shots and people. So every
 * candidate is scored here. The rules are calibrated on real API responses
 * saved in test/fixtures/photo-pools.json — see test/photo-check.js.
 *
 * Pure functions, no DOM: window.CalledItPhotos in the app, module.exports
 * in Node tests.
 */
(function (root) {
  'use strict';

  function set(list) {
    var o = Object.create(null);                 /* no prototype: "constructor" is just a word */
    String(list).split(/\s+/).forEach(function (w) { if (w) o[w] = true; });
    return o;
  }

  /* ---------- Wikimedia thumbnail sizes ----------
     Since 2026 Wikimedia only serves these widths; any other is refused with
     “Use thumbnail sizes listed on https://w.wiki/GHai”. The API already
     rounds requests up (iiurlwidth=640 → a 960px URL); this is a safety net
     for any URL that slips through (old caches, hand-made URLs). */
  var STD_WIDTHS = [20, 40, 60, 120, 250, 330, 500, 960, 1280, 1920, 3840];
  function stdThumb(url) {
    return String(url || '').replace(/(\/thumb\/[^?#]*\/)(\d+)px-([^\/?#]+)/, function (m, pre, w, rest) {
      w = +w;
      if (STD_WIDTHS.indexOf(w) !== -1) return m;
      var s = STD_WIDTHS[STD_WIDTHS.length - 1];
      for (var i = 0; i < STD_WIDTHS.length; i++) if (STD_WIDTHS[i] >= w) { s = STD_WIDTHS[i]; break; }
      return pre + s + 'px-' + rest;
    });
  }

  /* ---------- words ---------- */
  function words(s) {
    return String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'ss')
      .split(/[^a-z0-9]+/).filter(Boolean);
  }
  function cleanTitle(t) {
    return String(t || '').replace(/^(file|image|datei):/i, '').replace(/\.[a-z0-9]{2,5}$/i, '').replace(/_/g, ' ');
  }
  /* one id per picture across Commons and Wikipedia (“File:A b.jpg” = “A_b.jpg”) */
  function photoId(title) {
    return String(title || '').replace(/^(file|image):/i, '').replace(/_/g, ' ').trim().toLowerCase();
  }

  /* scenery / trail words (exact) */
  var GOOD = set(
    'lake lakes lac lago laghi laguna see seen trail trails path paths footpath sentier sentiero sendero hike hiking hiker hikers ' +
    'wanderweg wanderwege mountain mountains mount peak peaks piz pizzo mont monte dent dents aiguille glacier glaciers gletscher ' +
    'valley vallee valle tal val view views vista panorama panoramic panoramio aussicht ansicht ansichten blick vue scenery ' +
    'landscape landschaft creek river fluss springs spring falls waterfall wasserfall cascade cascada stream brook bach pond ' +
    'reservoir lagoon forest wald woods woodland park preserve reserve canyon gorge schlucht ridge alp alpe alpine alps alpen ' +
    'pass col summit gipfel hill hills trailhead greenbelt greenway nature meadow wiese sunset sunrise cliff cliffs overlook ' +
    'bluff bluffs dunes prairie wetland marsh bridge hut hutte cabane rifugio refuge horn berg spitze coast beach bay island ' +
    'wilderness matterhorn cervino jungfrau eiger dolomites rockies sierra appalachian montagne montagna cima cime punta ' +
    'passo colle ghiacciaio glaciar lacs vallon');
  /* German/Swiss compounds: Grindjisee, Zmutttal, Hörnliweg, Findelgletscher… */
  var GOOD_SUFFIX = ['gletscher', 'spitze', 'brucke', 'hutte', 'horn', 'berg', 'wald', 'bach', 'alpe', 'pass', 'joch', 'grat',
    'fluh', 'see', 'tal', 'weg', 'alp'];
  var SUFFIX_EXCEPT = set('capital hospital digital dental total metal crystal pedestal coastal oriental rental postal portal ' +
    'mental vital fatal natal frontal horizontal recital petal societal skeletal marital orbital tennessee longhorn longhorns ' +
    'bypass overpass underpass compass trespass surpass');
  /* never on a trail card (exact words) */
  var BAD = set(
    'map maps karte plans logo diagram chart board game games dungeon voting machine poster document screenshot scan flag ' +
    'coat arms wappen sign signs signpost signage wegweiser ticket menu portrait selfie interior inside microscope specimen ' +
    'herbarium insect insects beetle moth butterfly caterpillar larva larvae wasp spider scorpion snake lizard fungus fungi ' +
    'mushroom mushrooms lichen orchid flower flowers blume blumen blossom blossoms plant plants pflanze pflanzen plaque memorial ' +
    'grave cemetery friedhof tombstone church chapel kirche kapelle cathedral hotel restaurant bar cafe shop store building ' +
    'house street strasse gasse car cars bus tram train trains railway railroad station bahnhof airport aircraft airplane ' +
    'helicopter construction crane text book page cover newspaper stamp coin banknote advertisement graffiti crowd concert ' +
    'festival parade protest meeting conference election number sticker label bottle food dish meal icon svg drawing sketch ' +
    'painting etching engraving lithograph pastel frontispiece author museum exhibit statue sculpture swisstopo survey ' +
    'orthophoto satellite hall capitol tower office school elementary university campus hospital stadium mall garage apartment ' +
    'apartments room lobby kitchen people wedding dog cat headshot child children kid kids baby vehicle vehicles police ' +
    'polizei taxi truck alphorn cor neighborhood neighbourhood funivia seilbahn gondola cablecar telescope observatory ' +
    'ristorante recycling jet jets fighter military drone skyline downtown cityscape');
  /* …and inside long compounds: Bahnhofstrasse, Wanderwegweiser, Parkplatz… */
  var BAD_PART = ['strasse', 'gasse', 'bahnhof', 'kirche', 'kapelle', 'hotel', 'weiser', 'schild', 'friedhof', 'denkmal',
    'museum', 'station', 'parkplatz', 'polizei', 'seilbahn', 'gondelbahn', 'sesselbahn', 'skilift', 'restaurant', 'wappen',
    'fahrzeug'];
  /* never: astronaut photos geotagged below the ISS (“ISS065-E-351508 - View of Earth”), aircraft (“F 18 in the mountains”) */
  var NEVER = /\b(?:ISS|STS)\d+-E-\d+|\bview of earth\b/i;
  var AIRCRAFT = /\b(?:F|FA|EA|MiG|Su|KC|C|AH|UH)[- ]?\d{1,3}\b(?![.,]\d)/;
  /* Latin species names — “Erinus alpinus”, “Alyssum montanum”, “Gaillardia pulchella” = plant/insect close-ups */
  var BINOMIAL = /(?:^|[\s(,.-])[A-Z][a-z]{2,}\s+[a-z]{3,}(?:us|um|is|ae|ii|ensis|oides|ata|osa|ella|ina|ica|ias|iflora|ifolia|ula|ana|ense|alis)(?=$|[\s).,-])/;

  /* words that don't identify a particular trail */
  var STOP = set('the and trail trails weg route tour stage tappa via chemin des del della von zum zur walk walks loop path ' +
    'hike hiking wanderweg sentier sentiero sendero panorama park nature naturweg swiss with from near circuit lap');
  var AREA_STOP = set('your location near area current');

  function areaTokens(label) {
    var first = String(label || '').split(',')[0];
    return words(first).filter(function (w) { return w.length >= 4 && !/^\d+$/.test(w) && !AREA_STOP[w]; });
  }
  function nameTokens(name, area) {
    area = area || [];
    return words(name).filter(function (w) {
      return w.length >= 4 && !/^\d+$/.test(w) && !STOP[w] && area.indexOf(w) === -1;
    }).filter(function (w, i, a) { return a.indexOf(w) === i; });
  }
  function sameWord(w, n) {
    return w === n || (n.length >= 5 && w.indexOf(n) === 0) || (w.length >= 5 && n.indexOf(w) === 0);
  }

  var MIN_SCORE = 3;

  /* Score a Commons file from its title alone (before sizes are known):
     -99 = never (not a JPEG/WebP photo, or junk). ctx = { name, area } tokens. */
  function titleScore(title, ctx) {
    if (!/\.(jpe?g|webp)$/i.test(String(title || ''))) return -99;   /* TIFF scans, PNG maps, SVG, PDF, video */
    var raw = cleanTitle(title);
    if (NEVER.test(raw) || AIRCRAFT.test(raw)) return -99;
    var ws = words(raw), good = 0, i, j;
    for (i = 0; i < ws.length; i++) {
      var x = ws[i];
      if (BAD[x]) return -99;
      if (x.length >= 7) for (j = 0; j < BAD_PART.length; j++) if (x.indexOf(BAD_PART[j]) !== -1) return -99;
      if (GOOD[x]) { good++; continue; }
      if (x.length >= 6 && !SUFFIX_EXCEPT[x]) {
        for (j = 0; j < GOOD_SUFFIX.length; j++) {
          var s = GOOD_SUFFIX[j];
          if (x.length >= s.length + 3 && x.slice(-s.length) === s) { good++; break; }
        }
      }
    }
    var sc = Math.min(2, good) * 3;
    ctx = ctx || {};
    var name = ctx.name || [];
    var hits = name.filter(function (n) { return ws.some(function (x) { return sameWord(x, n); }); }).length;
    if (hits) sc += 4 + (hits - 1) * 3;                      /* named after this very trail… */
    if (hits >= 2 && hits === name.length) sc += 2;          /* …all of its name: “Matterhorn Glacier Trail 6” */
    if ((ctx.area || []).some(function (a) { return ws.indexOf(a) !== -1; })) sc += 2;   /* “Zermatt 2019” */
    if (BINOMIAL.test(raw)) sc -= 6;
    return sc;
  }

  /* Full score once size and type are known. ≥ MIN_SCORE = usable; -99 = never. */
  function score(title, w, h, mime, ctx) {
    if (!/^image\/(jpeg|webp)$/i.test(mime || '')) return -99;
    w = +w || 0; h = +h || 0;
    if (w < 640 || h < 360) return -99;
    var sc = titleScore(title, ctx);
    if (sc <= -50) return -99;
    var r = w / h;
    if (r >= 1.25 && r <= 3.2) sc += 1;                      /* landscape suits the cards */
    else if (r > 4) sc -= 1;                                 /* very thin panoramas crop to a sliver */
    if (r < 0.9) sc -= 4;                                    /* portrait crops badly */
    if (w >= 1600) sc += 1;
    return sc;
  }

  /* Does this photo name that particular trail? (“Hörnliweg, Zermatt.jpg” →
     the Hörnliweg; “Matterhorn Glacier Trail 6.jpg” → the Matterhorn glacier
     trail.) Such photos are kept for their own trail’s card. One-word names
     must be distinctive — “Matterhorn” alone names half of Zermatt’s photos. */
  function namesTrail(title, tokens) {
    if (!tokens || !tokens.length) return false;
    var ws = words(cleanTitle(title));
    function hit(n) { return ws.some(function (x) { return sameWord(x, n); }); }
    if (tokens.length === 1) return tokens[0].length >= 7 && !GOOD[tokens[0]] && hit(tokens[0]);
    return tokens.every(hit);
  }

  /* ---------- Wikipedia lead photos of nearby natural places ---------- */
  var NATURE = /\b(mountain|mountains|mount|peak|summit|massif|hill|hills|ridge|glacier|lake|lakes|reservoir|pond|lagoon|river|creek|stream|brook|springs?|waterfall|falls|cascade|valley|canyon|gorge|ravine|pass|plateau|mesa|butte|park|preserve|reserve|sanctuary|protected area|forest|woods|wilderness|nature|trail|greenway|greenbelt|island|beach|bay|coast|cove|cave|alps|alpine|meadow|wetland|marsh|garden|village|hamlet)\b/i;
  var NOT_NATURE = /\b(school|university|college|church|cathedral|chapel|temple|mosque|synagogue|hotel|resort|museum|gallery|sculpture|theatre|theater|cinema|stadium|arena|station|railway|railroad|airport|building|skyscraper|tower|house|mansion|district|neighbou?rhood|company|corporation|organi[sz]ation|think tank|television|series|film|album|song|band|festival|music|restaurant|bar|hospital|prison|bridge|road|highway|street|avenue|boulevard|telescope|observatory|ski area|ski resort|cable car|aerial tramway|gondola|funicular|lift|mall|shopping|statistical|county|municipality|capital|city in|town in|borough|memorial|cemetery|power station|dam)\b/i;
  var WIKI_FILE_BAD = set('map maps karte locator location relief topographic logo coat arms wappen flag seal emblem diagram ' +
    'chart sign plan funivia seilbahn gondola cablecar tram train railway station hotel church kirche telescope observatory');

  function wikiScore(title, desc, file, w, h) {
    if (!/\.jpe?g$/i.test(file || '')) return -99;          /* png/svg/gif lead images are maps, logos, flags */
    w = +w || 0; h = +h || 0;
    if (w < 640 || h < 360 || h > w * 1.1) return -99;
    var text = String(title || '') + ' — ' + String(desc || '');
    if (!NATURE.test(text) || NOT_NATURE.test(text)) return -99;
    var fw = words(cleanTitle(file)), i, j;
    for (i = 0; i < fw.length; i++) {
      if (WIKI_FILE_BAD[fw[i]]) return -99;
      if (fw[i].length >= 7) for (j = 0; j < BAD_PART.length; j++) if (fw[i].indexOf(BAD_PART[j]) !== -1) return -99;
    }
    var sc = 3, r = w / h;
    if (r >= 1.25 && r <= 3.2) sc += 1;
    if (w >= 1600) sc += 1;
    return sc;
  }

  var api = {
    STD_WIDTHS: STD_WIDTHS, MIN_SCORE: MIN_SCORE,
    stdThumb: stdThumb, words: words, photoId: photoId,
    areaTokens: areaTokens, nameTokens: nameTokens,
    titleScore: titleScore, score: score, wikiScore: wikiScore, namesTrail: namesTrail
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.CalledItPhotos = api;
})(typeof window !== 'undefined' ? window : null);
