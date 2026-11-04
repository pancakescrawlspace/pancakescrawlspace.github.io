// Tile Rummy's rules, and the computer players. Everything here works on tile
// ids alone and doesn't touch a page, so the same file runs in the page
// (index.html), in the Web Worker that computes the computer players' moves
// (worker.js), and in node for the tests (test/run.mjs).
//
// What is in it:
// - the tiles, and analyse() and normalize() for sets;
// - solve(): the search behind "strong" opponents, with a budget;
// - solveExact(): the dynamic program behind "optimal" opponents, in JavaScript;
// - wasmSolver(): the same dynamic program compiled from solver.c to
//   WebAssembly, which is faster;
// - realize(), simpleMove() and computerMove(): turning a solution into a move;
// - dealGame(), checkPlay(), playTiles(), drawTiles() and advanceTurn(): the rules
//   of a turn, on the game's shared state;
// - checkTurn(): the referee, which checks a state that came from elsewhere.
"use strict";


// 106 tiles: 1-13 in four colours, twice, and two jokers. A tile's id never
// changes; its kind (0-51, by value and then colour, or 52 for a joker) is what
// the solver counts.
const TILES = [];
for (let copy = 0; copy < 2; copy++) {
  for (let c = 0; c < 4; c++) for (let v = 1; v <= 13; v++) TILES.push({id: TILES.length, c, v, joker: false});
}
TILES.push({id: 104, c: 0, v: 0, joker: true}, {id: 105, c: 1, v: 0, joker: true});
const JOKER = 52;
const kindOf = id => TILES[id].joker ? JOKER : (TILES[id].v - 1) * 4 + TILES[id].c;
const penalty = id => TILES[id].joker ? 30 : TILES[id].v;
const rackValue = rack => rack.reduce((sum, id) => sum + penalty(id), 0);

// Whether tiles, in this order, are a valid set: a run (three or more
// consecutive numbers in one colour, 1 never after 13) or a group (three or four
// of a number in different colours). Gives its points, and what each tile
// stands for, which only says something new for a joker.
function analyse(ids) {
  const n = ids.length;
  if (n < 3) return null;
  const real = [];
  ids.forEach((id, i) => { if (!TILES[id].joker) real.push([TILES[id], i]); });
  if (!real.length) return null;
  const [first, at] = real[0];
  const start = first.v - at;
  if (start >= 1 && start + n - 1 <= 13 && real.every(([t, i]) => t.c === first.c && t.v === start + i)) {
    return {run: true, points: n * start + n * (n - 1) / 2, reps: ids.map((_, i) => ({v: start + i, c: first.c}))};
  }
  if (n <= 4 && real.every(([t]) => t.v === first.v) && new Set(real.map(([t]) => t.c)).size === real.length) {
    const missing = [0, 1, 2, 3].filter(c => !real.some(([t]) => t.c === c));
    let m = 0;
    return {run: false, points: first.v * n,
            reps: ids.map(id => ({v: first.v, c: TILES[id].joker ? missing[m++] : TILES[id].c}))};
  }
  return null;
}

// Puts a set in the order it reads best: a run as it is if it is one already,
// or else from low to high with jokers in the gaps; a group by colour with its
// jokers last. A set that is neither stays as it is.
function normalize(ids) {
  const a = analyse(ids);
  if (a?.run) return ids;
  const real = ids.filter(id => !TILES[id].joker), jokers = ids.filter(id => TILES[id].joker);
  if (!real.length) return ids;
  const group = [...real].sort((x, y) => TILES[x].c - TILES[y].c).concat(jokers);
  if (analyse(group)) return group;
  const byValue = [...real].sort((x, y) => TILES[x].v - TILES[y].v);
  const left = jokers.slice(), run = [];
  byValue.forEach((id, i) => {
    if (i) for (let gap = TILES[id].v - TILES[byValue[i - 1]].v - 1; gap > 0 && left.length; gap--) run.push(left.shift());
    run.push(id);
  });
  // Jokers left over go at the high end, or the low end once that is 13.
  let low = TILES[byValue[0]].v;
  while (left.length) {
    if (low + run.length - 1 < 13) run.push(left.shift());
    else { run.unshift(left.shift()); low--; }
  }
  return analyse(run) ? run : ids;
}

