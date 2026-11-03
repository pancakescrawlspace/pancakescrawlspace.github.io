// Four in a Row's Web Worker: it works out the computer player's move, away
// from the page, so that thinking never stops it. It answers each
// {id, moves, level, budget} with {id, column}, from computerMove() in ai.js.
"use strict";
importScripts("ai.js");

onmessage = e => {
  const {id, moves, level, budget} = e.data;
  postMessage({id, column: computerMove(moves, level, {budget})});
};
