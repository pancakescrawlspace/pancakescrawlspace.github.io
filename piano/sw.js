// The piano's service worker. It keeps the page and all 88 piano samples, so
// the piano also works offline once it has been opened, and browsers offer to
// install it as an app.
//
// The page comes from the network whenever there is one, so a new version
// shows up without changing anything here. Raise PAGE_CACHE's number only
// when the list of PAGE files changes.
"use strict";

const PAGE_CACHE = "piano-page-1";
const SAMPLE_CACHE = "piano-samples-1";     // the samples never change, so a new page keeps them
const PAGE = ["./", "index.html", "manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png",
              "icon-maskable-512.png", "apple-touch-icon.png"];
const SAMPLES = "https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM/acoustic_grand_piano-mp3/";
const PIANO = [21, 108];                   // A0 .. C8
const FLATS = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];

const sampleUrl = midi => `${SAMPLES}${FLATS[midi % 12]}${Math.floor(midi / 12) - 1}.mp3`;

async function fetchAndKeep(cache, request) {
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

// The page must all be kept; the samples, about 2 MB, as many as can be had.
// One that fails now is kept when it is first played.
self.addEventListener("install", event => {
  event.waitUntil((async () => {
    await (await caches.open(PAGE_CACHE)).addAll(PAGE);
    const samples = await caches.open(SAMPLE_CACHE);
    await Promise.allSettled(Array.from({length: PIANO[1] - PIANO[0] + 1}, async (_, i) => {
      const url = sampleUrl(PIANO[0] + i);
      if (!await samples.match(url)) await fetchAndKeep(samples, url);
    }));
    await self.skipWaiting();
  })());
});

// Drop the caches of older versions, and look after the open page at once.
self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith("piano-") && name !== PAGE_CACHE && name !== SAMPLE_CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  if (request.url.startsWith(SAMPLES)) {
    // Samples: the kept one, or else from the network and kept.
    event.respondWith(caches.open(SAMPLE_CACHE).then(async cache =>
      await cache.match(request, {ignoreVary: true}) ?? fetchAndKeep(cache, request)));
  } else if (request.url.startsWith(self.registration.scope)) {
    // The page: from the network and kept, or else the kept one. The settings
    // in the URL (?octaves=6) don't make it another page.
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
  }
});
