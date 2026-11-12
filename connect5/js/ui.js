(function () {
  'use strict';

  const { SIZE, BLACK, WHITE, EMPTY, createGame, playMove, isOver } = Connect5Game;
  const HUMAN = BLACK;
  const COMPUTER = WHITE;
  // Lets the browser paint the human's stone before the computer starts thinking.
  const THINK_DELAY_MS = 50;
  // In computer vs computer, a pause between moves so a person can follow the game.
  const WATCH_DELAY_MS = 500;
  const HINTS = {
    human: 'You play black and move first. Get five in a row to win.',
    computer: 'The computer plays both sides. Get five in a row to win.',
  };

  const boardEl = document.getElementById('board');
  const statusEl = document.getElementById('status');
  const modeEl = document.getElementById('mode');
  const blackLevelEl = document.getElementById('difficulty-black');
  const whiteLevelEl = document.getElementById('difficulty-white');
  const newGameEl = document.getElementById('new-game');
  const pauseEl = document.getElementById('pause');
  const hintEl = document.getElementById('hint');

  const cells = [];
  let game;
  let loading = true;
  let loadError = null;
  let thinking = false;
  let pendingMove = null;
  let paused = false;

  function watching() {
    return modeEl.value === 'computer';
  }

  function buildBoard() {
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'cell';
        cell.dataset.row = r;
        cell.dataset.col = c;
        if (r === 0) cell.classList.add('first-row');
        if (r === SIZE - 1) cell.classList.add('last-row');
        if (c === 0) cell.classList.add('first-col');
        if (c === SIZE - 1) cell.classList.add('last-col');
        boardEl.appendChild(cell);
        cells.push(cell);
      }
    }
  }

  function watchStatusText() {
    if (game.winner === BLACK) return ['Black wins.', 'win'];
    if (game.winner === WHITE) return ['White wins.', 'win'];
    if (game.draw) return ["It's a draw.", ''];
    if (loading) return ['Loading the computer…', ''];
    const side = game.current === BLACK ? 'Black' : 'White';
    return paused ? [`Paused. ${side} to move.`, ''] : [`${side} is thinking…`, ''];
  }

  function statusText() {
    if (loadError) return [loadError, 'lose'];
    if (watching()) return watchStatusText();
    if (game.winner === HUMAN) return ['You win!', 'win'];
    if (game.winner === COMPUTER) return ['The computer wins.', 'lose'];
    if (game.draw) return ["It's a draw.", ''];
    if (loading) return ['Loading the computer…', ''];
    return thinking ? ['Computer is thinking…', ''] : ['Your move (black).', ''];
  }

  function render() {
    const winCells = new Set((game.winLine || []).map(([r, c]) => r * SIZE + c));
    cells.forEach((cell, i) => {
      const value = game.board[i];
      const r = Math.floor(i / SIZE);
      const c = i % SIZE;
      const isLast = game.lastMove && game.lastMove[0] === r && game.lastMove[1] === c;
      cell.classList.toggle('empty', value === EMPTY);
      cell.classList.toggle('last', Boolean(isLast));
      cell.classList.toggle('win', winCells.has(i));
      const colour = value === BLACK ? 'black' : 'white';
      cell.innerHTML = value === EMPTY ? '' : `<span class="stone ${colour}"></span>`;
      const where = `row ${r + 1}, column ${c + 1}`;
      cell.setAttribute('aria-label', value === EMPTY ? where : `${where}, ${colour}`);
    });
    boardEl.classList.toggle('locked', watching() || loading || thinking || isOver(game));
    blackLevelEl.disabled = !watching();
    pauseEl.hidden = !watching();
    pauseEl.disabled = isOver(game) || Boolean(loadError);
    pauseEl.textContent = paused ? 'Resume' : 'Pause';
    hintEl.textContent = HINTS[modeEl.value];
    const [text, kind] = statusText();
    statusEl.textContent = text;
    statusEl.className = kind;
  }

  function scheduleComputer() {
    clearTimeout(pendingMove);
    thinking = !loading && !paused && !isOver(game);
    if (thinking) pendingMove = setTimeout(computerMove, watching() ? WATCH_DELAY_MS : THINK_DELAY_MS);
  }

  function computerMove() {
    pendingMove = null;
    const level = game.current === BLACK ? blackLevelEl.value : whiteLevelEl.value;
    const [r, c] = Connect5AI.chooseMove(game.board, game.current, level);
    playMove(game, r, c);
    thinking = false;
    if (watching()) scheduleComputer();
    render();
  }

  function onCellClick(event) {
    const cell = event.target.closest('.cell');
    if (!cell || watching() || loading || thinking || isOver(game)) return;
    if (!playMove(game, Number(cell.dataset.row), Number(cell.dataset.col))) return;
    scheduleComputer();
    render();
  }

  function newGame() {
    clearTimeout(pendingMove);
    thinking = false;
    paused = false;
    game = createGame();
    if (watching()) scheduleComputer();
    render();
  }

  function togglePause() {
    if (!watching() || isOver(game)) return;
    paused = !paused;
    scheduleComputer();
    render();
  }

  buildBoard();
  boardEl.addEventListener('click', onCellClick);
  newGameEl.addEventListener('click', newGame);
  modeEl.addEventListener('change', newGame);
  pauseEl.addEventListener('click', togglePause);
  newGame();
  Connect5AI.ready.then(() => {
    loading = false;
    if (watching()) scheduleComputer();
    render();
  }, (error) => {
    loadError = 'The computer could not be loaded: ' + error.message;
    render();
  });
})();
