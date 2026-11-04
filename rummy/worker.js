// Tile Rummy's Web Worker: it works out the computer players' moves, away
// from the page, so that a long think never stops the page.
//
// It loads rules.js, and then solver.wasm, the optimal opponents' solver
// compiled to WebAssembly; until that has loaded, or if it can't, the solver in
// rules.js does the work. It tells the page which one it uses ({solver}), and
// answers each {id, table, rack, melded, level, pinned} with {id, move}, the move
// from computerMove(). With `pinned` it uses the JavaScript solver, so that every
// player's browser gets the same move. With ?solver=js it doesn't load the WebAssembly.
"use strict";
importScripts("rules.js");

let wasm = null;
const ready = (async () => {
  if (new URLSearchParams(location.search).get("solver") === "js") return;
  try {
    let instance;
    try {
      ({instance} = await WebAssembly.instantiateStreaming(fetch("solver.wasm")));
    } catch {
      // A server that doesn't call it application/wasm: the slower way.
      const response = await fetch("solver.wasm");
      ({instance} = await WebAssembly.instantiate(await response.arrayBuffer()));
    }
    wasm = wasmSolver(instance.exports);
    postMessage({solver: "wasm"});
  } catch (e) {
    console.warn("Tile Rummy: no WebAssembly solver, so the JavaScript one", e);
  }
})();

onmessage = async e => {
  await ready;
  const {id, table, rack, melded, level, pinned} = e.data;
  useExactSolver(pinned || !wasm ? solveExact : wasm);
  postMessage({id, move: computerMove(table, rack, melded, level)});
};
