// chess.com public API helpers for background.js's finished-game check.
// The public archive only contains finished games.
const ChessApi = {
  async monthGames(user, y, m) {
    const url = `https://api.chess.com/pub/player/${encodeURIComponent(user.toLowerCase())}/games/${y}/${String(m).padStart(2, '0')}`;
    const r = await fetch(url);
    if (r.status === 404) return [];
    if (!r.ok) throw new Error('chess.com returned an error (' + r.status + ')');
    return (await r.json()).games || [];
  },

  // [year, month] pairs, newest first, in UTC like the archive
  months(n) {
    const out = [];
    const d = new Date();
    let y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
    for (let i = 0; i < n; i++) {
      out.push([y, m]);
      if (--m === 0) { m = 12; y--; }
    }
    return out;
  },

  gameId(url) {
    const m = String(url || '').match(/(\d+)\/?$/);
    return m ? m[1] : null;
  },

  async find(id, users) {
    for (const u of users) {
      for (const [y, m] of this.months(3)) {
        try {
          const g = (await this.monthGames(u, y, m)).find((x) => this.gameId(x.url) === String(id));
          if (g) return g;
        } catch (e) { /* try the next player or month */ }
      }
    }
    return null;
  },
};
