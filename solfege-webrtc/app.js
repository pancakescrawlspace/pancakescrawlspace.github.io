// The page: it draws the record it is given, and works out the next one when someone acts. It
// never changes the screen after a write: everything comes in through receive().
// See ARCHITECTURE.md, sections 5, 12 and 13.
import {STRINGS} from "./texts.js";
import {START_NOTES, compareAnswer, keyboardKeys, noteName} from "./music.js";
import {assign, answer, changeRoles, giveUp, luisteraar, newRecord, play, writer} from "./round.js";
import {allowed} from "./rules.js";
import {Sound} from "./sound.js";
import {connect} from "./room.js";

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
// ?test uses the stand-in relay, and &session=<name> acts as a browser of its own. &noroute acts
// like a network that allows no direct connection.
const TEST = params.has("test"), SESSION = params.get("session") ?? "main";
const STORE = TEST ? `solfege-webrtc.test.${SESSION}.` : "solfege-webrtc.";
const LANG_KEY = `${STORE}lang`, NAME_KEY = `${STORE}name`, LAST_KEY = `${STORE}last`;
const kept = key => { try { return localStorage.getItem(key); } catch { return null; } };
const keep = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
const forget = key => { try { localStorage.removeItem(key); } catch {} };

let lang = kept(LANG_KEY) === "en" ? "en" : "nl";
const t = (key, ...args) => {
  const text = STRINGS[lang][key];
  return typeof text === "function" ? text(...args) : text;
};

const sound = new Sound();
const BOTH = record => [[record.startNote, 0, 1.0], [record.note, 1.2, 1.4]];
const SECOND = record => [[record.note, 0, 1.4]];
const KEY = pitch => [[pitch, 0, 0.9]];

let online = null, room = null, view = null;
let shownStart = null;       // the start note the keyboard was drawn for
let heardRound = 0;          // the last round that played by itself, or was there on opening
let sent = -1;               // the turn a write was last sent from

const me = () => room.mySeat;
const record = () => view.record;
const nameOf = seat => view.seats[seat]?.name ?? t("someone");
const iAmSpeler = () => record().phase !== "roles" && record().speler === me();
const iAmLuisteraar = () => record().phase !== "roles" && luisteraar(record()) === me();

function showMessage(text) {
  $("message").textContent = text ?? "";
  $("message").hidden = !text;
}
function showOnly(section) {
  for (const id of ["start", "join", "game"]) $(id).hidden = id !== section;
}
const homeAddress = () => location.pathname + (TEST ? `?test&session=${SESSION}` : "");

// --- going online -----------------------------------------------------------------------

const REFUSALS = {offline: "noConnection", "not-a-member": "notInRoom", "seat-taken": "seatTaken", "open-elsewhere": "openElsewhere", "no-route": "noRoute"};

async function goOnline() {
  online ??= await connect({test: TEST, session: SESSION, check: allowed, noRoute: TEST && params.has("noroute"),
                            page: location.origin + location.pathname + (TEST ? "?test" : "")});
  return online;
}
function backToStart(error) {
  console.warn(error);
  if (error.code === "not-a-member") forget(LAST_KEY);
  history.replaceState(null, "", homeAddress());
  showStart();
  showMessage(t(REFUSALS[error.code] ?? "noConnection"));
}
function showStart() {
  $("start-name").value = kept(NAME_KEY) ?? "";
  $("continue").hidden = !kept(LAST_KEY);
  showOnly("start");
}

async function createGame() {
  showMessage(null);
  const name = $("start-name").value.trim() || t("someone");
  keep(NAME_KEY, name);
  try {
    enter(await (await goOnline()).create({name, record: newRecord()}), true);
  } catch (error) {
    backToStart(error);
  }
}
$("create").addEventListener("click", createGame);
$("continue").addEventListener("click", () => {
  const url = new URL(homeAddress(), location.href);
  url.searchParams.set("room", kept(LAST_KEY));
  location.href = url.href;
});

// An address with a room in it: back to a game you're in, or joining with the key after the #.
async function openAddress(id) {
  const hash = new URLSearchParams(location.hash.slice(1)), key = hash.get("key");
  try {
    const connected = await goOnline();
    const {seats, mine} = connected.preview(id, {from: hash.get("from")});
    if (mine !== null) { enter(await connected.open(id)); return; }
    if (!key) throw {code: "not-a-member"};
    const host = seats[0]?.name ?? t("someone");
    $("join-note").textContent = t("joinNote", host);
    $("join-name").value = kept(NAME_KEY) ?? "";
    showOnly("join");
    $("join-button").onclick = async () => {
      const name = $("join-name").value.trim() || t("someone");
      keep(NAME_KEY, name);
      $("join-button").disabled = true;
      $("join-waiting").textContent = t("joinWaiting", host);
      $("join-waiting").hidden = false;
      try {
        enter(await connected.join(id, key, {name}));
      } catch (error) {
        backToStart(error);
      }
    };
  } catch (error) {
    backToStart(error);
  }
}

