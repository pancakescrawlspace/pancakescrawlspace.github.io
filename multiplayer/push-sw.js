// The multiplayer layer's part of a game's service worker: shows the notification when the room
// says it's this player's turn, and opens the game at that room when it is tapped. The game gives
// the words; the push carries only {game, room, turn, by, kind}, where kind is "turn", "started"
// or "over", and by is the name of whoever moved, or joined, if they gave one.
//
//   importScripts("../multiplayer/push-sw.js");
//   tellTurns({
//     name: {nl: "Vier op een rij", en: "Four in a Row"},
//     icon: "icon-192.png",
//     nl: {someone: "Je tegenstander", turn: by => `${by} heeft gezet.`, started: by => ..., over: by => ...},
//     en: {...},
//   });
//
// The language is the one the page last wrote with client.js's setPushLanguage, or else the
// first one given. Browsers want a notification for every push, and Safari stops delivering to
// a site that skips them, so this never stays silent. See docs/architecture.md.
"use strict";

// `scope` is the service worker's global, or the tests' stand-in for it.
self.tellTurns = function tellTurns(words, scope = self) {
  const languages = Object.keys(words).filter(key => key !== "name" && key !== "icon");
  const addressOf = room => new URL(`./?room=${encodeURIComponent(room)}`, scope.registration.scope).href;

  async function language() {
    try {
      const kept = await (await scope.caches.open("multiplayer-push")).match(new URL("push-language", scope.registration.scope).href);
      const lang = kept && await kept.text();
      if (languages.includes(lang)) return lang;
    } catch {}
    return languages[0];
  }

  async function show(push) {
    const lang = await language(), say = words[lang];
    const title = typeof words.name === "string" ? words.name : words.name[lang];
    if (!push?.room) return scope.registration.showNotification(title, {icon: words.icon});
    const by = push.by || say.someone;
    const body = (say[push.kind] ?? say.turn)(by);
    return scope.registration.showNotification(title, {
      body,
      icon: words.icon,
      tag: push.room,                      // one notification per game: a newer one replaces it
      renotify: true,
      data: {url: addressOf(push.room), room: push.room},
    });
  }

  scope.addEventListener("push", event => {
    let push = null;
    try { push = event.data?.json(); } catch {}
    event.waitUntil(show(push));
  });

  // A window already showing that game comes forward; or else a window of this game goes to it;
  // or else one is opened.
  scope.addEventListener("notificationclick", event => {
    event.notification.close();
    const {url, room} = event.notification.data ?? {};
    if (!url) return;
    event.waitUntil((async () => {
      const windows = await scope.clients.matchAll({type: "window", includeUncontrolled: true});
      const showing = windows.find(client => new URL(client.url).searchParams.get("room") === room);
      if (showing) return showing.focus();
      const other = windows.find(client => client.url.startsWith(scope.registration.scope));
      if (other) {
        const moved = await other.navigate(url).catch(() => null);
        if (moved) return moved.focus();
      }
      return scope.clients.openWindow(url);
    })());
  });
};
