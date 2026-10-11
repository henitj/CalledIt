/* Home page — shows the result of device detection and tailored tips. */
(function () {
  'use strict';
  var C = window.CalledIt;
  var d = C.device;

  var icons = { ios: '🍏', android: '🤖', macos: '💻', windows: '🖥️', linux: '🖥️', other: '📱' };
  var headline = {
    ios: 'You’re on an Apple device',
    android: 'You’re on an Android device',
    macos: 'You’re on a Mac',
    windows: 'You’re on a Windows PC',
    linux: 'You’re on a Linux PC',
    other: 'Made for your device'
  };

  C.qs('#deviceIcon').textContent = icons[d.os] || icons.other;
  C.qs('#deviceTitle').textContent = headline[d.os] || headline.other;

  var mapsNote = d.isApple
    ? 'Directions open in Apple Maps first (Google Maps is one tap behind it).'
    : 'Directions open in Google Maps' + (d.isAndroid ? ' — right into the app you already have.' : '.');

  var facts = [
    'We detected <b>' + C.escapeHtml(d.osLabel) + '</b> running <b>' + C.escapeHtml(d.browser) + '</b>' + (d.touch ? ' with a touchscreen' : '') + '.',
    mapsNote,
    C.installInstructions(),
    'The bottom bar switches between pages — hide it with ▾, bring it back with the Menu button.'
  ];

  var ul = C.qs('#deviceFacts');
  ul.innerHTML = facts.map(function (f) { return '<li>' + f + '</li>'; }).join('');

  var chipText = d.isApple ? 'Apple detected' : d.isAndroid ? 'Android detected' : 'Desktop detected';
  if (d.tablet) chipText += ' · tablet';
  else if (d.mobile) chipText += ' · phone';
  else chipText += ' · large screen';
  C.qs('#deviceChip').textContent = chipText;
})();
