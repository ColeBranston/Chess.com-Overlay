# Chess Live Hints

A Chrome extension that adds a Stockfish 19 overlay to chess.com's analysis board and to finished games. Stockfish runs locally in your browser (WebAssembly).

## Install

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and pick this folder.

After changing the files, click the reload arrow on the extension's card, then reload your chess.com tabs.

## Where it runs

The overlay only runs where the game can't still be in play:

- **`/analysis` with no game in the URL:** always on.
- **Any page for a specific game** (`/game/live/…`, `/game/daily/…`, `/analysis/game/…`): locked until the game shows up in chess.com's public archive, which only lists finished games. The check repeats every 30 seconds, and the archive can take a few minutes to list a game.

Everywhere else, including games in progress, there is no overlay, no engine and no arrows. The check is `hintsState()` in `content.js`.

The **Hide hints / Live hints** button in the bottom-right corner turns the overlay off and on. The choice is remembered.

## What the overlay shows

Everything updates live as the position on the board changes.

- **Eval bar and score** for the position on the board.
- **Last move**, rated Best, Excellent, Good, Inaccuracy, Mistake or Blunder, with the best move when it wasn't played, and whether it was an only-move position. On a finished game the rating comes from the game analysis, along with the time spent on the move. On the analysis board it rates moves played on the board, using what the engine saw before and after.
- **Top 3 moves for the side to move** and **the other side's top 3 replies** to the best one. A second Stockfish searches the replies. Both searches are set to depth 60, so they keep getting deeper until the board changes, and the header shows how deep they've got. While the overlay is open on a position, they keep two CPU cores busy.
- **Arrows on chess.com's board**, which you can switch off with the Arrows checkbox:
  - green: the top 3 moves, with the best one boldest
  - blue: the best reply to the best move
  - dashed orange: what should have been played when the last move wasn't the best or an excellent alternative

### Score signs and sorting

Every score is from White's side: + is good for White and − is good for Black. Each top-3 list is sorted by score, best first for the side to move. That means the highest score comes first when White is to move and the lowest when Black is to move. A forced mate ranks above any normal score, and a quicker mate ranks above a slower one. Mid-search, Stockfish's lines can come from different depths, so its own order can be briefly out of date. The overlay sorts by score, not by the engine's line numbers. Move ratings, accuracy and engine-likeness use the same sorted order.

### On a finished game

A third Stockfish works through the whole game at depth 14, starting with the moves up to the one on the board. The overlay then adds:

- **Eval graph** for the game, with the board's move marked
- **Player report** for each player, covering their moves up to the one on the board:
  - accuracy and engine-likeness
  - how often they played the top move or a top-3 move
  - average centipawn loss
  - only-moves found and the longest run of top moves
  - time spent on only-move positions and move-time variation, when the game has clock data
  - chess.com's own accuracy for the whole game, when the archive has it
  - counts of each move rating
- **Move list** with each move's rating, with the board's move highlighted

If you play moves on the board that aren't in the game, the report stays at the last game position shown.

Engine-likeness is a rough signal from one game. Strong players often score high. Treat it as a reason to look closer, not proof, and report suspected cheating to chess.com.

## Files

- `manifest.json`: extension setup
- `content.js`, `content.css`: the finished-game check, the overlay and its button, and the arrows on chess.com's board
- `board-reader.js`: reads the board position from chess.com's page
- `background.js`, `api.js`: looks games up in chess.com's public archive
- `hints.html`, `hints.css`, `hints.js`: the overlay and its three Stockfish engines
- `scoring.js`: sorting engine lines, move ratings and the player report
- `lib/`: chess.js 0.10.3 and Stockfish 19, the lite single-threaded build from stockfish.js 19.0.1 (npm `stockfish`, GPLv3, licence in `lib/stockfish-COPYING.txt`). The lite build uses a much smaller neural network than full Stockfish 19: about 1.8MB instead of about 99MB, and somewhat weaker, though still far stronger than any human. The overlay runs three engines at once, so the full build would use a lot of memory. Single-threaded builds are the only ones that run here without cross-origin isolation.
"# Chess.com-Overlay" 
