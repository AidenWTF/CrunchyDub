"use strict";

(() => {
  if (window.__cdubLoaded) return;
  window.__cdubLoaded = true;

  const SETTINGS_KEY = "cdub-settings";
  const CACHE_KEY = "cdub-cache";
  const CATALOG_KEY = "cdub-catalog";
  const CACHE_TTL = 3 * 24 * 3600 * 1000;
  const CATALOG_TTL = 12 * 3600 * 1000;
  const MAX_CACHE = 6000;
  const SERIES_RE = /\/series\/([A-Z0-9]{5,})/;

  const DEFAULT_SETTINGS = {
    enabled: true, // filter on/off (languages still remembered)
    langs: [], // selected audio locales
    mode: "any", // "any" | "all"
    badges: true, // show badges on cards
    remove: false, // false: grey out non-matching titles; true: remove them from the page
  };

  /** id -> { id, type, title, slug, audio: string[] | null, poster, t } */
  const known = new Map();
  let settings = { ...DEFAULT_SETTINGS };
  let ready = false;

  // ---------------------------------------------------------------- storage

  const storageLoaded = browser.storage.local
    .get([SETTINGS_KEY, CACHE_KEY])
    .then((res) => {
      settings = { ...DEFAULT_SETTINGS, ...(res[SETTINGS_KEY] || {}) };
      delete settings.dim; // pre-1.4 option, replaced by `remove`
      const cache = res[CACHE_KEY] || {};
      const now = Date.now();
      for (const id in cache) {
        const [audio, title, slug, t] = cache[id];
        if (now - t < CACHE_TTL && !known.has(id)) {
          known.set(id, { id, type: "series", title, slug, audio, poster: "", t });
        }
      }
    })
    .catch(() => {});

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[SETTINGS_KEY]) return;
    settings = { ...DEFAULT_SETTINGS, ...(changes[SETTINGS_KEY].newValue || {}) };
    scheduleScan(true);
    ui.refresh();
  });

  function saveSettings() {
    browser.storage.local.set({ [SETTINGS_KEY]: settings }).catch(() => {});
  }

  let cacheSaveTimer = 0;
  function saveCacheSoon() {
    clearTimeout(cacheSaveTimer);
    cacheSaveTimer = setTimeout(() => {
      const entries = [...known.values()].filter((x) => x.audio).sort((a, b) => b.t - a.t).slice(0, MAX_CACHE);
      const obj = {};
      for (const x of entries) obj[x.id] = [x.audio, x.title, x.slug, x.t];
      browser.storage.local.set({ [CACHE_KEY]: obj }).catch(() => {});
    }, 2000);
  }

  function addItems(items) {
    let changed = false;
    const now = Date.now();
    for (const it of items) {
      if (!it || typeof it.id !== "string" || !Array.isArray(it.audio)) continue;
      const prev = known.get(it.id);
      known.set(it.id, {
        id: it.id,
        type: it.type || "series",
        title: it.title || (prev && prev.title) || "",
        slug: it.slug || (prev && prev.slug) || "",
        audio: it.audio,
        poster: it.poster || (prev && prev.poster) || "",
        t: now,
      });
      lookupFailed.delete(it.id);
      changed = true;
    }
    if (changed) {
      saveCacheSoon();
      scheduleScan(true);
    }
  }

  // ------------------------------------------------------- background comms

  browser.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "cdub-items") addItems(msg.items);
  });

  browser.runtime
    .sendMessage({ type: "cdub-get-known" })
    .then((res) => res && addItems(res.items))
    .catch(() => {});

  async function getAuth() {
    try {
      return (await browser.runtime.sendMessage({ type: "cdub-get-auth" })) || {};
    } catch (_) {
      return {};
    }
  }

  function apiLocale(auth) {
    return (auth && auth.locale) || "en-US";
  }

  // Use the page's own fetch (Firefox `content.fetch`) so the request looks like
  // one the site made itself (same origin, same cookies).
  const pageFetch = typeof content !== "undefined" && content.fetch ? content.fetch.bind(content) : fetch;

  async function api(path) {
    let auth = await getAuth();
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!auth.header) {
        await sleep(1500);
        auth = await getAuth();
        continue;
      }
      const sep = path.includes("?") ? "&" : "?";
      const url = `${location.origin}${path}${sep}locale=${encodeURIComponent(apiLocale(auth))}`;
      const res = await pageFetch(url, { headers: { Authorization: auth.header }, credentials: "include" });
      if (res.status === 401 || res.status === 403) {
        // Token expired. Crunchyroll renews it the next time the page talks to its
        // API (e.g. when you scroll), so wait up to 20 s for a different one.
        const expired = auth.header;
        for (let i = 0; i < 20; i++) {
          await sleep(1000);
          auth = await getAuth();
          if (auth.header && auth.header !== expired) break;
        }
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    }
    throw new Error(auth.header ? "Crunchyroll rejected the request" : "No Crunchyroll session token yet");
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // ------------------------------------------------------- per-card lookups

  const lookupQueue = new Set();
  const lookupInflight = new Set();
  const lookupFailed = new Map(); // id -> time
  let lookupTimer = 0;

  function queueLookup(id) {
    if (lookupQueue.has(id) || lookupInflight.has(id)) return;
    const f = lookupFailed.get(id);
    if (f && Date.now() - f < 60000) return;
    lookupQueue.add(id);
    clearTimeout(lookupTimer);
    lookupTimer = setTimeout(flushLookups, 400);
  }

  async function flushLookups() {
    const ids = [...lookupQueue].slice(0, 40);
    if (!ids.length) return;
    for (const id of ids) {
      lookupQueue.delete(id);
      lookupInflight.add(id);
    }
    try {
      const json = await api(`/content/v2/cms/objects/${ids.join(",")}?ratings=false`);
      const items = CDUB.extractItems(json);
      addItems(items);
      browser.runtime.sendMessage({ type: "cdub-remember", items }).catch(() => {});
      const got = new Set(items.map((x) => x.id));
      for (const id of ids) if (!got.has(id)) lookupFailed.set(id, Date.now());
    } catch (_) {
      for (const id of ids) lookupFailed.set(id, Date.now());
    } finally {
      for (const id of ids) lookupInflight.delete(id);
      scheduleScan(true);
    }
    if (lookupQueue.size) lookupTimer = setTimeout(flushLookups, 300);
  }

  // ------------------------------------------------------------ card logic

  function matches(audio) {
    const langs = settings.langs;
    if (!filterActive()) return true;
    if (!audio) return null;
    return settings.mode === "all" ? langs.every((l) => audio.includes(l)) : langs.some((l) => audio.includes(l));
  }

  function filterActive() {
    return settings.enabled && settings.langs.length > 0;
  }

  /** The element to hide for a card: the card's wrapper inside the grid/list. */
  const targetCache = new WeakMap();
  function hideTarget(card) {
    let t = targetCache.get(card);
    if (t && t.isConnected && t.contains(card)) return t;
    t = card;
    for (let i = 0; i < 4; i++) {
      const p = t.parentElement;
      if (!p || p === document.body || p.children.length !== 1) break;
      t = p;
    }
    targetCache.set(card, t);
    return t;
  }

  /** Virtualised lists position rows absolutely; hiding would leave holes, so dim instead. */
  function isVirtualRow(el) {
    for (let e = el, i = 0; e && i < 3; e = e.parentElement, i++) {
      if (e.style && e.style.position === "absolute") return true;
    }
    return false;
  }

  /**
   * Put the badge row on its own line below the card's info line
   * ("Sub | Dub", or "14+ • Subtitled • genres" in the hero banner).
   */
  function placeBadges(card, box) {
    const notHover = (el) => el && !el.closest('[data-t="hover-component"]');
    const anchor =
      [...card.querySelectorAll('[class*="__footer"]')].find(notHover) ||
      [...card.querySelectorAll('[data-t="meta-tags"]')].find(notHover) ||
      [...card.querySelectorAll('[data-t="title"], h3, h4')].find(notHover);
    if (!anchor) return card.appendChild(box);
    blockAncestor(anchor, card).after(box);
  }

  const HOVER_SEL = '[data-t="hover-component"]';

  function findBox(card, inHover) {
    for (const b of card.querySelectorAll(".cdub-badges")) {
      if (!!b.closest(HOVER_SEL) === inHover) return b;
    }
    return null;
  }

  function createBox(card, inHover) {
    const box = document.createElement("div");
    box.className = "cdub-badges" + (inHover ? " cdub-badges--hover" : "");
    if (!inHover) {
      placeBadges(card, box);
      return box;
    }
    const hover = card.querySelector(HOVER_SEL);
    if (!hover) return null;
    const anchor = hover.querySelector('[data-t="meta-info"]') || hover.querySelector('[data-t="title"]');
    if (!anchor) return null;
    anchor.after(box);
    return box;
  }

  // ------------------------------------------------- carousels (Discover etc.)

  /** The full-width banner at the top of Discover. */
  // A banner slide. Hidden slides have zero size, so this must not depend on layout.
  const HERO_SEL = '[class*="hero-content-card--"], [class*="hero-carousel__item--"]';

  function isHero(card) {
    if (card.matches(HERO_SEL)) return true;
    const w = card.getBoundingClientRect().width;
    return w > window.innerWidth * 0.5;
  }

  /**
   * In the hero banner, put the badge row on its own line under the
   * "Start Watching" / watchlist buttons.
   */
  function placeHeroBadges(card, box) {
    if (!box) return;
    box.classList.add("cdub-badges--hero");
    // Crunchyroll's banner: the play/watchlist buttons live in the slide's footer.
    const footer =
      card.querySelector('[class*="hero-content-card__footer"]') ||
      (card.querySelector('[data-t="up-next-btn"]') &&
        blockAncestor(card.querySelector('[data-t="up-next-btn"]'), card));
    if (footer) {
      if (footer.matches('[class*="hero-content-card__footer"]')) {
        if (box.parentElement !== footer || box !== footer.lastElementChild) footer.appendChild(box);
      } else if (footer.nextElementSibling !== box) {
        footer.after(box);
      }
      return;
    }
    const visible = (el) => !el.closest(".cdub-badges") && !el.closest(HOVER_SEL) && el.getBoundingClientRect().width > 0;
    const cta =
      // the labelled play button, not a full-banner overlay link
      [...card.querySelectorAll('a[href*="/watch/"]')].find((el) => visible(el) && el.textContent.trim()) ||
      [...card.querySelectorAll('button, [role="button"]')].find(visible);
    if (!cta) return fixOverlap(box, card);
    const row = blockAncestor(cta, card);
    if (row.nextElementSibling !== box) row.after(box);
  }

  /**
   * Fallback: in the hero banner the line after the title ("14+ • Sub | Dub • genres") is
   * pulled up over whatever precedes it. If the line after our badge row
   * overlaps it, move the badge row below that line instead.
   */
  function fixOverlap(box, card) {
    if (!box) return;
    for (let i = 0; i < 3; i++) {
      let ref = box;
      while (!ref.nextElementSibling && ref.parentElement && ref.parentElement !== card) ref = ref.parentElement;
      const next = ref.nextElementSibling;
      if (!next) return;
      const a = box.getBoundingClientRect();
      const b = next.getBoundingClientRect();
      if (!a.height || !b.height) return;
      if (b.top >= a.bottom - 1) return; // no overlap
      next.after(box);
    }
  }

  /**
   * On carousel pages, hide a whole row when every card in it is filtered out,
   * instead of leaving an empty row with just its title. A row is the largest
   * block around the carousel that holds nothing but that one carousel.
   */
  function hideEmptyRows(groups, groupOf) {
    const rows = new Set();
    for (const [parent, g] of groups) {
      if (!g.total || g.hidden !== g.total) continue;
      let row = parent;
      for (let i = 0; i < 10; i++) {
        const pp = row.parentElement;
        if (!pp || pp === document.body || pp.tagName === "MAIN" || pp.id === "content") break;
        if (pp.children.length > 3) break; // a feed / page layout with other things in it
        if (pp.querySelector("[data-cdub-trigger], .erc-browse-filtering")) break;
        const cards = pp.querySelectorAll("[data-cdub-id]");
        let mixed = false;
        for (const c of cards) {
          if (groupOf.get(c) !== parent) {
            mixed = true;
            break;
          }
        }
        if (mixed) break;
        row = pp;
        if (row.tagName === "SECTION") break;
      }
      rows.add(row);
    }
    for (const el of document.querySelectorAll(".cdub-hidden-row")) {
      if (!rows.has(el)) el.classList.remove("cdub-hidden-row");
    }
    for (const row of rows) row.classList.add("cdub-hidden-row");
  }

  // ------------------------------------------- "Dubs" buttons in the header

  function findNativeFilterTrigger() {
    return [...document.querySelectorAll('.erc-browse-filtering [role="button"]')].find(
      (t) => !t.closest("[data-cdub-trigger]")
    );
  }

  /**
   * Every page gets a "Dubs" button at the right of the top nav, next to search.
   * Browse pages also get one next to Crunchyroll's own "Filter".
   * The floating button is only a fallback when neither can be placed.
   */
  function ensureTriggers() {
    const browse = ensureBrowseButton();
    const nav = ensureNavButton();
    ui.setInlineTrigger(!!(browse || nav));
  }

  function triggerText() {
    const n = settings.langs.length;
    if (!filterActive()) return "Dubs";
    if (n <= 2) return "Dubs: " + settings.langs.map(CDUB.label).join(settings.mode === "all" ? " + " : " / ");
    return `Dubs (${n})`;
  }

  function syncTrigger(trigger, title) {
    const text = triggerText();
    if (title.textContent !== text) title.textContent = text;
    trigger.classList.toggle("cdub-trigger--active", filterActive());
    trigger.setAttribute("aria-expanded", String(ui.isOpenAt(trigger)));
  }

  function wireTrigger(trigger) {
    const open = (e) => {
      e.preventDefault();
      e.stopPropagation();
      ui.toggleAt(trigger);
    };
    trigger.addEventListener("click", open);
    trigger.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") open(e);
    });
  }

  /** A copy of Crunchyroll's Filter button, so it picks up the same styling. */
  function ensureBrowseButton() {
    const nativeTrigger = findNativeFilterTrigger();
    let mine = document.querySelector('[data-cdub-trigger="browse"]');
    if (!nativeTrigger) {
      if (mine) mine.remove();
      return null;
    }
    const nativeItem = nativeTrigger.closest("li") || nativeTrigger.closest(".erc-browse-filtering");
    if (!mine || mine.previousElementSibling !== nativeItem) {
      if (mine) mine.remove();
      mine = buildBrowseButton(nativeItem);
      nativeItem.after(mine);
    }
    const trigger = mine.querySelector('[role="button"]');
    syncTrigger(trigger, mine.querySelector(".cdub-trigger-title"));
    return trigger;
  }

  /** A copy of the header's search icon tile, turned into a "🎙 Dubs" button, placed just left of search. */
  //
  // It is never taken away: if Crunchyroll re-renders the header and drops it,
  // the next scan puts it back. Where it goes, in order of preference:
  //   1. just left of the search icon
  //   2. at the start of the header's icon area (.header-actions)
  //   3. at the end of the <header> itself
  // and if it ever was placed, it stays where it is when none of those exist.
  function ensureNavButton() {
    const search = [
      ...document.querySelectorAll(
        'header a[href$="/search"], header a[aria-label="Search"], header [data-t*="search"]'
      ),
    ].find((a) => !a.closest("[data-cdub-trigger]"));
    const actions = document.querySelector("header .header-actions");
    const header = document.querySelector("header");
    let mine = document.querySelector('[data-cdub-trigger="nav"]');

    let template = null;
    let place = null;
    if (search) {
      const item = (search.closest(".header-actions > *") || search.closest("a")) || search;
      template = item;
      if (!mine || mine.nextElementSibling !== item) place = (el) => item.before(el);
    } else if (actions) {
      if (!mine || mine.parentElement !== actions) place = (el) => actions.prepend(el);
    } else if (header) {
      if (!mine || !header.contains(mine)) place = (el) => header.appendChild(el);
    }

    if (place) {
      if (!mine) mine = buildNavButton(template);
      place(mine);
    }
    if (!mine || !mine.isConnected) return null;
    const trigger = mine.matches('[role="button"]') ? mine : mine.querySelector('[role="button"]');
    syncTrigger(trigger, mine.querySelector(".cdub-trigger-title"));
    return trigger;
  }

  function buildNavButton(item) {
    if (!item) return buildPlainNavButton();
    const wrap = item.cloneNode(true);
    wrap.setAttribute("data-cdub-trigger", "nav");
    const btn = wrap.matches("a") ? wrap : wrap.querySelector("a") || wrap;
    for (const el of [wrap, ...wrap.querySelectorAll("*")]) {
      el.removeAttribute("id");
      if (el !== wrap) el.removeAttribute("data-t");
    }
    btn.removeAttribute("href");
    btn.removeAttribute("data-t");
    btn.classList.remove("state-icon-only", "erc-search-header-button-old");
    btn.classList.add("cdub-nav-trigger");
    btn.setAttribute("role", "button");
    btn.setAttribute("tabindex", "0");
    btn.setAttribute("aria-label", "Filter by dub language");
    btn.setAttribute("title", "Filter by dub language");

    const oldIcon = btn.querySelector("svg");
    if (oldIcon) oldIcon.replaceWith(micIcon(oldIcon.getAttribute("class") || ""));

    // Label in the same text style as the nav links ("Popular", "Simulcast"…).
    const title = document.createElement("span");
    const navText = document.querySelector('a[data-t="header-menu-popular"] span');
    if (navText) title.className = navText.className;
    title.classList.add("cdub-trigger-title");
    btn.appendChild(title);

    wireTrigger(btn);
    return wrap;
  }

  function buildBrowseButton(nativeItem) {
    const item = nativeItem.cloneNode(true);
    item.setAttribute("data-cdub-trigger", "browse");
    for (const el of [item, ...item.querySelectorAll("*")]) {
      el.removeAttribute("id");
      el.removeAttribute("aria-controls");
      el.classList.remove("erc-browse-filters-onboarding", "onboarding-anchor", "erc-browse-filtering");
    }
    const trigger = item.querySelector('[role="button"]');
    trigger.setAttribute("aria-label", "Filter by dub language");
    trigger.setAttribute("title", "Filter by dub language");

    // Swap Crunchyroll's filter icon for a microphone, keeping its class for size/colour.
    const oldIcon = trigger.querySelector("svg");
    if (oldIcon) oldIcon.replaceWith(micIcon(oldIcon.getAttribute("class") || ""));

    const spans = trigger.querySelectorAll("span");
    const title = spans[spans.length - 1] || trigger;
    title.classList.add("cdub-trigger-title");
    wireTrigger(trigger);
    return item;
  }

  /** Used when there's no search icon to copy the look from. */
  function buildPlainNavButton() {
    const wrap = document.createElement("div");
    wrap.setAttribute("data-cdub-trigger", "nav");
    wrap.className = "cdub-nav-plain";
    const btn = document.createElement("a");
    btn.className = "cdub-nav-trigger";
    btn.setAttribute("role", "button");
    btn.setAttribute("tabindex", "0");
    btn.setAttribute("aria-label", "Filter by dub language");
    btn.setAttribute("title", "Filter by dub language");
    btn.appendChild(micIcon(""));
    const title = document.createElement("span");
    title.className = "cdub-trigger-title";
    btn.appendChild(title);
    wrap.appendChild(btn);
    wireTrigger(btn);
    return wrap;
  }

  function micIcon(cls) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    if (cls) svg.setAttribute("class", cls);
    const path = document.createElementNS(NS, "path");
    path.setAttribute(
      "d",
      "M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"
    );
    svg.appendChild(path);
    return svg;
  }

  /** Climb out of single-child wrappers and horizontal/inline rows so the badges get a line of their own. */
  function blockAncestor(el, card) {
    let a = el;
    for (let i = 0; i < 6; i++) {
      const p = a.parentElement;
      if (!p || p === card || !card.contains(p)) break;
      const cs = getComputedStyle(p);
      const rowLike =
        cs.display.startsWith("inline") ||
        (cs.display.includes("flex") && !cs.flexDirection.startsWith("column")) ||
        (cs.display.includes("grid") && cs.gridAutoFlow.startsWith("column"));
      if (p.children.length === 1 || rowLike) a = p;
      else break;
    }
    return a;
  }

  function badgeSig(item) {
    if (!item) return "loading";
    if (!item.audio) return "none";
    return item.audio.join(",") + "|" + settings.langs.join(",");
  }

  function fillBadges(box, item, failed) {
    box.textContent = "";
    if (!item || !item.audio) {
      const s = document.createElement("span");
      s.className = "cdub-badge cdub-badge--muted";
      s.textContent = failed ? "dubs: ?" : "…";
      s.title = failed ? "Couldn't load audio languages" : "Loading audio languages";
      box.appendChild(s);
      return;
    }
    for (const code of CDUB.sortLocales(item.audio, settings.langs)) {
      const s = document.createElement("span");
      s.className = "cdub-badge";
      if (CDUB.ORIGINAL.has(code)) s.classList.add("cdub-badge--orig");
      if (settings.langs.includes(code)) s.classList.add("cdub-badge--hit");
      s.textContent = CDUB.label(code);
      s.title = CDUB.name(code) + (CDUB.ORIGINAL.has(code) ? " (original audio)" : " dub");
      box.appendChild(s);
    }
  }

  const pageStats = { total: 0, shown: 0, counts: new Map() };

  function scan() {
    if (!ready) return;
    const seenCards = new Set();
    let total = 0;
    let shown = 0;
    const counts = new Map();

    const groups = new Map(); // card container (e.g. a carousel track) -> { total, hidden }
    const groupOf = new Map(); // card -> its container

    for (const a of document.querySelectorAll('a[href*="/series/"]')) {
      if (a.closest(".cdub-badges") || a.closest("#cdub-host")) continue;
      // The Discover banner: one slide per series. Its logo link has data-t="hero-card-logo",
      // so check for the slide first or the logo would be mistaken for the card.
      const card = a.closest(HERO_SEL) || a.closest('[data-t*="card"]');
      if (!card || seenCards.has(card)) continue;
      const m = (a.getAttribute("href") || "").match(SERIES_RE);
      if (!m) continue;
      seenCards.add(card);
      const id = m[1];
      card.dataset.cdubId = id;

      const item = known.get(id);
      if (!item) queueLookup(id);
      const failed = !item && lookupFailed.has(id) && !lookupInflight.has(id);

      // badges: on the card itself, and inside the hover overlay if it has one
      const sig = id + "|" + badgeSig(item) + (failed ? "|f" : "");
      for (const inHover of [false, true]) {
        let box = findBox(card, inHover);
        if (settings.badges) {
          if (!box) box = createBox(card, inHover);
          if (box && box.dataset.sig !== sig) {
            box.dataset.sig = sig;
            fillBadges(box, item, failed);
          }
        } else if (box) {
          box.remove();
        }
      }

      // filter (never the big hero banner: hiding its slides would break the slider)
      const audio = item && item.audio;
      const target = hideTarget(card);
      const hero = isHero(card);
      if (hero) placeHeroBadges(card, findBox(card, false));
      const ok = hero ? true : matches(audio);
      const dim = !settings.remove || isVirtualRow(target);
      target.classList.toggle("cdub-hidden", ok === false && !dim);
      target.classList.toggle("cdub-dimmed", ok === false && dim);
      card.classList.toggle("cdub-match", filterActive() && ok === true && !hero);

      if (!hero) {
        const parent = target.parentElement;
        if (parent) {
          groupOf.set(card, parent);
          const g = groups.get(parent) || { total: 0, hidden: 0 };
          g.total++;
          if (ok === false && !dim) g.hidden++;
          groups.set(parent, g);
        }
        total++;
        if (ok !== false) shown++;
      }
      if (audio) for (const c of new Set(audio)) counts.set(c, (counts.get(c) || 0) + 1);
    }

    // Undo our classes on elements that are no longer cards (React reuses DOM nodes).
    for (const el of document.querySelectorAll(".cdub-hidden, .cdub-dimmed")) {
      const card = el.matches("[data-cdub-id]") ? el : el.querySelector("[data-cdub-id]");
      if (!card || !seenCards.has(card)) el.classList.remove("cdub-hidden", "cdub-dimmed");
    }

    const onBrowsePage = !!findNativeFilterTrigger();
    hideEmptyRows(onBrowsePage ? new Map() : groups, groupOf);

    const hiddenChanged = pageStats.shown !== shown || pageStats.total !== total;
    pageStats.total = total;
    pageStats.shown = shown;
    pageStats.counts = counts;
    ensureTriggers();
    ui.refresh();
    if (hiddenChanged && filterActive()) nudgeInfiniteScroll();
  }

  // When most cards get hidden the page gets short; poke the site's
  // infinite-scroll listeners so it loads the next batch.
  let nudgeTimer = 0;
  function nudgeInfiniteScroll() {
    clearTimeout(nudgeTimer);
    nudgeTimer = setTimeout(() => {
      window.dispatchEvent(new Event("scroll"));
      document.dispatchEvent(new Event("scroll"));
      window.dispatchEvent(new Event("resize"));
    }, 300);
  }

  let scanQueued = false;
  function scheduleScan(soon) {
    if (scanQueued) return;
    scanQueued = true;
    setTimeout(
      () => {
        scanQueued = false;
        // Our own DOM changes during the scan must not re-trigger the observer.
        observer.disconnect();
        try {
          scan();
        } finally {
          observe();
        }
      },
      soon ? 30 : 150
    );
  }

  const observer = new MutationObserver(() => scheduleScan(false));
  function observe() {
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["href"] });
    }
  }

  // ---------------------------------------------------------------- UI

  const ui = (() => {
    let host, root, els;
    let panelOpen = false;

    function h(tag, props, ...kids) {
      const el = document.createElement(tag);
      for (const k in props || {}) {
        if (k === "class") el.className = props[k];
        else if (k.startsWith("on")) el.addEventListener(k.slice(2), props[k]);
        else if (k === "text") el.textContent = props[k];
        else el.setAttribute(k, props[k]);
      }
      for (const kid of kids.flat()) if (kid != null) el.append(kid);
      return el;
    }

    function mount() {
      if (host && host.isConnected) return;
      if (!host) build();
      document.body.appendChild(host);
    }

    function build() {
      host = h("div", { id: "cdub-host" });
      root = host;
      els = {};
      els.fab = h("button", { class: "fab", title: "Dub language filter", onclick: () => toggle() });
      els.panel = h("div", { class: "panel", hidden: "" });
      root.append(els.fab, els.panel);
      buildPanel();
    }

    function buildPanel() {
      els.enabled = h("input", {
        type: "checkbox",
        onchange: (e) => update({ enabled: e.target.checked }),
      });
      els.modeAny = h("button", { class: "seg", onclick: () => update({ mode: "any" }), text: "Any" });
      els.modeAll = h("button", { class: "seg", onclick: () => update({ mode: "all" }), text: "All" });
      els.langs = h("div", { class: "langs" });
      els.status = h("div", { class: "status" });
      els.badges = h("input", { type: "checkbox", onchange: (e) => update({ badges: e.target.checked }) });
      els.remove = h("input", {
        type: "checkbox",
        class: "tg",
        role: "switch",
        onchange: (e) => update({ remove: e.target.checked }),
      });

      els.panel.append(
        h(
          "div",
          { class: "head" },
          h("strong", { text: "CrunchyDub" }),
          h("label", { class: "switch", title: "Turn filtering on/off" }, els.enabled, h("span", { text: "On" })),
          h("button", { class: "x", title: "Close", onclick: () => toggle(false), text: "×" })
        ),
        h(
          "div",
          { class: "row" },
          h("span", { class: "muted", text: "Show titles with" }),
          h("div", { class: "segs" }, els.modeAny, els.modeAll),
          h("span", { class: "muted", text: "of:" })
        ),
        h(
          "label",
          { class: "toggle", title: "Off: non-matching titles are greyed out. On: they're removed from the page." },
          els.remove,
          h("span", { class: "track" }),
          h("span", { text: "Remove non-matching titles" })
        ),
        els.langs,
        h(
          "div",
          { class: "row" },
          h("button", { class: "link", onclick: () => update({ langs: [] }), text: "Clear selection" })
        ),
        els.status,
        h("button", { class: "primary", onclick: () => catalog.open(), text: "Search the whole catalog…" }),
        h(
          "div",
          { class: "opts" },
          h("label", {}, els.badges, " Show dub badges on cards")
        )
      );
    }

    function update(patch) {
      settings = { ...settings, ...patch };
      saveSettings();
      refresh();
      scheduleScan(true);
      catalog.refresh();
    }

    function toggleLang(code, on) {
      const set = new Set(settings.langs);
      if (on) set.add(code);
      else set.delete(code);
      update({ langs: CDUB.sortLocales([...set]), enabled: true });
    }

    let anchorEl = null; // header button the panel is dropped down from, if any
    let inlineTrigger = false; // a "Dubs" button exists in the page header

    function setInlineTrigger(v) {
      inlineTrigger = v;
    }

    function toggle(force) {
      panelOpen = force === undefined ? !panelOpen : force;
      if (!panelOpen) anchorEl = null;
      refresh();
      ensureTriggers();
    }

    function toggleAt(el) {
      if (panelOpen && anchorEl === el) return toggle(false);
      anchorEl = el;
      panelOpen = true;
      refresh();
      ensureTriggers();
    }

    function isOpenAt(el) {
      return panelOpen && anchorEl === el;
    }

    /** Drop the panel down under the header button, or fall back to the corner above the floating button. */
    function position() {
      const p = els.panel;
      const r = anchorEl && anchorEl.isConnected ? anchorEl.getBoundingClientRect() : null;
      if (!r || r.bottom < 0 || r.top > window.innerHeight) {
        p.classList.remove("anchored");
        p.style.top = p.style.left = p.style.maxHeight = "";
        return;
      }
      p.classList.add("anchored");
      const width = p.offsetWidth || 340;
      const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
      const top = r.bottom + 6;
      p.style.top = `${top}px`;
      p.style.left = `${left}px`;
      p.style.maxHeight = `${Math.max(240, window.innerHeight - top - 16)}px`;
    }

    window.addEventListener("scroll", () => panelOpen && anchorEl && position(), { passive: true });
    window.addEventListener("resize", () => panelOpen && position());

    // Click outside closes the panel, like Crunchyroll's own dropdowns.
    document.addEventListener(
      "mousedown",
      (e) => {
        if (!panelOpen || catalog.isOpen()) return;
        const t = e.target;
        if ((host && host.contains(t)) || (t.closest && t.closest("[data-cdub-trigger]"))) return;
        toggle(false);
      },
      true
    );

    function langOptions() {
      const codes = new Set([...CDUB.ORDER.filter((c) => !["es-LA", "ar-ME", "cmn-CN"].includes(c))]);
      for (const c of pageStats.counts.keys()) codes.add(c);
      for (const c of settings.langs) codes.add(c);
      return CDUB.sortLocales([...codes]);
    }

    function refresh() {
      if (!ready || !document.body) return;
      const hasCards = pageStats.total > 0;
      const show = hasCards || panelOpen || catalog.isOpen();
      if (!show) {
        if (host) host.remove();
        return;
      }
      mount();

      const active = filterActive();
      els.fab.textContent = "";
      els.fab.append(
        h("span", { class: "fab-icon", text: "🎙" }),
        h("span", {
          text: active
            ? `${settings.langs.map(CDUB.label).join(settings.mode === "all" ? " + " : " / ")}`
            : "Dubs",
        })
      );
      if (active && hasCards) els.fab.append(h("span", { class: "fab-count", text: `${pageStats.shown}/${pageStats.total}` }));
      els.fab.classList.toggle("on", active);
      els.fab.hidden = inlineTrigger;

      if (panelOpen) els.panel.removeAttribute("hidden");
      else els.panel.setAttribute("hidden", "");
      if (!panelOpen) return;
      position();

      els.enabled.checked = settings.enabled;
      els.badges.checked = settings.badges;
      els.remove.checked = settings.remove;
      els.modeAny.classList.toggle("sel", settings.mode === "any");
      els.modeAll.classList.toggle("sel", settings.mode === "all");

      const opts = langOptions();
      const sig = opts.join(",") + "|" + settings.langs.join(",") + "|" + [...pageStats.counts].join(";");
      if (els.langs.dataset.sig !== sig) {
        els.langs.dataset.sig = sig;
        const keepScroll = els.langs.scrollTop;
        els.langs.textContent = "";
        for (const code of opts) {
          const cb = h("input", { type: "checkbox", onchange: (e) => toggleLang(code, e.target.checked) });
          cb.checked = settings.langs.includes(code);
          const n = pageStats.counts.get(code) || 0;
          els.langs.append(
            h(
              "label",
              { class: "lang" + (cb.checked ? " sel" : "") + (n ? "" : " zero"), title: code },
              cb,
              h("span", { class: "code", text: CDUB.label(code) }),
              h("span", { class: "name", text: CDUB.name(code) }),
              h("span", { class: "n", text: n ? String(n) : "" })
            )
          );
        }
        els.langs.scrollTop = keepScroll;
      }

      const loading = pageStats.total - [...document.querySelectorAll("[data-cdub-id]")].filter((c) => known.has(c.dataset.cdubId)).length;
      let status = hasCards
        ? active
          ? `${pageStats.shown} of ${pageStats.total} titles on this page match; the rest are ${settings.remove ? "removed" : "greyed out"}.`
          : `${pageStats.total} titles on this page. Pick languages to filter.`
        : "No series cards on this page.";
      if (loading > 0) status += ` Loading dubs for ${loading}…`;
      if (active && hasCards && settings.remove) status += " Scroll down to load more.";
      els.status.textContent = status;
    }

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && panelOpen && !catalog.isOpen()) toggle(false);
    });

    return { refresh, toggle, toggleAt, isOpenAt, setInlineTrigger, h, mount, root: () => root, update, toggleLang, langOptions };
  })();

  // ------------------------------------------------------- catalog overlay

  const catalog = (() => {
    let el = null;
    let parts = null;
    let items = null; // full catalog
    let query = "";
    let sortBy = "alpha";
    let limit = 120;
    let loadingPromise = null;

    function isOpen() {
      return !!(el && el.isConnected && !el.hidden);
    }

    async function load(force) {
      if (!force) {
        const res = await browser.storage.local.get(CATALOG_KEY).catch(() => ({}));
        const c = res[CATALOG_KEY];
        if (c && Date.now() - c.at < CATALOG_TTL && Array.isArray(c.items) && c.items.length) {
          return c;
        }
      }
      const all = new Map();
      let start = 0;
      let total = Infinity;
      const n = 100;
      while (start < total) {
        setStatus(`Loading catalog… ${all.size}${isFinite(total) ? " / " + total : ""}`);
        const json = await api(`/content/v2/discover/browse?n=${n}&start=${start}&sort_by=alphabetical&ratings=false`);
        total = typeof json.total === "number" ? json.total : 0;
        const page = CDUB.extractItems(json);
        for (const it of page) all.set(it.id, it);
        const got = Array.isArray(json.data) ? json.data.length : 0;
        if (!got) break;
        start += got;
        if (start > 20000) break; // safety
      }
      const list = [...all.values()];
      const c = { at: Date.now(), items: list };
      browser.storage.local.set({ [CATALOG_KEY]: c }).catch(() => {});
      addItems(list);
      return c;
    }

    function setStatus(text) {
      if (parts) parts.status.textContent = text;
    }

    function build() {
      const h = ui.h;
      parts = {};
      parts.search = h("input", {
        type: "search",
        placeholder: "Search titles…",
        oninput: (e) => {
          query = e.target.value.trim().toLowerCase();
          limit = 120;
          render();
        },
      });
      parts.sort = h(
        "select",
        {
          onchange: (e) => {
            sortBy = e.target.value;
            render();
          },
        },
        h("option", { value: "alpha", text: "A–Z" }),
        h("option", { value: "dubs", text: "Most dubs" })
      );
      parts.chips = h("div", { class: "chips" });
      parts.status = h("div", { class: "cstatus" });
      parts.grid = h("div", { class: "grid" });
      parts.more = h("button", {
        class: "more",
        onclick: () => {
          limit += 240;
          render();
        },
        text: "Show more",
      });
      el = h(
        "div",
        { class: "overlay", onclick: (e) => e.target === el && close() },
        h(
          "div",
          { class: "sheet" },
          h(
            "div",
            { class: "chead" },
            h("strong", { text: "CrunchyDub catalog search" }),
            parts.search,
            parts.sort,
            h("button", { class: "link", title: "Re-download the catalog", onclick: () => reload(true), text: "Refresh" }),
            h("button", { class: "x", title: "Close", onclick: close, text: "×" })
          ),
          parts.chips,
          parts.status,
          parts.grid,
          parts.more
        )
      );
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && isOpen()) close();
      });
    }

    function open() {
      if (!el) build();
      ui.mount();
      ui.root().appendChild(el);
      el.hidden = false;
      document.documentElement.classList.add("cdub-noscroll");
      ui.toggle(false);
      render();
      parts.search.focus();
      if (!items) reload(false);
    }

    function close() {
      if (!el) return;
      el.hidden = true;
      document.documentElement.classList.remove("cdub-noscroll");
      ui.refresh();
    }

    async function reload(force) {
      if (loadingPromise) return loadingPromise;
      items = null;
      render();
      loadingPromise = load(force)
        .then((c) => {
          items = c.items;
        })
        .catch((err) => {
          setStatus(
            `Couldn't load the catalog (${err.message}). Try scrolling a Crunchyroll page so it refreshes its session, then press Refresh.`
          );
        })
        .finally(() => {
          loadingPromise = null;
          render();
        });
      return loadingPromise;
    }

    function refresh() {
      if (isOpen()) render();
    }

    function render() {
      if (!parts) return;
      const h = ui.h;

      // language chips (same selection as the panel)
      parts.chips.textContent = "";
      const counts = new Map();
      if (items) for (const it of items) for (const c of new Set(it.audio)) counts.set(c, (counts.get(c) || 0) + 1);
      const codes = CDUB.sortLocales([...new Set([...ui.langOptions(), ...counts.keys()])]).filter(
        (c) => counts.get(c) || settings.langs.includes(c) || !items
      );
      for (const code of codes) {
        const on = settings.langs.includes(code);
        parts.chips.append(
          h(
            "button",
            {
              class: "chip" + (on ? " sel" : ""),
              title: CDUB.name(code),
              onclick: () => ui.toggleLang(code, !on),
            },
            CDUB.name(code),
            counts.get(code) ? h("span", { class: "n", text: String(counts.get(code)) }) : null
          )
        );
      }
      parts.chips.append(
        h(
          "span",
          { class: "segs" },
          h("button", { class: "seg" + (settings.mode === "any" ? " sel" : ""), onclick: () => ui.update({ mode: "any" }), text: "Any" }),
          h("button", { class: "seg" + (settings.mode === "all" ? " sel" : ""), onclick: () => ui.update({ mode: "all" }), text: "All" })
        )
      );

      parts.grid.textContent = "";
      if (!items) {
        parts.more.hidden = true;
        return;
      }

      const langs = settings.enabled ? settings.langs : [];
      let list = items.filter((it) => {
        if (query && !it.title.toLowerCase().includes(query)) return false;
        if (!langs.length) return true;
        return settings.mode === "all" ? langs.every((l) => it.audio.includes(l)) : langs.some((l) => it.audio.includes(l));
      });
      const byTitle = (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" });
      if (sortBy === "dubs") list = list.slice().sort((a, b) => b.audio.length - a.audio.length || byTitle(a, b));
      else list = list.slice().sort(byTitle);

      setStatus(
        `${list.length} of ${items.length} titles` +
          (langs.length ? ` with ${settings.mode === "all" ? "all" : "any"} of: ${langs.map(CDUB.name).join(", ")}` : "")
      );

      for (const it of list.slice(0, limit)) {
        const href =
          it.type === "series"
            ? `/series/${it.id}/${it.slug || ""}`
            : `/search?q=${encodeURIComponent(it.title)}`;
        const badges = h("div", { class: "cbadges" });
        for (const code of CDUB.sortLocales(it.audio, settings.langs)) {
          badges.append(
            h("span", {
              class: "badge" + (settings.langs.includes(code) ? " hit" : "") + (CDUB.ORIGINAL.has(code) ? " orig" : ""),
              title: CDUB.name(code),
              text: CDUB.label(code),
            })
          );
        }
        parts.grid.append(
          h(
            "a",
            { class: "tile", href },
            it.poster ? h("img", { src: it.poster, loading: "lazy", alt: "" }) : h("div", { class: "noimg" }),
            h("div", { class: "title", text: it.title || it.id }),
            badges
          )
        );
      }
      parts.more.hidden = list.length <= limit;
    }

    return { open, close, isOpen, refresh };
  })();

  // ---------------------------------------------------------------- start

  function start() {
    ready = true;
    observe();
    scheduleScan(true);
  }

  Promise.all([
    storageLoaded,
    new Promise((r) => {
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", r, { once: true });
      else r();
    }),
  ]).then(start);
})();