function enter(newRoom, justMade = false) {
  room = newRoom;
  keep(LAST_KEY, room.id);
  const url = new URL(location.href);
  url.searchParams.set("room", room.id);
  url.hash = "";
  history[justMade ? "pushState" : "replaceState"](null, "", url);
  showMessage(null);
  showOnly("game");
  room.onConnection = connected => { $("connection").hidden = connected; if (view) render(); };
  room.onRoute = noRoute => { $("no-route").hidden = !noRoute; };
  room.onPresence = () => { if (view) render(); };
  room.watch(receive);
}

// --- every change comes in here ---------------------------------------------------------

function receive(news) {
  const first = !view;
  view = news;
  const {phase, round} = record();
  if (first) {
    heardRound = round;
  } else if (phase === "guessing" && round !== heardRound) {
    heardRound = round;
    if (iAmLuisteraar() && !sound.locked()) sound.play(BOTH(record()));
  }
  render();
}

async function send(next) {
  sent = record().turn;
  try {
    await room.write(next);
  } catch (error) {
    sent = -1;
    console.warn(error);
    if (error.code !== "stale") showMessage(t("notAccepted"));   // if stale, a newer record is on its way
  }
}
const waitingForRecord = () => sent === record().turn;

// --- drawing ----------------------------------------------------------------------------

function drawKeyboard(start) {
  const {keys, whites} = keyboardKeys(start);
  const keyboard = $("keyboard");
  keyboard.replaceChildren();
  keyboard.style.setProperty("--whites", whites);
  for (const key of keys) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = `key ${key.black ? "black" : "white"}${key.start ? " start" : ""}`;
    el.dataset.pitch = key.pitch;
    el.setAttribute("aria-label", noteName(key.pitch));
    if (key.black) {
      el.style.left = `${key.left}%`;
      el.style.width = `${key.width}%`;
    }
    if (key.label) el.append(key.label);
    keyboard.append(el);
  }
  shownStart = start;
  $("keyboard-box").hidden = false;
  const box = $("keyboard-box"), startKey = keyboard.querySelector(".start");
  box.scrollLeft = startKey.offsetLeft + startKey.offsetWidth / 2 - box.clientWidth / 2;
}

function renderSeat(seat) {
  const el = $(`seat-${seat}`), info = view.seats[seat], r = record();
  const present = room.present;
  const away = info && seat !== me() && $("connection").hidden && present && !present.includes(seat);
  el.querySelector(".name").textContent = !info ? t("invited")
    : `${nameOf(seat)}${seat === me() ? ` (${t("you")})` : ""}${away ? ` · ${t("away")}` : ""}`;
  const hasRole = r.speler !== undefined && r.phase !== "roles";
  el.querySelector(".role").textContent = !hasRole ? "" : r.speler === seat ? t("speler") : t("luisteraar");
  const {first, later, shown} = r.score[seat];
  el.querySelector(".score").textContent = t("score", first, later, shown);
}

function renderRoles() {
  const open = room.iCreated && record().phase === "roles" && Boolean(view.seats[1]);
  const wasOpen = !$("roles").hidden;
  $("roles").hidden = !open;
  if (!open) return;
  const form = $("roles-who");
  const chosen = form.querySelector("input:checked")?.value ?? String(record().speler ?? 0);
  form.querySelectorAll("label").forEach(label => label.remove());
  for (const seat of [0, 1]) {
    const label = document.createElement("label"), input = document.createElement("input");
    input.type = "radio";
    input.name = "speler";
    input.value = seat;
    input.checked = String(seat) === chosen;
    label.append(input, ` ${nameOf(seat)}`);
    form.append(label);
  }
  const select = $("roles-start");
  const value = wasOpen ? select.value : String(record().startNote);
  select.replaceChildren(...START_NOTES.map(note => new Option(noteName(note), note)));
  select.value = value;
}

function renderMessages() {
  const r = record(), other = 1 - me();
  let said = "", result = "", kind = "";
  if (r.phase === "roles") {
    if (!view.seats[1]) said = t("waitingGuest");
    else if (!room.iCreated) said = t("waitingRoles", nameOf(0));
  } else if (r.phase === "choosing") {
    said = iAmSpeler() ? t("playNote") : t("waitingFor", nameOf(other));
  } else {
    said = iAmLuisteraar() ? t("listen") : t("listening", nameOf(other));
  }
  if (r.phase !== "guessing" && r.last) {
    const right = r.last.outcome === "right";
    result = t(right ? "right" : "itWas", noteName(r.last.note));
    if (right) kind = "yes";
  } else if (r.phase === "guessing" && r.tries && iAmLuisteraar()) {
    result = compareAnswer(r.guess, r.note) === "octave" ? t("wrongOctave") : t("notThat");
    kind = "no";
  }
  $("said").textContent = said;
  $("result").textContent = result;
  $("result").className = kind;
}