// The solver. Given the tiles on the table, which must all stay there, and a
// rack, finds the arrangement of all the table's tiles and some of the rack's
// into valid sets that plays the most from the rack (byPoints: the most points,
// for a first meld). It goes through the tiles from low to high; the lowest one
// left is either left on the rack or is the lowest real tile of a set, so each
// arrangement is tried about once, and states it has seen are remembered.
// Returns {sets: [[{k, fromRack}]], count, points}, null if the table can't be
// arranged at all, or {tooBig: true} once it has looked at `budget` states.
function solve(tableIds, rackIds, byPoints = false, budget = 250000) {
  const M = new Array(53).fill(0), O = new Array(53).fill(0);   // must be played, may be played
  for (const id of tableIds) M[kindOf(id)]++;
  for (const id of rackIds) O[kindOf(id)]++;
  const memo = new Map();
  let states = 0;
  const worth = v => byPoints ? v * 1000 + 1 : 1000 + v;
  const keyOf = pos => {
    let key = pos + ":" + (M[JOKER] * 3 + O[JOKER]) + ":";
    for (let k = pos; k < 52; k++) key += M[k] * 3 + O[k];
    return key;
  };
  // Takes a tile of a kind, from the table's first; says whether it came from the rack.
  const take = k => { if (M[k]) { M[k]--; return false; } O[k]--; return true; };
  const putBack = (k, fromRack) => { if (fromRack) O[k]++; else M[k]++; };

  // Every set whose lowest real tile is of kind pos, as its kinds in order.
  function setsFrom(pos) {
    const v = (pos >> 2) + 1, c = pos & 3, J = M[JOKER] + O[JOKER], out = [];
    const others = [];
    for (let c2 = c + 1; c2 < 4; c2++) if (M[pos + c2 - c] + O[pos + c2 - c]) others.push(pos + c2 - c);
    for (let mask = 0; mask < 1 << others.length; mask++) {
      const kinds = others.filter((_, i) => mask >> i & 1);
      for (let j = 0; j <= J; j++) {
        const n = 1 + kinds.length + j;
        if (n >= 3 && n <= 4) out.push({run: false, v, kinds: [pos, ...kinds, ...Array(j).fill(JOKER)]});
      }
    }
    for (let lead = 0; lead <= Math.min(J, v - 1); lead++) {
      const seq = [...Array(lead).fill(JOKER), pos];
      const extend = (w, jokers) => {
        if (seq.length >= 3) out.push({run: true, start: v - lead, kinds: seq.slice()});
        if (w > 13) return;
        const k = (w - 1) * 4 + c;
        if (M[k] + O[k]) { seq.push(k); extend(w + 1, jokers); seq.pop(); }
        if (jokers) { seq.push(JOKER); extend(w + 1, jokers - 1); seq.pop(); }
      };
      extend(v + 1, J - lead);
    }
    return out;
  }

  const first = pos => { while (pos < 52 && M[pos] + O[pos] === 0) pos++; return pos; };
  function best(pos) {
    pos = first(pos);
    if (pos === 52) return M[JOKER] ? -Infinity : 0;   // a joker from the table can't be left over
    const key = keyOf(pos);
    const seen = memo.get(key);
    if (seen) return seen.score;
    if (++states > budget) throw solve.TooBig;
    let score = -Infinity, choice = null;
    if (!M[pos]) {                                       // leave this one on the rack
      O[pos]--;
      score = best(pos);
      O[pos]++;
    }
    for (const set of setsFrom(pos)) {
      const fromRack = set.kinds.map(take);
      let gain = 0;
      fromRack.forEach((r, i) => { if (r) gain += worth(set.run ? set.start + i : set.v); });
      const rest = best(pos);
      if (rest + gain > score) { score = rest + gain; choice = set; }
      set.kinds.forEach((k, i) => putBack(k, fromRack[i]));
    }
    memo.set(key, {score, choice});
    return score;
  }

  try {
    if (best(0) === -Infinity) return null;
  } catch (e) {
    if (e === solve.TooBig) return {tooBig: true};
    throw e;
  }
  // Follow the choices from the start to read off the sets.
  const sets = [];
  let count = 0, points = 0;
  for (let pos = first(0); pos < 52; pos = first(pos)) {
    const {choice} = memo.get(keyOf(pos));
    if (!choice) { O[pos]--; continue; }
    sets.push(choice.kinds.map((k, i) => {
      const fromRack = take(k);
      if (fromRack) { count++; points += choice.run ? choice.start + i : choice.v; }
      return {k, fromRack};
    }));
  }
  return {sets, count, points};
}
solve.TooBig = Symbol("too big");

