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
      '  <p class="site-footer__credits"><button type="button" class="footer-link-btn" id="footerKeys">⚙️ Settings — map key, AI model</button></p>' +
      '</div>';
    BODY.appendChild(f);
    qs('#footerKeys', f).addEventListener('click', openSettings);
  }

  /* ---------------- overlay stack + Android back gesture ----------------
     Overlays (trail details, assistant, settings …) push a history entry so
     the Android back gesture/back button CLOSES the overlay and returns to
     the last page instead of exiting the app. */
  var overlayStack = [];

  function pushOverlay(name, closeFn) {
    var entry = { name: name, closeFn: closeFn, hist: false };
    overlayStack.push(entry);
    try {
      history.pushState({ calleditOverlay: name, depth: overlayStack.length }, '');
      entry.hist = true;
    } catch (e) { /* file:// in some WebViews — overlay still works, no history */ }
  }

  function popOverlay() {
    var top = overlayStack.pop();
    if (top && typeof top.closeFn === 'function') top.closeFn();
    return !!top;
  }

  function closeOverlayByName(name) {
    for (var i = overlayStack.length - 1; i >= 0; i--) {
      if (overlayStack[i].name === name) {
        overlayStack[i].closeFn();
        overlayStack.splice(i, 1);
        return true;
      }
    }
    return false;
  }

  window.addEventListener('popstate', function () {
    /* Back gesture: close whatever overlay is open instead of leaving the app */
    popOverlay();
  });

  /* Close the top overlay programmatically (used by UI close buttons). */
  function closeOverlay(name) {
    if (overlayStack.length && (name == null || overlayStack[overlayStack.length - 1].name === name)) {
      var top = overlayStack[overlayStack.length - 1];
      if (top.hist) {
        /* consume the history entry; popstate will pop + run closeFn */
        history.back();
      } else {
        popOverlay();
      }
      return true;
    }
    return closeOverlayByName(name);
  }

  /* ---------------- location services prompt ----------------
     After permission is granted, phones can still have Location Services
     turned off — geolocation then fails with code 2. Prompt the user to
     actually turn location on (the Android app opens the system settings). */
  var pendingLocationRetry = null;

  function hasBridge(fn) {
    return !!(window.CalledItAndroid && typeof window.CalledItAndroid[fn] === 'function');
  }

  function openLocationSettings() {
    if (hasBridge('openLocationSettings')) {
      window.CalledItAndroid.openLocationSettings();   /* APK: straight to the system screen */
      return;
    }
    toast('Turn on Location / GPS in your device’s quick settings, then tap “Near me” again.', 5200);
  }

  /* Called by the Android app (onResume) once device location is back ON:
     re-runs whatever needed it (Near me / Track hike) without another tap. */
  function onNativeLocationOn() {
    var retry = pendingLocationRetry;
    pendingLocationRetry = null;
    var open = qs('.loc-prompt');
    if (open) open.remove();
    if (typeof retry === 'function') {
      toast('Location is on — continuing…', 2200);
      setTimeout(retry, 400);
    }
  }

  function promptEnableLocation(onRetry) {
    pendingLocationRetry = onRetry || null;

    /* APK: one native dialog (“Turn on location” → system settings). The app
       calls CalledIt.onNativeLocationOn() when you come back with it on. */
    if (hasBridge('promptEnableLocation')) {
      var shown = window.CalledItAndroid.promptEnableLocation();
      if (shown === false) {                   /* location is ON — there’s just no fix yet */
        pendingLocationRetry = null;
        toast('Location is on, but there’s no GPS fix yet — step outside or near a window, then try again.', 5200);
      }
      return;
    }

    if (qs('.loc-prompt')) return;            /* never stack two prompts */
    var wrap = document.createElement('div');
    wrap.className = 'loc-prompt';
    wrap.setAttribute('role', 'alertdialog');
    wrap.setAttribute('aria-label', 'Location is turned off');
    wrap.innerHTML =
      '<div class="loc-prompt__card">' +
      '  <h2>📍 Location is turned off</h2>' +
      '  <p>You allowed CalledIt to use your location, but your device’s location (GPS) switch is off, so we can’t find you yet.</p>' +
      '  <div class="btn-row" style="margin-top:14px">' +
      '    <button type="button" class="btn btn-primary" id="locPromptOpen">Turn on location</button>' +
      '    <button type="button" class="btn btn-ghost" id="locPromptRetry">I turned it on — retry</button>' +
      '    <button type="button" class="btn btn-ghost" id="locPromptClose">Not now</button>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(wrap);
    function done() { wrap.remove(); }
    qs('#locPromptOpen', wrap).addEventListener('click', openLocationSettings);
    qs('#locPromptRetry', wrap).addEventListener('click', function () {
      done();
      var retry = pendingLocationRetry; pendingLocationRetry = null;
      if (retry) retry();
    });
    qs('#locPromptClose', wrap).addEventListener('click', function () { pendingLocationRetry = null; done(); });
  }

  /* ---------------- settings dialog ----------------
     Google Maps / TrailSplits keys + which Grok model the trail assistant
     uses (via Puter.js — no AI key needed). Stored on this device only and
     merged into CALLEDIT_CONFIG on every load (see config.js). */
  function openSettings() {
    var existing = qs('#settingsBackdrop');
    if (existing) existing.remove();
    var cfg = window.CALLEDIT_CONFIG || {};
    var ai = cfg.ai || { models: [], model: '' };
    var saved = {};
    try { saved = JSON.parse(localStorage.getItem('calledit_keys_v1') || '{}') || {}; } catch (e) { saved = {}; }
    var esc = escapeHtml;
    var modelOptions = (ai.models || []).map(function (m) {
      return '<option value="' + esc(m.id) + '"' + (m.id === ai.model ? ' selected' : '') + '>' + esc(m.label) + '</option>';
    }).join('');
    var puterSignedIn = !!(window.puter && window.puter.auth && window.puter.auth.isSignedIn && window.puter.auth.isSignedIn());

    var box = document.createElement('div');
    box.className = 'modal-backdrop is-open';
    box.id = 'settingsBackdrop';
    box.innerHTML =
      '<div class="modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="settingsTitle">' +
      '  <button type="button" class="modal__close" id="settingsClose" aria-label="Close settings">' +
      '    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>' +
      '  </button>' +
      '  <h2 id="settingsTitle">Settings</h2>' +
      '  <p class="muted" style="font-size:.9rem">Saved on this device only. Leave a key empty to keep using the built-in one.</p>' +
      '  <div class="settings-grid">' +
      '    <label>Trail assistant AI model<div class="muted" style="font-size:.75rem">Grok by xAI, free through Puter — no API key needed</div>' +
      '      <select id="setAiModel">' + modelOptions + '</select></label>' +
      '    <div class="settings-row" id="puterRow">' +
      '      <div><b>Puter account</b><div class="muted" style="font-size:.75rem" id="puterStatus">' +
               (puterSignedIn ? 'Connected — the assistant can answer anything.' : 'Not connected yet — your first assistant question opens a free one-time sign-in.') +
      '      </div></div>' +
      (puterSignedIn ? '      <button type="button" class="btn btn-ghost btn-sm" id="puterSignOut">Sign out</button>' : '') +
      '    </div>' +
      '    <label>Google Maps key<div class="muted" style="font-size:.75rem">Maps JavaScript API + Places API (New): map, photos, ratings</div>' +
      '      <input id="setGoogleKey" type="text" spellcheck="false" autocomplete="off" placeholder="AIza…" value="' + esc(saved.googleMapsApiKey || '') + '"></label>' +
      '    <label>TrailSplits key<div class="muted" style="font-size:.75rem">Trail &amp; elevation API (optional — the free tier works without one)</div>' +
      '      <input id="setTrailsKey" type="text" spellcheck="false" autocomplete="off" placeholder="optional" value="' + esc(saved.trailsplitsApiKey || '') + '"></label>' +
      '  </div>' +
      '  <div class="btn-row" style="margin-top:18px">' +
      '    <button type="button" class="btn btn-primary" id="settingsSave">Save</button>' +
      '    <button type="button" class="btn btn-ghost" id="settingsCancel">Cancel</button>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(box);

    function close() {
      box.remove();
      closeOverlay('settings');
    }
    qs('#settingsClose', box).addEventListener('click', close);
    qs('#settingsCancel', box).addEventListener('click', close);
    box.addEventListener('click', function (e) { if (e.target === box) close(); });
    var signOut = qs('#puterSignOut', box);
    if (signOut) signOut.addEventListener('click', function () {
      try { window.puter.auth.signOut(); } catch (e) { }
      qs('#puterStatus', box).textContent = 'Signed out. Your next assistant question will ask you to sign in again.';
      signOut.remove();
    });
    qs('#settingsSave', box).addEventListener('click', function () {
      var payload = {
        googleMapsApiKey: qs('#setGoogleKey', box).value.trim(),
        trailsplitsApiKey: qs('#setTrailsKey', box).value.trim(),
        aiModel: qs('#setAiModel', box).value
      };
      try { localStorage.setItem('calledit_keys_v1', JSON.stringify(payload)); } catch (e) { }
      close();
      toast('Saved. Reloading so it takes effect…');
      setTimeout(function () { location.reload(); }, 700);
    });
    pushOverlay('settings', function () { box.remove(); });
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
    icons: ICONS,
    /* overlays + Android back gesture */
    pushOverlay: pushOverlay, popOverlay: popOverlay, closeOverlay: closeOverlay,
    /* location services */
    openLocationSettings: openLocationSettings, promptEnableLocation: promptEnableLocation,
    onNativeLocationOn: onNativeLocationOn,
    /* settings */
    openSettings: openSettings
  };
})();
