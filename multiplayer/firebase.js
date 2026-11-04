// The multiplayer layer on Firebase's Realtime Database: the same interface as
// client.js's rooms on our own server, with the access checks in security rules
// (firebase/database.rules.json) instead of Python. client.js loads this only when a
// game is configured for Firebase. See firebase/README.md.
//
// In the database, per room: `seats` and who may read them, `members` (who is in it),
// `record` (the turn counter and the state), and `present` (who has it open). The
// state is always one string, because the database doesn't keep empty lists or nulls.
// Invite keys are at paths that can't be listed.
//
// Everyone signs in anonymously, as a session. To create games, a person also signs
// in with Google, and that account has to be on the list of creators, added by hand.
import {RoomRefusal, inviteLink, parseInvite, scrambled, unscrambled} from "./client.js";

const SDK = "https://www.gstatic.com/firebasejs/11.10.0";
const ROOM_ID_LETTERS = "abcdefghijklmnopqrstuvwxyz234567";
// For the tests, on Firebase's emulator, with no account or real project.
const EMULATOR_PROJECT = "demo-solfege";
const EMULATOR_DATABASE = `${EMULATOR_PROJECT}-default-rtdb`;
const EMULATOR_CONFIG = {apiKey: "not-needed-for-the-emulator", projectId: EMULATOR_PROJECT, authDomain: "localhost",
                         databaseURL: `http://127.0.0.1:9000?ns=${EMULATOR_DATABASE}`};

const randomText = length => Array.from(crypto.getRandomValues(new Uint8Array(length)), byte => ROOM_ID_LETTERS[byte % 32]).join("");

