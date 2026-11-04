// The rules of the exercise, as pure functions: each takes a record and gives the next one,
// or throws if that change isn't allowed. The Worker runs this same file, and its result is
// what counts; the page uses what it needs to draw. See ARCHITECTURE.md, section 9.
import {compareAnswer, START_NOTES} from "./music.js";

const REACH = 12;
const emptyScore = () => ({first: 0, later: 0, shown: 0});

const checkPhase = (record, phase) => {
  if (record.phase !== phase) throw new Error(`not in ${phase}, but in ${record.phase}`);
};
// The score as an object, with new counts for its seats, since the database may give a list.
const withScore = (record, seat, count) => {
  const score = {0: {...record.score[0]}, 1: {...record.score[1]}};
  score[seat][count]++;
  return score;
};

export const luisteraar = record => 1 - record.speler;

// The seat that may act now. In roles it is the creator's, who always has seat 0.
export function writer(record) {
  if (record.phase === "roles") return 0;
  return record.phase === "choosing" ? record.speler : luisteraar(record);
}

export const newRecord = (startNote = 60) => ({turn: 0, phase: "roles", round: 0, startNote, score: {0: emptyScore(), 1: emptyScore()}});

export function assign(record, speler, startNote) {
  checkPhase(record, "roles");
  if (speler !== 0 && speler !== 1) throw new Error("no such seat");
  if (!START_NOTES.includes(startNote)) throw new Error("no such start note");
  return {...record, turn: record.turn + 1, phase: "choosing", speler, startNote};
}

export function changeRoles(record) {
  checkPhase(record, "choosing");
  return {...record, turn: record.turn + 1, phase: "roles"};
}

export function play(record, note) {
  checkPhase(record, "choosing");
  if (note === record.startNote || Math.abs(note - record.startNote) > REACH) throw new Error("not a note to play");
  const {guess, ...rest} = record;
  return {...rest, turn: record.turn + 1, phase: "guessing", round: record.round + 1, note, tries: 0};
}

// The end of a round. Its own fields go, and the result stays until the next one.
function ended(record, outcome, score, guess) {
  const {note, tries, wrong, guess: _, ...rest} = record;
  const next = {...rest, turn: record.turn + 1, phase: "choosing", score, last: {note, startNote: record.startNote, outcome, tries}};
  return guess === undefined ? next : {...next, guess};
}

export function answer(record, pitch) {
  checkPhase(record, "guessing");
  if (compareAnswer(pitch, record.note) === "right") {
    return ended(record, "right", withScore(record, luisteraar(record), record.tries ? "later" : "first"), pitch);
  }
  return {...record, turn: record.turn + 1, tries: record.tries + 1, guess: pitch, wrong: {...record.wrong, [pitch]: true}};
}

export function giveUp(record) {
  checkPhase(record, "guessing");
  return ended(record, "shown", withScore(record, luisteraar(record), "shown"));
}