// Turns the solver's sets back into tile ids. Sets that are on the table
// already keep their tiles and their place, so the table doesn't shuffle more
// than the move needs; the rest take the places of the sets that changed.
function realize(table, sets, rack) {
  const sig = kinds => kinds.join(",");
  const taken = new Set();
  const kept = table.map(set => {
    const s = sig(set.map(kindOf));
    const i = sets.findIndex((parts, i) => !taken.has(i) && parts.every(p => !p.fromRack) && sig(parts.map(p => p.k)) === s);
    if (i < 0) return null;
    taken.add(i);
    return set.slice();
  });
  const pools = [new Map(), new Map()];   // table tiles that are free to move, and the rack's, by kind
  const add = (map, id) => { const k = kindOf(id); if (!map.has(k)) map.set(k, []); map.get(k).push(id); };
  table.forEach((set, i) => { if (!kept[i]) set.forEach(id => add(pools[0], id)); });
  rack.forEach(id => add(pools[1], id));
  const fresh = sets.filter((_, i) => !taken.has(i))
    .map(parts => normalize(parts.map(p => pools[p.fromRack ? 1 : 0].get(p.k).pop())));
  const out = kept.map(set => set ?? fresh.shift() ?? null).filter(Boolean);
  return out.concat(fresh);
}

// The simple way to play: sets from the rack alone, and then (after the first
// meld) single tiles onto the ends of sets on the table, while any fit.
function simpleMove(table, rack, melded) {
  const own = solve([], rack, !melded, 120000);
  let next = table.map(set => set.slice()), left = rack.slice(), points = 0;
  if (own && !own.tooBig && own.count) {
    for (const set of realize([], own.sets, rack)) {
      next.push(set);
      points += analyse(set).points;
      left = left.filter(id => !set.includes(id));
    }
  }
  if (!melded) return {table: next, rack: left, points};
  for (let again = true; again;) {
    again = false;
    tiles: for (const id of left) {
      for (let i = 0; i < next.length; i++) {
        for (const tryIt of [[...next[i], id], [id, ...next[i]]]) {
          if (analyse(normalize(tryIt))) {
            next[i] = normalize(tryIt);
            left = left.filter(x => x !== id);
            again = true;
            break tiles;
          }
        }
      }
    }
  }
  return {table: next, rack: left, points};
}

