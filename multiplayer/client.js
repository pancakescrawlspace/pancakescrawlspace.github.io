// The multiplayer layer's interface for games: rooms on the multiplayer server, or on our
// Cloudflare Worker, with the same interface as a game's local room (watch, play, mySeat).
// It knows nothing of any game, and has no user interface; each game draws its own. No
// dependencies. See README.md.
//
//   const mp = await connect({game: "connect4", realProject: true});   // on the Worker if no server serves the page
//   await mp.signIn({secret});              // only to create games, if the server has a secret
//   const room = await mp.create({seats, state, current: 0});
//   room.inviteLinks[1]                     // to send to the person for seat 1
//   const room = await mp.join(link, {name: "Ria"});
//   const room = await mp.open(roomId);     // a room you are in already
//   room.watch(record => { … });            // now, and after every change
//   await room.play({state, current});      // refused if it isn't your turn, or stale
//   await room.play({state, current}, {forSeat: 2});   // a computer player's turn
//
// A refusal is an error with a `code`, the server's word for it: "stale",
// "out-of-turn", "seat-taken", "wrong-key", "not-started", "no-such-room", "secret-needed",
// "wrong-secret", "too-many-rooms", "too-many-attempts"...
//
// A record is {version, game, seats, started, current, turn, state}.
//
// connect({scramble: true}) scrambles the state on its way to the server and back. The
// key is in this file, so it only stops a glance at the record, not a determined
// player. It is a few lines of our own because the browser's encryption isn't
// available on a plain address on the home network.

export class RoomRefusal extends Error {
  constructor(code) {
    super(`the room refused this: ${code}`);
    this.code = code;
  }
}

// Our Worker (worker/worker.js), for pages that no multiplayer server serves. Its address
// isn't a secret: the Worker's password and session key are.
export const WORKER = "https://games.pancakescrawlspace.workers.dev";

async function health(base) {
  try {
    const answer = await fetch(`${base}/api/health`, {cache: "no-store"});
    const data = answer.ok ? await answer.json() : null;
    return data?.multiplayer === true ? data : null;
  } catch {
    return null;
  }
}
const serverIsThere = async base => Boolean(await health(base));
// Whether rooms are there to use, for a game to decide whether to offer them: on a
// multiplayer server that serves this page, or else on our Worker, if the game allows that.
// Test pages don't, so that they never touch the real Worker.
export async function available(base = "..", {realProject = false} = {}) {
  return realProject || serverIsThere(base);
}

// An invite link: this page's address, with the room in it, and the seat and key after
// the #, which browsers don't send to any server. So the link is what lets someone in.
export function inviteLink(room, seat, key, page = location.href) {
  const url = new URL(page);
  url.searchParams.set("room", room);
  url.hash = new URLSearchParams({seat, key}).toString();
  return url.href;
}
export function parseInvite(link = location.href) {
  const url = new URL(link);
  const fragment = new URLSearchParams(url.hash.slice(1));
  const room = url.searchParams.get("room"), key = fragment.get("key"), seat = Number(fragment.get("seat"));
  return room && key && Number.isInteger(seat) ? {room, seat, key} : null;
}

const SCRAMBLE_KEY = "not a secret, only against a glance";
function keystream(length) {
  let h = 2166136261;
  for (const char of SCRAMBLE_KEY) h = Math.imul(h ^ char.charCodeAt(0), 16777619);
  return Array.from({length}, () => {
    h = Math.imul(h ^ (h >>> 15), 2246822519);
    h = Math.imul(h ^ (h >>> 13), 3266489917);
    return (h ^= h >>> 16) & 255;
  });
}
export function scrambled(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value)), stream = keystream(bytes.length);
  return {scrambled: btoa(String.fromCharCode(...bytes.map((byte, i) => byte ^ stream[i])))};
}
export function unscrambled(value) {
  if (typeof value?.scrambled !== "string") return value;
  const bytes = Uint8Array.from(atob(value.scrambled), char => char.charCodeAt(0)), stream = keystream(bytes.length);
  return JSON.parse(new TextDecoder().decode(bytes.map((byte, i) => byte ^ stream[i])));
}

