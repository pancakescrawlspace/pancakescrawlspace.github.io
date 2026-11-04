// Rooms over an MQTT broker. This is the only file that knows how the messages go, and it knows
// nothing of what's in the exercise: the record is the page's, and so is `check`, which says whether
// a write is allowed. See ARCHITECTURE.md, sections 3, 5, 8 and 10.
//
// The creator's browser takes the role of a server: it holds the record, and decides on every
// write. A browser never changes its own screen after a write: watch() is the only way news comes
// in, also for your own writes.
import {openTopic} from "./broker.js";

const BROKER = "wss://broker.hivemq.com:8884/mqtt", TEST_BROKER = "ws://127.0.0.1:8897/mqtt";
const LETTERS = "abcdefghijklmnopqrstuvwxyz234567";
const LOCK_WAIT = 1500;

const randomText = length => Array.from(crypto.getRandomValues(new Uint8Array(length)), byte => LETTERS[byte % 32]).join("");
const later = ms => new Promise(resolve => setTimeout(resolve, ms));

// A refusal has a code: stale, refused, not-a-member, seat-taken, open-elsewhere or offline.
export class Refusal extends Error {
  constructor(code) {
    super(`refused: ${code}`);
    this.code = code;
  }
}

// {test} uses the stand-in broker, and never a real one. {session} is a browser of its own, for
// the tests, which can also shorten the waits.
export async function connect({
  test = false, session = "main", check, page = location.origin + location.pathname, broker = test ? TEST_BROKER : BROKER,
  brokerWait = test ? 1500 : 8000, writeWait = 8000, keepalive = 60,
} = {}) {
  const prefix = test ? `solfege-mqtt.test.${session}.` : "solfege-mqtt.";
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
    const topic = await openTopic(broker, state.key, {keepalive, retry: test ? 100 : 1000, pingWait: test ? 500 : 10000});
    let me = randomText(8);       // this connection's name, to know its own messages when they come back
    let otherName = null;         // the name of the other's latest connection: only its bye counts
    let listening = false, otherHere = false, connected = null, closed = false, blocked = false, writes = 0, brokerReady = null;
    const brokerIsReady = new Promise(resolve => { brokerReady = resolve; });
    const waiting = new Map(), watchers = new Set();

    const view = () => structuredClone({seats: state.seats, record: state.record});
    const deliver = () => {
      if (!state.record) return;
      for (const watcher of watchers) watcher(view());
    };
    // Publishes a message, with no way to know if it arrives: the next one puts that right.
    const say = async message => {
      if (blocked || closed) return;
      try {
        await topic.send({...message, from: me, creator: iCreated});
      } catch (error) {
        console.warn(error);
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
      const now = listening;     // only about this browser's own connection: the other may be away
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
      onConnection: () => {},
      onPresence: () => {},

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
          topic.send({kind: "write", from: me, creator: false, token: state.myToken, n, record: next}).catch(() => waiting.get(n)?.("offline"));
        });
      },

      close() {
        if (closed) return;
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
        // Cut off from the broker, and back again.
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
        // No more signs of life, like a device going to sleep, and waking up again.
        silence: () => topic.test.silence(),
        reconnect: () => topic.restart(),
        // Connects anew, leaving the old connection for the broker to give up on.
        abandon: () => topic.test.abandon(),
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
      const {kind, token, from} = message;
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
      if (kind === "bye") {
        if (from === otherName) setOtherHere(false);
        return;
      }
      otherName = from;
      if (kind === "here" || kind === "join") {
        setOtherHere(true);
        sendNews();
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
      const {kind, record, from} = message;
      if (kind === "here") {
        otherName = from;
        if (joining) sayJoin();
        else sayHere();
      } else if (kind === "bye") {
        if (from === otherName) setOtherHere(false);
      } else if (kind === "refused" && message.to === state.myToken) {
        if (message.n) waiting.get(message.n)?.(message.code);
        else joining?.reject(new Refusal(message.code));
      } else if (kind === "news" && message.guest === state.myToken) {
        // An old message sent again changes nothing.
        if (state.record && record.turn < state.record.turn) return;
        otherName = from;
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
      brokerReady();
      listening = true;
      showStatus();
      if (joining) sayJoin();
      else sayHere();
    }, () => {
      listening = false;
      showStatus();
    }, async () => {
      // Sealed anew for each connection. An old connection's will can come after the new one has
      // spoken, as the broker takes its time to give up, so the other only counts the latest's.
      me = randomText(8);
      return topic.seal({kind: "bye", from: me, creator: iCreated, token: state.myToken});
    });
    return {room, brokerIsReady, join: () => new Promise((resolve, reject) => { joining = {resolve, reject}; })};
  }

  const reachedBroker = async ({room, brokerIsReady}) => {
    const reached = await Promise.race([brokerIsReady.then(() => true), later(brokerWait)]);
    if (reached) return;
    room.close();
    throw new Refusal("offline");
  };

  const online = {
    async create({name, record}) {
      const id = randomText(12), state = {mySeat: 0, key: randomText(32), myToken: randomText(32), otherToken: null, seats: [{name}, null], record};
      const made = await roomFor(id, state, await hold(id));
      await reachedBroker(made);
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
      joined.catch(() => {});      // seen below, unless the broker fails first
      await reachedBroker(made);
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
