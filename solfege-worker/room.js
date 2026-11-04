// Rooms, through the Worker: this file knows the way to the server and how to stay connected, and
// nothing of what's in the exercise. See ARCHITECTURE.md, sections 6, 7 and 10.
//
// The browser asks, and the server decides. A browser never changes its own screen after a move:
// watch() is the only way news comes in, also for your own moves.
import {WORKER} from "./address.js";

const TEST_WORKER = "http://127.0.0.1:8898";
const LONGEST_WAIT = 30000;

// A refusal has a code: stale, refused, no-such-room, not-a-member, wrong-key, seat-taken or offline.
export class Refusal extends Error {
  constructor(code) {
    super(`refused: ${code}`);
    this.code = code;
  }
}

// {test} uses a local copy of the Worker, and never the real one. {session} is a browser of its
// own, for the tests, which can also shorten the waits.
export function connect({
  test = false, session = "main", page = location.origin + location.pathname, address = test ? TEST_WORKER : WORKER,
  pingEvery = 30000, pingWait = 10000, moveWait = 8000,
} = {}) {
  const prefix = test ? `solfege-worker.test.${session}.` : "solfege-worker.";
  const place = id => `${prefix}room.${id}`;
  const load = id => { try { return JSON.parse(localStorage.getItem(place(id))); } catch { return null; } };
  const save = (id, state) => { try { localStorage.setItem(place(id), JSON.stringify(state)); } catch (error) { console.warn(error); } };
  const rooms = new Set();

  async function ask(path, options) {
    if (!address) throw new Refusal("offline");
    try {
      return await fetch(`${address}${path}`, options);
    } catch (error) {
      console.warn(error);
      throw new Refusal("offline");
    }
  }

  function roomFor(id, state, joining = null) {
    let socket = null, view = null, connected = null, closed = false, blocked = false;
    let wait = 1000, again = null, pinging = null, unanswered = null, deaf = false, moves = 0;
    const watchers = new Set(), waiting = new Map();

    const deliver = () => {
      for (const watcher of watchers) watcher(structuredClone(view));
    };
    const setConnected = now => {
      if (connected === now) return;
      connected = now;
      room.onConnection(now);
    };
    const stopPinging = () => {
      clearInterval(pinging);
      clearTimeout(unanswered);
      unanswered = null;
    };
    const finishMoves = code => { for (const finish of [...waiting.values()]) finish(code); };

    const room = {
      id,
      mySeat: state.mySeat ?? 1,
      iCreated: state.mySeat === 0,
      inviteLink: null,
      present: null,
      onConnection: () => {},
      onPresence: () => {},
      onGone: () => {},

      // Calls `watcher` with {seats, record}, soon, and after every change. Returns the function
      // that stops it.
      watch(watcher) {
        watchers.add(watcher);
        Promise.resolve().then(() => { if (view && watchers.has(watcher)) watcher(structuredClone(view)); });
        return () => {
          watchers.delete(watcher);
          if (!watchers.size) room.close();
        };
      },

      // Says what someone did. The server works out what follows, and tells everyone.
      async act(action, ...args) {
        if (!connected) throw new Refusal("offline");
        const n = ++moves;
        socket.send(JSON.stringify({kind: "move", n, turn: view.record.turn, action, args}));
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => waiting.get(n)?.("offline"), moveWait);
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
        clearTimeout(again);
        stopPinging();
        socket?.close();
        socket = null;
        connected = false;
        finishMoves("offline");
        joining?.reject(new Refusal("offline"));
      },

      test: {
        // Cut off from everything, and back again.
        cut(off) {
          blocked = off;
          if (off) {
            socket?.close();
            lost();
          } else {
            wake();
          }
        },
        // The connection ends, and it tries again after the usual wait, or the given one.
        drop({wait: longer} = {}) {
          if (longer) wait = longer;
          socket?.close();
          lost();
        },
        // The next pings go unanswered.
        deaf() { deaf = true; },
      },
    };
    rooms.add(room);

    function receive(message) {
      const {kind} = message;
      if (kind === "welcome") {
        state.mySeat = message.seat;
        state.token = message.token;
        delete state.key;
        delete state.name;
        save(id, state);
      } else if (kind === "view") {
        view = {seats: message.seats, record: message.record};
        wait = 1000;
        setConnected(true);
        const present = JSON.stringify(room.present) !== JSON.stringify(message.present);
        room.present = message.present;
        if (present) room.onPresence(room.present);
        joining?.resolve(room);
        joining = null;
        deliver();
      } else if (kind === "answer") {
        waiting.get(message.n)?.(message.code);
      } else if (kind === "refused") {
        const refusal = new Refusal(message.code);
        const wasJoining = joining;
        joining = null;
        room.close();
        if (wasJoining) wasJoining.reject(refusal);
        else room.onGone(message.code);
      }
    }

    function link() {
      clearTimeout(again);
      if (closed || blocked || socket) return;
      const mine = new WebSocket(`${address.replace(/^http/, "ws")}/rooms/${id}/live`);
      socket = mine;
      mine.onopen = () => {
        if (mine !== socket) return;
        mine.send(JSON.stringify(state.token ? {kind: "hello", token: state.token} : {kind: "join", key: state.key, name: state.name}));
        deaf = false;
        pinging = setInterval(ping, pingEvery);
      };
      mine.onmessage = event => {
        if (mine !== socket) return;
        if (event.data === "pong") {
          if (!deaf) {
            clearTimeout(unanswered);
            unanswered = null;
          }
        } else {
          receive(JSON.parse(event.data));
        }
      };
      mine.onclose = () => { if (mine === socket) lost(); };
    }
    function ping() {
      if (socket?.readyState !== WebSocket.OPEN) return;
      socket.send("ping");
      unanswered ??= setTimeout(() => {
        socket?.close();
        lost();
      }, pingWait);
    }
    function lost() {
      stopPinging();
      socket = null;
      finishMoves("offline");
      if (closed) return;
      setConnected(false);
      if (joining) {
        const wasJoining = joining;
        joining = null;
        room.close();
        wasJoining.reject(new Refusal("offline"));
        return;
      }
      if (blocked) return;
      again = setTimeout(link, wait);
      wait = Math.min(wait * 2, LONGEST_WAIT);
    }
    // A phone that wakes up, or a network that returns: there's no reason to wait any longer.
    function wake() {
      if (closed || blocked || socket || document.hidden) return;
      wait = 1000;
      link();
    }
    addEventListener("pagehide", room.close);
    addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);

    if (state.mySeat === 0) {
      const url = new URL(page);
      url.searchParams.set("room", id);
      url.hash = new URLSearchParams({key: state.key}).toString();
      room.inviteLink = url.href;
    }
    link();
    return room;
  }

  const online = {
    async create({name}) {
      const response = await ask("/rooms", {method: "POST", body: JSON.stringify({name})});
      if (!response.ok) throw new Refusal("offline");
      const {id, key, token} = await response.json();
      const state = {mySeat: 0, token, key};
      save(id, state);
      return roomFor(id, state);
    },

    // Who is in a room, and which seat is yours, if any.
    async preview(id) {
      const response = await ask(`/rooms/${id}`);
      if (response.status === 404) throw new Refusal("no-such-room");
      if (!response.ok) throw new Refusal("offline");
      const {seats} = await response.json();
      return {seats, mine: load(id)?.mySeat ?? null};
    },

    async open(id) {
      const {mine} = await online.preview(id);
      if (mine === null) throw new Refusal("not-a-member");
      return roomFor(id, load(id));
    },

    async join(id, key, {name}) {
      const {mine} = await online.preview(id);
      if (mine !== null) return roomFor(id, load(id));
      return new Promise((resolve, reject) => {
        roomFor(id, {key, name}, {resolve, reject});
      });
    },
  };
  if (test) online.test = {closeAll: () => { for (const room of [...rooms]) room.close(); }};
  return online;
}
