// A room: the shared record of a game, and the only way the page changes it.
//
// This one is local: it lives in this browser, for playing against the
// computer players. It is Four in a Row's, until both can use the layer's. It has
// the same interface as a room of the planned multiplayer layer
// (see "Its interface for games" in docs/tile-rummy-multiplayer-plan.md), and
// behaves like one: changes come back later through watch(), never directly,
// and everything passes through JSON, as it would over a network. So the page
// can't come to depend on anything an online room couldn't do.
//
//   record = {seats, current, turn, state}
//
// `seats` says who sits where: {kind: "person"} or {kind: "computer", level}.
// `current` is the seat that may write next, and `turn` counts the writes. The
// room knows nothing of the game: `state` is an opaque value to it.
"use strict";

class RoomRefusal extends Error {
  constructor(code) {
    super(`the room refused this: ${code}`);
    this.code = code;
  }
}

// `keep` is called with every new record, to store it. `latest` may give the newest
// stored record, which another tab can have written: a write made without having
// seen it is refused as stale. `delay` holds back every write and update by that
// many milliseconds; the tests use it to act like a network.
function createLocalRoom({record, keep = () => {}, latest = () => null, delay = 0}) {
  const copy = value => JSON.parse(JSON.stringify(value));
  const later = () => new Promise(resolve => delay ? setTimeout(resolve, delay) : queueMicrotask(resolve));
  let shared = copy(record);
  const views = new Set();

  function publish() {
    keep(copy(shared));
    const news = JSON.stringify(shared);
    for (const view of views) later().then(() => view.receive(JSON.parse(news)));
  }

  // One player's view of the room: what one browser would have.
  function viewFor(seat) {
    let seen = shared.turn;
    const watchers = new Set();
    const view = {
      receive(news) {
        seen = news.turn;
        for (const watcher of watchers) watcher(news);
      },
    };
    views.add(view);
    return {
      mySeat: seat,

      // Calls `watcher` with the record, now and after every change. Returns
      // the function that stops it.
      watch(watcher) {
        watchers.add(watcher);
        const now = copy(shared);
        later().then(() => { if (watchers.has(watcher)) { seen = Math.max(seen, now.turn); watcher(now); } });
        return () => watchers.delete(watcher);
      },

      // Writes the record after a turn. Refused if it isn't this seat's turn,
      // or if this view hasn't yet seen the latest record. {forSeat} plays
      // for a computer player's seat, which any member may do.
      async play({state, current}, {forSeat} = {}) {
        await later();
        const writer = forSeat ?? seat;
        const newest = latest();
        if (newest && newest.turn > shared.turn) shared = copy(newest);
        if (forSeat !== undefined && shared.seats[forSeat]?.kind !== "computer") throw new RoomRefusal("not-a-computer-seat");
        if (seen !== shared.turn) throw new RoomRefusal("stale");
        if (writer !== shared.current) throw new RoomRefusal("out-of-turn");
        shared = copy({...shared, state, current, turn: shared.turn + 1, restarted: false});
        publish();
      },

      // Local only, and not part of an online room: takes over a record from
      // elsewhere as it is. For another tab's change, and the tests' set-ups.
      adopt(news) {
        shared = copy(news);
        seen = shared.turn;
        return copy(shared);
      },

      // Another player's view of the same room. The tests use it as a second browser.
      as: viewFor,
    };
  }
  return viewFor;
}
