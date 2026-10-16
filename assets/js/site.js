/* SLOOP — sodwave.com: the menu, the layer tabs, the latest release from GitHub, reveal on scroll. No tracking, no cookies. */
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];

  /* the menu on phones */
  const btn = $(".menu-btn"), nav = $("#nav");
  if (btn && nav) {
    btn.addEventListener("click", () => {
      const open = nav.classList.toggle("open");
      btn.setAttribute("aria-expanded", String(open));
    });
    nav.addEventListener("click", (e) => { if (e.target.closest("a")) { nav.classList.remove("open"); btn.setAttribute("aria-expanded", "false"); } });
  }

  /* the layer tabs (arrow keys move between them) */
  const tabs = $$('[role="tab"]');
  const pick = (t, focus) => {
    tabs.forEach((x) => {
      const on = x === t;
      x.setAttribute("aria-selected", String(on));
      x.tabIndex = on ? 0 : -1;
      const p = document.getElementById(x.getAttribute("aria-controls"));
      if (p) p.hidden = !on;
    });
    if (focus) t.focus();
  };
  tabs.forEach((t, i) => {
    t.addEventListener("click", () => pick(t));
    t.addEventListener("keydown", (e) => {
      const k = e.key, n = tabs.length;
      const j = k === "ArrowDown" || k === "ArrowRight" ? (i + 1) % n : k === "ArrowUp" || k === "ArrowLeft" ? (i + n - 1) % n
        : k === "Home" ? 0 : k === "End" ? n - 1 : -1;
      if (j >= 0) { e.preventDefault(); pick(tabs[j], true); }
    });
  });

  /* the latest release (GitHub), kept for an hour in this browser; the page says 2.7 without it */
  const show = (r) => {
    $$("[data-version]").forEach((el) => { el.textContent = r.v; });
    if (r.d) $$("[data-date]").forEach((el) => { el.textContent = " · " + r.d; });
  };
  try {
    const c = JSON.parse(localStorage.getItem("sloop-rel") || "null");
    if (c && Date.now() - c.t < 3600e3) show(c);
    else throw 0;
  } catch (_) {
    fetch("https://api.github.com/repos/isod89/sloop-fm1/releases/latest", { headers: { Accept: "application/vnd.github+json" } })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((j) => {
        const v = String(j.tag_name || "").replace(/^v/i, "");
        if (!/^\d+(\.\d+)*[\w.-]*$/.test(v)) return;
        const d = j.published_at ? new Date(j.published_at).toLocaleDateString("en", { year: "numeric", month: "short", day: "numeric" }) : "";
        const r = { v, d, t: Date.now() };
        show(r);
        try { localStorage.setItem("sloop-rel", JSON.stringify(r)); } catch (_) { /* private mode */ }
      })
      .catch(() => { /* offline or rate-limited: the static version stays */ });
  }

  $$("[data-year]").forEach((el) => { el.textContent = String(new Date().getFullYear()); });

  /* reveal on scroll */
  const rv = $$(".rv");
  if ("IntersectionObserver" in window && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }),
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
    rv.forEach((el) => io.observe(el));
  } else {
    rv.forEach((el) => el.classList.add("in"));
  }
})();
