"use strict";

/* Code shared by the background and content scripts. */

// Chrome only has `chrome.*`; its MV3 APIs return promises just like Firefox's `browser.*`.
if (typeof globalThis.browser === "undefined" && typeof globalThis.chrome !== "undefined") {
  globalThis.browser = globalThis.chrome;
}

var CDUB = (() => {
  // Short badge label + full name for the audio locales Crunchyroll uses.
  const LANGS = {
    "en-US": ["EN", "English"],
    "en-IN": ["EN-IN", "English (India)"],
    "es-419": ["ES-LA", "Spanish (Latin America)"],
    "es-ES": ["ES-ES", "Spanish (Spain)"],
    "es-LA": ["ES-LA", "Spanish (Latin America)"],
    "pt-BR": ["PT-BR", "Portuguese (Brazil)"],
    "pt-PT": ["PT-PT", "Portuguese (Portugal)"],
    "fr-FR": ["FR", "French"],
    "de-DE": ["DE", "German"],
    "it-IT": ["IT", "Italian"],
    "ru-RU": ["RU", "Russian"],
    "pl-PL": ["PL", "Polish"],
    "ar-SA": ["AR", "Arabic"],
    "ar-ME": ["AR", "Arabic"],
    "hi-IN": ["HI", "Hindi"],
    "ta-IN": ["TA", "Tamil"],
    "te-IN": ["TE", "Telugu"],
    "kn-IN": ["KN", "Kannada"],
    "ml-IN": ["ML", "Malayalam"],
    "bn-IN": ["BN", "Bengali"],
    "mr-IN": ["MR", "Marathi"],
    "tr-TR": ["TR", "Turkish"],
    "ca-ES": ["CA", "Catalan"],
    "th-TH": ["TH", "Thai"],
    "vi-VN": ["VI", "Vietnamese"],
    "id-ID": ["ID", "Indonesian"],
    "ms-MY": ["MS", "Malay"],
    "tl-PH": ["TL", "Tagalog"],
    "zh-CN": ["ZH", "Chinese (Mandarin)"],
    "cmn-CN": ["ZH", "Chinese (Mandarin)"],
    "zh-TW": ["ZH-TW", "Chinese (Taiwan)"],
    "zh-HK": ["YUE", "Cantonese"],
    "ko-KR": ["KO", "Korean"],
    "ja-JP": ["JA", "Japanese"],
  };

  // Display order for badges and the language list.
  const ORDER = Object.keys(LANGS);

  // Locales that are usually the original audio rather than a dub.
  const ORIGINAL = new Set(["ja-JP", "zh-CN", "cmn-CN", "zh-TW", "zh-HK", "ko-KR"]);

  let displayNames = null;
  try {
    displayNames = new Intl.DisplayNames(["en"], { type: "language" });
  } catch (_) {}

  function label(code) {
    if (LANGS[code]) return LANGS[code][0];
    return String(code).toUpperCase();
  }

  function name(code) {
    if (LANGS[code]) return LANGS[code][1];
    try {
      if (displayNames) return displayNames.of(code) || code;
    } catch (_) {}
    return code;
  }

  function sortLocales(list, preferred) {
    const pref = preferred || [];
    const rank = (c) => {
      const p = pref.indexOf(c);
      if (p !== -1) return p - 1000;
      const o = ORDER.indexOf(c);
      return o === -1 ? 500 : o;
    };
    return [...new Set(list)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  }

  /** Walk any Crunchyroll API response and pull out every series/movie that lists its audio locales. */
  function extractItems(root) {
    const out = [];
    const seen = new Set();
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== "object") continue;
      if (Array.isArray(node)) {
        for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]);
        continue;
      }
      const item = toItem(node);
      if (item && !seen.has(item.id)) {
        seen.add(item.id);
        out.push(item);
      }
      for (const k in node) {
        const v = node[k];
        if (v && typeof v === "object") stack.push(v);
      }
    }
    return out;
  }

  function toItem(o) {
    if (typeof o.id !== "string") return null;
    const type = o.type;
    if (type !== "series" && type !== "movie_listing") return null;
    const meta = o.series_metadata || o.movie_listing_metadata || o;
    if (!Array.isArray(meta.audio_locales)) return null;
    return {
      id: o.id,
      type,
      title: o.title || "",
      slug: o.slug_title || "",
      audio: meta.audio_locales.filter((x) => typeof x === "string" && /^[a-z]{2,3}(-[A-Za-z0-9]+)*$/.test(x)),
      poster: pickPoster(o.images),
    };
  }

  function pickPoster(images) {
    try {
      const list = images.poster_tall[0];
      const p = list.find((x) => x.width >= 240) || list[list.length - 1];
      return p.source || "";
    } catch (_) {
      return "";
    }
  }

  return { LANGS, ORDER, ORIGINAL, label, name, sortLocales, extractItems };
})();