// The exact solver, for "optimal" opponents: a dynamic program over the values
// 1 to 13, after van Rijn, Takes and Vis, "The Complexity of Rummikub Problems"
// (2015). It grows runs one value at a time, so all it needs to know when it
// goes on to the next value is, for each colour, how many open runs are 1, 2,
// or 3 and more long, and how many jokers it has used: the tiles at higher
// values are part of the question, not of the state. A run of 1 or 2 must go
// on, so every run ends valid. The tiles of a value left over after the runs
// go into groups as well as they can. Same arguments and result as solve().
//
// solver.c is the same program in C, line for line, for WebAssembly; a change
// here belongs there too, and the tests check that the two agree.
const solveExact = (() => {
  const NONE = -2147483648;
  const TABLE_BITS = 18, TABLE_SIZE = 1 << TABLE_BITS, MAX_MOVES = 256;
  // The best result from each state, in a hash table that is made on first
  // use. An entry belongs to this call when its generation is this call's, so
  // nothing needs clearing between calls.
  let keys, generationOf, scoreOf, movesOf, groupsOf, moveBuffers;
  let generation = 0, filled = 0, full = false;
  const must = new Int32Array(53), may = new Int32Array(53);   // must be played (the table's), may be played (the rack's)
  let byPoints = false, jokers = 0;
  const worth = v => byPoints ? v * 1000 + 1 : 1000 + v;

  // A state: the value v, the jokers used u, and per colour n1 + 5 n2 + 25 n3
  // for n1 open runs of 1, n2 of 2 and n3 of 3 or more (at most 4 in all).
  const keyOf = (v, code, u) => v + 16 * (u + 4 * (code[0] + 128 * (code[1] + 128 * (code[2] + 128 * code[3]))));
  function slot(key) {
    const lo = key % 4294967296, hi = (key - lo) / 4294967296;
    let i = (Math.imul(lo | 0, 0x9E3779B1) ^ Math.imul(hi | 0, 0x85EBCA77)) >>> (32 - TABLE_BITS);
    while (generationOf[i] === generation && keys[i] !== key) i = (i + 1) & (TABLE_SIZE - 1);
    return i;
  }

  // What one colour can do at value v, into out, 6 numbers each: the real
  // tiles it takes, the jokers that continue runs, the runs it starts after one
  // joker (s1) and after two (s2), the colour's next code, and all of it packed
  // 3 bits each: of its runs of 3 or more, e end, r3 go on with a real tile and
  // j3 with a joker; its runs of 2 and 1 all go on (r2, j2, r1, j1); and s0,
  // s1, s2 new runs start with a real tile after 0, 1 or 2 jokers.
  function movesFor(code, have, left, v, out) {
    const n1 = code % 5, n2 = Math.floor(code / 5) % 5, n3 = Math.floor(code / 25);
    // New runs need room to grow three long, and values for their jokers.
    const most0 = v <= 11 ? 4 : 0, most1 = v >= 2 && v <= 12 ? 4 : 0, most2 = v >= 3 ? 4 : 0;
    let count = 0;
    for (let e = 0; e <= n3; e++) {
      for (let r3 = 0; r3 <= n3 - e; r3++) {
        const j3 = n3 - e - r3;
        for (let r2 = 0; r2 <= n2; r2++) {
          const j2 = n2 - r2;
          for (let r1 = 0; r1 <= n1; r1++) {
            const j1 = n1 - r1, real = r3 + r2 + r1, goOn = j3 + j2 + j1;
            if (real > have || goOn > left) continue;
            for (let s2 = 0; s2 <= most2; s2++) {
              for (let s1 = 0; s1 <= most1; s1++) {
                for (let s0 = 0; s0 <= most0; s0++) {
                  if (real + s0 + s1 + s2 > have || goOn + s1 + 2 * s2 > left) break;
                  if (count === MAX_MOVES) return -1;
                  const m = count++ * 6;
                  out[m] = real + s0 + s1 + s2;
                  out[m + 1] = goOn;
                  out[m + 2] = s1;
                  out[m + 3] = s2;
                  out[m + 4] = s0 + 5 * (n1 + s1) + 25 * (n3 - e + n2 + s2);
                  out[m + 5] = e | r3 << 3 | j3 << 6 | r2 << 9 | j2 << 12 | r1 << 15 | j1 << 18 | s0 << 21 | s1 << 24 | s2 << 27;
                }
              }
            }
          }
        }
      }
    }
    return count;
  }

  // The most tiles of a value that go into groups, for each number of jokers
  // in them, given what is left of each colour (rest) and must be played
  // (need). With G groups of 3 or 4, each colour in a group at most once, that
  // works when every colour has at most G tiles, every group has a real tile,
  // and 3G <= tiles and jokers <= 4G. Each answer: bit 8 if possible, and 2
  // bits per colour for how many of it. It depends on nothing else, so it is
  // kept for every call.
  const groupCache = new Int32Array(6561 * 3 * 3).fill(-1);
  function groupMoves(rest, need, left, out) {
    let index = left;
    for (let c = 0; c < 4; c++) index = index * 9 + rest[c] * 3 + need[c];
    index *= 3;
    if (groupCache[index] === -1) {
      const bestReal = [-1, -1, -1], best = [0, 0, 0];
      for (let g0 = need[0]; g0 <= rest[0]; g0++) {
        for (let g1 = need[1]; g1 <= rest[1]; g1++) {
          for (let g2 = need[2]; g2 <= rest[2]; g2++) {
            for (let g3 = need[3]; g3 <= rest[3]; g3++) {
              const real = g0 + g1 + g2 + g3, most = Math.max(g0, g1, g2, g3);
              for (let j = 0; j <= left; j++) {
                const count = real + j, groups = Math.max(most, Math.ceil(count / 4));
                const ok = real ? groups <= real && 3 * groups <= count : j === 0;
                if (ok && real > bestReal[j]) { bestReal[j] = real; best[j] = 1 << 8 | g0 | g1 << 2 | g2 << 4 | g3 << 6; }
              }
            }
          }
        }
      }
      for (let j = 0; j < 3; j++) groupCache[index + j] = best[j];
    }
    out[0] = groupCache[index];
    out[1] = groupCache[index + 1];
    out[2] = groupCache[index + 2];
  }

  // The best score from value v on, from this state.
  function best(v, code, u) {
    if (v > 13) {
      for (let c = 0; c < 4; c++) if (code[c] % 25) return NONE;    // a run of 1 or 2 left open
      return u >= must[JOKER] ? 0 : NONE;                         // a table joker left over
    }
    const key = keyOf(v, code, u);
    let i = slot(key);
    if (generationOf[i] === generation) return scoreOf[i];
    if (full) return NONE;
    const k0 = (v - 1) * 4, left = jokers - u, moves = moveBuffers[v];
    const have = [0, 1, 2, 3].map(c => must[k0 + c] + may[k0 + c]), counts = [0, 0, 0, 0];
    for (let c = 0; c < 4; c++) {
      counts[c] = movesFor(code[c], have[c], left, v, moves[c]);
      if (counts[c] < 0) { full = true; return NONE; }
    }
    let score = NONE, chosen = [0, 0, 0, 0], chosenGroups = 0;
    const rest = [0, 0, 0, 0], need = [0, 0, 0, 0], next = [0, 0, 0, 0], options = [0, 0, 0], at = [0, 0, 0, 0];
    const jokersOf = c => { const m = moves[c], x = at[c] * 6; return m[x + 1] + m[x + 2] + 2 * m[x + 3]; };
    // Every combination of the colours' moves, as long as the jokers last.
    for (at[0] = 0; at[0] < counts[0]; at[0]++) {
      const used0 = jokersOf(0);
      if (used0 > left) continue;
      for (at[1] = 0; at[1] < counts[1]; at[1]++) {
        const used1 = used0 + jokersOf(1);
        if (used1 > left) continue;
        for (at[2] = 0; at[2] < counts[2]; at[2]++) {
          const used2 = used1 + jokersOf(2);
          if (used2 > left) continue;
          for (at[3] = 0; at[3] < counts[3]; at[3]++) {
            const used = used2 + jokersOf(3);
            if (used > left) continue;
            // The jokers in the runs, in the order they are used: the table's come first, and bring nothing.
            let runJokers = 0, n = u;
            for (let c = 0; c < 4; c++) {
              const m = moves[c], x = at[c] * 6;
              rest[c] = have[c] - m[x];
              need[c] = Math.max(0, must[k0 + c] - m[x]);
              next[c] = m[x + 4];
              for (let y = 0; y < m[x + 1]; y++) if (++n > must[JOKER]) runJokers += worth(v);
              for (let y = 0; y < m[x + 3]; y++) {
                if (++n > must[JOKER]) runJokers += worth(v - 2);
                if (++n > must[JOKER]) runJokers += worth(v - 1);
              }
              for (let y = 0; y < m[x + 2]; y++) if (++n > must[JOKER]) runJokers += worth(v - 1);
            }
            groupMoves(rest, need, left - used, options);
            for (let j = 0; j <= left - used; j++) {
              if (!(options[j] >> 8 & 1)) continue;
              let played = 0;
              for (let c = 0; c < 4; c++) played += Math.max(0, moves[c][at[c] * 6] + (options[j] >> 2 * c & 3) - must[k0 + c]);
              const later = best(v + 1, next, u + used + j);
              if (later === NONE) continue;
              const total = later + played * worth(v) + runJokers + Math.max(0, Math.min(j, n + j - must[JOKER])) * worth(v);
              if (total > score) {
                score = total;
                for (let c = 0; c < 4; c++) chosen[c] = moves[c][at[c] * 6 + 5];
                chosenGroups = (options[j] & 0xFF) | j << 8;
              }
            }
          }
        }
      }
    }
    if (full) return NONE;
    i = slot(key);                       // the search below may have moved things
    if (filled * 4 > TABLE_SIZE * 3) { full = true; return NONE; }
    filled++;
    generationOf[i] = generation;
    keys[i] = key;
    scoreOf[i] = score;
    for (let c = 0; c < 4; c++) movesOf[i * 4 + c] = chosen[c];
    groupsOf[i] = chosenGroups;
    return score;
  }

  return function solveExact(tableIds, rackIds, points = false) {
    if (!keys) {
      keys = new Float64Array(TABLE_SIZE);
      generationOf = new Uint32Array(TABLE_SIZE);
      scoreOf = new Int32Array(TABLE_SIZE);
      movesOf = new Uint32Array(TABLE_SIZE * 4);
      groupsOf = new Uint32Array(TABLE_SIZE);
      moveBuffers = Array.from({length: 14}, () => Array.from({length: 4}, () => new Int32Array(MAX_MOVES * 6)));
    }
    must.fill(0);
    may.fill(0);
    for (const id of tableIds) must[kindOf(id)]++;
    for (const id of rackIds) may[kindOf(id)]++;
    byPoints = points;
    jokers = must[JOKER] + may[JOKER];
    generation++;
    filled = 0;
    full = false;
    const score = best(1, [0, 0, 0, 0], 0);
    if (full) return {tooBig: true};
    if (score === NONE) return null;

    // Follow the choices from value 1 to read off the sets, taking the table's
    // tiles of each kind first, and the jokers in the order the search counted them.
    const placed = new Array(53).fill(0), sets = [];
    let count = 0, total = 0, u = 0, open = [[], [], [], []];
    const place = (k, v) => {
      const fromRack = placed[k]++ >= must[k];
      if (fromRack) { count++; total += v; }
      return {k, fromRack};
    };
    for (let v = 1; v <= 13; v++) {
      const code = open.map(runs => {
        const n = [0, 0, 0, 0];
        for (const run of runs) n[Math.min(3, run.length)]++;
        return n[1] + 5 * n[2] + 25 * n[3];
      });
      const i = slot(keyOf(v, code, u)), k0 = (v - 1) * 4;
      for (let c = 0; c < 4; c++) {
        const [e, r3, j3, r2, j2, r1, j1, s0, s1, s2] = [0, 3, 6, 9, 12, 15, 18, 21, 24, 27].map(b => movesOf[i * 4 + c] >> b & 7);
        const threes = open[c].filter(r => r.length >= 3), twos = open[c].filter(r => r.length === 2), ones = open[c].filter(r => r.length === 1);
        const next = [];
        const goOn = (runs, from, n, k) => { for (let y = 0; y < n; y++) { runs[from + y].push(place(k, v)); next.push(runs[from + y]); } };
        sets.push(...threes.slice(0, e));
        goOn(threes, e, r3, k0 + c);
        goOn(threes, e + r3, j3, JOKER);
        goOn(twos, 0, r2, k0 + c);
        goOn(twos, r2, j2, JOKER);
        goOn(ones, 0, r1, k0 + c);
        goOn(ones, r1, j1, JOKER);
        for (let y = 0; y < s2; y++) next.push([place(JOKER, v - 2), place(JOKER, v - 1), place(k0 + c, v)]);
        for (let y = 0; y < s1; y++) next.push([place(JOKER, v - 1), place(k0 + c, v)]);
        for (let y = 0; y < s0; y++) next.push([place(k0 + c, v)]);
        open[c] = next;
        u += j3 + j2 + j1 + s1 + 2 * s2;
      }
      const gp = groupsOf[i], g = [gp & 3, gp >> 2 & 3, gp >> 4 & 3, gp >> 6 & 3], j = gp >> 8 & 3;
      const real = g[0] + g[1] + g[2] + g[3];
      if (real) {
        // Deal each colour's tiles round the groups, so no group gets a colour twice; then the jokers.
        const groups = Array.from({length: Math.max(...g, Math.ceil((real + j) / 4))}, () => []);
        let at = 0;
        g.forEach((n, c) => { for (let y = 0; y < n; y++) groups[at++ % groups.length].push(place(k0 + c, v)); });
        for (let y = 0; y < j; y++) (groups.find(x => x.length < 3) ?? groups.find(x => x.length < 4)).push(place(JOKER, v));
        sets.push(...groups);
      }
      u += j;
    }
    sets.push(...open.flat());
    return {sets, count, points: total};
  };
})();

