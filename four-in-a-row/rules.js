// The rules of Four in a Row: nothing but plain data in and out, with no page,
// no computer players and no idea of where a move comes from. Used by the page
// and the tests, and, when the game is played online, the referee in every
// player's browser.
//
// A game's whole state is a small JSON value, which is all that would have to
// travel between players:
//
//   {version: 1, first: 0, moves: [3, 3, 4], wins: [2, 1], draws: 0}
//
// `first` is the seat that started this game, `moves` the column of every move
// so far, in order, and `wins` and `draws` the score over the games so far.
// Everything else, the board too, follows from these.
"use strict";

const COLUMNS = 7, ROWS = 6, IN_A_ROW = 4, STATE_VERSION = 1;

function newState(first = 0, wins = [0, 0], draws = 0) {
  return {version: STATE_VERSION, first, moves: [], wins: [...wins], draws};
}

// The seat whose move it is, whether or not the game has ended.
function seatToMove(state) {
  return (state.first + state.moves.length) % 2;
}

// The board as seven columns, each a list of seats from the bottom up.
function boardOf(state) {
  const columns = Array.from({length: COLUMNS}, () => []);
  state.moves.forEach((column, i) => columns[column].push((state.first + i) % 2));
  return columns;
}

// All cells in a line of four or more through this cell, as [column, row]; a
// move can complete more than one line at once.
function linesThrough(columns, column, row) {
  const seat = columns[column][row];
  const cells = [];
  for (const [dc, dr] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
    const line = [[column, row]];
    for (const sign of [1, -1]) {
      for (let c = column + sign * dc, r = row + sign * dr; columns[c]?.[r] === seat; c += sign * dc, r += sign * dr) {
        line.push([c, r]);
      }
    }
    if (line.length >= IN_A_ROW) cells.push(...line);
  }
  return cells;
}

// {over, winner, line}: winner is a seat, or null while playing and for a draw.
// line is the winning cells, without doubles.
function outcome(state) {
  const columns = boardOf(state);
  if (state.moves.length) {
    const column = state.moves[state.moves.length - 1];
    const cells = linesThrough(columns, column, columns[column].length - 1);
    if (cells.length) {
      const seen = new Set(cells.map(String));
      return {over: true, winner: columns[column].at(-1), line: [...seen].map(s => s.split(",").map(Number))};
    }
  }
  return {over: state.moves.length === COLUMNS * ROWS, winner: null, line: []};
}

function legalColumns(state) {
  if (outcome(state).over) return [];
  const columns = boardOf(state);
  return columns.flatMap((stack, column) => stack.length < ROWS ? [column] : []);
}

// The state after `seat` plays in `column`, with the score brought up to date
// if that ends the game. The old state isn't changed. Throws on a move that
// isn't allowed, which the page never makes.
function playMove(state, seat, column) {
  if (seat !== seatToMove(state)) throw new RangeError(`it is not seat ${seat}'s turn`);
  if (!legalColumns(state).includes(column)) throw new RangeError(`column ${column} can't be played`);
  const next = {...state, moves: [...state.moves, column], wins: [...state.wins]};
  const {over, winner} = outcome(next);
  if (over) {
    if (winner === null) next.draws++;
    else next.wins[winner]++;
  }
  return next;
}

// The first game after a finished one, or any game: the same score, an empty board.
function nextGame(state, first = 1 - state.first) {
  return newState(first, state.wins, state.draws);
}

// Who writes the next turn, for the `current` of a shared record. While a game
// is on that is the player to move; after it, the player who would start the
// next game, so that one person is always the one to start it.
function nextCurrent(state) {
  return outcome(state).over ? 1 - state.first : seatToMove(state);
}

// Whether a value is a state at all: true for one that came from these rules.
// For anything from outside, such as the browser's storage or another player.
function validState(state) {
  if (state === null || typeof state !== "object") return false;
  const {version, first, moves, wins, draws} = state;
  const count = n => Number.isInteger(n) && n >= 0;
  if (version !== STATE_VERSION || (first !== 0 && first !== 1)) return false;
  if (!Array.isArray(moves) || moves.length > COLUMNS * ROWS) return false;
  if (!Array.isArray(wins) || wins.length !== 2 || !wins.every(count) || !count(draws)) return false;
  let replay = newState(first);
  for (const column of moves) {
    if (!legalColumns(replay).includes(column)) return false;
    replay = {...replay, moves: [...replay.moves, column]};
  }
  return true;
}

// The referee: whether `after` can follow `before` in one turn, written by
// `seat`. Returns null if so, or else a word for what is wrong. Both a move and
// the start of a next game are turns.
function checkTurn(before, after, seat) {
  if (!validState(after)) return "invalid";
  const {over} = outcome(before);
  if (over) {
    if (seat !== nextCurrent(before)) return "wrong-seat";
    if (after.moves.length || after.draws !== before.draws || String(after.wins) !== String(before.wins)) return "not-a-new-game";
    return null;
  }
  if (seat !== seatToMove(before)) return "wrong-seat";
  if (after.first !== before.first || after.moves.length !== before.moves.length + 1 ||
      before.moves.some((column, i) => after.moves[i] !== column)) return "not-one-move";
  const expected = playMove(before, seat, after.moves.at(-1));
  if (expected.draws !== after.draws || String(expected.wins) !== String(after.wins)) return "wrong-score";
  return null;
}
