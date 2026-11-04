// Sessions and rooms on Firebase. This is the only file that knows Firebase, and it knows
// nothing of what's in the exercise: the record is the page's. See ARCHITECTURE.md, section 10.
//
// A browser never changes its own screen after a write: watch() is the only way news comes in,
// also for your own writes.
import {FIREBASE_PROJECT} from "./project.js";

const SDK = "https://www.gstatic.com/firebasejs/11.10.0";
const EMULATOR_PROJECT = "demo-solfege-poc";
const EMULATOR_DATABASE = `${EMULATOR_PROJECT}-default-rtdb`;
const LETTERS = "abcdefghijklmnopqrstuvwxyz234567";

const randomText = length => Array.from(crypto.getRandomValues(new Uint8Array(length)), byte => LETTERS[byte % 32]).join("");

// A refusal has a code: stale, refused, not-on-list, no-such-room, not-a-member, wrong-key,
// seat-taken or offline.
export class Refusal extends Error {
  constructor(code) {
    super(`refused: ${code}`);
    this.code = code;
  }
}

const twoSeats = seats => [seats?.[0] ?? null, seats?.[1] ?? null];

// {test} uses the emulator, and never the real project. {session} is a browser of its own, for
// the tests. {unlisted} leaves a test's Google account off the list of creators.
export async function connect({test = false, session = "main", unlisted = false, page = location.origin + location.pathname} = {}) {
  const config = test ? {apiKey: "not-needed", projectId: EMULATOR_PROJECT, authDomain: "localhost", databaseURL: `http://127.0.0.1:9000?ns=${EMULATOR_DATABASE}`}
    : FIREBASE_PROJECT;
  if (!config) throw new Refusal("offline");
  let firebaseApp, auth, db;
  try {
    [firebaseApp, auth, db] = await Promise.all([
      import(`${SDK}/firebase-app.js`), import(`${SDK}/firebase-auth.js`), import(`${SDK}/firebase-database.js`),
    ]);
  } catch (error) {
    console.warn(error);
    throw new Refusal("offline");
  }
  const name = `solfege-poc-${session}`;
  const app = firebaseApp.getApps().find(each => each.name === name) ?? firebaseApp.initializeApp(config, name);
  const sessionAuth = auth.getAuth(app);
  const database = db.getDatabase(app);
  if (test && !sessionAuth.emulatorConfig) {
    auth.connectAuthEmulator(sessionAuth, "http://127.0.0.1:9099", {disableWarnings: true});
    db.connectDatabaseEmulator(database, "127.0.0.1", 9000);
  }
  await sessionAuth.authStateReady();

  async function signedIn() {
    if (!sessionAuth.currentUser) await auth.signInAnonymously(sessionAuth);
    return sessionAuth.currentUser.uid;
  }
  const at = path => db.ref(database, path);
  const denied = error => /permission.denied/i.test(`${error?.code} ${error?.message}`);
  // The network, or Firebase, not answering isn't a refusal by the rules.
  const offline = error => {
    console.warn(error);
    return new Refusal("offline");
  };
  const read = async path => {
    try {
      return (await db.get(at(path))).val();
    } catch (error) {
      if (denied(error)) return undefined;
      throw offline(error);
    }
  };

  function roomFor(id, mySeat, key) {
    let view = {seats: null, record: null}, connected = false, presence = null;
    const watchers = new Set(), stops = [];
    const deliver = () => {
      if (!view.seats || !view.record) return;
      for (const watcher of watchers) watcher(structuredClone(view));
    };
    const room = {
      id,
      mySeat,
      iCreated: mySeat === 0,
      inviteLink: null,
      present: null,
      onConnection: () => {},
      onPresence: () => {},

      // Calls `watcher` with {seats, record}, soon, and after every change. Returns the function
      // that stops it.
      watch(watcher) {
        watchers.add(watcher);
        if (view.seats && view.record) Promise.resolve().then(() => { if (watchers.has(watcher)) watcher(structuredClone(view)); });
        if (!stops.length) {
          stops.push(db.onValue(at(`rooms/${id}/seats`), snapshot => { view.seats = twoSeats(snapshot.val()); deliver(); }));
          stops.push(db.onValue(at(`rooms/${id}/record`), snapshot => { if (snapshot.val()) { view.record = snapshot.val(); deliver(); } }));
          stops.push(db.onValue(at(`rooms/${id}/present`), snapshot => {
            room.present = [...new Set(Object.values(snapshot.val() ?? {}))].sort();
            room.onPresence(room.present);
          }));
          // Who is here: an entry per open connection, which the server removes when it goes.
          stops.push(db.onValue(at(".info/connected"), async snapshot => {
            const now = snapshot.val() === true;
            if (now !== connected) {
              connected = now;
              room.onConnection(now);
            }
            if (!now) return;
            presence = db.push(at(`rooms/${id}/present`));
            await db.onDisconnect(presence).remove();
            await db.set(presence, mySeat);
          }));
        }
        return () => {
          watchers.delete(watcher);
          if (!watchers.size) room.close();
        };
      },

      // Writes the next record, if the record is still the one before it. Nothing shows until
      // the server has it, so `applyLocally` is off.
      async write(next) {
        let late = false;
        try {
          const result = await db.runTransaction(at(`rooms/${id}/record`), now => {
            if (now === null) return null;       // nothing known yet: the server corrects this
            if (now.turn !== next.turn - 1) { late = true; return undefined; }
            return next;
          }, {applyLocally: false});
          if (!result.committed) throw new Refusal(late ? "stale" : "refused");
        } catch (error) {
          if (error instanceof Refusal) throw error;
          if (denied(error)) throw new Refusal("refused");
          throw offline(error);
        }
      },

      close() {
        for (const stop of stops.splice(0)) stop();
        if (presence) {
          db.onDisconnect(presence).cancel().catch(() => {});
          db.remove(presence).catch(() => {});
          presence = null;
        }
      },
    };
    if (key) {
      const url = new URL(page);
      url.searchParams.set("room", id);
      url.hash = new URLSearchParams({key}).toString();
      room.inviteLink = url.href;
    }
    return room;
  }

  async function seatsOf(id) {
    const seats = await read(`rooms/${id}/seats`);
    if (seats === null || seats === undefined) throw new Refusal("no-such-room");
    return twoSeats(seats);
  }
  const seatFor = (seats, uid) => {
    const seat = seats.findIndex(each => each?.uid === uid);
    return seat < 0 ? null : seat;
  };

  const online = {
    uid: () => sessionAuth.currentUser?.uid ?? null,

    // Signs in with Google, keeping this session if the account is new here. It has to follow
    // a click, or browsers block the pop-up.
    async signInWithGoogle() {
      await signedIn();
      if (test) {
        const credential = auth.GoogleAuthProvider.credential(JSON.stringify({sub: randomText(12), email: `${randomText(8)}@example.com`, email_verified: true}));
        await auth.linkWithCredential(sessionAuth.currentUser, credential);
        const uid = sessionAuth.currentUser.uid;
        if (!unlisted) {
          await fetch(`http://127.0.0.1:9000/creators/${uid}.json?ns=${EMULATOR_DATABASE}`, {method: "PUT", headers: {Authorization: "Bearer owner"}, body: "true"});
        }
        return;
      }
      try {
        await auth.linkWithPopup(sessionAuth.currentUser, new auth.GoogleAuthProvider());
      } catch (error) {
        if (error.code !== "auth/credential-already-in-use") throw error;
        await auth.signInWithCredential(sessionAuth, auth.GoogleAuthProvider.credentialFromError(error));
      }
    },

    async create({name, record}) {
      let uid;
      try {
        uid = await signedIn();
      } catch (error) {
        throw offline(error);
      }
      const id = randomText(12), key = randomText(32);
      try {
        await db.update(at("/"), {
          [`rooms/${id}`]: {creator: uid, seats: {0: {uid, name}}, record},
          [`invites/${id}`]: {[key]: true},
        });
      } catch (error) {
        if (denied(error)) throw new Refusal("not-on-list");
        throw offline(error);
      }
      return roomFor(id, 0, key);
    },

    // Who is in a room, and which seat is yours, if any.
    async preview(id) {
      const uid = await signedIn().catch(error => { throw offline(error); });
      const seats = await seatsOf(id);
      return {seats, mine: seatFor(seats, uid)};
    },

    async open(id) {
      const {mine} = await online.preview(id);
      if (mine === null) throw new Refusal("not-a-member");
      return roomFor(id, mine);
    },

    async join(id, key, {name}) {
      const {mine} = await online.preview(id);
      if (mine !== null) return roomFor(id, mine);
      try {
        await db.set(at(`rooms/${id}/seats/1`), {uid: online.uid(), name, key});
      } catch (error) {
        if (!denied(error)) throw offline(error);
        // Too late for the seat, or the wrong key: the seat says which.
        throw new Refusal((await seatsOf(id))[1] ? "seat-taken" : "wrong-key");
      }
      return roomFor(id, 1);
    },
  };
  if (test) online.test = {db, database};
  return online;
}
