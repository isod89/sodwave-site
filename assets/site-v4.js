/* sodwave.com — v4: language, phone menu, header line, the FM-1 that changes firmware. */
(function () {
  var root = document.documentElement, body = document.body;

  // language: EN / FR, remembered (the same key as before: sw_lang)
  function setLang(l) {
    root.lang = l;
    body.classList.remove('lang-en', 'lang-fr');
    body.classList.add('lang-' + l);
    var t = document.getElementById('lang');
    if (t) {
      t.innerHTML = l === 'en' ? '<b>EN</b> / FR' : 'EN / <b>FR</b>';
      t.setAttribute('aria-label', l === 'en' ? 'Passer en français' : 'Switch to English');
    }
    try { localStorage.setItem('sw_lang', l); } catch (e) { /* private mode */ }
  }
  var saved; try { saved = localStorage.getItem('sw_lang'); } catch (e) { /* */ }
  setLang(saved || ((navigator.language || 'en').slice(0, 2) === 'fr' ? 'fr' : 'en'));
  var tog = document.getElementById('lang');
  if (tog) tog.addEventListener('click', function () { setLang(root.lang === 'en' ? 'fr' : 'en'); });

  var yr = document.getElementById('yr'); if (yr) yr.textContent = new Date().getFullYear();

  // phone menu
  var nav = document.getElementById('nav'), mb = document.getElementById('menu');
  function closeMenu() { if (!nav) return; nav.classList.remove('open'); mb.setAttribute('aria-expanded', 'false'); }
  if (mb && nav) {
    mb.addEventListener('click', function () { var o = nav.classList.toggle('open'); mb.setAttribute('aria-expanded', o ? 'true' : 'false'); });
    nav.querySelectorAll('a').forEach(function (a) { a.addEventListener('click', closeMenu); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeMenu(); });
  }

  // a line under the header once the page scrolls
  var hd = document.querySelector('.hd');
  function onScroll() { if (hd) hd.classList.toggle('scrolled', window.scrollY > 4); }
  window.addEventListener('scroll', onScroll, { passive: true }); onScroll();

  // the FM-1: one keyboard, four firmwares. It changes by itself every few seconds until someone picks one.
  document.querySelectorAll('[data-rig]').forEach(function (rig) {
    var imgs = rig.querySelectorAll('.rig-stage img'), tabs = rig.querySelectorAll('[role=tab]'), caps = rig.querySelectorAll('.rig-cap > div');
    var cur = 0, timer = null, still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    function show(i, focus) {
      cur = (i + tabs.length) % tabs.length;
      imgs.forEach(function (im, k) { im.classList.toggle('on', k === cur); });
      tabs.forEach(function (t, k) { t.setAttribute('aria-selected', k === cur ? 'true' : 'false'); t.tabIndex = k === cur ? 0 : -1; });
      caps.forEach(function (c, k) { c.hidden = k !== cur; });
      if (focus) tabs[cur].focus();
    }
    function stop() { if (timer) { clearInterval(timer); timer = null; } }
    tabs.forEach(function (t, k) {
      t.addEventListener('click', function () { stop(); show(k); });
      t.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); stop(); show(cur + (e.key === 'ArrowRight' ? 1 : -1), true); }
      });
    });
    show(0);
    if (!still) {
      timer = setInterval(function () { if (!document.hidden) show(cur + 1); }, 4200);
      rig.addEventListener('pointerenter', stop);
      rig.addEventListener('focusin', stop);
    }
  });
})();