export async function connectFirebase({game, config, emulator = false, listOnSignIn = true, sessionName = "multiplayer.session", page, scramble = false} = {}) {
  if (emulator) config = EMULATOR_CONFIG;
  const [{initializeApp, getApps}, auth, db] = await Promise.all([
    import(`${SDK}/firebase-app.js`), import(`${SDK}/firebase-auth.js`), import(`${SDK}/firebase-database.js`),
  ]);
  // An app per session name: each keeps its own sign-in, which the tests use as separate browsers.
  const name = sessionName.replace(/[^\w-]/g, "_");
  const app = getApps().find(each => each.name === name) ?? initializeApp(config, name);
  const session = auth.getAuth(app);
  const database = db.getDatabase(app);
  if (emulator && !session.emulatorConfig) {
    auth.connectAuthEmulator(session, "http://127.0.0.1:9099", {disableWarnings: true});
    db.connectDatabaseEmulator(database, "127.0.0.1", 9000);
  }
  await session.authStateReady();
  async function signedIn() {
    if (!session.currentUser) await auth.signInAnonymously(session);
    return session.currentUser.uid;
  }
  const at = path => db.ref(database, path);
  const denied = error => /permission.denied/i.test(`${error?.code} ${error?.message}`);
  const read = async path => {
    try {
      return (await db.get(at(path))).val();
    } catch (error) {
      if (denied(error)) return undefined;
      throw error;
    }
  };

  const toSend = state => JSON.stringify(scramble ? scrambled(state) : state);
  const fromStore = text => unscrambled(JSON.parse(text));
  const seatList = seats => Array.isArray(seats) ? seats : Object.keys(seats ?? {}).sort((a, b) => a - b).map(key => seats[key]);
  const publicSeat = ({key, ...seat}) => seat;
  const makeRecord = (seats, inner) => ({version: 1, game, seats: seatList(seats).map(publicSeat), started: inner.started,
                                          current: inner.current, turn: inner.turn, state: fromStore(inner.state)});

  function roomFor(id, firstRecord, mySeat, invites = {}) {
    let record = firstRecord, seats = null, inner = null, connected = false, presence = null;
    const watchers = new Set(), stops = [];
    const deliver = () => {
      if (!seats || !inner) return;
      const news = makeRecord(seats, inner);
      if (news.turn < record.turn) return;
      record = news;
      for (const each of watchers) each(structuredClone(news));
    };
    const room = {
      id,
      online: true,
      mySeat,
      inviteLinks: Object.fromEntries(Object.entries(invites).map(([seat, key]) => [seat, inviteLink(id, seat, key, page)])),
      onConnection: () => {},
      present: null,
      onPresence: () => {},

      watch(watcher) {
        watchers.add(watcher);
        Promise.resolve().then(() => { if (watchers.has(watcher)) watcher(structuredClone(record)); });
        if (!stops.length) {
          stops.push(db.onValue(at(`rooms/${id}/seats`), snapshot => { seats = snapshot.val(); deliver(); }));
          stops.push(db.onValue(at(`rooms/${id}/record`), snapshot => { if (snapshot.val()) { inner = snapshot.val(); deliver(); } }));
          stops.push(db.onValue(at(`rooms/${id}/present`), snapshot => {
            room.present = [...new Set(Object.values(snapshot.val() ?? {}))].sort((a, b) => a - b);
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

      // Only one write can raise the turn counter: the rules see to that, and a
      // transaction tells us who was too late. Nothing shows until the server has it.
      async play({state, current}, _options = {}) {
        const seen = record.turn;
        let late = false;
        try {
          const result = await db.runTransaction(at(`rooms/${id}/record`), now => {
            if (now === null) return null;       // nothing known yet: the server corrects this
            if (now.turn !== seen) { late = true; return undefined; }
            return {started: now.started, current, turn: now.turn + 1, state: toSend(state)};
          }, {applyLocally: false});
          if (!result.committed) throw new RoomRefusal(late ? "stale" : "out-of-turn");
        } catch (error) {
          if (error instanceof RoomRefusal) throw error;
          if (!denied(error)) throw error;
          const inner = await read(`rooms/${id}/record`);
          if (inner === undefined) throw new RoomRefusal("not-a-member");
          if (!inner?.started) throw new RoomRefusal("not-started");
          throw new RoomRefusal(inner.turn !== seen ? "stale" : "out-of-turn");
        }
        db.set(at(`rooms/${id}/updated`), db.serverTimestamp()).catch(() => {});
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
    return room;
  }

  async function openRoom(id) {
    const uid = await signedIn();
    const seats = await read(`rooms/${id}/seats`);
    if (seats === null || seats === undefined) throw new RoomRefusal("no-such-room");
    const seat = await read(`rooms/${id}/members/${uid}`);
    if (seat === null || seat === undefined) throw new RoomRefusal("not-a-member");
    const inner = await read(`rooms/${id}/record`);
    return roomFor(id, makeRecord(seats, inner), seat);
  }

  // Creators' rooms nobody has opened for a long time: nothing runs by itself on
  // the free plan, so a creator's browser removes them when making a new one.
  async function forgetOldRooms(uid, olderThan = 60 * 24 * 3600 * 1000) {
    const mine = await read(`creatorRooms/${uid}`);
    for (const id of Object.keys(mine ?? {})) {
      const updated = await read(`rooms/${id}/updated`);
      if (updated === null || updated === undefined) {
        await db.remove(at(`creatorRooms/${uid}/${id}`)).catch(() => {});
      } else if (Date.now() - updated > olderThan) {
        await db.update(at("/"), {[`rooms/${id}`]: null, [`invites/${id}`]: null, [`creatorRooms/${uid}/${id}`]: null}).catch(() => {});
      }
    }
  }

  const mp = {
    // On Firebase, creating games takes a Google account on the list, not a password.
    usesGoogle: true,
    uid: () => session.currentUser?.uid ?? null,

    // Signs in with Google, keeping your session and its seats if that account is new here.
    async signIn() {
      await signedIn();
      const provider = new auth.GoogleAuthProvider();
      if (emulator) {
        // The emulator takes a made-up account, without a window to click in.
        const credential = auth.GoogleAuthProvider.credential(JSON.stringify({sub: randomText(12), email: `${randomText(8)}@example.com`, email_verified: true}));
        await auth.linkWithCredential(session.currentUser, credential);
        const uid = session.currentUser.uid;
        if (listOnSignIn) {                    // as you would add someone by hand in the console
          await fetch(`http://127.0.0.1:9000/creators/${uid}.json?ns=${EMULATOR_DATABASE}`, {method: "PUT", headers: {Authorization: "Bearer owner"}, body: "true"});
        }
        return uid;
      }
      try {
        await auth.linkWithPopup(session.currentUser, provider);
      } catch (error) {
        if (error.code !== "auth/credential-already-in-use") throw error;
        await auth.signInWithCredential(session, auth.GoogleAuthProvider.credentialFromError(error));
      }
      return session.currentUser.uid;
    },

    async create({seats, state, current = 0}) {
      const uid = await signedIn();
      const id = randomText(12);
      const creator = seats.findIndex(seat => seat.kind === "person");
      if (creator < 0) throw new RoomRefusal("no-seat-for-a-person");
      const stored = seats.map((seat, i) => i === creator ? {...seat, uid} : seat);
      const keys = {}, invites = {};
      seats.forEach((seat, i) => {
        if (seat.kind === "person" && i !== creator) {
          keys[i] = randomText(32);
          invites[i] = {[keys[i]]: true};
        }
      });
      const started = Object.keys(keys).length === 0;
      const inner = {started, current, turn: 0, state: toSend(state)};
      const changes = {
        [`rooms/${id}`]: {game, creator: uid, updated: db.serverTimestamp(), seats: stored, members: {[uid]: creator}, record: inner},
        [`creatorRooms/${uid}/${id}`]: true,
      };
      if (Object.keys(invites).length) changes[`invites/${id}`] = invites;
      try {
        await db.update(at("/"), changes);
      } catch (error) {
        if (denied(error)) throw new RoomRefusal("secret-needed");
        throw error;
      }
      forgetOldRooms(uid).catch(() => {});
      return roomFor(id, makeRecord(stored, inner), creator, keys);
    },

    open: openRoom,

    async preview(link) {
      const invite = parseInvite(link);
      if (!invite) throw new RoomRefusal("not-an-invite");
      const uid = await signedIn();
      const seats = await read(`rooms/${invite.room}/seats`);
      if (!seats) throw new RoomRefusal("no-such-room");
      const seat = await read(`rooms/${invite.room}/members/${uid}`);
      const list = seatList(seats);
      if (seat !== null && seat !== undefined) return {game, seats: list.map(publicSeat), joined: true, seat};
      if (list[invite.seat]?.uid) throw new RoomRefusal("seat-taken");
      return {game, seats: list.map(each => ({kind: each.kind, name: each.name ?? null, taken: Boolean(each.uid)}))};
    },

    async join(link, {name} = {}) {
      const invite = parseInvite(link);
      if (!invite) throw new RoomRefusal("not-an-invite");
      const uid = await signedIn();
      const room = invite.room;
      const seats = await read(`rooms/${room}/seats`);
      if (!seats) throw new RoomRefusal("no-such-room");
      const list = seatList(seats);
      const mine = await read(`rooms/${room}/members/${uid}`);
      if (mine === invite.seat) return openRoom(room);
      if (mine !== null && mine !== undefined) throw new RoomRefusal("already-in-room");
      const seat = list[invite.seat];
      if (!seat || seat.kind !== "person") throw new RoomRefusal("no-such-seat");
      if (seat.uid) throw new RoomRefusal("seat-taken");
      const updated = {...seat, uid, key: invite.key};
      const cleaned = (name ?? "").trim().slice(0, 40);
      if (cleaned) updated.name = cleaned;
      const last = list.every((each, i) => i === invite.seat || each.kind !== "person" || each.uid);
      const changes = {[`seats/${invite.seat}`]: updated, [`members/${uid}`]: invite.seat};
      if (last) changes["record/started"] = true;
      try {
        await db.update(at(`rooms/${room}`), changes);
      } catch (error) {
        if (!denied(error)) throw error;
        // Too late for the seat, or the wrong key: the seat says which.
        const now = seatList(await read(`rooms/${room}/seats`))[invite.seat];
        throw new RoomRefusal(now?.uid ? "seat-taken" : "wrong-key");
      }
      db.set(at(`rooms/${room}/updated`), db.serverTimestamp()).catch(() => {});
      return openRoom(room);
    },
  };
  if (emulator) {
    // For the tests: the database and the module, to try what a dishonest browser might.
    mp.test = {database, db, at, forgetOldRooms, signedIn, session};
  }
  return mp;
}
