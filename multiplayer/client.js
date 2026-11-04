// The multiplayer layer's interface for games: rooms on the multiplayer server,
// with the same interface as a game's local room (watch, play, mySeat). It knows
// nothing of any game, and has no user interface; each game draws its own. No
// dependencies. See README.md.
//
//   const mp = await connect({game: "connect4", realProject: true});
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

// Our project on Firebase, for pages that no multiplayer server serves. None of this is
// a secret: it only says which project is meant, and firebase/database.rules.json says
// who may do what there.
const FIREBASE_PROJECT = {
  apiKey: "AIzaSyDMrcVe3eBPGup0iSGALAJEF_rOo6QPJZY",
  authDomain: "games-f66f0.firebaseapp.com",
  databaseURL: "https://games-f66f0-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "games-f66f0",
  storageBucket: "games-f66f0.firebasestorage.app",
  messagingSenderId: "538105910348",
  appId: "1:538105910348:web:f77fc4c47c07eb19b490e9",
};

async function serverIsThere(base) {
  try {
    const answer = await fetch(`${base}/api/health`, {cache: "no-store"});
    return answer.ok && (await answer.json()).multiplayer === true;
  } catch {
    return false;
  }
}
// Whether rooms are there to use, for a game to decide whether to offer them: on a
// multiplayer server that serves this page, or else on Firebase, if the game allows that.
// Test pages don't, so that they never touch the real project.
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

export async function connect({game, base = "..", sessionName = "multiplayer.session", storage = localStorage, page, scramble = false, firebase = null, realProject = false} = {}) {
  // {config}, or "emulator" for the tests: the rooms are on Firebase instead of our own server. See firebase.js.
  if (!firebase && realProject && !await serverIsThere(base)) firebase = {config: FIREBASE_PROJECT};
  if (firebase) {
    const {connectFirebase} = await import("./firebase.js");
    return connectFirebase({game, sessionName, page, scramble, ...(firebase === "emulator" ? {emulator: true} : firebase)});
  }
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
    let record = plain(firstRecord), source = null;
    const watchers = new Set();
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
        Promise.resolve().then(() => { if (watchers.has(watcher)) watcher(structuredClone(record)); });
        if (!source) {
          source = new EventSource(`${base}/api/rooms/${id}/events?token=${encodeURIComponent(token)}`);
          source.onopen = () => room.onConnection(true);
          source.onerror = () => room.onConnection(false);
          source.onmessage = event => {
            const news = plain(JSON.parse(event.data));
            if (news.turn < record.turn) return;
            record = news;
            for (const each of watchers) each(structuredClone(news));
          };
          source.addEventListener("presence", event => {
            room.present = JSON.parse(event.data);
            room.onPresence(room.present);
          });
        }
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
        source?.close();
        source = null;
      },
    };
    return room;
  }

  return {
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
