// Sessions and rooms over WebRTC. This is the only file that knows WebRTC, and it knows nothing
// of what's in the exercise: the record is the page's, and so is `check`, which says whether a
// write is allowed. See ARCHITECTURE.md, sections 3, 5 and 10.
//
// The creator's browser takes the role of a server: it holds the record, and decides on every
// write. A browser never changes its own screen after a write: watch() is the only way news
// comes in, also for your own writes.
import {signal} from "./signal.js";

const RELAY = "https://ntfy.sh", TEST_RELAY = "http://127.0.0.1:8899";
const STUN = [{urls: "stun:stun.cloudflare.com:3478"}];
const LETTERS = "abcdefghijklmnopqrstuvwxyz234567";
const GATHER_WAIT = 3000, LOCK_WAIT = 1500, WRITE_WAIT = 8000, DOUBT_WAIT = 2000;

const randomText = length => Array.from(crypto.getRandomValues(new Uint8Array(length)), byte => LETTERS[byte % 32]).join("");
const later = ms => new Promise(resolve => setTimeout(resolve, ms));

// A refusal has a code: stale, refused, not-a-member, seat-taken, open-elsewhere, no-route or offline.
export class Refusal extends Error {
  constructor(code) {
    super(`refused: ${code}`);
    this.code = code;
  }
}

// Each browser describes itself once, with all its addresses, rather than sending them one by one.
function gathered(pc) {
  const complete = new Promise(resolve => {
    const look = () => { if (pc.iceGatheringState === "complete") resolve(); };
    pc.addEventListener("icegatheringstatechange", look);
    look();
  });
  return Promise.race([complete, later(GATHER_WAIT)]);
}