// The exact solver from solver.wasm, given the exports of its instance. It
// takes and gives the same as solveExact(). The tile counts go into the
// module's `input` memory, and the sets come back in its `output`: the number
// of sets, the tiles from the rack played, their points, and then each set as
// its length and its tiles (kind * 2, plus 1 if from the rack).
function wasmSolver(exports) {
  return function solveExactWasm(tableIds, rackIds, byPoints = false) {
    const memory = new Uint8Array(exports.memory.buffer), at = exports.input();
    memory.fill(0, at, at + 107);
    for (const id of tableIds) memory[at + kindOf(id)]++;
    for (const id of rackIds) memory[at + 53 + kindOf(id)]++;
    memory[at + 106] = byPoints ? 1 : 0;
    const result = exports.solve();
    if (result === 0) return null;
    if (result < 0) return {tooBig: true};
    const out = new Int32Array(exports.memory.buffer, exports.output(), 1024);
    const sets = [];
    let i = 3;
    for (let s = 0; s < out[0]; s++) {
      const set = [];
      for (let n = out[i++]; n > 0; n--) set.push({k: out[i] >> 1, fromRack: (out[i++] & 1) === 1});
      sets.push(set);
    }
    return {sets, count: out[1], points: out[2]};
  };
}

// The exact solver the optimal opponents use: solveExact() unless
// useExactSolver() gives another (the worker gives the WebAssembly one). When
// that one can't finish, solveExact() takes over, and then simpleMove().
let exactSolver = solveExact;
function useExactSolver(solver) { exactSolver = solver; }
function exact(tableIds, rackIds, byPoints) {
  const found = exactSolver(tableIds, rackIds, byPoints);
  return found?.tooBig && exactSolver !== solveExact ? solveExact(tableIds, rackIds, byPoints) : found;
}

