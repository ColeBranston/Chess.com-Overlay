// Tells content.js whether a game is in chess.com's public archive (that is, finished),
// and if so hands back its moves and players for the overlay's game report.
importScripts('api.js');

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg && msg.type === 'is-archived') {
    ChessApi.find(msg.id, msg.users || [])
      .then((g) => reply({
        archived: !!g,
        game: g && { pgn: g.pgn, rules: g.rules, white: g.white, black: g.black, accuracies: g.accuracies || null, time_class: g.time_class || '' },
      }))
      .catch(() => reply({ archived: false }));
    return true;
  }
});
