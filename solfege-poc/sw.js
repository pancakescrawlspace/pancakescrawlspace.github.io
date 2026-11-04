// Keeps the app's files, so the page opens without a network, and browsers offer to install it.
// Each file comes from the network if it can, and otherwise from what's kept. Raise the number
// in CACHE only when the list of PAGE files changes.
"use strict";

const CACHE = "poc-page-1";
const PAGE = ["./", "index.html", "app.js", "texts.js", "sound.js", "round.js", "music.js", "room.js", "project.js",
              "manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png"];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(PAGE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(self.clients.claim());
});

// Requests outside this folder, such as Firebase's, pass straight through.
self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET" || !request.url.startsWith(self.registration.scope)) return;
  const url = new URL(request.url);
  url.search = "";
  event.respondWith(caches.open(CACHE).then(async cache => {
    try {
      const response = await fetch(request);
      if (response.ok) await cache.put(url, response.clone());
      return response;
    } catch {
      return await cache.match(url) ?? Response.error();
    }
  }));
});