// A computer player's move: the tiles it plays and the table after it, or
// null to draw. Before its first meld it plays only sets from its own rack,
// and only if they make 30 points. "easy" never rearranges the table;
// "strong" does, with solve(); "optimal" does, with the exact solver.
function computerMove(table, rack, melded, level) {
  const optimal = level === "optimal";
  // The table after a solution, and what is left on the rack.
  const after = (base, found) => {
    const next = realize(base, found.sets, rack);
    const onTable = new Set(next.flat());
    return {table: next, rack: rack.filter(id => !onTable.has(id))};
  };
  let move;
  if (!melded) {
    const found = optimal ? exact([], rack, true) : {tooBig: true};
    if (!found.tooBig) {
      if (found.points < 30) return null;
      move = after([], found);
    } else {
      move = simpleMove([], rack, false);
      if (move.points < 30) return null;
    }
    move.table = table.map(set => set.slice()).concat(move.table);
  } else if (level === "easy") {
    move = simpleMove(table, rack, true);
  } else {
    const found = optimal ? exact(table.flat(), rack) : solve(table.flat(), rack);
    move = found && !found.tooBig ? after(table, found) : simpleMove(table, rack, true);
  }
  const placed = rack.filter(id => !move.rack.includes(id));
  return placed.length ? {...move, placed} : null;
}

