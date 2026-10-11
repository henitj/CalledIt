/* ============================================================
   CalledIt — shared app shell
   - device detection (Apple / Android / desktop)
   - header + collapsible bottom navigation (injected on every page)
   - small formatting / DOM utilities shared by all pages
   ============================================================ */
(function () {
  'use strict';

  var BODY = document.body;

  /* ---------------- tiny helpers ---------------- */
  function qs(sel, el) { return (el || document).querySelector(sel); }
  function qsa(sel, el) { return Array.prototype.slice.call((el || document).querySelectorAll(sel)); }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtKm(m, digits) {
    if (m == null || isNaN(m)) return '—';
    var v = m / 1000;
    return (v < 10 ? v.toFixed(digits == null ? 1 : digits) : Math.round(v).toString()) + ' km';
  }

  function fmtBoth(m) {
    if (m == null || isNaN(m)) return '—';
    var km = m / 1000, mi = m / 1609.344;
    var a = (km < 10 ? km.toFixed(1) : Math.round(km)) + ' km';
    var b = (mi < 10 ? mi.toFixed(1) : Math.round(mi)) + ' mi';
    return a + ' · ' + b;
  }

  function fmtDuration(mins) {
    if (mins == null || isNaN(mins)) return '—';
    mins = Math.round(mins);
    if (mins < 60) return '~' + mins + ' min';
    var h = Math.floor(mins / 60), r = mins % 60;
    return '~' + h + ' h' + (r ? ' ' + r + ' min' : '');
  }

  function stars(rating) {
    if (rating == null) return '';
    var full = Math.round(rating);
    var out = '';
    for (var i = 1; i <= 5; i++) out += i <= full ? '★' : '☆';
    return out;
  }

  function haversineM(lat1, lon1, lat2, lon2) {
    var R = 6371000, toRad = Math.PI / 180;
    var dLat = (lat2 - lat1) * toRad, dLon = (lon2 - lon1) * toRad;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  var toastEl = null, toastTimer = null;
  function toast(msg, ms) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'toast';
      toastEl.setAttribute('role', 'status');
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('is-visible'); }, ms || 3200);
  }

  /* ---------------- device detection ----------------
     Detects Apple (iPhone/iPad/Mac) vs Android vs other, using the
     user agent, platform and touch points (iPadOS pretends to be a Mac). */
  function detectDevice() {
    var ua = navigator.userAgent || '';
    var plat = navigator.platform || '';
    var touch = navigator.maxTouchPoints || 0;
    var isIPadOS = /Mac/.test(plat) && touch > 1;

    var d = {
      os: 'other', osLabel: 'this device', mobile: false, tablet: false,
      formFactor: 'desktop', isApple: false, isAndroid: false,
      touch: touch > 0,
      browser: 'other'
    };

    if (/iPhone|iPod/i.test(ua)) {
      d.os = 'ios'; d.osLabel = 'an iPhone'; d.mobile = true; d.formFactor = 'phone';
    } else if (/iPad/i.test(ua) || isIPadOS) {
      d.os = 'ios'; d.osLabel = 'an iPad'; d.tablet = true; d.formFactor = 'tablet';
    } else if (/Android/i.test(ua)) {
      d.os = 'android';
      d.mobile = /Mobile/i.test(ua);
      d.tablet = !d.mobile;
      d.formFactor = d.mobile ? 'phone' : 'tablet';
      d.osLabel = d.tablet ? 'an Android tablet' : 'an Android phone';
    } else if (/Windows/i.test(ua)) {
      d.os = 'windows'; d.osLabel = 'a Windows PC';
    } else if (/Mac/i.test(plat) || /Macintosh/i.test(ua)) {
      d.os = 'macos'; d.osLabel = 'a Mac';
    } else if (/Linux/i.test(plat) || /Linux/i.test(ua)) {
      d.os = 'linux'; d.osLabel = 'a Linux PC';
    }

    d.isApple = d.os === 'ios' || d.os === 'macos';
    d.isAndroid = d.os === 'android';

    if (/Edg(e|A|iOS)?\//i.test(ua)) d.browser = 'edge';
    else if (/CriOS|Chrome\//i.test(ua)) d.browser = 'chrome';
    else if (/FxiOS|Firefox\//i.test(ua)) d.browser = 'firefox';
    else if (/Safari\//i.test(ua)) d.browser = 'safari';

    document.documentElement.dataset.os = d.os;
    document.documentElement.dataset.form = d.formFactor;
    try { localStorage.setItem('calledit_device', JSON.stringify({ os: d.os, formFactor: d.formFactor, browser: d.browser, at: Date.now() })); } catch (e) { /* private mode */ }
    return d;
  }

  var device = detectDevice();

  /* Directions links: iPhones get Apple Maps first, everyone else Google first. */
  function directionsLinks(lat, lon) {
    var g = 'https://www.google.com/maps/dir/?api=1&destination=' + lat + ',' + lon;
    var a = 'https://maps.apple.com/?daddr=' + lat + ',' + lon;
    return device.isApple
      ? [{ label: 'Directions · Apple Maps', href: a, primary: true }, { label: 'Google Maps', href: g }]
      : [{ label: 'Directions · Google Maps', href: g, primary: true }, { label: 'Apple Maps', href: a }];
  }

  function installInstructions() {
    if (device.os === 'ios') return 'Tap the Share button in Safari, then “Add to Home Screen” to keep CalledIt one tap away.';
    if (device.isAndroid) return 'Open the browser menu (⋮) and choose “Install app” or “Add to Home screen”.';
    return 'Bookmark this page with Ctrl/Cmd + D — or use your browser’s “Install app” option in the address bar.';
  }

  /* ---------------- icons (inline SVG, stroke = currentColor) ---------------- */
  function svg(inner, vb) {
    return '<svg viewBox="' + (vb || '0 0 24 24') + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + inner + '</svg>';
  }
  var ICONS = {
    home: svg('<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/>'),
    start: svg('<circle cx="12" cy="12" r="9"/><polygon points="15.5 8.5 13.7 13.7 8.5 15.5 10.3 10.3 15.5 8.5" fill="currentColor" stroke="none"/>'),
    trails: svg('<path d="M9 4 4 6v14l5-2 6 2 5-2V4l-5 2-6-2z"/><path d="M9 4v14M15 6v14"/>'),
    social: svg('<path d="M19.8 5.1a4.6 4.6 0 0 0-6.5 0L12 6.4l-1.3-1.3a4.6 4.6 0 1 0-6.5 6.5l1.3 1.3L12 19.4l6.5-6.5 1.3-1.3a4.6 4.6 0 0 0 0-6.5z"/>'),
    chevronDown: svg('<polyline points="6 9 12 15 18 9"/>'),
    chevronUp: svg('<polyline points="18 15 12 9 6 15"/>')
  };

  /* ---------------- header ---------------- */
  var NAV_ITEMS = [
    { id: 'home', href: 'index.html', label: 'Home', icon: ICONS.home },
    { id: 'start', href: 'start.html', label: 'Start', icon: ICONS.start },
    { id: 'trails', href: 'trails.html', label: 'Trails', icon: ICONS.trails },
    { id: 'social', href: 'social.html', label: 'Community', icon: ICONS.social }
  ];

  function buildHeader(page) {
    var skip = document.createElement('a');
    skip.className = 'skip-link';
    skip.href = '#main';
    skip.textContent = 'Skip to content';
    BODY.insertBefore(skip, BODY.firstChild);

    var header = document.createElement('header');
    header.className = 'site-header';
    header.innerHTML =
      '<div class="wrap site-header__row">' +
      '  <a class="brand" href="index.html" aria-label="CalledIt home">' +
      '    <img src="assets/icon.png" alt="" class="brand__mark" width="36" height="36">' +
      '    <span class="brand__name">Called<em>It</em></span>' +
      '  </a>' +
      '  <nav class="top-links" aria-label="Sections">' +
      NAV_ITEMS.map(function (i) {
        return '<a href="' + i.href + '"' + (i.id === page ? ' class="is-active" aria-current="page"' : '') + '>' + i.label + '</a>';
      }).join('') +
      '  </nav>' +
      '  <button type="button" class="btn btn-soft btn-sm" id="shareBtn">' +
      '    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/></svg>' +
      '    <span>Share</span>' +
      '  </button>' +
      '</div>';
    BODY.insertBefore(header, BODY.firstChild);

    /* subtle shadow once the page scrolls */
    var onScroll = function () { header.classList.toggle('is-scrolled', window.scrollY > 8); };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    qs('#shareBtn', header).addEventListener('click', function () {
      var data = { title: document.title, text: 'Find and share great trails with CalledIt', url: location.href };
      if (navigator.share) {
        navigator.share(data).catch(function () { /* dismissed */ });
      } else if (navigator.clipboard) {
        navigator.clipboard.writeText(location.href).then(function () { toast('Link copied to clipboard'); });
      } else {
        toast('Copy the address bar link to share');
      }
    });
  }

  /* ---------------- bottom navigation ---------------- */
  function buildBottomNav(page) {
    var nav = document.createElement('nav');
    nav.className = 'bottom-nav';
    nav.id = 'bottomNav';
    nav.setAttribute('aria-label', 'Primary');
    nav.innerHTML =
      '<div class="bottom-nav__inner">' +
      NAV_ITEMS.map(function (i) {
        return '<a class="bn-item' + (i.id === page ? ' is-active' : '') + '" href="' + i.href + '"' +
          (i.id === page ? ' aria-current="page"' : '') + '>' + i.icon + '<span>' + i.label + '</span></a>';
      }).join('') +
      '  <button type="button" class="bn-collapse" id="bnCollapse" aria-label="Hide navigation bar" title="Hide this bar">' +
      ICONS.chevronDown +
      '  </button>' +
      '</div>';
    BODY.appendChild(nav);

    var reopen = document.createElement('button');
    reopen.type = 'button';
    reopen.className = 'nav-reopen';
    reopen.id = 'navReopen';
    reopen.setAttribute('aria-label', 'Show navigation bar');
    reopen.innerHTML = ICONS.chevronUp + '<span>Menu</span>';
    BODY.appendChild(reopen);

    function hideNav() {
      BODY.classList.add('nav-hidden');
      try { localStorage.setItem('calledit_nav_hidden', '1'); } catch (e) { }
      toast('Hidden. Tap “Menu” (bottom right) to bring the bar back.');
    }
    function showNav() {
      BODY.classList.remove('nav-hidden');
      try { localStorage.setItem('calledit_nav_hidden', '0'); } catch (e) { }
    }

    var hidden = false;
    try { hidden = localStorage.getItem('calledit_nav_hidden') === '1'; } catch (e) { }
    if (hidden) BODY.classList.add('nav-hidden');

    qs('#bnCollapse').addEventListener('click', hideNav);
    reopen.addEventListener('click', showNav);

    /* First-visit coach mark: explain that the bar switches pages and can be closed */
    var hintSeen = false;
    try { hintSeen = localStorage.getItem('calledit_nav_hint_seen') === '1'; } catch (e) { }
    if (!hintSeen && !hidden) {
      var hint = document.createElement('div');
      hint.className = 'nav-hint';
      hint.setAttribute('role', 'dialog');
      hint.setAttribute('aria-label', 'How to navigate');
      hint.innerHTML =
        '<p><strong>Getting around 👋</strong><br>' +
        'Use this bar to jump between <b>Home</b>, <b>Start</b>, <b>Trails</b> and <b>Community</b>. ' +
        'Tap <b>▾</b> to tuck it away — the <b>Menu</b> button in the corner brings it back.</p>' +
        '<button type="button" class="btn btn-primary btn-sm" id="navHintOk">Got it</button>';
      BODY.appendChild(hint);
      qs('#navHintOk', hint).addEventListener('click', function () {
        hint.classList.add('is-gone');
        setTimeout(function () { hint.remove(); }, 350);
        try { localStorage.setItem('calledit_nav_hint_seen', '1'); } catch (e) { }
      });
    }
  }

  /* ---------------- footer ---------------- */
  function buildFooter() {
    var f = document.createElement('footer');
    f.className = 'site-footer';
    f.innerHTML =
      '<div class="wrap site-footer__row">' +
      '  <p><strong>CalledIt</strong> — call your next trail, then go walk it.</p>' +
      '  <p class="site-footer__credits">Trail &amp; route data: <a href="https://trailsplits.com" target="_blank" rel="noopener">TrailSplits</a> · ' +
      'Map data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors · ' +
      'Photos &amp; ratings: Google · Weather: Open-Meteo (CC BY 4.0)</p>' +
      '</div>';
    BODY.appendChild(f);
  }

  /* ---------------- soft-keyboard watchdog ----------------
     When the on-screen keyboard opens (phones + WebView APKs), the fixed
     bottom bars would cover the input or get pushed around. We detect the
     viewport shrink and switch to keyboard mode (see .kb-open in CSS). */
  function watchKeyboard() {
    if (!window.visualViewport) return;
    var open = false;
    function apply() {
      var vv = window.visualViewport;
      var kb = vv.height < window.innerHeight * 0.72;
      if (kb !== open) {
        open = kb;
        BODY.classList.toggle('kb-open', open);
      }
    }
    window.visualViewport.addEventListener('resize', apply);
    window.visualViewport.addEventListener('scroll', apply);
  }
  watchKeyboard();

  /* ---------------- boot ---------------- */
  var page = BODY.dataset.page || 'home';
  buildHeader(page);
  buildBottomNav(page);
  buildFooter();
  BODY.classList.add('app-ready');

  /* ---------------- public namespace ---------------- */
  window.CalledIt = {
    qs: qs, qsa: qsa,
    escapeHtml: escapeHtml,
    fmtKm: fmtKm, fmtBoth: fmtBoth, fmtDuration: fmtDuration,
    stars: stars, haversineM: haversineM,
    toast: toast,
    device: device,
    directionsLinks: directionsLinks,
    installInstructions: installInstructions,
    icons: ICONS
  };
})();
