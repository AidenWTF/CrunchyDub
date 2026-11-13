"use strict";

/*
 * Background script (Firefox: background page, Chrome: service worker).
 *
 * 1. Remembers the Authorization header Crunchyroll's own web app sends to its
 *    API, so the content script can look up series the page didn't load itself.
 * 2. Firefox only: reads (without modifying) the JSON the page receives from
 *    /content/v2/* and extracts the audio locales of every series in it, so most
 *    cards get their dub badges without any extra request. Chrome has no
 *    filterResponseData, so there the content script looks every card up.
 */

if (typeof importScripts === "function" && typeof CDUB === "undefined") importScripts("shared.js");

const API_URLS = ["https://www.crunchyroll.com/content/v2/*"];

let auth = { header: null, at: 0, locale: null };
const known = new Map(); // id -> item (see CDUB.extractItems)
const MAX_KNOWN = 5000;

// Chrome may stop the service worker at any time, so keep the token in session storage too.
const session = browser.storage && browser.storage.session;
const authLoaded = session
  ? session
      .get("auth")
      .then((r) => {
        if (r && r.auth && r.auth.at > auth.at) auth = r.auth;
      })
      .catch(() => {})
  : Promise.resolve();

browser.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (details.tabId < 0) return; // ignore requests that don't come from a tab
    const h = (details.requestHeaders || []).find((x) => x.name.toLowerCase() === "authorization");
    const next = { ...auth };
    if (h && /^Bearer\s/i.test(h.value)) {
      next.header = h.value;
      next.at = Date.now();
    }
    try {
      const loc = new URL(details.url).searchParams.get("locale");
      if (loc) next.locale = loc;
    } catch (_) {}
    if (next.header !== auth.header || next.locale !== auth.locale) {
      auth = next;
      if (session) session.set({ auth }).catch(() => {});
    }
  },
  { urls: API_URLS },
  ["requestHeaders"]
);

if (browser.webRequest.filterResponseData) {
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
        try {
          filter.disconnect();
        } catch (_) {}
      };
    },
    { urls: API_URLS, types: ["xmlhttprequest"] },
    ["blocking"]
  );
}

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

async function handleMessage(msg) {
  if (msg.type === "cdub-get-auth") {
    await authLoaded;
    return { header: auth.header, at: auth.at, locale: auth.locale };
  }
  if (msg.type === "cdub-get-known") {
    return { items: [...known.values()] };
  }
  if (msg.type === "cdub-remember" && Array.isArray(msg.items)) {
    for (const it of msg.items) if (it && typeof it.id === "string") remember(it);
    return true;
  }
  return undefined;
}

// sendResponse + `return true` works in both Firefox and Chrome.
browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return false;
  handleMessage(msg).then(sendResponse, () => sendResponse(undefined));
  return true;
});
