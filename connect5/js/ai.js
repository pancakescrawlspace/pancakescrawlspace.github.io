(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./game.js'), require('./ai-wasm.js'));
  } else {
    root.Connect5AI = factory(root.Connect5Game, root.Connect5AIWasm);
  }
})(typeof self !== 'undefined' ? self : globalThis, function (Game, wasmBase64) {
  'use strict';

  // Loads the computer player, which lives in WebAssembly (assembly/index.ts, compiled into
  // ai-wasm.js). `ready` resolves once it can be used; chooseMove throws before that.

  const { SIZE } = Game;
  const LEVELS = ['easy', 'medium', 'hard'];
  const DEFAULT_TIME_LIMIT_MS = 700;
  const DEFAULT_MAX_DEPTH = 4;

  let ai = null;

  const bytes = Uint8Array.from(atob(wasmBase64), (ch) => ch.charCodeAt(0));
  const imports = {
    env: {
      now: () => Date.now(),
      abort: () => { throw new Error('WebAssembly AI aborted'); },
    },
  };
  const ready = WebAssembly.instantiate(bytes, imports).then(({ instance }) => {
    ai = instance.exports;
  });

  // Choose a move [row, col] for `player` on `board` at the given level
  // ('easy' | 'medium' | 'hard'). The board must have an empty cell.
  function chooseMove(board, player, level, options) {
    if (!ai) throw new Error('The AI is not ready yet; wait for Connect5AI.ready');
    const levelIndex = LEVELS.indexOf(level);
    if (levelIndex < 0) throw new Error('Unknown difficulty level: ' + level);
    const opts = options || {};
    const rng = opts.rng || Math.random;
    const maxDepth = opts.maxDepth || DEFAULT_MAX_DEPTH;
    if (maxDepth > ai.MAX_DEPTH.value) throw new RangeError('maxDepth is at most ' + ai.MAX_DEPTH.value);
    new Int32Array(ai.memory.buffer, ai.boardPtr(), SIZE * SIZE).set(board);
    const index = ai.chooseMove(player, levelIndex, rng(), opts.timeLimitMs || DEFAULT_TIME_LIMIT_MS, maxDepth);
    if (index < 0) throw new Error('The board has no empty cell');
    return [Math.floor(index / SIZE), index % SIZE];
  }

  return { LEVELS, ready, chooseMove };
});
