/* Start page — accordions + remember the chosen activity mode. */
(function () {
  'use strict';
  var C = window.CalledIt;

  /* accordion */
  C.qsa('.accordion__item').forEach(function (item) {
    var btn = C.qs('.accordion__btn', item);
    var panel = C.qs('.accordion__panel', item);
    btn.addEventListener('click', function () {
      var open = item.classList.toggle('is-open');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      panel.style.maxHeight = open ? panel.scrollHeight + 'px' : '0px';
    });
  });

  /* remember mode so the trails page opens in the right one */
  C.qsa('.mode-card').forEach(function (card) {
    card.addEventListener('click', function () {
      try { localStorage.setItem('calledit_mode', card.dataset.mode || 'hike'); } catch (e) { }
    });
  });

  /* open the first accordion item by default so it’s discoverable */
  var first = C.qs('.accordion__item');
  if (first) {
    first.classList.add('is-open');
    var b = C.qs('.accordion__btn', first);
    var p = C.qs('.accordion__panel', first);
    b.setAttribute('aria-expanded', 'true');
    requestAnimationFrame(function () { p.style.maxHeight = p.scrollHeight + 'px'; });
  }
})();