// The live updates come over Server-Sent Events from the server, which reconnect by
// themselves, and over a WebSocket from the Worker, which lets a room sleep between moves.
// That one is pinged, so that a connection gone silent is noticed, and is reconnected here.
const PING_EVERY = 25 * 1000, SILENT_FOR = 60 * 1000, RECONNECT_AFTER = [500, 1000, 2000, 5000, 10000];

// For the tests: acts as if the network were gone, for the live updates of every room this page
// watches, from any connect().
let offline = false;
const watched = new Set();
const forTests = {
  goOffline() {
    offline = true;
    for (const room of watched) room.cutOff();
  },
  goOnline() {
    offline = false;
    for (const room of watched) room.reconnect();
  },
};

export async function connect({game, base = "..", sessionName = "multiplayer.session", storage = localStorage, page, scramble = false, realProject = false} = {}) {
  if (realProject && !await serverIsThere(base)) base = WORKER;
  // Which kind of live updates, asked once, when a room is first watched.
  let liveKind = null;
  const kindOfLive = () => liveKind ??= health(base).then(data => data?.live === "websocket" ? "websocket" : "events");
  let token = null;
  try { token = storage.getItem(sessionName); } catch {}

  async function request(path, body) {
    const headers = token ? {Authorization: `Bearer ${token}`} : {};
    const answer = await fetch(`${base}/api/${path}`, body === undefined ? {headers, cache: "no-store"}
      : {method: "POST", headers: {...headers, "Content-Type": "application/json"}, body: JSON.stringify(body)});
    const data = await answer.json().catch(() => ({}));
    if (!answer.ok) throw new RoomRefusal(data.error ?? `status-${answer.status}`);
    return data;
  }
  // A session takes the creators' secret or an invite key, unless the server has no secret.
  async function newSession(credentials = {}) {
    const previous = token;
    token = null;
    try {
      token = (await request("session", credentials)).token;
    } catch (error) {
      token = previous;
      throw error;
    }
    try { storage.setItem(sessionName, token); } catch {}
  }
  // A session the server no longer knows, such as after a new database, is replaced.
  async function asked(path, body, credentials) {
    if (!token) await newSession(credentials);
    try {
      return await request(path, body);
    } catch (error) {
      if (error.code !== "no-session") throw error;
      token = null;
      await newSession(credentials);
      return request(path, body);
    }
  }

  const plain = record => ({...record, state: unscrambled(record.state)});
  const toSend = state => scramble ? scrambled(state) : state;

  function roomFor(id, firstRecord, mySeat, invites = {}) {
    let record = plain(firstRecord), live = null;
    const watchers = new Set();
    const news = data => {
      const next = plain(data);
      if (next.turn < record.turn) return;
      record = next;
      for (const each of watchers) each(structuredClone(next));
    };
    const presence = seats => {
      room.present = seats;
      room.onPresence(seats);
    };

    function eventSource() {
      const source = new EventSource(`${base}/api/rooms/${id}/events?token=${encodeURIComponent(token)}`);
      source.onopen = () => room.onConnection(true);
      source.onerror = () => room.onConnection(false);
      source.onmessage = event => news(JSON.parse(event.data));
      source.addEventListener("presence", event => presence(JSON.parse(event.data)));
      return {close: () => source.close()};
    }

    // A WebSocket that comes back after it drops, until closed here.
    function webSocket() {
      let socket = null, pinger = null, retry = null, tries = 0, heard = 0, closed = false;
      const address = new URL(`${base}/api/rooms/${id}/live`, location.href);
      address.protocol = address.protocol === "https:" ? "wss:" : "ws:";
      function open() {
        address.searchParams.set("token", token);
        socket = new WebSocket(address);
        socket.onopen = () => {
          tries = 0;
          heard = Date.now();
          room.onConnection(true);
          pinger = setInterval(() => {
            if (Date.now() - heard > SILENT_FOR) lost();
            else socket.send("ping");
          }, PING_EVERY);
        };
        socket.onmessage = event => {
          heard = Date.now();
          if (event.data === "pong") return;
          const data = JSON.parse(event.data);
          if (data.record) news(data.record);
          if (data.presence) presence(data.presence);
        };
        socket.onclose = lost;
      }
      // Closed by the other end, or silent for too long: a dead connection may take a while to
      // finish closing, so this one is let go at once, and a new one tried.
      function lost() {
        if (!socket) return;
        const old = socket;
        socket = null;
        old.onopen = old.onmessage = old.onclose = null;
        clearInterval(pinger);
        try { old.close(); } catch {}
        if (closed) return;
        room.onConnection(false);
        retry = setTimeout(open, RECONNECT_AFTER[Math.min(tries++, RECONNECT_AFTER.length - 1)]);
      }
      open();
      return {
        close() {
          closed = true;
          clearTimeout(retry);
          clearInterval(pinger);
          socket?.close();
        },
      };
    }

    // Opens the live updates, unless they are open, nobody watches, or the network is "gone" in a test.
    async function goLive() {
      const kind = await kindOfLive();
      if (live || !watchers.size || offline) return;
      live = kind === "websocket" ? webSocket() : eventSource();
    }
    const room = {
      id,
      online: true,
      mySeat,
      inviteLinks: Object.fromEntries(Object.entries(invites).map(([seat, key]) => [seat, inviteLink(id, seat, key, page)])),
      // Called with false when the connection drops, and true when it is back. The browser reconnects by itself.
      onConnection: () => {},
      // The seats of those who have this room open now, as far as known yet; and when that changes.
      present: null,
      onPresence: () => {},

      // Calls `watcher` with the record, now and after every change. Returns the function that stops it.
      watch(watcher) {
        watchers.add(watcher);
        watched.add(room);
        Promise.resolve().then(() => { if (watchers.has(watcher)) watcher(structuredClone(record)); });
        goLive();
        return () => {
          watchers.delete(watcher);
          if (!watchers.size) room.close();
        };
      },

      // Writes the record after a turn. {forSeat} says it is a computer player's: the
      // server decides who may write, so here it only tells the reader what this is.
      async play({state, current}, _options = {}) {
        await asked(`rooms/${id}/turn`, {turn: record.turn + 1, current, state: toSend(state)});
      },

      close() {
        live?.close();
        live = null;
        watched.delete(room);
      },

      // For the tests' switch below.
      cutOff() {
        if (!live) return;
        live.close();
        live = null;
        room.onConnection(false);
      },
      reconnect: goLive,
    };
    return room;
  }

  return {
    // Where the rooms are: this page's server, or the Worker.
    base,

    // For the tests: cuts the page's live updates off, as a lost network would, and brings them back.
    test: forTests,

    // Gives the creators' secret, to be allowed to create games. A session you have stays.
    async signIn({secret}) {
      const answer = await request("session", {secret});
      if (answer.token) {
        token = answer.token;
        try { storage.setItem(sessionName, token); } catch {}
      }
    },

    async create({seats, state, current = 0}) {
      const made = await asked("rooms", {game, seats, state: toSend(state), current});
      return roomFor(made.room, made.record, made.seat, made.invites);
    },

    async open(id) {
      const {record, seat} = await asked(`rooms/${id}`);
      if (!record) throw new RoomRefusal("not-a-member");
      return roomFor(id, record, seat);
    },

    // What a link is for, before joining: the game and the seats, with their names.
    async preview(link) {
      const invite = parseInvite(link);
      if (!invite) throw new RoomRefusal("not-an-invite");
      const answer = await asked(`rooms/${invite.room}`, undefined, invite);
      return answer.record ? {game: answer.record.game, seats: answer.record.seats, joined: true, seat: answer.seat} : answer;
    },

    async join(link, {name} = {}) {
      const invite = parseInvite(link);
      if (!invite) throw new RoomRefusal("not-an-invite");
      const {record, seat} = await asked(`rooms/${invite.room}/join`, {seat: invite.seat, key: invite.key, name}, invite);
      return roomFor(invite.room, record, seat);
    },
  };
}