// --- the rules of a turn ----------------------------------------------------------
//
// These work on the game's shared state, a plain JSON value:
//
//   {players: [{human, name, rack, melded, said}], pool, table, current, turns,
//    passes, over, result: {winner, blocked}, sheet: [{points, winner}], round, top}
//
// None of them changes the state it is given: each returns a new one, so anyone
// can hold on to the state before a move and compare. They know nothing of a page,
// or of where a move comes from. They throw on a move that isn't allowed; checkPlay
// says why beforehand.

const copyGame = game => JSON.parse(JSON.stringify(game));
const sortedIds = ids => [...ids].sort((a, b) => a - b);

function shuffle(list, random) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

// The points of the sets made only of these tiles: what counts for a first meld.
function meldPoints(table, placed) {
  const mine = new Set(placed);
  return table.filter(set => set.every(id => mine.has(id))).reduce((s, set) => s + (analyse(set)?.points ?? 0), 0);
}

// A new game for these players ({human, name}): 14 tiles each and the rest in the
// pool. Everyone draws a tile, and the highest starts; a tie draws again. `round`
// counts the games played on, and `top` is the number that won the draw.
function dealGame(players, random = Math.random, sheet = [], round = 1) {
  const pool = shuffle(TILES.map(tile => tile.id), random);
  const dealt = players.map(p => ({...p, rack: pool.splice(0, 14), melded: false, said: null}));
  let picks, top;
  do {
    const bag = shuffle(TILES.filter(tile => !tile.joker).map(tile => tile.v), random);
    picks = dealt.map((_, i) => bag[i]);
    top = Math.max(...picks);
  } while (picks.filter(v => v === top).length > 1);
  dealt.forEach((p, i) => { p.said = ["picked", picks[i]]; });
  const game = {players: dealt, pool, table: [], current: picks.indexOf(top), turns: 0, passes: 0, over: false, result: null,
                sheet: copyGame(sheet), round, top};
  return {game, top};
}

// The seat that writes the next turn in a shared record: the player to move, or
// after a game its winner, who so starts the next one.
const whoWrites = game => game.over ? game.result.winner : game.current;

function mustBeTurnOf(game, seat) {
  if (game.over) throw new RangeError("the game is over");
  if (seat !== game.current) throw new RangeError(`it is not seat ${seat}'s turn`);
}

// The end of the game, for a winner, or null if everyone had to pass: then the
// lowest rack wins. It changes the copy it is given.
function finishGame(next, winner) {
  const values = next.players.map(p => rackValue(p.rack));
  const blocked = winner === null;
  let points;
  if (blocked) {
    const low = Math.min(...values);
    winner = values.indexOf(low);
    points = values.map(v => low - v);
  } else {
    points = values.map(v => -v);
  }
  points[winner] = -points.reduce((s, x, i) => i === winner ? s : s + x, 0);
  next.sheet.push({points, winner});
  next.players[winner].said = ["saidOut"];
  next.over = true;
  next.result = {winner, blocked};
  return next;
}

// Whether this seat may end its turn with this table and rack. Returns null if
// so, or else why not, as [key, ...args] for the page's messages.
function checkPlay(game, seat, table, rack) {
  mustBeTurnOf(game, seat);
  const player = game.players[seat];
  const had = new Set(player.rack);
  if (rack.some(id => !had.has(id)) ||
      String(sortedIds([...table.flat(), ...rack])) !== String(sortedIds([...game.table.flat(), ...player.rack]))) {
    return ["errTiles"];                         // a tile from elsewhere, or a table tile taken back
  }
  const left = new Set(rack), placed = player.rack.filter(id => !left.has(id));
  if (!placed.length) return ["errNothing"];
  if (table.some(set => !analyse(set))) return ["errInvalid"];
  if (!player.melded) {
    const sets = new Set(table.map(String));
    if (game.table.some(set => !sets.has(String(set)))) return ["errLocked"];
    const points = meldPoints(table, placed);
    if (points < 30) return ["errMeld", points];
  }
  return null;
}