function renderKeys() {
  const r = record();
  if (r.phase === "roles") {
    $("keyboard-box").hidden = true;
    return;
  }
  if (shownStart !== r.startNote) drawKeyboard(r.startNote);
  $("keyboard-box").hidden = false;
  const choosing = r.phase === "choosing" && iAmSpeler(), guessing = r.phase === "guessing" && iAmLuisteraar();
  const wrong = r.wrong ?? {};
  $("keyboard").classList.toggle("active", choosing || guessing);
  for (const el of $("keyboard").children) {
    const pitch = Number(el.dataset.pitch);
    el.disabled = !(choosing && pitch !== r.startNote) && !guessing;
    el.classList.toggle("wrong", r.phase === "guessing" && Boolean(wrong[pitch]));
    el.classList.toggle("note", r.phase === "guessing" && iAmSpeler() && pitch === r.note);
    el.classList.toggle("right", r.phase === "choosing" && r.last?.note === pitch && r.last.startNote === r.startNote);
  }
}

function setTitle() {
  const mine = view && room && writer(record()) === me() && (record().phase !== "roles" || Boolean(view.seats[1]));
  document.title = mine && document.hidden ? `● ${t("yourTurn")} · ${t("title")}` : t("title");
}
addEventListener("visibilitychange", setTitle);

function render() {
  if (!view) return;
  const r = record();
  renderSeat(0);
  renderSeat(1);
  renderRoles();
  renderMessages();
  renderKeys();
  $("invite").hidden = !(room.iCreated && !view.seats[1]);
  $("invite-link").value = room.inviteLink ?? "";
  const listening = r.phase === "guessing" && iAmLuisteraar();
  $("buttons").hidden = !listening;
  $("sound-notice").hidden = !(listening && sound.locked());
  $("change-roles").hidden = !(room.iCreated && r.phase === "choosing");
  setTitle();
}

// --- input ------------------------------------------------------------------------------

// Browsers only allow sound after a click, so any click unlocks it.
document.addEventListener("click", () => {
  sound.unlock();
  if (view) render();
}, {capture: true});

$("keyboard").addEventListener("click", e => {
  const key = e.target.closest(".key");
  if (!key || key.disabled || !view || waitingForRecord()) return;
  const pitch = Number(key.dataset.pitch), r = record();
  if (r.phase === "choosing" && iAmSpeler()) {
    sound.play(KEY(pitch));
    send(play(r, pitch));
  } else if (r.phase === "guessing" && iAmLuisteraar()) {
    if (compareAnswer(pitch, r.note) !== "right") sound.play(KEY(pitch));
    send(answer(r, pitch));
  }
});

const playBoth = () => { sound.play(BOTH(record())); render(); };
const playSecond = () => { sound.play(SECOND(record())); render(); };
const showAnswer = () => { if (!waitingForRecord()) send(giveUp(record())); };
$("play-both").addEventListener("click", playBoth);
$("play-second").addEventListener("click", playSecond);
$("give-up").addEventListener("click", showAnswer);

// The shortcuts stand in for the luisteraar's buttons, and never for the piano.
document.addEventListener("keydown", e => {
  if (!view || record().phase !== "guessing" || !iAmLuisteraar()) return;
  if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest?.("input, select, textarea")) return;
  const key = e.key.toLowerCase();
  if (key === " ") playBoth();
  else if (key === "p") playSecond();
  else if (key === "s") showAnswer();
  else return;
  e.preventDefault();
});

$("begin").addEventListener("click", () => {
  if (waitingForRecord()) return;
  send(assign(record(), Number($("roles-who").querySelector("input:checked").value), Number($("roles-start").value)));
});
$("change-roles").addEventListener("click", () => { if (!waitingForRecord()) send(changeRoles(record())); });
$("copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("invite-link").value);
    showMessage(null);
    $("said").textContent = t("copied");
  } catch {
    $("invite-link").select();           // no clipboard here: it can be copied by hand
  }
});

// --- language ---------------------------------------------------------------------------

function setLanguage(name) {
  lang = name;
  keep(LANG_KEY, name);
  document.documentElement.lang = name;
  for (const el of document.querySelectorAll("[data-t]")) el.innerHTML = t(el.dataset.t);
  for (const el of document.querySelectorAll("[data-t-title]")) el.title = t(el.dataset.tTitle);
  for (const button of document.querySelectorAll("[data-lang]")) button.setAttribute("aria-pressed", button.dataset.lang === name);
  setTitle();
  render();
}
for (const button of document.querySelectorAll("[data-lang]")) button.addEventListener("click", () => setLanguage(button.dataset.lang));

// --- starting ---------------------------------------------------------------------------

// Leaving the page ends its connection. A browser that later brings the page back from its
// back-and-forward cache would show a game with nothing behind it.
addEventListener("pageshow", event => { if (event.persisted) location.reload(); });
setLanguage(lang);
$("home").href = homeAddress();
const wanted = params.get("room");
if (wanted) openAddress(wanted);
else showStart();
if (!TEST && "serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(e => console.warn(e));
if (TEST) window.app = {sound, t, get room() { return room; }, get view() { return view; }, get online() { return online; }, record: () => view?.record};
