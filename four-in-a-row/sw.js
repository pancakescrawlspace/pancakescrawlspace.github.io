// Four in a Row's service worker. It keeps the page, so the game also works
// offline once it has been opened, and browsers offer to install it as an app.
//
// The page comes from the network whenever there is one, so a new version
// shows up without changing anything here. Raise PAGE_CACHE's number only
// when the list of PAGE files changes.
"use strict";

const PAGE_CACHE = "connect4-page-1";
const PAGE = ["./", "index.html", "rules.js", "ai.js", "room.js", "worker.js", "manifest.webmanifest", "icon.svg",
              "icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png"];

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    await (await caches.open(PAGE_CACHE)).addAll(PAGE);
    await self.skipWaiting();
  })());
});

// Drop the caches of older versions, and look after the open page at once.
self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith("connect4-") && name !== PAGE_CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

// The page: from the network and kept, or else the kept one. The settings in
// the URL don't make it another page.
self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET" || !request.url.startsWith(self.registration.scope)) return;
  const url = new URL(request.url);
  url.search = "";
  event.respondWith(caches.open(PAGE_CACHE).then(async cache => {
    try {
      const response = await fetch(request);
      if (response.ok) await cache.put(url, response.clone());
      return response;
    } catch (e) {
      return await cache.match(url) ?? Response.error();
    }
  }));
});
