// Live hints overlay. content.js sends it the board position, but only on the analysis
// board or a finished game, and it shows:
//   - the eval, and a rating of the move that led to the position
//   - Stockfish's 3 best moves for the side to move and the other side's 3 best replies to
//     the top one, each list sorted best first by score; a second engine searches the replies
//   - on a finished game (content.js sends its moves): an eval graph, a report for each
//     player up to the move on the board, and the move list with ratings; a third engine
//     works through the game for these
// It also tells content.js which arrows to draw on chess.com's board.
(() => {
const CHESS_ORIGIN = 'https://www.chess.com';
// Live searches never really reach this: they keep deepening, updating as they go, until
// the board changes. The game engine has to finish each position, so it stays shallow.
const DEPTH = 60;
const GAME_DEPTH = 14;
const REPLY_FROM_DEPTH = 8;   // the top move jumps around before this, so wait to search replies
const MEMORY = 300;           // positions remembered for rating moves played on the board
const TAG = { best:['★','Best'], exc:['!','Excellent'], good:['✓','Good'], inacc:['?!','an Inaccuracy'], mist:['?','a Mistake'], blund:['??','a Blunder'] };
const TAG_NAME = { best:'Best', exc:'Excellent', good:'Good', inacc:'Inaccuracy', mist:'Mistake', blund:'Blunder' };
const $ = (id) => document.getElementById(id);

let fen = null;        // position on the board
let lines = [];        // multipv lines for fen (engine order; sort before use)
let replyMove = null;  // top move (uci) the replies are searched after
let replyFen = null;   // position after replyMove
let replyLines = [];   // multipv lines for replyFen
let failed = false, locked = false;

const seen = new Map();      // fen -> deepest lines seen for it, to rate the move that left it
const movedInto = new Map(); // fen -> { mv, fenB }: a move seen played on the board, and from where
let lastMove = null;         // movedInto entry for fen

let game = null;       // finished game: { pgn, header, white, black, fens, hist, over, times, accuracies }
let GA = [];           // GA[i] = engine result for game.fens[i]: { lines[], done }
let ply = null;        // index into game.fens that matches the board, null when off the game line
let lastPly = 0;       // last matched index; the report covers the moves before it
let gameJob = null;    // index the game engine is searching

let arrowsOn = true;
const open = { report: true, moves: false };   // which collapsible sections are open

/* ---------- helpers ---------- */
const stmIsWhite = (f) => f.split(' ')[1] === 'w';
const neg = (s) => s.mate != null ? { mate: -s.mate } : { cp: -s.cp };
const whiteScore = (s, f) => stmIsWhite(f) ? s : neg(s);
const isWhiteAhead = (s) => s.mate != null ? s.mate > 0 : s.cp >= 0;
const posKey = (f) => f.split(' ').slice(0, 2).join(' ');
function fmtScore(s) {
  if (s.mate != null) return (s.mate > 0 ? '+' : '−') + 'M' + Math.abs(s.mate);
  const v = s.cp / 100;
  if (Math.abs(v) < 0.005) return '0.00';
  return (v > 0 ? '+' : '−') + Math.abs(v).toFixed(2);
}
const fmtSecs = (t) => t >= 60 ? Math.floor(t / 60) + 'm ' + Math.round(t % 60) + 's' : t.toFixed(1) + 's';
function esc(t) { return String(t).replace(/[&<>"]/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c])); }
function pvToSan(f, pv, n) {
  const c = new Chess(f), out = [];
  for (const u of pv.slice(0, n)) {
    const m = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
    if (!m) break;
    out.push(m.san);
  }
  return out;
}
function scoreHTML(s, f) {
  const ws = whiteScore(s, f);
  return '<span class="score ' + (isWhiteAhead(ws) ? 'w' : 'b') + '">' + fmtScore(ws) + '</span>';
}
function gameOver(f) {
  const c = new Chess(f);
  if (c.in_checkmate()) return 'Checkmate.';
  if (c.in_stalemate()) return 'Stalemate.';
  if (c.insufficient_material()) return 'Draw by insufficient material.';
  return null;
}
function afterMove(f, u) {
  const c = new Chess(f);
  return c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }) ? c.fen() : null;
}
// The single legal move that turns position a into b, or null.
function findMove(a, b) {
  const c = new Chess(a), key = posKey(b);
  for (const m of c.moves({ verbose: true })) {
    c.move(m);
    const hit = posKey(c.fen()) === key;
    c.undo();
    if (hit) return m;
  }
  return null;
}
function moveLabel(f, san) {
  const p = f.split(' ');
  return p[5] + (p[1] === 'w' ? '. ' : '… ') + san;
}
function remember(map, key, value) {
  map.delete(key);
  map.set(key, value);
  if (map.size > MEMORY) map.delete(map.keys().next().value);
}
const playerName = (color) => {
  const p = game && (color === 'w' ? game.white : game.black);
  return (p && p.username) || (color === 'w' ? 'White' : 'Black');
};

/* ---------- engine ---------- */
function parseInfo(line) {
  if (line.indexOf(' pv ') < 0 || line.indexOf(' score ') < 0) return null;
  if (/ (lowerbound|upperbound)/.test(line)) return null;
  const t = line.split(' '), o = { multipv: 1 };
  for (let i = 1; i < t.length; i++) {
    const k = t[i];
    if (k === 'depth') o.depth = +t[++i];
    else if (k === 'multipv') o.multipv = +t[++i];
    else if (k === 'score') { const ty = t[++i], v = +t[++i]; o.score = ty === 'cp' ? { cp: v } : { mate: v }; }
    else if (k === 'pv') { o.pv = t.slice(i + 1).filter(Boolean); break; }
    else if (['seldepth', 'nodes', 'nps', 'time', 'hashfull', 'tbhits', 'currmove', 'currmovenumber'].includes(k)) i++;
  }
  return o.depth && o.pv && o.pv.length && o.score ? o : null;
}
// One Stockfish worker that always searches the last position it was given.
// onInfo(fen, info) gets each multipv line for that position; onDone(fen) runs when a
// search reaches its depth (not when it was stopped for a new position).
function Engine(depth, onInfo, onDone) {
  let worker = null, ready = false;
  let target = null;     // position it should be searching
  let running = null;    // position it is searching now
  let stopping = false;  // a stop was sent and its bestmove has not come back yet
  let done = null;       // position whose search finished
  const post = (cmd) => worker && worker.postMessage(cmd);

  function kick() {
    if (!ready) return;
    if (running) {
      if (running !== target && !stopping) { stopping = true; post('stop'); }
      return;
    }
    if (target && target !== done) {
      running = target;
      post('position fen ' + target);
      post('go depth ' + depth);
    }
  }
  function onLine(line) {
    if (line === 'uciok') { post('setoption name Hash value 32'); post('setoption name MultiPV value 3'); post('isready'); return; }
    if (line === 'readyok') { if (!ready) { ready = true; kick(); } return; }
    if (line.startsWith('info')) {
      if (stopping || !running || running !== target) return;
      const info = parseInfo(line);
      if (info) onInfo(running, info);
      return;
    }
    if (line.startsWith('bestmove')) {
      const finished = !stopping && running;
      if (finished) done = running;
      running = null;
      stopping = false;
      if (finished && onDone) onDone(finished);
      kick();
    }
  }
  try {
    worker = new Worker('lib/stockfish-19-lite-single.js');
    worker.onmessage = (e) => onLine(String(e.data));
    worker.onerror = () => { failed = true; render(); };
    post('uci');
  } catch (e) { failed = true; }

  return {
    search(f) {
      if (f !== target) done = null;
      target = f;
      kick();
    },
  };
}

function keepDeepest(list, info) {
  const old = list[info.multipv - 1];
  if (!old || info.depth >= old.depth) list[info.multipv - 1] = info;
}

const main = Engine(DEPTH, (f, info) => {
  if (f !== fen) return;
  keepDeepest(lines, info);
  const top = Scoring.sortLines(lines)[0];
  if (top && top.depth >= REPLY_FROM_DEPTH && top.pv[0] !== replyMove) setReplyMove(top.pv[0]);
  scheduleRender();
});
const reply = Engine(DEPTH, (f, info) => {
  if (f !== replyFen) return;
  keepDeepest(replyLines, info);
  scheduleRender();
});
const gameEngine = Engine(GAME_DEPTH, (f, info) => {
  if (!game || gameJob == null || game.fens[gameJob] !== f) return;
  keepDeepest((GA[gameJob] || (GA[gameJob] = { lines: [] })).lines, info);
  scheduleRender();
}, (f) => {
  if (game && gameJob != null && game.fens[gameJob] === f) (GA[gameJob] || (GA[gameJob] = { lines: [] })).done = true;
  gameJob = null;
  nextGameJob();
  scheduleRender();
});

function setReplyMove(u) {
  replyMove = u;
  replyLines = [];
  replyFen = u ? afterMove(fen, u) : null;
  reply.search(replyFen && !gameOver(replyFen) ? replyFen : null);
}

/* ---------- finished game ---------- */
function pendingPly(i) { return !game.over[i] && !(GA[i] && GA[i].done); }
// Positions up to the board's move first, so its numbers fill in soonest, then the rest.
function nextGameJob() {
  let i = -1;
  if (game) {
    for (let k = 0; k <= lastPly && k < game.fens.length; k++) if (pendingPly(k)) { i = k; break; }
    if (i < 0) i = game.fens.findIndex((_, k) => pendingPly(k));
  }
  gameJob = i < 0 ? null : i;
  gameEngine.search(i < 0 ? null : game.fens[i]);
}
// The board's position in the game. A position can repeat, so take the match nearest the last one.
function matchPly() {
  ply = null;
  if (!game || !fen) return;
  const k = posKey(fen);
  game.fens.forEach((g, i) => {
    if (posKey(g) === k && (ply == null || Math.abs(i - lastPly) < Math.abs(ply - lastPly))) ply = i;
  });
  if (ply != null) lastPly = ply;
}
function setGame(g) {
  const pgn = g && g.pgn ? String(g.pgn) : null;
  if ((game ? game.pgn : null) === pgn) return;
  game = null;
  GA = [];
  ply = null;
  lastPly = 0;
  const P = pgn && Scoring.parseGame(pgn);
  if (P && P.hist.length) {
    game = {
      pgn, header: P.header, white: g.white || {}, black: g.black || {},
      fens: P.fens, hist: P.hist, over: P.over,
      times: Scoring.computeTimes(pgn, P.header.TimeControl, P.hist),
      accuracies: g.accuracies || null, timeClass: g.time_class || '',
    };
    matchPly();
  }
  nextGameJob();
  render();
}
function gameInfos() {
  return game.hist.map((mv, i) => Scoring.scoreMove(mv, game.fens[i], GA[i], GA[i + 1], game.over[i + 1]) || { color: mv.color, pending: true });
}

/* ---------- position ---------- */
function setFen(f) {
  locked = false;
  if (f === fen) return;
  const prev = fen;
  if (prev && lines.length) remember(seen, prev, { lines: lines.slice() });
  fen = f;
  lines = [];
  setReplyMove(null);
  const valid = f && new Chess().validate_fen(f).valid;
  if (valid && prev) {
    const mv = findMove(prev, f);
    if (mv) remember(movedInto, f, { mv, fenB: prev });
  }
  lastMove = valid ? movedInto.get(f) || null : null;
  matchPly();
  main.search(valid && !gameOver(f) ? f : null);
  render();
}
function lock() {
  locked = true;
  fen = null;
  lines = [];
  lastMove = null;
  setReplyMove(null);
  main.search(null);
  setGame(null);
  render();
}

// The move that led to the board's position, rated: from the game analysis on a finished
// game, otherwise from what the engine saw before and after a move played on the board.
function lastMoveView(infos) {
  if (game && ply != null && ply > 0) {
    const i = ply - 1, x = infos[i];
    return { san: game.hist[i].san, fenB: game.fens[i], x: x.pending ? null : x, before: GA[i], time: game.times ? game.times[i] : null };
  }
  if (!lastMove) return null;
  const before = seen.get(lastMove.fenB) || null;
  const x = Scoring.scoreMove(lastMove.mv, lastMove.fenB, before, { lines }, Scoring.overInfo(fen));
  return { san: lastMove.mv.san, fenB: lastMove.fenB, x, before, time: null };
}

/* ---------- render ---------- */
function evalHTML() {
  const o = Scoring.overInfo(fen);
  let pct = 50, num = '…', text = 'Analysing this position';
  if (o === 'mate') {
    const whiteWon = !stmIsWhite(fen);
    pct = whiteWon ? 100 : 0; num = 'Checkmate'; text = playerName(whiteWon ? 'w' : 'b') + ' wins';
  } else if (o === 'draw') {
    num = '½–½'; text = 'Draw';
  } else {
    const best = Scoring.sortLines(lines)[0];
    if (best) {
      const s = whiteScore(best.score, fen);
      pct = s.mate != null ? (s.mate > 0 ? 100 : 0) : Scoring.winPct(s.cp);
      num = fmtScore(s);
      text = s.mate == null && Math.abs(s.cp) < 30 ? 'Roughly equal' : playerName(isWhiteAhead(s) ? 'w' : 'b') + ' is better';
    }
  }
  return '<section class="eval"><div class="evalbar" title="White\'s share of the bar"><span style="width:' + pct.toFixed(1) + '%"></span></div>' +
    '<div class="evalrow"><span class="evalnum">' + esc(num) + '</span><span class="evaltext">' + esc(text) + '</span></div>' +
    '<p class="fine">Scores are from White\'s side: + is good for White, − is good for Black.</p></section>';
}
function lastMoveHTML(lm) {
  if (!lm) return '';
  const label = esc(moveLabel(lm.fenB, lm.san));
  let h = '<section class="side-block lastmove"><p class="side">Last move</p><div class="mi-title">' +
    (lm.x ? '<span class="tag ' + lm.x.cls + '">' + TAG[lm.x.cls][0] + '</span>' : '') + label + '</div>';
  if (!lm.x) return h + '<p class="note">' + (lm.before ? 'Still analysing this move…' : 'Not enough analysis of the position before it.') + '</p></section>';
  let t = '<strong>' + esc(lm.san) + '</strong> is ' + (lm.x.cls === 'best' ? 'the best move' : TAG[lm.x.cls][1].toLowerCase()) + '.';
  const best = Scoring.sortLines(lm.before && lm.before.lines)[0];
  if (!lm.x.top1 && best) t += ' Best was <strong>' + esc(pvToSan(lm.fenB, best.pv, 1)[0] || best.pv[0]) + '</strong> (' + fmtScore(whiteScore(best.score, lm.fenB)) + ').';
  if (lm.x.critical) t += lm.x.found ? ' This was the only good move, and it was found.' : ' This was an only-move position.';
  if (lm.time != null) t += ' Took ' + fmtSecs(lm.time) + '.';
  return h + '<p class="mi-text">' + t + '</p></section>';
}
function linesHTML(f, list) {
  return Scoring.sortLines(list).map((l) => {
    const s = pvToSan(f, l.pv, 4);
    return '<div class="line">' + scoreHTML(l.score, f) + '<span class="move">' + esc(s[0] || l.pv[0]) + '</span><span class="pv">' + esc(s.slice(1).join(' ')) + '</span></div>';
  }).join('');
}
const orderNote = (f) => stmIsWhite(f) ? 'best first, highest score' : 'best first, lowest score';
function hintsHTML() {
  if (failed) return '<p class="note">Stockfish could not start.</p>';
  if (!fen) return '<p class="note">Waiting for the board…</p>';
  if (!new Chess().validate_fen(fen).valid) return '<p class="note">Could not read this position.</p>';
  const over = gameOver(fen);
  if (over) return '<p class="note">' + over + '</p>';

  const me = stmIsWhite(fen) ? 'White' : 'Black', opp = stmIsWhite(fen) ? 'Black' : 'White';
  let h = '<section class="side-block best"><p class="side">' + me + ' to move · top 3 <span class="dim">(' + orderNote(fen) + ')</span></p>';
  h += lines.length ? linesHTML(fen, lines) : '<p class="note">Analysing…</p>';
  h += '</section><section class="side-block reply"><p class="side">';
  if (!replyMove) return h + opp + '\'s top 3 replies</p><p class="note">Waiting for ' + me + '\'s top move…</p></section>';
  const san = pvToSan(fen, [replyMove], 1)[0] || replyMove;
  h += opp + '\'s top 3 replies to <strong>' + esc(san) + '</strong>' + (replyFen ? ' <span class="dim">(' + orderNote(replyFen) + ')</span>' : '') + '</p>';
  const overAfter = replyFen && gameOver(replyFen);
  if (overAfter) h += '<p class="note">' + overAfter + '</p>';
  else h += replyLines.length ? linesHTML(replyFen, replyLines) : '<p class="note">Analysing…</p>';
  return h + '</section>';
}

function evalPct(i) {
  const o = game.over[i];
  if (o === 'mate') return stmIsWhite(game.fens[i]) ? 0 : 100;
  if (o === 'draw') return 50;
  const best = Scoring.sortLines(GA[i] && GA[i].lines)[0];
  return best ? Scoring.winPct(Scoring.cpOf(whiteScore(best.score, game.fens[i]))) : null;
}
function graphHTML() {
  const w = game.fens.length - 1;
  let prev = 50;
  const pts = game.fens.map((_, i) => { const v = evalPct(i); prev = v == null ? prev : v; return prev; });
  const d = 'M0,100 ' + pts.map((v, i) => 'L' + i + ',' + (100 - v).toFixed(1)).join(' ') + ' L' + w + ',100 Z';
  return '<svg class="graph" viewBox="0 0 ' + w + ' 100" preserveAspectRatio="none" aria-label="Eval graph">' +
    '<rect width="' + w + '" height="100" class="g-bg"/><path d="' + d + '" class="g-fill"/>' +
    '<line x1="0" x2="' + w + '" y1="50" y2="50" class="g-mid"/>' +
    '<line x1="' + lastPly + '" x2="' + lastPly + '" y1="0" y2="100" class="g-cur"/></svg>';
}
function cardHTML(color, infos) {
  const p = color === 'w' ? game.white : game.black;
  const s = Scoring.summarize(infos.slice(0, lastPly), color, game.times), lk = Scoring.likeness(s);
  const res = game.header.Result, dash = '—';
  const score = res === '1/2-1/2' ? '½' : res === '1-0' ? (color === 'w' ? '1' : '0') : res === '0-1' ? (color === 'b' ? '1' : '0') : '';
  const chessAcc = game.accuracies && game.accuracies[color === 'w' ? 'white' : 'black'];
  const row = (k, v) => '<tr><th>' + k + '</th><td>' + v + '</td></tr>';
  let h = '<div class="card"><div class="prow"><span class="pname ' + color + '">' + esc(playerName(color)) +
    (p.rating ? ' <span class="dim">(' + esc(p.rating) + ')</span>' : '') + '</span>' + (score ? '<span class="presult">' + score + '</span>' : '') + '</div>';
  h += '<div class="big-row"><div class="big"><span class="v">' + (s.n ? s.acc.toFixed(1) : dash) + '</span><span class="k">Accuracy</span></div>' +
    '<div class="big"><span class="v">' + (lk ? lk.v + ' <span class="chip ' + lk.band[0] + '">' + lk.band[1] + '</span>' : dash) + '</span>' +
    '<span class="k">Engine-likeness' + (lk ? '' : ' (needs 10 scored moves, ' + s.n + ' so far)') + '</span></div></div>';
  h += '<table class="stats"><tbody>' +
    row('Top engine move played', s.n ? Math.round(s.t1) + '%' : dash) +
    row('One of the top 3 moves', s.n ? Math.round(s.t3) + '%' : dash) +
    row('Avg. centipawn loss', s.n ? Math.round(s.cpl) : dash) +
    row('Only moves found', s.crit ? s.critFound + ' of ' + s.crit : dash) +
    row('Longest run of top moves', s.n ? s.streak : dash) +
    (game.times ? row('Avg. time on only-move positions', s.critAvg != null ? fmtSecs(s.critAvg) + ' <span class="dim">vs ' + (s.otherAvg != null ? fmtSecs(s.otherAvg) : dash) + ' on others</span>' : dash) +
      row('Move-time variation', s.cv != null ? s.cv.toFixed(2) + ' <span class="dim">' + (s.cv < 0.45 ? 'unusually steady' : 'normal') + '</span>' : dash) : '') +
    (chessAcc != null ? row('chess.com accuracy <span class="dim">(whole game)</span>', chessAcc.toFixed(1)) : '') +
    row('Moves scored', s.n + (s.waiting ? ' <span class="dim">(analysing ' + s.waiting + ' more)</span>' : '')) +
    '</tbody></table>';
  h += '<div class="counts">' + Object.keys(TAG_NAME).map((k) => '<span><span class="tag ' + k + '">' + TAG[k][0] + '</span>' + s.counts[k] + ' ' + TAG_NAME[k] + '</span>').join('') + '</div></div>';
  return h;
}
function movesHTML(infos) {
  let h = '<div class="moves">', i = 0, num = +game.fens[0].split(' ')[5] || 1;
  const cell = (k) => {
    const x = infos[k];
    return '<span class="mv' + (k === lastPly - 1 ? ' cur' : '') + '">' + esc(game.hist[k].san) +
      (x.pending ? '' : ' <span class="tag ' + x.cls + '" title="' + TAG_NAME[x.cls] + '">' + TAG[x.cls][0] + '</span>') + '</span>';
  };
  if (!stmIsWhite(game.fens[0])) { h += '<span class="num">' + num + '.</span><span></span>' + cell(0); i = 1; num++; }
  for (; i < game.hist.length; i += 2) {
    h += '<span class="num">' + num + '.</span>' + cell(i) + (i + 1 < game.hist.length ? cell(i + 1) : '<span></span>');
    num++;
  }
  return h + '</div>';
}
function gameHTML(infos) {
  if (!game) return '';
  const hd = game.header;
  const tc = game.timeClass ? game.timeClass[0].toUpperCase() + game.timeClass.slice(1) : '';
  const done = game.fens.filter((_, i) => !game.over[i] && GA[i] && GA[i].done).length;
  const total = game.fens.filter((_, i) => !game.over[i]).length;
  let h = '<section class="side-block game"><p class="side">' + esc(playerName('w')) + ' vs ' + esc(playerName('b')) +
    ' · ' + esc(hd.Result || '*') + (hd.Termination ? ' · ' + esc(hd.Termination) : '') + (tc ? ' · ' + esc(tc) : '') + '</p>';
  h += graphHTML();
  h += '<p class="fine">' + (done < total ? 'Analysing the game: ' + done + ' of ' + total + ' positions at depth ' + GAME_DEPTH + '.' : 'Game analysed at depth ' + GAME_DEPTH + '.') + '</p>';
  if (ply == null && fen) h += '<p class="note">The board is off the game\'s moves, so the report stops at the last game position shown.</p>';
  h += '<details data-sec="report"' + (open.report ? ' open' : '') + '><summary>Player report ' +
    (lastPly ? 'up to <strong>' + esc(moveLabel(game.fens[lastPly - 1], game.hist[lastPly - 1].san)) + '</strong>' : 'before the first move') + '</summary>' +
    cardHTML('w', infos) + cardHTML('b', infos) +
    '<p class="fine">Engine-likeness compares each move to Stockfish\'s top choices. The first 4 moves and forced moves aren\'t scored. "Only moves" are positions where every move but one loses a lot. One game is a very small sample, and strong players often score high on all of this, so treat it as a reason to look closer, not proof of cheating. If you think someone cheated, report them to chess.com, which checks far more data.</p></details>';
  h += '<details data-sec="moves"' + (open.moves ? ' open' : '') + '><summary>Moves</summary>' + movesHTML(infos) + '</details>';
  return h + '</section>';
}

function bodyHTML(infos, lm) {
  if (locked) return '<p class="note">Hints turn on once this game is finished. chess.com\'s archive can take a few minutes to list it.</p>';
  if (failed || !fen) return hintsHTML() + gameHTML(infos);
  return evalHTML() + lastMoveHTML(lm) + hintsHTML() + gameHTML(infos);
}

// Arrows for content.js to draw: the top 3 moves (best one boldest), the reply to the best
// move, and a dashed arrow for what should have been played when the last move wasn't good.
function arrowList(lm) {
  if (!arrowsOn || locked || !fen) return [];
  const out = [], L = Scoring.sortLines(lines);
  L.slice(1, 3).forEach((l) => { if (l.pv[0] !== L[0].pv[0]) out.push({ uci: l.pv[0], kind: 'alt' }); });
  if (L[0]) out.push({ uci: L[0].pv[0], kind: 'best' });
  const R = Scoring.sortLines(replyLines)[0];
  if (R && replyMove && L[0] && L[0].pv[0] === replyMove) out.push({ uci: R.pv[0], kind: 'reply' });
  if (lm && lm.x && !lm.x.top1 && lm.x.cls !== 'exc') {
    const b = Scoring.sortLines(lm.before && lm.before.lines)[0];
    if (b) out.push({ uci: b.pv[0], kind: 'should' });
  }
  return out;
}

let lastHTML = null, lastArrows = null, timer = null;
function render() {
  const infos = game ? gameInfos() : [];
  const lm = !locked && fen ? lastMoveView(infos) : null;
  const html = bodyHTML(infos, lm);
  if (html !== lastHTML) { $('body').innerHTML = html; lastHTML = html; }
  const top = Scoring.sortLines(lines)[0], rtop = Scoring.sortLines(replyLines)[0];
  $('meta').textContent = !locked && top ? 'Stockfish 19 · depth ' + top.depth + (rtop ? ' / ' + rtop.depth : '') : '';
  const arrows = arrowList(lm), key = JSON.stringify(arrows);
  if (key !== lastArrows) { lastArrows = key; parent.postMessage({ cgr: 'arrows', arrows }, CHESS_ORIGIN); }
  parent.postMessage({ cgr: 'hints-height', height: document.documentElement.scrollHeight }, CHESS_ORIGIN);
}
function scheduleRender() {
  if (timer) return;
  timer = setTimeout(() => { timer = null; render(); }, 120);
}

/* ---------- controls and messages ---------- */
document.addEventListener('toggle', (e) => {
  const sec = e.target.dataset && e.target.dataset.sec;
  if (sec && open[sec] !== e.target.open) { open[sec] = e.target.open; render(); }
}, true);
$('arrowsOpt').addEventListener('change', (e) => {
  arrowsOn = e.target.checked;
  try { chrome.storage.local.set({ arrowsOn }); } catch (err) { /* storage unavailable */ }
  render();
});
try {
  chrome.storage.local.get('arrowsOn').then((r) => {
    if (r.arrowsOn === false) { arrowsOn = false; $('arrowsOpt').checked = false; render(); }
  }).catch(() => {});
} catch (e) { /* storage unavailable */ }

window.addEventListener('message', (e) => {
  if (e.origin !== CHESS_ORIGIN || e.source !== parent || !e.data) return;
  if (e.data.type === 'fen') setFen(String(e.data.fen || ''));
  else if (e.data.type === 'game') setGame(e.data.game);
  else if (e.data.type === 'locked') lock();
});

render();
parent.postMessage({ cgr: 'hints-ready' }, CHESS_ORIGIN);
})();
