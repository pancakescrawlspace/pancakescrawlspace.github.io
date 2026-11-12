(function () {
  'use strict';

  const { SIZE, BLACK, WHITE, EMPTY, createGame, playMove, isOver } = Connect5Game;
  const HUMAN = BLACK;
  const COMPUTER = WHITE;
  // Lets the browser paint the human's stone before the computer starts thinking.
  const THINK_DELAY_MS = 50;

  const boardEl = document.getElementById('board');
  const statusEl = document.getElementById('status');
  const difficultyEl = document.getElementById('difficulty');
  const newGameEl = document.getElementById('new-game');

  const cells = [];
  let game;
  let loading = true;
  let loadError = null;
  let thinking = false;
  let pendingMove = null;

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

  function statusText() {
    if (loadError) return [loadError, 'lose'];
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
    boardEl.classList.toggle('locked', loading || thinking || isOver(game));
    const [text, kind] = statusText();
    statusEl.textContent = text;
    statusEl.className = kind;
  }

  function computerMove() {
    pendingMove = null;
    const [r, c] = Connect5AI.chooseMove(game.board, COMPUTER, difficultyEl.value);
    playMove(game, r, c);
    thinking = false;
    render();
  }

  function onCellClick(event) {
    const cell = event.target.closest('.cell');
    if (!cell || loading || thinking || isOver(game)) return;
    if (!playMove(game, Number(cell.dataset.row), Number(cell.dataset.col))) return;
    thinking = !isOver(game);
    render();
    if (thinking) pendingMove = setTimeout(computerMove, THINK_DELAY_MS);
  }

  function newGame() {
    clearTimeout(pendingMove);
    thinking = false;
    game = createGame();
    render();
  }

  buildBoard();
  boardEl.addEventListener('click', onCellClick);
  newGameEl.addEventListener('click', newGame);
  newGame();
  Connect5AI.ready.then(() => {
    loading = false;
    render();
  }, (error) => {
    loadError = 'The computer could not be loaded: ' + error.message;
    render();
  });
})();
