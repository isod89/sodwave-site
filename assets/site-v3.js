/* sodwave.com — shared script (v3): language, menu, top bar, reveal on scroll, background waves. */
(function () {
  var root = document.documentElement, body = document.body;
  root.classList.add('js');

  // language: EN / FR, remembered (same key as before: sw_lang)
  function setLang(l) {
    root.lang = l;
    body.classList.remove('lang-en', 'lang-fr');
    body.classList.add('lang-' + l);
    var t = document.getElementById('langtog');
    if (t) { t.innerHTML = l === 'en' ? '<b>EN</b> / FR' : 'EN / <b>FR</b>'; t.title = l === 'en' ? 'Passer en français' : 'Switch to English'; }
    try { localStorage.setItem('sw_lang', l); } catch (e) { /* private mode */ }
  }
  window.setLang = setLang;
  var saved; try { saved = localStorage.getItem('sw_lang'); } catch (e) { /* */ }
  setLang(saved || ((navigator.language || 'en').slice(0, 2) === 'fr' ? 'fr' : 'en'));
  var tog = document.getElementById('langtog');
  if (tog) tog.addEventListener('click', function () { setLang(root.lang === 'en' ? 'fr' : 'en'); });

  // year
  var yr = document.getElementById('yr'); if (yr) yr.textContent = new Date().getFullYear();

  // phone menu
  var links = document.getElementById('links'), mb = document.getElementById('menu-btn');
  if (mb && links) {
    mb.addEventListener('click', function () { var o = links.classList.toggle('open'); mb.setAttribute('aria-expanded', o ? 'true' : 'false'); mb.textContent = o ? '✕' : '☰'; });
    links.querySelectorAll('a').forEach(function (a) { a.addEventListener('click', function () { links.classList.remove('open'); mb.textContent = '☰'; mb.setAttribute('aria-expanded', 'false'); }); });
  }

  // top bar: a line under it once the page scrolls
  var nav = document.querySelector('.nav');
  function onScroll() { if (nav) nav.classList.toggle('scrolled', window.scrollY > 8); }
  window.addEventListener('scroll', onScroll, { passive: true }); onScroll();

  // reveal on scroll
  var rv = document.querySelectorAll('.rv');
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    rv.forEach(function (el) { io.observe(el); });
  } else rv.forEach(function (el) { el.classList.add('in'); });

  // the background waves (the four colours), drawn once; they drift slowly (CSS)
  document.querySelectorAll('.waves').forEach(function (box) {
    var cols = ['#FF621A', '#FFC618', '#1ECC70', '#2E82FF'], W = 2400, H = 900, s = '';
    cols.forEach(function (c, k) {
      var y0 = 250 + k * 90, a = 40 + k * 14, d = '';
      for (var x = 0; x <= W; x += 12) {
        var y = y0 + a * Math.sin((x / W) * Math.PI * 4 + k * 1.3) * (0.65 + 0.35 * Math.sin((x / W) * Math.PI * 8 + k));   // (period W/2: seamless loop)
        d += (x ? 'L' : 'M') + x + ' ' + y.toFixed(1);
      }
      s += '<path d="' + d + '" fill="none" stroke="' + c + '" stroke-width="' + (2.4 - k * 0.3) + '" stroke-opacity=".55" stroke-linecap="round"/>';
    });
    box.insertAdjacentHTML('beforeend', '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-hidden="true">' + s + '</svg>');
  });
})();
