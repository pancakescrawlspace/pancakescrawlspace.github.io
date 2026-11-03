// The computer player: given the moves so far, which column to play. It needs
// nothing else, so it runs the same in the Web Worker, on the page and in node.
//
// Easy plays by a rule of thumb. Medium and Hard use the same search, negamax
// with alpha-beta pruning: Medium looks a few moves ahead, and Hard looks as far
// as it can in its time. A search that reaches the end of the game has solved
// the position, and from there Hard plays perfectly.
//
// The board is a bitboard, as Pascal Pons explains in his solver's tutorial
// (blog.gamesolver.org). Each column has seven bits, the lowest for its bottom
// row and the top one always empty, so a cell is bit column * 7 + row, and lines
// can't wrap from one column into the next. Those 49 bits don't fit in one of
// JavaScript's 32-bit integers, so each bitboard is a pair: lo and hi.
"use strict";

const AI = (() => {
  const W = 7, H = 6, CELLS = W * H, WIN = 1000;
  const SOLVED = WIN - CELLS;          // scores at least this far from 0 are proven wins or losses
  const lo = i => i < 32 ? 1 << i : 0;
  const hi = i => i < 32 ? 0 : 1 << (i - 32);
  const LO = [], HI = [];              // the bit of each index
  for (let i = 0; i < W * (H + 1); i++) { LO.push(lo(i)); HI.push(hi(i)); }
  const maskOf = cells => {
    let l = 0, h = 0;
    for (const [c, r] of cells) { l |= LO[c * 7 + r]; h |= HI[c * 7 + r]; }
    return [l, h];
  };
  const allCells = [];
  for (let c = 0; c < W; c++) for (let r = 0; r < H; r++) allCells.push([c, r]);
  const [BOARD_LO, BOARD_HI] = maskOf(allCells);
  const [CENTRE_LO, CENTRE_HI] = maskOf(allCells.filter(([c]) => c === 3));
  const [NEAR_LO, NEAR_HI] = maskOf(allCells.filter(([c]) => c === 2 || c === 4));
  // Rows 1, 3 and 5 as people count them (r = 0, 2, 4), the ones where a threat
  // is worth most to the player who started; the others are worth most to the
  // other player, since near the end each tends to get the squares of their parity.
  const [ODD_LO, ODD_HI] = maskOf(allCells.filter(([, r]) => r % 2 === 0));
  const ORDER = [3, 2, 4, 1, 5, 0, 6];

  const TABLE_SIZE = 2097143;          // a prime; about 25 MB once it's in use
  let keys, values, depths, kinds;
  const heights = new Int8Array(W);
  let nodes = 0, deadline = Infinity;
  const OUT_OF_TIME = Symbol("out of time");

  const pop = x => {
    x -= (x >>> 1) & 0x55555555;
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    return (((x + (x >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24;
  };

  // The empty cells where a stone would complete a line for the player with
  // stones p, given all stones m. The result is left in SPOT_LO and SPOT_HI, so
  // that nothing has to be allocated at each of the millions of positions.
  let SPOT_LO = 0, SPOT_HI = 0;
  function threats(pl, ph, ml, mh) {
    let rl = (pl << 1) & (pl << 2) & (pl << 3);                  // three stacked below it
    let rh = ((ph << 1) | (pl >>> 31)) & ((ph << 2) | (pl >>> 30)) & ((ph << 3) | (pl >>> 29));
    for (let s = 6; s <= 8; s++) {                               // the two diagonals, and across
      const s2 = s * 2, s3 = s * 3;
      const a1l = pl << s, a1h = (ph << s) | (pl >>> (32 - s));
      const a2l = pl << s2, a2h = (ph << s2) | (pl >>> (32 - s2));
      const a3l = pl << s3, a3h = (ph << s3) | (pl >>> (32 - s3));
      const b1l = (pl >>> s) | (ph << (32 - s)), b1h = ph >>> s;
      const b2l = (pl >>> s2) | (ph << (32 - s2)), b2h = ph >>> s2;
      const b3l = (pl >>> s3) | (ph << (32 - s3)), b3h = ph >>> s3;
      const al = a1l & a2l, ah = a1h & a2h, bl = b1l & b2l, bh = b1h & b2h;
      rl |= (al & a3l) | (al & b1l) | (bl & a1l) | (bl & b3l);
      rh |= (ah & a3h) | (ah & b1h) | (bh & a1h) | (bh & b3h);
    }
    SPOT_LO = rl & BOARD_LO & ~ml;
    SPOT_HI = rh & BOARD_HI & ~mh;
  }

  // How good the position looks to the player to move, when the search stops
  // before the end: open threats, more so on rows of the right parity, and
  // stones in the middle, where most lines run. Always well below SOLVED.
  function evaluate(pl, ph, ml, mh, myLo, myHi, opLo, opHi, n) {
    const ol = pl ^ ml, oh = ph ^ mh;
    const goodLo = n % 2 === 0 ? ODD_LO : ~ODD_LO, goodHi = n % 2 === 0 ? ODD_HI : ~ODD_HI;
    return 8 * (pop(myLo) + pop(myHi) - pop(opLo) - pop(opHi))
      + 6 * (pop(myLo & goodLo) + pop(myHi & goodHi) - pop(opLo & ~goodLo) - pop(opHi & ~goodHi))
      + 3 * (pop(pl & CENTRE_LO) + pop(ph & CENTRE_HI) - pop(ol & CENTRE_LO) - pop(oh & CENTRE_HI))
      + (pop(pl & NEAR_LO) + pop(ph & NEAR_HI) - pop(ol & NEAR_LO) - pop(oh & NEAR_HI));
  }

  // The score of a position for the player to move, who has stones p, after n
  // stones in all: WIN minus the number of stones when the game ends, negative
  // for a loss, 0 for a draw, or an estimate if `depth` runs out first.
  function search(pl, ph, ml, mh, n, depth, alpha, beta) {
    if ((++nodes & 8191) === 0 && performance.now() > deadline) throw OUT_OF_TIME;
    if (n === CELLS) return 0;

    threats(pl, ph, ml, mh);
    const myLo = SPOT_LO, myHi = SPOT_HI;
    for (let c = 0; c < W; c++) {
      const h = heights[c];
      if (h < H && ((myLo & LO[c * 7 + h]) | (myHi & HI[c * 7 + h]))) return WIN - (n + 1);
    }
    const ol = pl ^ ml, oh = ph ^ mh;
    threats(ol, oh, ml, mh);
    const opLo = SPOT_LO, opHi = SPOT_HI;

    // The moves that don't lose at once: if the opponent threatens to win right
    // away, only the block; and never directly under a cell where they would win.
    let forced = -1;
    for (let c = 0; c < W; c++) {
      const h = heights[c];
      if (h < H && ((opLo & LO[c * 7 + h]) | (opHi & HI[c * 7 + h]))) {
        if (forced >= 0) return -(WIN - (n + 2));
        forced = c;
      }
    }
    let count = 0;
    const moves = [0, 0, 0, 0, 0, 0, 0];
    for (let i = 0; i < W; i++) {
      const c = ORDER[i], h = heights[c];
      if (h >= H || (forced >= 0 && c !== forced)) continue;
      if (h + 1 < H && ((opLo & LO[c * 7 + h + 1]) | (opHi & HI[c * 7 + h + 1]))) continue;
      moves[count++] = c;
    }
    if (count === 0) return -(WIN - (n + 2));

    // The best that can still happen: no win on the next stone (we checked), and no loss before the opponent's next but one.
    const most = WIN - (n + 3), least = -(WIN - (n + 4));
    if (beta > most) { beta = most; if (alpha >= beta) return beta; }
    if (alpha < least) { alpha = least; if (alpha >= beta) return alpha; }
    if (depth <= 0) {
      const score = evaluate(pl, ph, ml, mh, myLo, myHi, opLo, opHi, n);
      return score < alpha ? alpha : score > beta ? beta : score;
    }

    // Seen before, at least this deep? pos + mask is different for every position.
    const key = (ph + mh) * 4294967296 + (pl >>> 0) + (ml >>> 0);
    const slot = key % TABLE_SIZE;
    if (keys[slot] === key && depths[slot] >= depth) {
      const known = values[slot], kind = kinds[slot];
      if (kind === 0) return known;                               // exact
      if (kind === 1) { if (known > alpha) alpha = known; }       // at least
      else if (known < beta) beta = known;                        // at most
      if (alpha >= beta) return known;
    }
    const start = alpha;

    // Try first the moves that make the most new threats. Most positions are
    // settled by their first move, so this is where the search's speed comes from.
    if (count > 1) {
      const scores = [0, 0, 0, 0, 0, 0, 0];
      for (let i = 0; i < count; i++) {
        const c = moves[i], at = c * 7 + heights[c];
        threats(pl | LO[at], ph | HI[at], ml | LO[at], mh | HI[at]);
        const score = pop(SPOT_LO) + pop(SPOT_HI);
        let j = i;
        while (j > 0 && scores[j - 1] < score) { scores[j] = scores[j - 1]; moves[j] = moves[j - 1]; j--; }
        scores[j] = score;
        moves[j] = c;
      }
    }

    // A forced move costs no depth: it hardly widens the search, and traps run along such moves.
    const nextDepth = count === 1 ? depth : depth - 1;
    let best = -Infinity;
    for (let i = 0; i < count; i++) {
      const c = moves[i], at = c * 7 + heights[c];
      heights[c]++;
      const score = -search(ol, oh, ml | LO[at], mh | HI[at], n + 1, nextDepth, -beta, -alpha);
      heights[c]--;
      if (score > best) best = score;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    keys[slot] = key;
    values[slot] = best;
    depths[slot] = depth;
    kinds[slot] = best <= start ? 2 : best >= beta ? 1 : 0;
    return best;
  }

  function setUp(moves) {
    heights.fill(0);
    let pl = 0, ph = 0, ml = 0, mh = 0;      // p: the stones of the player to move
    for (const c of moves) {
      const at = c * 7 + heights[c]++;
      pl |= LO[at]; ph |= HI[at];
      ml |= LO[at]; mh |= HI[at];
      pl ^= ml; ph ^= mh;                    // now it is the other player's turn
    }
    return {pl, ph, ml, mh, n: moves.length};
  }

  function clearTable() {
    if (!keys) {
      keys = new Float64Array(TABLE_SIZE);
      values = new Int16Array(TABLE_SIZE);
      depths = new Int8Array(TABLE_SIZE);
      kinds = new Int8Array(TABLE_SIZE);
    } else keys.fill(0);
  }

  // Searches ever deeper until time runs out, the depth limit is reached or the
  // position is solved. Returns the columns that the last finished depth found
  // best (more than one if they score the same), their score, the depth, whether
  // that score is certain, and the number of positions looked at.
  function analyse(moves, {budget = Infinity, maxDepth = CELLS} = {}) {
    const {pl, ph, ml, mh, n} = setUp(moves);
    const ol = pl ^ ml, oh = ph ^ mh;
    let legal = ORDER.filter(c => heights[c] < H);
    nodes = 0;
    threats(pl, ph, ml, mh);
    const wins = legal.filter(c => (SPOT_LO & LO[c * 7 + heights[c]]) | (SPOT_HI & HI[c * 7 + heights[c]]));
    if (wins.length) return {columns: wins, score: WIN - (n + 1), depth: 0, solved: true, nodes};

    clearTable();
    deadline = performance.now() + budget;
    let result = null;
    const left = CELLS - n;
    for (let depth = 1; depth <= Math.min(maxDepth, left); depth++) {
      const scored = [];
      let best = -Infinity;
      try {
        for (const c of legal) {
          const at = c * 7 + heights[c];
          heights[c]++;
          // best - 1 as the bound, so that a move equal to the best gets its exact score too.
          const alpha = best === -Infinity ? -Infinity : best - 1;
          const score = -search(ol, oh, ml | LO[at], mh | HI[at], n + 1, depth - 1, -Infinity, -alpha);
          heights[c]--;
          scored.push([c, score]);
          if (score > best) best = score;
        }
      } catch (e) {
        if (e !== OUT_OF_TIME) throw e;
        if (result) break;
        // Not even one depth done, which only happens with almost no time: keep what there is.
        setUp(moves);
        if (!scored.length) return {columns: [legal[0]], score: 0, depth: 0, solved: false, nodes};
        result = {columns: scored.filter(([, s]) => s === best).map(([c]) => c), score: best, depth, solved: false, nodes};
        break;
      }
      const solved = Math.abs(best) >= SOLVED || depth === left;
      result = {columns: scored.filter(([, s]) => s === best).map(([c]) => c), score: best, depth, solved, nodes};
      if (solved) break;
      legal = [...scored].sort((a, b) => b[1] - a[1]).map(([c]) => c);     // the best so far first, next time
    }
    deadline = Infinity;
    return {...result, nodes};
  }

  // Easy: takes a win it can see, usually blocks yours, and otherwise tends
  // towards the middle, without looking any further.
  function easyMove(moves, random) {
    const {pl, ph, ml, mh} = setUp(moves);
    const legal = ORDER.filter(c => heights[c] < H);
    const hits = () => legal.filter(c => (SPOT_LO & LO[c * 7 + heights[c]]) | (SPOT_HI & HI[c * 7 + heights[c]]));
    threats(pl, ph, ml, mh);
    const wins = hits();
    if (wins.length) return wins[0];
    threats(pl ^ ml, ph ^ mh, ml, mh);
    const blocks = hits();
    if (blocks.length && random() < .75) return blocks[0];
    const weights = legal.map(c => 4 - Math.abs(c - 3));
    let pick = random() * weights.reduce((a, b) => a + b);
    for (let i = 0; i < legal.length; i++) if ((pick -= weights[i]) < 0) return legal[i];
    return legal[0];
  }

  // The column for the player to move. `budget` is Hard's thinking time in
  // milliseconds; `maxDepth`, if given, replaces it with a fixed depth.
  function computerMove(moves, level = "hard", {random = Math.random, budget = 1000, maxDepth} = {}) {
    if (moves.length >= CELLS) throw new RangeError("the board is full");
    if (level === "easy") return easyMove(moves, random);
    if (moves.length === 0) return 3;                             // the best first move, known from the game's solution
    const options = level === "medium" ? {maxDepth: maxDepth ?? 4} : maxDepth ? {maxDepth} : {budget};
    const {columns} = analyse(moves, options);
    return columns[Math.floor(random() * columns.length)];
  }

  return {computerMove, analyse, threatCells(moves) {
    const {pl, ph, ml, mh} = setUp(moves);
    threats(pl, ph, ml, mh);
    return allCells.filter(([c, r]) => (SPOT_LO & LO[c * 7 + r]) | (SPOT_HI & HI[c * 7 + r]));
  }};
})();
const computerMove = AI.computerMove;
