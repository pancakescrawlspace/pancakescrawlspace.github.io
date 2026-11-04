// Rooms over the relay. This is the only file that knows how the messages go, and it knows nothing
// of what's in the exercise: the record is the page's, and so is `check`, which says whether a
// write is allowed. See ARCHITECTURE.md, sections 3, 5, 8 and 10.
//
// The creator's browser takes the role of a server: it holds the record, and decides on every
// write. A browser never changes its own screen after a write: watch() is the only way news comes
// in, also for your own writes. Every message counts, as the relay allows only so many a day.
import {openTopic} from "./relay.js";

const RELAY = "https://ntfy.sh", TEST_RELAY = "http://127.0.0.1:8899";
const LETTERS = "abcdefghijklmnopqrstuvwxyz234567";
const LOCK_WAIT = 1500;

const randomText = length => Array.from(crypto.getRandomValues(new Uint8Array(length)), byte => LETTERS[byte % 32]).join("");
const later = ms => new Promise(resolve => setTimeout(resolve, ms));

// A refusal has a code: stale, refused, not-a-member, seat-taken, open-elsewhere, relay-limit or offline.
export class Refusal extends Error {
  constructor(code) {
    super(`refused: ${code}`);
    this.code = code;
  }
}

// {test} uses the stand-in relay, and never the real one. {session} is a browser of its own, for
// the tests, which can also shorten the waits.
export async function connect({
  test = false, session = "main", check, page = location.origin + location.pathname, relay = test ? TEST_RELAY : RELAY,
  relayWait = test ? 1500 : 8000, writeWait = 8000,
} = {}) {
  const prefix = test ? `solfege-relay.test.${session}.` : "solfege-relay.";
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

  async function roomFor(id, state, release, joining = null) {
    const iCreated = state.mySeat === 0;
    const topic = await openTopic(relay, state.key, {retry: test ? 300 : 10000});
    const me = randomText(8);     // this page's name, to know its own messages when they come back
    const bye = await topic.seal({kind: "bye", from: me, creator: iCreated, token: state.myToken});
    let listening = false, otherHere = false, connected = null, closed = false, blocked = false, writes = 0, relayReady = null;
    const relayIsReady = new Promise(resolve => { relayReady = resolve; });
    const waiting = new Map(), watchers = new Set();

    const view = () => structuredClone({seats: state.seats, record: state.record});
    const deliver = () => {
      if (!state.record) return;
      for (const watcher of watchers) watcher(view());
    };
    const noteLimit = () => {
      room.limited = true;
      room.onLimit();
    };
    // Posts a message. It only matters to the caller if the day's limit has been reached.
    const say = async message => {
      if (blocked || closed) return;
      try {
        await topic.send({...message, from: me, creator: iCreated});
      } catch (error) {
        console.warn(error);
        if (error.limit) noteLimit();
      }
    };
    const sayHere = () => say({kind: "here", token: state.myToken});
    const sayJoin = () => say({kind: "join", token: state.myToken, name: state.seats[1].name});
    const sendNews = n => say({kind: "news", seats: state.seats, record: state.record, guest: state.otherToken, n});

    function showStatus() {
      const present = otherHere ? [0, 1] : [state.mySeat];
      if (JSON.stringify(room.present) !== JSON.stringify(present)) {
        room.present = present;
        room.onPresence(present);
      }
      const now = listening && (iCreated || otherHere);
      if (connected !== now) {
        connected = now;
        room.onConnection(now);
      }
    }
    const setOtherHere = here => {
      otherHere = here;
      showStatus();
    };

    const room = {
      id,
      mySeat: state.mySeat,
      iCreated,
      inviteLink: null,
      present: [state.mySeat],
      limited: false,
      onConnection: () => {},
      onPresence: () => {},
      onLimit: () => {},

      // Calls `watcher` with {seats, record}, soon, and after every change. Returns the function
      // that stops it.
      watch(watcher) {
        watchers.add(watcher);
        Promise.resolve().then(() => {
          if (!watchers.has(watcher)) return;
          room.onConnection(connected ?? iCreated);
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
        if (!listening) throw new Refusal("offline");
        const n = ++writes;
        return new Promise((resolve, reject) => {
          const finish = code => {
            clearTimeout(timer);
            waiting.delete(n);
            if (code) reject(new Refusal(code));
            else resolve();
          };
          const timer = setTimeout(() => {
            finish("offline");
            setOtherHere(false);
          }, writeWait);
          waiting.set(n, finish);
          topic.send({kind: "write", from: me, creator: false, token: state.myToken, n, record: next}).catch(error => {
            if (error.limit) noteLimit();
            waiting.get(n)?.(error.limit ? "relay-limit" : "offline");
          });
        });
      },

      close() {
        if (closed) return;
        // Not only if it's listening: a browser that's leaving a page may end the stream first.
        if (!blocked) topic.sendSealed(bye);
        closed = true;
        rooms.delete(room);
        removeEventListener("pagehide", room.close);
        removeEventListener("online", wake);
        document.removeEventListener("visibilitychange", wake);
        topic.close();
        for (const finish of [...waiting.values()]) finish("offline");
        joining?.reject(new Refusal("offline"));
        release();
      },

      test: {
        // Cut off from the relay, and back again, without a word to anyone.
        cut(off) {
          blocked = off;
          if (off) {
            topic.close();
            listening = false;
            showStatus();
          } else {
            wake();
          }
        },
      },
    };
    rooms.add(room);

    // --- the creator decides

    function accept(next, seat, n) {
      if (next?.turn !== state.record.turn + 1) throw new Refusal("stale");
      if (!check(state.record, next, seat, state.seats)) throw new Refusal("refused");
      state.record = next;
      save(id, state);
      deliver();
      sendNews(n);
    }

    function creatorHears(message) {
      const {kind, token} = message;
      if (kind === "join" && !state.otherToken) {
        state.otherToken = token;
        state.seats[1] = {name: String(message.name).slice(0, 40)};
        save(id, state);
        deliver();
      }
      if (token !== state.otherToken) {
        if (kind === "join") say({kind: "refused", to: token, code: "seat-taken"});
        return;
      }
      if (kind === "here" || kind === "join") {
        setOtherHere(true);
        sendNews();
      } else if (kind === "bye") {
        setOtherHere(false);
      } else if (kind === "write") {
        try {
          accept(message.record, 1, message.n);
        } catch (error) {
          say({kind: "refused", to: token, n: message.n, code: error.code ?? "refused"});
        }
      }
    }

    // --- the guest is told

    function guestHears(message) {
      const {kind, record} = message;
      if (kind === "here") {
        if (joining) sayJoin();
        else sayHere();
      } else if (kind === "bye") {
        setOtherHere(false);
      } else if (kind === "refused" && message.to === state.myToken) {
        if (message.n) waiting.get(message.n)?.(message.code);
        else joining?.reject(new Refusal(message.code));
      } else if (kind === "news" && message.guest === state.myToken) {
        // An old message sent again by the relay changes nothing.
        if (state.record && record.turn < state.record.turn) return;
        state.seats = message.seats;
        state.record = record;
        save(id, state);
        setOtherHere(true);
        joining?.resolve(room);
        joining = null;
        waiting.get(message.n)?.(null);
        deliver();
      }
    }

    // A phone that wakes up, or a network that returns: if it's no longer listening, start again.
    function wake() {
      if (!closed && !blocked && !listening && !document.hidden) topic.restart();
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

    topic.listen(message => {
      if (closed || blocked || message.from === me || Boolean(message.creator) === iCreated) return;
      if (iCreated) creatorHears(message);
      else guestHears(message);
    }, () => {
      relayReady();
      listening = true;
      showStatus();
      if (joining) sayJoin();
      else sayHere();
    }, () => {
      listening = false;
      showStatus();
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
