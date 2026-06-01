// hlj-module.ts — High Low Jack as a Game module + its Durable Object.
//
// This is a thin ADAPTER over the existing pure code in engine.ts / ai.ts /
// protocol.ts. It reimplements no rules: each method delegates to functions you
// already have and tested. The deferred features (signal-responsive bidding,
// implicit-trump-on-lead) land inside engine.ts / ai.ts later and flow through
// here unchanged.

import {
  createGame,
  applyMove,
  legalMoves,
  setSignal,
  type GameState,
  type Move,
  type PlayerCount,
  type HandSignal,
} from "./engine.ts";
import { redact, type PlayerView } from "./protocol.ts";
import { aiMove, handConfidence } from "./ai.ts";
import type { Game } from "./game.ts";

export type HLJConfig = { players: PlayerCount; target: number };

const moveEq = (a: Move, b: Move): boolean => JSON.stringify(a) === JSON.stringify(b);

export const hljModule: Game<GameState, Move, HLJConfig, PlayerView> = {
  meta: { id: "high-low-jack", name: "High Low Jack", supportedPlayerCounts: [4, 6, 8] },

  seatCount: (config) => config.players,

  createGame: (config, seed) => createGame(config.players, seed, config.target),

  // Pitch's turn order: bidder during bidding, otherwise the player to act.
  // null once the game is over. This is the per-game knowledge that USED to be
  // hardcoded in the server.
  seatToAct: (s) => (s.phase === "gameOver" ? null : s.phase === "bidding" ? s.bidTurn : s.turn),

  // Pitch's move set is tiny, so enumerate-and-compare is a fine authorizer.
  // (Rummy will implement a direct validator here instead.)
  isLegal: (s, move) => legalMoves(s).some((m) => moveEq(m, move)),

  legalMoves: (s) => legalMoves(s),

  applyMove: (s, move) => applyMove(s, move),

  isOver: (s) => s.phase === "gameOver",

  redact: (s, seat, meta) => redact(s, seat, { seats: meta.seats, hostSeat: meta.hostSeat }),

  lobbyView: (config, seat, meta) => {
    // A minimal undealt state so the lobby view carries seats/scores to render.
    const g = createGame(config.players, 1, config.target);
    const blanked = { ...g, hands: g.hands.map(() => []), kitty: [], phase: "bidding" as const };
    return redact(blanked, seat, { seats: meta.seats, hostSeat: meta.hostSeat, phase: "lobby" });
  },

  aiMove: (s, seat) => aiMove(s, seat),

  // Hand signals: a non-turn side action. A bot reveals its confidence as it
  // comes to bid. Rummy will simply omit `aux`.
  aux: {
    apply: (s, seat, payload) => setSignal(s, seat, payload as HandSignal),
    botAux: (s, seat) =>
      s.phase === "bidding" && s.signals[seat] == null
        ? handConfidence(s.hands[seat], s.players)
        : null,
  },
};

// The Durable Object subclass for High Low Jack rooms lives in worker.ts (the
// worker entry), alongside the other games' subclasses and the shared routing.
// The module above is pure — it imports no runtime — so it can also be reused
// on the client for single-player.
