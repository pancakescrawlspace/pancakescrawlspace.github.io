(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Connect5Game = factory();
  }
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const SIZE = 15;
  const WIN_LENGTH = 5;
  const EMPTY = 0;
  const BLACK = 1;
  const WHITE = 2;
  const DIRECTIONS = [[0, 1], [1, 0], [1, 1], [1, -1]];

  function createBoard() {
    return new Array(SIZE * SIZE).fill(EMPTY);
  }

  function inBounds(r, c) {
    return r >= 0 && r < SIZE && c >= 0 && c < SIZE;
  }

  function opponent(player) {
    return player === BLACK ? WHITE : BLACK;
  }

  function isFull(board) {
    return !board.includes(EMPTY);
  }

  // Cells of the unbroken line of five or more through (r, c) that contains
  // the stone there, or null if the stone is not part of one.
  function findWinLine(board, r, c) {
    const player = board[r * SIZE + c];
    if (player === EMPTY) return null;
    for (const [dr, dc] of DIRECTIONS) {
      const line = [[r, c]];
      for (const sign of [1, -1]) {
        let rr = r + dr * sign;
        let cc = c + dc * sign;
        while (inBounds(rr, cc) && board[rr * SIZE + cc] === player) {
          line.push([rr, cc]);
          rr += dr * sign;
          cc += dc * sign;
        }
      }
      if (line.length >= WIN_LENGTH) return line;
    }
    return null;
  }

  function createGame() {
    return {
      board: createBoard(),
      current: BLACK,
      winner: null,
      winLine: null,
      draw: false,
      lastMove: null,
    };
  }

  function isOver(game) {
    return game.winner !== null || game.draw;
  }

  // Returns false (and changes nothing) for an occupied or invalid cell or a finished game.
  function playMove(game, r, c) {
    if (isOver(game) || !inBounds(r, c) || game.board[r * SIZE + c] !== EMPTY) return false;
    game.board[r * SIZE + c] = game.current;
    game.lastMove = [r, c];
    const line = findWinLine(game.board, r, c);
    if (line) {
      game.winner = game.current;
      game.winLine = line;
    } else if (isFull(game.board)) {
      game.draw = true;
    } else {
      game.current = opponent(game.current);
    }
    return true;
  }

  return {
    SIZE, WIN_LENGTH, EMPTY, BLACK, WHITE, DIRECTIONS,
    createBoard, inBounds, opponent, isFull, findWinLine, createGame, isOver, playMove,
  };
});
