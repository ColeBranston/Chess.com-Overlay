// Runs in chess.com's own page context, where the board element exposes its position.
// It answers position requests from content.js and does nothing else; content.js decides
// whether hints are allowed on the page and falls back to reading the pieces if this fails.
window.addEventListener('message', (e) => {
  if (e.source !== window || !e.data || e.data.cgr !== 'get-fen') return;
  let fen = null;
  try {
    const board = document.querySelector('wc-chess-board, chess-board');
    if (board && board.game && typeof board.game.getFEN === 'function') fen = board.game.getFEN();
  } catch (err) { /* content.js reads the pieces instead */ }
  window.postMessage({ cgr: 'fen', fen }, location.origin);
});
