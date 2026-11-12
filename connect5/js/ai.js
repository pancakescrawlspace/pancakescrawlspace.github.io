(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./game.js'));
  } else {
    root.Connect5AI = factory(root.Connect5Game);
  }
})(typeof self !== 'undefined' ? self : globalThis, function (Game) {
  'use strict';

  const { SIZE, WIN_LENGTH, EMPTY, BLACK, DIRECTIONS, inBounds, opponent } = Game;

  const LEVELS = ['easy', 'medium', 'hard'];
  // Score of a five-cell window by the number of stones of one colour in it
  // (the other colour must have none there).
  const WINDOW_SCORE = [0, 1, 10, 100, 1000, 1000000];
  const FIVE = WINDOW_SCORE[WIN_LENGTH];
  const WIN_VALUE = 1e9;

  const HARD_MAX_DEPTH = 4;
  const HARD_WIDTH = 8;
  const HARD_TIME_LIMIT_MS = 700;

  // Score for `player` playing at (r, c), summed over the five-cell windows through it.
  function cellScore(board, r, c, player) {
    let total = 0;
    for (const [dr, dc] of DIRECTIONS) {
      for (let start = -(WIN_LENGTH - 1); start <= 0; start++) {
        const endR = r + dr * (start + WIN_LENGTH - 1);
        const endC = c + dc * (start + WIN_LENGTH - 1);
        if (!inBounds(r + dr * start, c + dc * start) || !inBounds(endR, endC)) continue;
        let own = 1;
        let blocked = false;
        for (let k = 0; k < WIN_LENGTH; k++) {
          const v = board[(r + dr * (start + k)) * SIZE + c + dc * (start + k)];
          if (v === EMPTY || (start + k === 0)) continue;
          if (v === player) own++;
          else { blocked = true; break; }
        }
        if (!blocked) total += WINDOW_SCORE[own];
      }
    }
    return total;
  }

  // Static value of the whole board from `player`'s point of view.
  function evaluate(board, player) {
    let black = 0;
    let white = 0;
    for (const [dr, dc] of DIRECTIONS) {
      for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
          if (!inBounds(r + dr * (WIN_LENGTH - 1), c + dc * (WIN_LENGTH - 1))) continue;
          let b = 0;
          let w = 0;
          for (let k = 0; k < WIN_LENGTH; k++) {
            const v = board[(r + dr * k) * SIZE + c + dc * k];
            if (v === EMPTY) continue;
            if (v === BLACK) b++; else w++;
          }
          if (b > 0 && w === 0) black += WINDOW_SCORE[b];
          else if (w > 0 && b === 0) white += WINDOW_SCORE[w];
        }
      }
    }
    const mine = player === BLACK ? black : white;
    const theirs = player === BLACK ? white : black;
    return mine * 1.5 - theirs;
  }

  // Empty cells within `distance` of any stone; the centre for an empty board.
  function candidateCells(board, distance) {
    const cells = [];
    let any = false;
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        if (board[r * SIZE + c] !== EMPTY) { any = true; continue; }
        let near = false;
        for (let dr = -distance; dr <= distance && !near; dr++) {
          for (let dc = -distance; dc <= distance; dc++) {
            if (inBounds(r + dr, c + dc) && board[(r + dr) * SIZE + c + dc] !== EMPTY) {
              near = true;
              break;
            }
          }
        }
        if (near) cells.push([r, c]);
      }
    }
    if (!any) {
      const mid = Math.floor(SIZE / 2);
      return [[mid, mid]];
    }
    return cells;
  }

  // Candidate moves for `player`, best first by the pattern heuristic. A winning
  // move comes alone; otherwise, if the opponent threatens five, only the cells
  // that stop it are returned.
  function rankedMoves(board, player, distance) {
    const other = opponent(player);
    const scored = candidateCells(board, distance).map(([r, c]) => {
      const attack = cellScore(board, r, c, player);
      const defense = cellScore(board, r, c, other);
      return { r, c, attack, defense, score: attack + defense };
    });
    const win = scored.find((m) => m.attack >= FIVE);
    if (win) return [win];
    const forced = scored.filter((m) => m.defense >= FIVE);
    const pool = forced.length ? forced : scored;
    return pool.sort((a, b) => b.score - a.score);
  }

  function randomItem(items, rng) {
    return items[Math.floor(rng() * items.length)];
  }

  function easyMove(board, player, rng) {
    const moves = rankedMoves(board, player, 1);
    if (moves.length === 1 && moves[0].attack >= FIVE) return [moves[0].r, moves[0].c];
    return randomItem(candidateCells(board, 1), rng);
  }

  function mediumMove(board, player, rng) {
    const moves = rankedMoves(board, player, 2);
    const best = moves[0].score;
    const top = moves.filter((m) => m.score === best);
    const move = randomItem(top, rng);
    return [move.r, move.c];
  }

  class Timeout extends Error {}

  const FOUR = WINDOW_SCORE[WIN_LENGTH - 1];
  const VCF_DEPTH = 6;

  function fiveCells(board, player) {
    return candidateCells(board, 1).filter(([r, c]) => cellScore(board, r, c, player) >= FIVE);
  }

  // Looks for a win for `player` (to move) by a chain of fours, each forcing a single
  // reply, ending in a five or in a double four. Returns the first move of the chain.
  function findFourChain(board, player, depth) {
    const wins = fiveCells(board, player);
    if (wins.length) return wins[0];
    if (depth === 0 || fiveCells(board, opponent(player)).length) return null;
    const other = opponent(player);
    for (const [r, c] of candidateCells(board, 1)) {
      if (cellScore(board, r, c, player) < FOUR) continue;
      board[r * SIZE + c] = player;
      const threats = fiveCells(board, player);
      let found = false;
      if (threats.length >= 2) {
        found = true;
      } else if (threats.length === 1) {
        const [tr, tc] = threats[0];
        board[tr * SIZE + tc] = other;
        found = findFourChain(board, player, depth - 1) !== null;
        board[tr * SIZE + tc] = EMPTY;
      }
      board[r * SIZE + c] = EMPTY;
      if (found) return [r, c];
    }
    return null;
  }

  function negamax(board, player, depth, alpha, beta, ctx) {
    if (Date.now() > ctx.deadline) throw new Timeout();
    if (depth === 0) return evaluate(board, player);
    const moves = rankedMoves(board, player, 2).slice(0, HARD_WIDTH);
    if (moves.length === 0) return 0;
    if (moves[0].attack >= FIVE) return WIN_VALUE + depth;
    let best = -Infinity;
    for (const m of moves) {
      board[m.r * SIZE + m.c] = player;
      const value = -negamax(board, opponent(player), depth - 1, -beta, -alpha, ctx);
      board[m.r * SIZE + m.c] = EMPTY;
      if (value > best) best = value;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    return best;
  }

  function hardMove(board, player, options) {
    const moves = rankedMoves(board, player, 2).slice(0, HARD_WIDTH);
    if (moves.length === 1) return [moves[0].r, moves[0].c];
    const ctx = { deadline: Date.now() + (options.timeLimitMs || HARD_TIME_LIMIT_MS) };
    const work = board.slice();
    const chain = findFourChain(work, player, VCF_DEPTH);
    if (chain) return chain;
    let best = moves[0];
    const maxDepth = options.maxDepth || HARD_MAX_DEPTH;
    try {
      for (let depth = 2; depth <= maxDepth; depth++) {
        let bestMove = null;
        let alpha = -Infinity;
        for (const m of moves) {
          work[m.r * SIZE + m.c] = player;
          const value = -negamax(work, opponent(player), depth - 1, -Infinity, -alpha, ctx);
          work[m.r * SIZE + m.c] = EMPTY;
          if (value > alpha) { alpha = value; bestMove = m; }
        }
        best = bestMove;
        // Search the previous best move first next time, for better pruning.
        moves.splice(moves.indexOf(best), 1);
        moves.unshift(best);
        if (alpha >= WIN_VALUE) break;
      }
    } catch (e) {
      if (!(e instanceof Timeout)) throw e;
    }
    return [best.r, best.c];
  }

  // Choose a move [row, col] for `player` on `board` at the given level
  // ('easy' | 'medium' | 'hard'). The board must have an empty cell.
  function chooseMove(board, player, level, options) {
    const opts = options || {};
    const rng = opts.rng || Math.random;
    switch (level) {
      case 'easy': return easyMove(board, player, rng);
      case 'medium': return mediumMove(board, player, rng);
      case 'hard': return hardMove(board, player, opts);
      default: throw new Error('Unknown difficulty level: ' + level);
    }
  }

  return { LEVELS, chooseMove, evaluate, cellScore };
});