// A seat ends its turn with this table and rack; if the rack is empty, it has won.
// Returns the new game, and the tiles that went from the rack to the table.
function playTiles(game, seat, table, rack) {
  const error = checkPlay(game, seat, table, rack);
  if (error) throw new RangeError(`this play isn't allowed: ${error}`);
  const next = copyGame(game), player = next.players[seat];
  const left = new Set(rack), placed = player.rack.filter(id => !left.has(id));
  player.said = player.melded ? ["saidPlay", placed.length] : ["saidMeld", meldPoints(table, placed)];
  player.melded = true;
  player.rack = [...rack];
  next.table = table.map(set => [...set]);
  next.passes = 0;
  return {game: rack.length ? next : finishGame(next, seat), placed};
}

// A seat draws tiles from the pool (three as the time limit's penalty), or passes
// if it is empty; the game ends once everyone in a row has had to pass. Returns
// the new game, and the tiles drawn. What everyone can read doesn't say which.
function drawTiles(game, seat, count = 1) {
  mustBeTurnOf(game, seat);
  const next = copyGame(game), player = next.players[seat];
  if (!next.pool.length) {
    player.said = ["saidPass"];
    next.passes++;
    return {game: next.passes >= next.players.length ? finishGame(next, null) : next, drawn: []};
  }
  const drawn = [];
  for (let i = 0; i < count && next.pool.length; i++) drawn.push(next.pool.pop());
  player.rack.push(...drawn);
  player.said = count === 3 ? ["saidPenalty"] : ["saidDraw"];
  return {game: next, drawn};
}

// The next player's turn.
function advanceTurn(game) {
  if (game.over) throw new RangeError("the game is over");
  const next = copyGame(game);
  next.current = (next.current + 1) % next.players.length;
  next.turns++;
  return next;
}

// --- the referee -------------------------------------------------------------------
//
// Whether `after` can follow `before` in one turn by this seat: a play, a draw or a
// pass, followed by the next player's turn; or, after the end of a game, the deal of
// the next one. Returns null if so, or else a word for what is wrong. It simply works
// out what the rules give and compares, so it needs nothing but the two states.
//
// It catches anything that breaks the rules, and also a draw that isn't the top of
// the pool. It can't tell whether a deal was really shuffled, or whether someone has
// looked at the other racks; that takes more than a referee.
function checkTurn(before, after, seat) {
  try {
    return before.over ? checkNextDeal(before, after, seat) : checkPlayOrDraw(before, after, seat);
  } catch {
    return "not-a-game";
  }
}

function checkPlayOrDraw(before, after, seat) {
  if (seat !== before.current) return "wrong-seat";
  const had = before.players[seat], has = after.players[seat];
  const sameTable = sameState(before.table, after.table);
  let expected;
  if (sameTable && has.rack.length >= had.rack.length) {
    expected = drawTiles(before, seat, has.said?.[0] === "saidPenalty" ? 3 : 1).game;
  } else {
    const error = checkPlay(before, seat, after.table, has.rack);
    if (error) return error[0];
    expected = playTiles(before, seat, after.table, has.rack).game;
  }
  if (!expected.over) expected = advanceTurn(expected);
  return sameState(expected, after) ? null : "not-what-the-rules-give";
}

function checkNextDeal(before, after, seat) {
  if (seat !== whoWrites(before)) return "wrong-seat";
  if (after.over || after.result !== null || after.turns !== 0 || after.passes !== 0 || after.table.length) return "not-a-new-deal";
  if (after.round !== before.round + 1) return "wrong-round";
  if (!sameState(after.sheet, before.sheet)) return "scores-changed";
  const who = players => players.map(({human, name}) => ({human, name}));
  if (!sameState(who(after.players), who(before.players))) return "players-changed";
  if (after.players.some(p => p.rack.length !== 14 || p.melded)) return "not-a-new-deal";
  const all = sortedIds([...after.players.flatMap(p => p.rack), ...after.pool]);
  if (String(all) !== String(TILES.map(tile => tile.id))) return "tiles-missing";
  const picks = after.players.map(p => p.said?.[1]);
  const top = Math.max(...picks);
  if (after.top !== top || picks.filter(v => v === top).length !== 1 || picks[after.current] !== top) return "wrong-starter";
  return null;
}

// Compares two JSON values, whatever the order of their keys, since storage and
// services don't all keep that.
function sameState(a, b) {
  const sorted = value => Array.isArray(value) ? value.map(sorted)
    : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
}
