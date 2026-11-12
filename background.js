"use strict";

/*
 * Background script.
 *
 * 1. Remembers the Authorization header Crunchyroll's own web app sends to its
 *    API, so the content script can look up series the page didn't load itself.
 * 2. Reads (without modifying) the JSON the page receives from
 *    /content/v2/* and extracts the audio locales of every series/movie in it,
 *    so most cards get their dub badges without any extra request.
 */

const API_URLS = ["https://www.crunchyroll.com/content/v2/*"];

let auth = { header: null, at: 0, locale: null };
const known = new Map(); // id -> item (see extractItems)
const MAX_KNOWN = 5000;

browser.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (details.tabId < 0) return; // ignore our own / other non-tab requests
    const h = details.requestHeaders.find((x) => x.name.toLowerCase() === "authorization");
    if (h && /^Bearer\s/i.test(h.value)) {
      auth.header = h.value;
      auth.at = Date.now();
    }
    try {
      const loc = new URL(details.url).searchParams.get("locale");
      if (loc) auth.locale = loc;
    } catch (_) {}
  },
  { urls: API_URLS },
  ["requestHeaders"]
);

browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.method !== "GET" || details.tabId < 0) return;
    let filter;
    try {
      filter = browser.webRequest.filterResponseData(details.requestId);
    } catch (_) {
      return;
    }
    const chunks = [];
    filter.ondata = (e) => {
      chunks.push(e.data);
      filter.write(e.data); // pass through untouched
    };
    filter.onstop = () => {
      filter.close();
      handleBody(details.tabId, chunks);
    };
    filter.onerror = () => {
      try { filter.disconnect(); } catch (_) {}
    };
  },
  { urls: API_URLS, types: ["xmlhttprequest"] },
  ["blocking"]
);

function handleBody(tabId, chunks) {
  let text = "";
  try {
    const dec = new TextDecoder("utf-8");
    for (const c of chunks) text += dec.decode(c, { stream: true });
    text += dec.decode();
  } catch (_) {
    return;
  }
  if (!text.includes("audio_locales")) return;
  let json;
  try {
    json = JSON.parse(text);
  } catch (_) {
    return;
  }
  const items = CDUB.extractItems(json);
  if (!items.length) return;
  for (const it of items) remember(it);
  browser.tabs.sendMessage(tabId, { type: "cdub-items", items }).catch(() => {});
}

function remember(it) {
  known.delete(it.id);
  known.set(it.id, it);
  if (known.size > MAX_KNOWN) known.delete(known.keys().next().value);
}

browser.runtime.onMessage.addListener((msg) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "cdub-get-auth") {
    return Promise.resolve({ header: auth.header, at: auth.at, locale: auth.locale });
  }
  if (msg.type === "cdub-get-known") {
    return Promise.resolve({ items: [...known.values()] });
  }
  if (msg.type === "cdub-remember" && Array.isArray(msg.items)) {
    for (const it of msg.items) if (it && typeof it.id === "string") remember(it);
    return Promise.resolve(true);
  }
});
