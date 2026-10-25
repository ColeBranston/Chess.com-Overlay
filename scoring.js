// Move scoring for the live hints panel: sorting engine lines, rating moves, and the
// per-player report (accuracy, engine-likeness and the rest). Needs chess.js loaded first.
const Scoring = {
  START: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',

  clamp: (v, a, b) => Math.max(a, Math.min(b, v)),
  winPct: (cp) => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1),
  cpOf(s) { return s.mate != null ? (s.mate > 0 ? 1000 : -1000) : this.clamp(s.cp, -1000, 1000); },

  // An engine score (side to move's view) as one sortable number: a mate beats any
  // centipawn score, a quicker mate ranks above a slower one, and being mated ranks lowest.
  rank(s) { return s.mate != null ? (s.mate > 0 ? 100000 - s.mate : -100000 - s.mate) : s.cp; },

  // Multipv lines, best first for the side to move. Mid-search the lines come from
  // different depths, so the engine's own multipv order can be out of date: sort by score.
  sortLines(list) {
    return (list || []).filter(Boolean).sort((a, b) => this.rank(b.score) - this.rank(a.score) || a.multipv - b.multipv);
  },

  overInfo(fen) {
    const c = new Chess(fen);
    return c.in_checkmate() ? 'mate' : (c.in_stalemate() || c.insufficient_material()) ? 'draw' : null;
  },

  // Positions and moves of a PGN, or null if it can't be read. A move is marked forced
  // when it was the only legal one.
  parseGame(pgn) {
    const c = new Chess();
    if (!c.load_pgn(pgn, { sloppy: true })) return null;
    const header = c.header();
    const b = new Chess(header.FEN || this.START);
    const fens = [b.fen()], hist = [];
    for (const san of c.history()) {
      const legal = b.moves().length;
      const m = b.move(san);
      if (!m) break;
      m.forced = legal === 1;
      hist.push(m);
      fens.push(b.fen());
    }
    return { header, fens, hist, over: fens.map((f, i) => i === fens.length - 1 ? this.overInfo(f) : null) };
  },

  // Seconds spent on each move, from the PGN's clock comments, or null without them.
  computeTimes(pgn, tc, hist) {
    const clk = [...pgn.matchAll(/\[%clk (\d+):(\d+):(\d+(?:\.\d+)?)\]/g)].map((m) => +m[1] * 3600 + +m[2] * 60 + +m[3]);
    const m = /^(\d+)(?:\+(\d+(?:\.\d+)?))?$/.exec(tc || '');
    if (!m || clk.length !== hist.length) return null;
    const base = +m[1], inc = +(m[2] || 0), last = { w: base, b: base };
    return hist.map((mv, i) => {
      const spent = Math.max(0, last[mv.color] - clk[i] + inc);
      last[mv.color] = clk[i];
      return spent;
    });
  },

  // Scores one move. before/after are the engine results ({lines[]}) for the positions
  // before and after it; overAfter is overInfo() of the position after. Null until the
  // engine has enough depth.
  scoreMove(mv, fenB, before, after, overAfter) {
    const L = this.sortLines(before && before.lines);
    if (!L[0] || L[0].depth < 8) return null;
    const uci = mv.from + mv.to + (mv.promotion || '');
    const best = this.cpOf(L[0].score);
    const rank = L.findIndex((l) => l.pv[0] === uci);
    let played;
    if (rank >= 0) played = this.cpOf(L[rank].score);
    else if (overAfter === 'mate') played = 1000;
    else if (overAfter === 'draw') played = 0;
    else {
      const A = this.sortLines(after && after.lines);
      if (!A[0] || A[0].depth < 8) return null;
      played = -this.cpOf(A[0].score);
    }
    const drop = Math.max(0, this.winPct(best) - this.winPct(played));
    const acc = this.clamp(103.1668 * Math.exp(-0.04354 * drop) - 3.1669, 0, 100);
    const cls = rank === 0 ? 'best' : drop < 2 ? 'exc' : drop < 5 ? 'good' : drop < 10 ? 'inacc' : drop < 20 ? 'mist' : 'blund';
    // an "only move": the second-best move is much worse, and the game isn't already decided
    const second = L[1] ? this.cpOf(L[1].score) : null;
    const critical = second != null && this.winPct(best) - this.winPct(second) >= 15 && this.winPct(best) <= 97;
    const fullmove = +fenB.split(' ')[5] || 1;
    return {
      color: mv.color, cls, acc, drop, cpl: Math.max(0, best - played),
      top1: rank === 0, top3: rank >= 0 && rank < 3,
      critical, found: rank === 0,
      counted: !mv.forced && fullmove > 4,
    };
  },

  // One player's report from scoreMove() results (infos[i] for move i; a move the engine
  // hasn't reached yet is { color, pending: true }) and optional seconds per move.
  summarize(infos, color, times) {
    const s = { n: 0, t1: 0, t3: 0, cpl: 0, acc: 0, crit: 0, critFound: 0, streak: 0, waiting: 0,
      counts: { best: 0, exc: 0, good: 0, inacc: 0, mist: 0, blund: 0 }, critT: [], otherT: [], allT: [] };
    let run = 0, inv = 0;
    infos.forEach((x, i) => {
      if (!x || x.color !== color) return;
      if (x.pending) { s.waiting++; return; }
      s.counts[x.cls]++;
      if (!x.counted) return;
      s.n++; s.t1 += x.top1; s.t3 += x.top3; s.cpl += x.cpl; s.acc += x.acc; inv += 1 / Math.max(x.acc, 1);
      run = x.top1 ? run + 1 : 0;
      s.streak = Math.max(s.streak, run);
      if (x.critical) { s.crit++; if (x.found) s.critFound++; }
      if (times) { const t = times[i]; (x.critical ? s.critT : s.otherT).push(t); s.allT.push(t); }
    });
    // game accuracy: average of the mean and the harmonic mean, so a few blunders weigh in properly
    if (s.n) { s.t1 = s.t1 / s.n * 100; s.t3 = s.t3 / s.n * 100; s.cpl /= s.n; s.acc = (s.acc / s.n + s.n / inv) / 2; }
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    if (s.allT.length >= 10) {
      const m = mean(s.allT);
      s.cv = m > 0 ? Math.sqrt(mean(s.allT.map((t) => (t - m) ** 2))) / m : null;
    }
    s.critAvg = s.critT.length ? mean(s.critT) : null;
    s.otherAvg = s.otherT.length ? mean(s.otherT) : null;
    return s;
  },

  // s: { n, t1, t3, acc } with t1/t3 as percentages. Null below 10 scored moves.
  likeness(s) {
    if (s.n < 10) return null;
    const v = Math.round(0.45 * s.t1 + 0.2 * s.t3 + 0.35 * s.acc);
    const band = v < 60 ? ['ok', 'Human range'] : v < 75 ? ['strong', 'Strong play'] : v < 85 ? ['warn', 'Engine-like'] : ['high', 'Very engine-like'];
    return { v, band };
  },
};
