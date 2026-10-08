/* DEV-ONLY UI audit helper. Injected by hand into a page; deleted before release. Not part of the app. */
(function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cv = document.createElement("canvas");
  cv.width = cv.height = 1;
  const cx = cv.getContext("2d", { willReadFrequently: true });

  function rgba(str) {
    cx.clearRect(0, 0, 1, 1);
    cx.fillStyle = "#000";
    cx.fillStyle = str;
    cx.fillRect(0, 0, 1, 1);
    const d = cx.getImageData(0, 0, 1, 1).data;
    return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
  }
  const over = (top, bot) => {
    const a = top.a + bot.a * (1 - top.a);
    if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
    return {
      r: (top.r * top.a + bot.r * bot.a * (1 - top.a)) / a,
      g: (top.g * top.a + bot.g * bot.a * (1 - top.a)) / a,
      b: (top.b * top.a + bot.b * bot.a * (1 - top.a)) / a,
      a,
    };
  };
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
  const hex = (c) => "#" + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
  const short = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    const cls = (el.getAttribute("class") || "").split(/\s+/).filter(Boolean).slice(0, 3).join(".");
    if (cls) s += "." + cls;
    return s;
  };

  function visibleChain(el) {
    // returns effective opacity or 0 when hidden
    let op = 1;
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === "none" || cs.visibility === "hidden") return 0;
      op *= parseFloat(cs.opacity);
      if (e.classList && e.classList.contains("sr-only")) return 0;
    }
    return op;
  }

  function effBg(el) {
    const layers = [];
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (/gradient|url\(/.test(cs.backgroundImage)) return null; // unknown background
      const c = rgba(cs.backgroundColor);
      if (c.a > 0) { layers.push(c); if (c.a >= 0.999) break; }
    }
    let base = rgba(getComputedStyle(document.body).backgroundColor);
    if (base.a < 1) base = { r: 255, g: 255, b: 255, a: 1 };
    let out = base;
    for (let i = layers.length - 1; i >= 0; i--) out = over(layers[i], out);
    return out;
  }

  function check() {
    const W = innerWidth;
    const res = { route: location.pathname + location.search, vw: W, theme: document.documentElement.dataset.theme };
    const all = [...document.querySelectorAll("body *")];

    // 1) horizontal overflow of the page and of clipped containers
    res.pageOverflowX = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    const clipped = [];
    for (const el of all) {
      if (!(el instanceof HTMLElement)) continue;
      const cs = getComputedStyle(el);
      if (cs.overflowX === "hidden" && el.scrollWidth > el.clientWidth + 3 && el.clientWidth > 0) {
        if (/ellipsis/.test(cs.textOverflow) || el.classList.contains("truncate") || el.classList.contains("line-clamp-1")) continue;
        if (!visibleChain(el)) continue;
        clipped.push(`${short(el)} [${el.clientWidth}<${el.scrollWidth}] "${(el.innerText || "").trim().slice(0, 40)}"`);
      }
    }
    res.clippedContainers = clipped.slice(0, 12);
    res.clippedCount = clipped.length;

    const beyond = [];
    for (const el of all) {
      if (!(el instanceof HTMLElement || el instanceof SVGElement)) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || r.right <= W + 1) continue;
      if (visibleChain(el) < 0.05) continue;
      if (getComputedStyle(el).position === "fixed") continue;
      let clippedBy = false;
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const ps = getComputedStyle(p);
        if (/(auto|scroll|hidden|clip)/.test(ps.overflowX) && p.getBoundingClientRect().right <= W + 1) { clippedBy = true; break; }
      }
      if (!clippedBy) beyond.push(`${short(el)} right=${Math.round(r.right)}`);
    }
    res.beyondViewport = beyond.slice(0, 10);
    res.beyondCount = beyond.length;

    // 2) contrast + tiny text
    const fails = new Map();
    const tiny = new Map();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    let textNodes = 0;
    while ((n = walker.nextNode())) {
      const txt = n.nodeValue.trim();
      if (!txt) continue;
      const el = n.parentElement;
      if (!el || /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|OPTION)$/.test(el.tagName)) continue;
      const op = visibleChain(el);
      if (op < 0.05) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      textNodes++;
      const cs = getComputedStyle(el);
      const size = parseFloat(cs.fontSize);
      if (size < 11) {
        const k = size + "px";
        const t = tiny.get(k) || { n: 0, s: [] };
        t.n++; if (t.s.length < 3) t.s.push(txt.slice(0, 24));
        tiny.set(k, t);
      }
      const bg = effBg(el);
      if (!bg) continue;
      let fg = rgba(cs.color);
      fg = { ...fg, a: fg.a * op };
      const eff = over(fg, bg);
      const cr = ratio(eff, bg);
      const bold = parseInt(cs.fontWeight, 10) >= 700;
      const large = size >= 24 || (size >= 18.66 && bold);
      const need = large ? 3 : 4.5;
      if (cr < need) {
        const key = `${hex(eff)} on ${hex(bg)} ${size}px`;
        const f = fails.get(key) || { n: 0, cr: +cr.toFixed(2), s: [], el: short(el) };
        f.n++; if (f.s.length < 3) f.s.push(txt.slice(0, 28));
        fails.set(key, f);
      }
    }
    res.textNodes = textNodes;
    res.contrastFails = [...fails.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 14).map(([k, v]) => `${k} ratio=${v.cr} x${v.n} ${v.el} ${JSON.stringify(v.s)}`);
    res.contrastFailCount = [...fails.values()].reduce((s, v) => s + v.n, 0);
    res.tinyText = [...tiny.entries()].map(([k, v]) => `${k} x${v.n} ${JSON.stringify(v.s)}`);

    // 3) small click targets + missing names
    const small = [];
    const nameless = [];
    const sel = "button, a[href], [role=button], [role=tab], [role=switch], select, input:not([type=hidden]), textarea";
    for (const el of document.querySelectorAll(sel)) {
      if (visibleChain(el) < 0.05) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const label = (el.getAttribute("aria-label") || el.getAttribute("title") || el.innerText || el.getAttribute("placeholder") || el.value || "").trim();
      const lbl = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      const wrapped = el.closest("label");
      const labelled = el.getAttribute("aria-labelledby");
      const hasImgAlt = el.querySelector("img[alt]:not([alt=''])");
      if (!label && !lbl && !wrapped && !labelled && !hasImgAlt) nameless.push(short(el));
      const inline = getComputedStyle(el).display === "inline" && el.tagName === "A";
      if (!inline && (r.width < 24 || r.height < 24) && !(el.type === "range")) small.push(`${short(el)} ${Math.round(r.width)}x${Math.round(r.height)} "${label.slice(0, 20)}"`);
    }
    res.smallTargets = small.length;
    res.smallTargetSamples = small.slice(0, 6);
    res.nameless = nameless.length;
    res.namelessSamples = nameless.slice(0, 6);
    res.imgNoAlt = document.querySelectorAll("img:not([alt])").length;
    res.h1 = document.querySelectorAll("h1").length;
    res.title = document.title;
    res.nodes = all.length;
    return res;
  }

  function census() {
    const size = new Map(), radius = new Map(), shadow = new Map(), weight = new Map(), dur = new Map();
    for (const el of document.querySelectorAll("body *")) {
      if (visibleChain(el) < 0.05) continue;
      const cs = getComputedStyle(el);
      if ([...el.childNodes].some((c) => c.nodeType === 3 && c.nodeValue.trim())) {
        size.set(cs.fontSize, (size.get(cs.fontSize) || 0) + 1);
        weight.set(cs.fontWeight, (weight.get(cs.fontWeight) || 0) + 1);
      }
      if (cs.borderTopLeftRadius !== "0px") radius.set(cs.borderTopLeftRadius, (radius.get(cs.borderTopLeftRadius) || 0) + 1);
      if (cs.boxShadow !== "none") { const k = cs.boxShadow.slice(0, 60); shadow.set(k, (shadow.get(k) || 0) + 1); }
      if (cs.transitionDuration !== "0s") dur.set(cs.transitionDuration, (dur.get(cs.transitionDuration) || 0) + 1);
    }
    const top = (m, k = 12) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([a, b]) => `${a} x${b}`);
    const fontProbe = (f) => { cx.font = `16px ${f}, monospace`; const a = cx.measureText("mmmmmmmWWWW1lI").width; cx.font = "16px monospace"; return a !== cx.measureText("mmmmmmmWWWW1lI").width; };
    return {
      fontSizes: top(size, 16), weights: top(weight, 6), radii: top(radius, 10), shadows: top(shadow, 8), durations: top(dur, 8),
      inter: fontProbe("Inter"), segoe: fontProbe("'Segoe UI'"), body: getComputedStyle(document.body).fontFamily.slice(0, 80),
    };
  }

  async function go(route, wait = 1500) {
    history.pushState({}, "", route);
    dispatchEvent(new PopStateEvent("popstate"));
    await sleep(wait);
    for (let i = 0; i < 12 && document.querySelector(".skeleton, .animate-spin"); i++) await sleep(400);
    await sleep(300);
  }

  window.__A = { sleep, check, census, go, rgba };
})();
