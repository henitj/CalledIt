/* Community page — Pack-It-Out pledge, condition reports, cleanup days. */
(function () {
  'use strict';
  var C = window.CalledIt;
  var qs = C.qs, qsa = C.qsa, esc = C.escapeHtml;

  function store(key, val) {
    if (val === undefined) {
      try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
    }
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { }
  }

  function daysAgo(n) { return Date.now() - n * 864e5; }
  function timeAgo(ts) {
    var d = Date.now() - ts;
    if (d < 36e5) return Math.max(1, Math.round(d / 6e4)) + ' min ago';
    if (d < 864e5) return Math.round(d / 36e5) + ' h ago';
    return Math.round(d / 864e5) + ' d ago';
  }

  /* ---------------- profile (name + photo) ----------------
     The photo is downscaled to 256px JPEG client-side before saving —
     that keeps localStorage happy and makes upload work even in WebViews
     (the Android app forwards file-chooser requests to the system picker). */
  var profile = store('calledit_profile_v1') || { name: '', photo: null };

  function renderProfile() {
    var img = qs('#avatarImg'), fb = qs('#avatarFallback');
    if (profile.photo) {
      img.src = profile.photo;
      img.hidden = false;
      fb.hidden = true;
    } else {
      img.hidden = true;
      fb.hidden = false;
      fb.textContent = (profile.name || '🙂').trim().charAt(0).toUpperCase() || '🙂';
    }
    if (qs('#profileName') && document.activeElement !== qs('#profileName')) {
      qs('#profileName').value = profile.name || '';
    }
    var pts = store('calledit_points_v1');
    var bags = store('calledit_bags_v1');
    qs('#karmaPoints').textContent = typeof pts === 'number' ? pts : 0;
    qs('#karmaBags').textContent = typeof bags === 'number' ? bags : 0;
  }

  function saveProfile() {
    try {
      store('calledit_profile_v1', profile);
    } catch (e) {
      C.toast('Couldn’t save the photo on this device (storage full) — try a smaller image.');
    }
  }

  function handlePhotoFile(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) { C.toast('Please choose an image file (jpg, png…)'); return; }
    if (file.size > 12 * 1024 * 1024) { C.toast('That image is over 12 MB — pick a smaller one'); return; }
    var reader = new FileReader();
    reader.onerror = function () { C.toast('Couldn’t read that file — try another photo.'); };
    reader.onload = function () {
      var im = new Image();
      im.onerror = function () { C.toast('That doesn’t look like a valid image — try another.'); };
      im.onload = function () {
        try {
          var max = 256;
          var scale = Math.min(1, max / Math.max(im.width, im.height));
          var w = Math.max(1, Math.round(im.width * scale)), h = Math.max(1, Math.round(im.height * scale));
          var canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          canvas.getContext('2d').drawImage(im, 0, 0, w, h);
          profile.photo = canvas.toDataURL('image/jpeg', 0.85);
          saveProfile();
          renderProfile();
          C.toast('Profile photo updated 📸');
        } catch (e) {
          C.toast('Couldn’t process that photo — try a different one.');
        }
      };
      im.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  var avatarInput = qs('#avatarInput');
  if (avatarInput) {
    avatarInput.addEventListener('change', function () {
      handlePhotoFile(avatarInput.files && avatarInput.files[0]);
      avatarInput.value = '';   /* allow re-picking the same file */
    });
    /* extra-proof for WebViews: tap anywhere on the avatar block opens the
       picker via JS (label activation is unreliable in some WebViews). The
       input is outside the label to avoid double-opening. */
    qs('.avatar-wrap').addEventListener('click', function (e) {
      if (e.target !== avatarInput) {
        e.preventDefault();
        avatarInput.click();
      }
    });
  }
  var nameInput = qs('#profileName');
  if (nameInput) {
    nameInput.addEventListener('input', function () {
      profile.name = nameInput.value;
      saveProfile();
    });
  }

  /* ---------------- pack-it-out points (sane amounts) ----------------
     5 points per bag — max 3 bags per log and max 3 logs per day
     (45 points/day). It’s a thank-you, not a grind. */
  var PTS_PER_BAG = 5, MAX_BAGS = 3, MAX_LOGS_PER_DAY = 3;

  function todayKey() { return new Date().toDateString(); }
  function litterLogs() { return store('calledit_litter_v1') || []; }

  function renderLitter() {
    var logs = litterLogs().slice(0, 8);
    qs('#litterLog').innerHTML = logs.length
      ? '<div class="report-list" style="margin-top:14px">' + logs.map(function (l) {
          return '<div class="report"><div class="report__top">' +
            '<span class="chip chip--amber">🧺 ' + l.bags + ' bag' + (l.bags > 1 ? 's' : '') + ' · +' + (l.bags * PTS_PER_BAG) + ' pts</span>' +
            (l.trail ? '<span class="report__trail">' + esc(l.trail) + '</span>' : '') +
            '<span class="report__time">' + timeAgo(l.ts) + '</span></div>' +
            (l.note ? '<p class="report__text">' + esc(l.note) + '</p>' : '') +
            '</div>';
        }).join('') + '</div>'
      : '';
    renderProfile();
  }

  qs('#litterForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var logs = litterLogs();
    var todayCount = logs.filter(function (l) { return new Date(l.ts).toDateString() === todayKey(); }).length;
    if (todayCount >= MAX_LOGS_PER_DAY) {
      C.toast('That’s ' + MAX_LOGS_PER_DAY + ' logs today — plenty of karma already! Come back tomorrow. 🌲');
      return;
    }
    var bags = Math.min(MAX_BAGS, Math.max(1, parseInt(qs('#litterBags').value, 10) || 1));
    var entry = {
      ts: Date.now(),
      bags: bags,
      trail: qs('#litterTrail').value.trim(),
      note: qs('#litterNote').value.trim()
    };
    logs.unshift(entry);
    store('calledit_litter_v1', logs.slice(0, 100));
    var pts = (store('calledit_points_v1') || 0) + bags * PTS_PER_BAG;
    var bagTotal = (store('calledit_bags_v1') || 0) + bags;
    try {
      localStorage.setItem('calledit_points_v1', JSON.stringify(pts));
      localStorage.setItem('calledit_bags_v1', JSON.stringify(bagTotal));
    } catch (e2) { }
    qs('#litterForm').reset();
    renderLitter();
    C.toast('+' + (bags * PTS_PER_BAG) + ' trail-karma points — thank you! 💚');
  });

  renderLitter();

  /* ---------------- Pack-It-Out pledge ---------------- */
  var GOAL = 250;
  var count = store('calledit_pledge_total');
  if (typeof count !== 'number') { count = 187; store('calledit_pledge_total', count); }

  function renderPledge() {
    qs('#pledgeCount').textContent = count.toLocaleString();
    qs('#pledgeBar').style.width = Math.min(100, count / GOAL * 100) + '%';
    qs('#pledgeGoalText').textContent = count >= GOAL
      ? 'Goal reached — amazing! New goal coming soon.'
      : Math.round(count / GOAL * 100) + '% of this month’s goal of ' + GOAL + ' pledges';
  }
  renderPledge();

  qs('#pledgeBtn').addEventListener('click', function () {
    var today = new Date().toDateString();
    if (store('calledit_pledged_day') === today) {
      C.toast('You already pledged today — thank you! 🌲');
      return;
    }
    store('calledit_pledged_day', today);
    count += 1;
    store('calledit_pledge_total', count);
    renderPledge();
    C.toast('Pledge counted. Every wrapper home! 💚');
  });

  /* ---------------- reports ---------------- */
  var TYPES = ['All', 'Kudos', 'Muddy', 'Obstacle', 'Closure', 'Trail work', 'Wildlife'];
  var TYPE_STYLE = {
    'Kudos': 'chip--amber', 'Muddy': 'chip--blue', 'Obstacle': 'chip--danger',
    'Closure': 'chip--danger', 'Trail work': 'chip', 'Wildlife': 'chip--grey'
  };
  var TYPE_ICON = {
    'Kudos': '🌟', 'Muddy': '💧', 'Obstacle': '🌲', 'Closure': '⛔', 'Trail work': '🛠', 'Wildlife': '🐿'
  };

  var seed = [
    { id: 's1', trail: 'Matterhorn Glacier Trail', type: 'Kudos', text: 'Volunteers re-marked the faded signs near Schwarzsee — crystal clear now. Legends!', ts: daysAgo(0.4), kudos: 24 },
    { id: 's2', trail: '5-Seenweg', type: 'Muddy', text: 'Boggy section just east of Stellisee after last night’s rain. Poles or gaiters recommended.', ts: daysAgo(1.2), kudos: 11 },
    { id: 's3', trail: 'Gornergrat loop', type: 'Trail work', text: 'Switchback repair weekend — Sat 09:00 at the railway bridge, tools provided. Helpers welcome!', ts: daysAgo(2), kudos: 17 },
    { id: 's4', trail: 'Trift gorge path', type: 'Closure', text: 'Footbridge inspection Tue 10:00–14:00, short diversion signed via the lower path.', ts: daysAgo(2.6), kudos: 8 },
    { id: 's5', trail: 'Zmutt village trail', type: 'Wildlife', text: 'Marmots very active near the hamlet — please keep snacks sealed and dogs close.', ts: daysAgo(3.1), kudos: 19 }
  ];

  var reports = seed.concat(store('calledit_reports_v1') || []);
  var kudosGiven = store('calledit_kudos_v1') || [];
  var activeFilter = 'All';

  var filtersEl = qs('#reportFilters');
  filtersEl.innerHTML = TYPES.map(function (t) {
    return '<button type="button" class="suggest-chip' + (t === activeFilter ? ' is-on' : '') + '" data-type="' + esc(t) + '"' +
      (t === activeFilter ? ' style="background:var(--green-500);color:#fff"' : '') + '>' + esc(t) + '</button>';
  }).join('');
  qsa('[data-type]', filtersEl).forEach(function (btn) {
    btn.addEventListener('click', function () {
      activeFilter = btn.dataset.type;
      qsa('[data-type]', filtersEl).forEach(function (b) {
        var on = b.dataset.type === activeFilter;
        b.style.background = on ? 'var(--green-500)' : '';
        b.style.color = on ? '#fff' : '';
      });
      renderReports();
    });
  });

  function renderReports() {
    var list = reports
      .filter(function (r) { return activeFilter === 'All' || r.type === activeFilter; })
      .sort(function (a, b) { return b.ts - a.ts; });
    qs('#reportList').innerHTML = list.map(function (r) {
      var given = kudosGiven.indexOf(r.id) !== -1;
      return '<div class="report">' +
        '<div class="report__top">' +
        '<span class="chip ' + (TYPE_STYLE[r.type] || 'chip--grey') + '">' + (TYPE_ICON[r.type] || 'ℹ️') + ' ' + esc(r.type) + '</span>' +
        '<span class="report__trail">' + esc(r.trail) + '</span>' +
        '<span class="report__time">' + timeAgo(r.ts) + '</span>' +
        '</div>' +
        '<p class="report__text">' + esc(r.text) + '</p>' +
        '<div class="report__foot">' +
        '<button type="button" class="kudos-btn' + (given ? ' is-active' : '') + '" data-kudos="' + esc(r.id) + '">👍 Kudos · ' + (r.kudos + (given ? 1 : 0)) + '</button>' +
        '</div>' +
        '</div>';
    }).join('') || '<div class="empty-state"><p>No reports of this type yet. Be the first below!</p></div>';

    qsa('[data-kudos]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.dataset.kudos;
        if (kudosGiven.indexOf(id) !== -1) { C.toast('You already gave kudos to this report'); return; }
        kudosGiven.push(id);
        store('calledit_kudos_v1', kudosGiven);
        renderReports();
      });
    });
  }
  renderReports();

  qs('#reportForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var trail = qs('#reportTrail').value.trim();
    var type = qs('#reportType').value;
    var text = qs('#reportText').value.trim();
    if (!trail || !text) return;
    var r = { id: 'u' + Date.now(), trail: trail, type: type, text: text, ts: Date.now(), kudos: 0 };
    var mine = store('calledit_reports_v1') || [];
    mine.unshift(r);
    if (mine.length > 50) mine.length = 50;
    store('calledit_reports_v1', mine);
    reports.unshift(r);
    qs('#reportForm').reset();
    renderReports();
    C.toast('Report posted — thanks for looking out for others! 🙌');
  });

  /* ---------------- cleanup days: next 4 Saturdays ---------------- */
  var events = [];
  var d = new Date();
  var day = d.getDay();
  var add = (6 - day + 7) % 7; if (add === 0) add = 7;
  var spots = [
    'Forest loop — meet at the trailhead parking',
    'River path — meet at the old bridge',
    'Meadow circuit — meet at the village square',
    'Ridge access trail — meet at the bus stop'
  ];
  for (var i = 0; i < 4; i++) {
    var ev = new Date(d.getTime() + (add + i * 7) * 864e5);
    events.push({ date: ev, what: spots[i % spots.length] });
  }
  qs('#eventList').innerHTML = events.map(function (ev) {
    return '<div class="event-item">' +
      '<div class="event-date"><div class="d">' + ev.date.getDate() + '</div><div class="m">' +
      ev.date.toLocaleDateString(undefined, { month: 'short' }) + '</div></div>' +
      '<div><b>Cleanup &amp; coffee</b> · 09:00–11:00<br><span class="muted">' + esc(ev.what) + '</span></div>' +
      '</div>';
  }).join('');
})();
