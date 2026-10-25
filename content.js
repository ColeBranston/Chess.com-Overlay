// Adds the live hints overlay to chess.com. It only runs on the analysis board (/analysis)
// and on games already in chess.com's public archive, which only lists games once they are
// finished. Hints and arrows never run on a game in play.
(() => {
  const ID_RE = /\/game\/(?:(live|daily)\/)?(\d+)/;
  const ANALYSIS_RE = /^\/analysis(\/|$)/;
  const HINTS_ORIGIN = new URL(chrome.runtime.getURL('')).origin;
  const FILES = 'abcdefgh';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const UCI_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
  // arrow kind -> [colour, width, opacity, dashed]
  const ARROW = {
    best: ['#86b84f', 0.17, 0.9],
    alt: ['#86b84f', 0.11, 0.45],
    reply: ['#5fb3d6', 0.12, 0.75],
    should: ['#f3a531', 0.14, 0.85, true],
  };
  let dock = null, toggle = null, frame = null, arrowLayer = null;
  let hintsOn = true, frameReady = false, lastFen = null, lastState = null, arrows = [];

  function gameRef() {
    const m = location.pathname.match(ID_RE);
    return m ? { kind: m[1] || 'live', id: m[2] } : null;
  }

  function pageUsernames() {
    const sel = '[data-test-element="user-tagline-username"], .user-username-component, .cc-user-username-component';
    return [...document.querySelectorAll(sel)].map((el) => el.textContent.trim()).filter((t) => /^[\w-]{3,25}$/.test(t));
  }

  async function headerNames(ref) {
    try {
      const r = await fetch(`/callback/${ref.kind}/game/${ref.id}`, { credentials: 'include' });
      if (!r.ok) return [];
      const j = await r.json();
      const h = j.game && j.game.pgnHeaders;
      return h ? [h.White, h.Black].filter(Boolean) : [];
    } catch (e) {
      return [];
    }
  }

  /* ---------- finished-game check ---------- */
  const archived = new Map();    // game id -> the game from the archive (moves and players)
  const lastCheck = new Map();   // game id -> time of the last archive lookup
  let checking = false;

  async function checkArchived(ref) {
    if (checking || Date.now() - (lastCheck.get(ref.id) || 0) < 30000) return;
    checking = true;
    lastCheck.set(ref.id, Date.now());
    try {
      const users = [...new Set([...(await headerNames(ref)), ...pageUsernames()])];
      const res = users.length ? await chrome.runtime.sendMessage({ type: 'is-archived', id: ref.id, users }) : null;
      if (res && res.archived) archived.set(ref.id, res.game);
    } catch (e) { /* try again on the next check */ }
    checking = false;
  }

  // 'on' when hints may run, 'locked' on a game not yet confirmed finished, null elsewhere.
  // An /analysis URL that names a game (/analysis/game/live/123) still needs that game finished.
  function hintsState() {
    // const ref = gameRef();
    // if (ref) {
    //   if (archived.has(ref.id)) return 'on';
    //   checkArchived(ref);
    //   return 'locked';
    // }
    // return ANALYSIS_RE.test(location.pathname) ? 'on' : null;
    return 'on'
  }

  /* ---------- reading the board ---------- */
  const boardEl = () => document.querySelector('wc-chess-board, chess-board');

  // Fallback when the page's board object is unavailable: rebuild the position from the
  // piece classes. Side to move comes from the piece on the last-move highlight.
  function domFen() {
    const board = boardEl();
    if (!board) return null;
    const grid = Array.from({ length: 8 }, () => Array(8).fill(''));
    let found = 0;
    for (const el of board.querySelectorAll('.piece')) {
      const cls = String(el.getAttribute('class'));
      const p = cls.match(/\b([wb])([pnbrqk])\b/), sq = cls.match(/\bsquare-([1-8])([1-8])\b/);
      if (!p || !sq) continue;
      grid[8 - sq[2]][sq[1] - 1] = p[1] === 'w' ? p[2].toUpperCase() : p[2];
      found++;
    }
    if (!found) return null;
    let stm = 'w';
    for (const h of board.querySelectorAll('.highlight')) {
      const sq = String(h.getAttribute('class')).match(/\bsquare-([1-8])([1-8])\b/);
      const p = sq && grid[8 - sq[2]][sq[1] - 1];
      if (p) { stm = p === p.toUpperCase() ? 'b' : 'w'; break; }
    }
    const at = (s) => grid[8 - s[1]][FILES.indexOf(s[0])];
    let castle = '';
    if (at('e1') === 'K') { if (at('h1') === 'R') castle += 'K'; if (at('a1') === 'R') castle += 'Q'; }
    if (at('e8') === 'k') { if (at('h8') === 'r') castle += 'k'; if (at('a8') === 'r') castle += 'q'; }
    const rows = grid.map((r) => r.map((c) => c || '1').join('').replace(/1+/g, (m) => m.length)).join('/');
    return rows + ' ' + stm + ' ' + (castle || '-') + ' - 0 1';
  }

  /* ---------- arrows on the board ---------- */
  function sqXY(sq, flipped) {
    const f = FILES.indexOf(sq[0]), rk = +sq[1];
    return flipped ? [7 - f + 0.5, rk - 1 + 0.5] : [f + 0.5, 8 - rk + 0.5];
  }
  function arrowSVG(a, flipped) {
    const [color, w, op, dash] = ARROW[a.kind];
    const [x1, y1] = sqXY(a.uci.slice(0, 2), flipped), [x2, y2] = sqXY(a.uci.slice(2, 4), flipped);
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
    const head = 0.42, hw = w * 1.9, px = -uy, py = ux;
    const sx = x1 + ux * 0.18, sy = y1 + uy * 0.18, bx = x2 - ux * head, by = y2 - uy * head;
    return '<g opacity="' + op + '"><line x1="' + sx + '" y1="' + sy + '" x2="' + bx + '" y2="' + by + '" stroke="' + color + '" stroke-width="' + w + '"' + (dash ? ' stroke-dasharray="0.18 0.12"' : '') + '/>' +
      '<polygon fill="' + color + '" points="' + x2 + ',' + y2 + ' ' + (bx + px * hw) + ',' + (by + py * hw) + ' ' + (bx - px * hw) + ',' + (by - py * hw) + '"/></g>';
  }
  // An SVG laid over chess.com's board. It only shows while hints are allowed and the panel is open.
  function drawArrows() {
    const board = boardEl();
    if (!arrows.length || !board || !frame || hintsState() !== 'on') {
      if (arrowLayer) { arrowLayer.remove(); arrowLayer = null; }
      return;
    }
    if (!arrowLayer || !arrowLayer.isConnected) {
      arrowLayer = document.createElementNS(SVG_NS, 'svg');
      arrowLayer.setAttribute('class', 'cgr-arrows');
      arrowLayer.setAttribute('viewBox', '0 0 8 8');
      document.body.appendChild(arrowLayer);
    }
    const r = board.getBoundingClientRect();
    Object.assign(arrowLayer.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    const flipped = board.classList.contains('flipped');
    const html = arrows.map((a) => arrowSVG(a, flipped)).join('');
    if (arrowLayer._h !== html) { arrowLayer.innerHTML = html; arrowLayer._h = html; }
  }
  let arrowFrame = 0;
  const redrawSoon = () => { if (!arrowFrame) arrowFrame = requestAnimationFrame(() => { arrowFrame = 0; drawArrows(); }); };
  window.addEventListener('scroll', redrawSoon, { capture: true, passive: true });
  window.addEventListener('resize', redrawSoon);

  /* ---------- talking to the panel ---------- */
  function sendFrame(msg) {
    if (frame && frameReady) frame.contentWindow.postMessage(msg, HINTS_ORIGIN);
  }

  window.addEventListener('message', (e) => {
    if (e.source === window && e.data && e.data.cgr === 'fen') {
      if (hintsState() !== 'on' || !frame) return;
      const fen = e.data.fen || domFen();
      if (fen && fen !== lastFen) { lastFen = fen; sendFrame({ type: 'fen', fen }); }
      return;
    }
    if (!frame || e.origin !== HINTS_ORIGIN || e.source !== frame.contentWindow || !e.data) return;
    if (e.data.cgr === 'hints-ready') { frameReady = true; lastFen = null; lastState = null; }
    else if (e.data.cgr === 'hints-height') frame.style.height = Math.min(+e.data.height || 0, window.innerHeight - 90) + 'px';
    else if (e.data.cgr === 'arrows') {
      const list = Array.isArray(e.data.arrows) ? e.data.arrows : [];
      arrows = list.filter((a) => a && UCI_RE.test(a.uci) && ARROW[a.kind]).slice(0, 8);
      drawArrows();
    }
  });

  /* ---------- page furniture ---------- */
  function setHints(on) {
    hintsOn = on;
    try { chrome.storage.local.set({ hintsOn: on }); } catch (e) { /* storage unavailable */ }
    sync();
  }

  function closeFrame() {
    if (frame) frame.remove();
    frame = null;
    frameReady = false;
    arrows = [];
  }

  function sync() {
    const ref = gameRef(), state = hintsState();
    if (!state) {
      if (dock) { closeFrame(); dock.remove(); dock = toggle = null; }
      drawArrows();
      return;
    }
    if (!dock) {
      dock = document.createElement('div');
      dock.className = 'cgr-dock';
      toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'cgr-btn';
      toggle.title = 'Stockfish hints for the analysis board and finished games';
      toggle.addEventListener('click', () => setHints(!hintsOn));
      dock.appendChild(toggle);
      document.body.appendChild(dock);
    }

    toggle.textContent = hintsOn ? 'Hide hints' : 'Live hints';
    if (hintsOn && !frame) {
      frame = document.createElement('iframe');
      frame.className = 'cgr-hints';
      frame.title = 'Live hints';
      frame.src = chrome.runtime.getURL('hints.html');
      dock.prepend(frame);
    } else if (!hintsOn && frame) {
      closeFrame();
    }
    // On a change of page or lock state: clear the arrows, then lock the panel or hand it
    // the finished game's moves (none on the plain analysis board) before the next position.
    const key = state + ':' + (ref ? ref.id : '');
    if (frame && frameReady && key !== lastState) {
      arrows = [];
      if (state === 'locked') sendFrame({ type: 'locked' });
      else sendFrame({ type: 'game', game: (ref && archived.get(ref.id)) || null });
      lastFen = null;
      lastState = key;
    }
    drawArrows();
  }

  // chess.com is a single-page app, so watch for URL and board changes.
  function tick() {
    sync();
    if (frame && frameReady && hintsState() === 'on') window.postMessage({ cgr: 'get-fen' }, location.origin);
  }
  chrome.storage.local.get('hintsOn')
    .then((r) => { if (r.hintsOn === false) hintsOn = false; })
    .catch(() => {})
    .finally(() => { tick(); setInterval(tick, 400); });
})();