// {test} uses the stand-in relay, and never a real one. {session} is a browser of its own, for
// the tests, which can also shorten the waits. {noRoute} behaves like a network that allows no
// direct connection.
export async function connect({
  test = false, session = "main", check, page = location.origin + location.pathname, relay = test ? TEST_RELAY : RELAY,
  iceServers = test ? [] : STUN, noRoute = false, routeWait = test ? 5000 : 20000, relayWait = test ? 1500 : 8000,
} = {}) {
  const prefix = test ? `solfege-webrtc.test.${session}.` : "solfege-webrtc.";
  const relayRetry = test ? 300 : 10000;
  const place = id => `${prefix}room.${id}`;
  const load = id => { try { return JSON.parse(localStorage.getItem(place(id))); } catch { return null; } };
  const save = (id, state) => { try { localStorage.setItem(place(id), JSON.stringify(state)); } catch (error) { console.warn(error); } };
  const rooms = new Set();

  // One tab per room, or two would fight over one seat. It waits a moment, since a page that's
  // being reloaded takes a moment to let go.
  async function hold(id) {
    if (!navigator.locks) return () => {};
    let release;
    const held = new Promise(resolve => { release = resolve; });
    return new Promise((resolve, reject) => {
      navigator.locks.request(`${prefix}lock.${id}`, {signal: AbortSignal.timeout(LOCK_WAIT)}, () => { resolve(release); return held; })
        .catch(() => reject(new Refusal("open-elsewhere")));
    });
  }

  async function roomFor(id, state, release) {
    const iCreated = state.mySeat === 0;
    const introductions = await signal(relay, state.key, {retry: relayRetry});
    let me = randomText(8);      // this connection's name, new each time one is lost
    let peer = null;             // the attempt that has become the connection
    let closed = false, blocked = false, writes = 0;
    const attempts = new Map(), waiting = new Map(), watchers = new Set();
    let joining = null, relayReady = null;
    const relayIsReady = new Promise(resolve => { relayReady = resolve; });

    const view = () => structuredClone({seats: state.seats, record: state.record});
    const deliver = () => {
      if (!state.record) return;
      for (const watcher of watchers) watcher(view());
    };
    const tell = (attempt, message) => {
      if (attempt?.channel?.readyState === "open") attempt.channel.send(JSON.stringify(message));
    };
    const say = message => {
      if (!blocked && !closed) introductions.send({...message, from: me, creator: iCreated}).catch(error => console.warn(error));
    };
    const sayHere = () => say({kind: "here"});

    const room = {
      id,
      mySeat: state.mySeat,
      iCreated,
      inviteLink: null,
      present: [state.mySeat],
      noRoute: false,
      onConnection: () => {},
      onPresence: () => {},
      onRoute: () => {},

      // Calls `watcher` with {seats, record}, soon, and after every change. Returns the function
      // that stops it.
      watch(watcher) {
        watchers.add(watcher);
        Promise.resolve().then(() => {
          if (!watchers.has(watcher)) return;
          room.onConnection(iCreated || Boolean(peer));
          if (state.record) watcher(view());
        });
        return () => {
          watchers.delete(watcher);
          if (!watchers.size) room.close();
        };
      },

      // Writes the next record, if the record is still the one before it. Nothing shows until
      // the creator's browser has it, which for the creator means a moment later.
      async write(next) {
        await null;
        if (iCreated) return accept(next, 0);
        if (!peer) throw new Refusal("offline");
        const n = ++writes;
        tell(peer, {kind: "write", n, record: next});
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => { waiting.delete(n); reject(new Refusal("offline")); }, WRITE_WAIT);
          waiting.set(n, code => {
            clearTimeout(timer);
            waiting.delete(n);
            if (code) reject(new Refusal(code));
            else resolve();
          });
        });
      },

      close() {
        if (closed) return;
        closed = true;
        rooms.delete(room);
        removeEventListener("pagehide", room.close);
        removeEventListener("online", wake);
        document.removeEventListener("visibilitychange", wake);
        introductions.close();
        for (const attempt of [...attempts.values(), peer]) if (attempt) hangUp(attempt);
        peer = null;
        for (const finish of [...waiting.values()]) finish("offline");
        joining?.reject(new Refusal("offline"));
        release();
      },

      test: {
        // Cut off from everything, and back again.
        cut(off) {
          blocked = off;
          if (off) {
            for (const attempt of [...attempts.values(), peer]) if (attempt) lost(attempt);
          } else {
            wake();
          }
        },
        // As if this page had gone away unnoticed, and a new one had come: the old connection
        // stays open, for the other side to deal with.
        abandon() {
          peer = null;
          me = randomText(8);
          presenceChanged();
          sayHere();
        },
      },
    };
    rooms.add(room);

    function presenceChanged() {
      room.present = peer ? [0, 1] : [state.mySeat];
      room.onPresence(room.present);
      if (!iCreated) room.onConnection(Boolean(peer));
    }
    function routeFound(found) {
      if (room.noRoute === !found) return;
      room.noRoute = !found;
      room.onRoute(room.noRoute);
    }

    // --- the creator decides

    function accept(next, seat) {
      if (next?.turn !== state.record.turn + 1) throw new Refusal("stale");
      if (!check(state.record, next, seat, state.seats)) throw new Refusal("refused");
      state.record = next;
      save(id, state);
      deliver();
      tell(peer, {kind: "news", record: next});
    }

    function meetGuest(attempt, {token, name}) {
      if (state.otherToken && token !== state.otherToken) {
        tell(attempt, {kind: "refused", code: "seat-taken"});
        attempt.channel.close();
        return;
      }
      if (!state.otherToken) {
        state.otherToken = token;
        state.seats[1] = {name: String(name).slice(0, 40)};
        save(id, state);
      }
      becomePeer(attempt);
      tell(attempt, {kind: "welcome", token: state.myToken, seats: state.seats, record: state.record});
      deliver();
    }

    // --- the guest is told

    function meetCreator(attempt, {token, seats, record}) {
      if (state.otherToken && token !== state.otherToken) {
        lost(attempt);
        return;
      }
      state.otherToken = token;
      state.seats = seats;
      state.record = record;
      save(id, state);
      becomePeer(attempt);
      joining?.resolve(room);
      joining = null;
      deliver();
    }

    function receive(attempt, message) {
      const {kind} = message;
      if (iCreated && kind === "hello" && attempt !== peer) {
        meetGuest(attempt, message);
      } else if (iCreated && kind === "write" && attempt === peer) {
        let code = null;
        try {
          accept(message.record, 1);
        } catch (error) {
          code = error.code ?? "refused";
        }
        tell(attempt, {kind: "answer", n: message.n, code});
      } else if (!iCreated && kind === "welcome" && attempt !== peer) {
        meetCreator(attempt, message);
      } else if (!iCreated && kind === "refused") {
        joining?.reject(new Refusal(message.code));
        lost(attempt);
      } else if (!iCreated && kind === "news" && attempt === peer) {
        state.record = message.record;
        save(id, state);
        deliver();
      } else if (!iCreated && kind === "answer" && attempt === peer) {
        waiting.get(message.n)?.(message.code);
      }
    }

    // --- making a connection

    function hangUp(attempt) {
      attempt.gone = true;
      clearTimeout(attempt.timer);
      clearTimeout(attempt.doubt);
      attempt.pc.close();
      if (attempts.get(attempt.from) === attempt) attempts.delete(attempt.from);
    }
    function lost(attempt) {
      if (attempt.gone) return;
      hangUp(attempt);
      if (peer !== attempt || closed) return;
      peer = null;
      me = randomText(8);
      for (const finish of [...waiting.values()]) finish("offline");
      presenceChanged();
      sayHere();
    }
    function becomePeer(attempt) {
      clearTimeout(attempt.timer);
      attempts.delete(attempt.from);
      if (peer) hangUp(peer);
      peer = attempt;
      routeFound(true);
      presenceChanged();
    }

    function begin(from) {
      if (!iCreated) for (const other of [...attempts.values()]) hangUp(other);
      const pc = new RTCPeerConnection({iceServers, iceTransportPolicy: noRoute ? "relay" : "all"});
      const attempt = {pc, from, channel: null, gone: false, answered: !iCreated};
      attempts.set(from, attempt);
      pc.onconnectionstatechange = () => {
        clearTimeout(attempt.doubt);
        if (pc.connectionState === "failed" || pc.connectionState === "closed") lost(attempt);
        // It can come back by itself, but not usually when someone has really gone.
        else if (pc.connectionState === "disconnected") attempt.doubt = setTimeout(() => lost(attempt), DOUBT_WAIT);
      };
      attempt.timer = setTimeout(() => {
        const tried = attempt.answered;
        lost(attempt);
        if (!tried || closed) return;
        routeFound(false);
        joining?.reject(new Refusal("no-route"));
      }, routeWait);
      return attempt;
    }
    function useChannel(attempt, channel) {
      attempt.channel = channel;
      const greet = () => { if (!iCreated) tell(attempt, {kind: "hello", token: state.myToken, name: state.seats[1]?.name}); };
      channel.onopen = greet;
      channel.onclose = () => lost(attempt);
      channel.onmessage = event => {
        try {
          receive(attempt, JSON.parse(event.data));
        } catch (error) {
          console.warn(error);
        }
      };
      if (channel.readyState === "open") greet();
    }

    async function makeOffer(to) {
      const attempt = begin(to);
      useChannel(attempt, attempt.pc.createDataChannel("room"));
      await attempt.pc.setLocalDescription();
      await gathered(attempt.pc);
      if (!attempt.gone) say({kind: "offer", to, sdp: attempt.pc.localDescription.sdp});
    }
    async function makeAnswer({from, sdp}) {
      const attempt = begin(from);
      attempt.pc.ondatachannel = event => useChannel(attempt, event.channel);
      await attempt.pc.setRemoteDescription({type: "offer", sdp});
      await attempt.pc.setLocalDescription();
      await gathered(attempt.pc);
      if (!attempt.gone) say({kind: "answer", to: from, sdp: attempt.pc.localDescription.sdp});
    }
    async function takeAnswer({from, sdp}) {
      const attempt = attempts.get(from);
      if (!attempt) return;
      attempt.answered = true;
      await attempt.pc.setRemoteDescription({type: "answer", sdp});
    }

    // Who says what, through the relay. The creator always makes the offer, so that the two can't
    // collide. A name that's already connected, or being tried, is someone saying the same again.
    function introduced(message) {
      const {kind, from, to, creator} = message;
      if (closed || blocked || from === me || (to && to !== me) || from === peer?.from) return;
      const fromTheOtherSide = Boolean(creator) !== iCreated;
      if (!fromTheOtherSide) return;
      let step = null;
      if (kind === "here" && iCreated && !attempts.has(from)) step = makeOffer(from);
      else if (kind === "here" && !iCreated) sayHere();
      else if (kind === "offer" && !iCreated) step = makeAnswer(message);
      else if (kind === "answer" && iCreated) step = takeAnswer(message);
      step?.catch(error => console.warn(error));
    }

    // A phone that wakes up, or a network that returns: if there's no connection, start again.
    function wake() {
      if (closed || blocked || peer || document.hidden) return;
      introductions.restart();
    }
    addEventListener("pagehide", room.close);
    addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);

    if (iCreated) {
      const url = new URL(page);
      url.searchParams.set("room", id);
      url.hash = new URLSearchParams({key: state.key, from: state.seats[0].name}).toString();
      room.inviteLink = url.href;
    }

    introductions.listen(introduced, () => {
      relayReady();
      if (!peer) sayHere();
    });
    return {room, relayIsReady, join: () => new Promise((resolve, reject) => { joining = {resolve, reject}; })};
  }

  const reachedRelay = async ({room, relayIsReady}) => {
    const reached = await Promise.race([relayIsReady.then(() => true), later(relayWait)]);
    if (reached) return;
    room.close();
    throw new Refusal("offline");
  };

  const online = {
    async create({name, record}) {
      const id = randomText(12), state = {mySeat: 0, key: randomText(32), myToken: randomText(32), otherToken: null, seats: [{name}, null], record};
      const made = await roomFor(id, state, await hold(id));
      await reachedRelay(made);
      save(id, state);
      return made.room;
    },

    // Who is in a room, and which seat is yours, if any. Only this browser's memory and the link
    // can say: nobody else is there to ask.
    preview(id, {from} = {}) {
      const state = load(id);
      if (state) return {seats: state.seats, mine: state.mySeat};
      return {seats: [from ? {name: from} : null, null], mine: null};
    },

    async open(id) {
      const state = load(id);
      if (!state) throw new Refusal("not-a-member");
      return (await roomFor(id, state, await hold(id))).room;
    },

    // Only finishes once the creator is there, however long that takes.
    async join(id, key, {name}) {
      if (load(id)) return online.open(id);
      const state = {mySeat: 1, key, myToken: randomText(32), otherToken: null, seats: [null, {name}], record: null};
      const made = await roomFor(id, state, await hold(id));
      const joined = made.join();
      joined.catch(() => {});      // seen below, unless the relay fails first
      await reachedRelay(made);
      try {
        return await joined;
      } catch (error) {
        made.room.close();
        throw error;
      }
    },
  };
  if (test) online.test = {closeAll: () => { for (const room of [...rooms]) room.close(); }};
  return online;
}
