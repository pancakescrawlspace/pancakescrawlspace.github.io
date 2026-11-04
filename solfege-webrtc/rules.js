// What may change in the record, and who may change it. The creator's browser asks this about
// every write, the guest's included: it's the only check there is. See ARCHITECTURE.md, section 11.
const isNumber = value => typeof value === "number";
const isEvery = (object, check) => Boolean(object) && typeof object === "object" && Object.entries(object).every(check);

const COUNT = {first: isNumber, later: isNumber, shown: isNumber};
const LAST = {note: isNumber, startNote: isNumber, outcome: value => value === "right" || value === "shown", tries: isNumber};
const fits = (object, fields) => isEvery(object, ([field, value]) => field in fields && fields[field](value));

const FIELDS = {
  turn: isNumber,
  phase: value => value === "roles" || value === "choosing" || value === "guessing",
  round: isNumber,
  speler: value => value === 0 || value === 1,
  startNote: value => isNumber(value) && value >= 48 && value <= 72,
  note: isNumber,
  guess: isNumber,
  tries: isNumber,
  wrong: value => isEvery(value, ([, wrong]) => wrong === true),
  last: value => fits(value, LAST),
  score: value => isEvery(value, ([, count]) => fits(count, COUNT)),
};
const wellMade = record => fits(record, FIELDS) && ["turn", "phase", "round", "startNote", "score"].every(field => field in record);

// Whether `seat` may turn the record `before` into `after`. `seats` says who is in the room.
export function allowed(before, after, seat, seats) {
  if (!wellMade(after) || after.turn !== before.turn + 1) return false;
  const same = field => after[field] === before[field];
  const from = before.phase, to = after.phase;

  if (from === "roles" && to === "choosing") return seat === 0 && Boolean(seats[1]) && "speler" in after && !("note" in after) && same("round");
  if (from === "choosing" && to === "roles") return seat === 0 && !("note" in after) && same("round");
  if (from === "choosing" && to === "guessing") {
    return seat === before.speler && same("speler") && same("startNote") && after.note !== before.startNote
      && Math.abs(after.note - before.startNote) <= 12 && after.tries === 0 && after.round === before.round + 1;
  }
  if (from !== "guessing" || seat !== 1 - before.speler || !same("speler") || !same("startNote") || !same("round")) return false;
  if (to === "guessing") return same("note") && "guess" in after && after.guess !== before.note && after.tries === before.tries + 1;
  if (to !== "choosing" || "note" in after || after.last?.note !== before.note || after.last.startNote !== before.startNote) return false;
  return after.last.outcome === "right" ? after.guess === before.note : !("guess" in after);
}
