// hlj-module.ts — High Low Jack as a Game module + its move log.
//
// This is a thin ADAPTER over the existing pure code in engine.ts / ai.ts /
// protocol.ts. It reimplements no rules: each method delegates to functions you
// already have and tested.
//
// On top of the engine it maintains an authoritative move log. The engine never
// learns about the log: every engine transition is `{ ...state, ... }`, so the
// extra `log` / `logSeq` fields we add to the state ride through each transition
// untouched. We only APPEND new entries at this boundary, by diffing the engine
// state before and after each move. Because the log lives in state, it persists
// across hibernation and is identical for every client (including reconnects).

import {
  createGame as engineCreateGame,
  applyMove as engineApplyMove,
  legalMoves,
  setSignal,
  type GameState,
  type Move,
  type PlayerCount,
  type HandSignal,
} from "./engine.ts";
import { redact, type PlayerView } from "./protocol.ts";
import { aiMove, handConfidence } from "./ai.ts";
import type { Game, LogEntry } from "./game.ts";

export type HLJConfig = { players: PlayerCount; target: number };

// The engine's state plus an authoritative, append-only move log.
export type HljState = GameState & { log: LogEntry[]; logSeq: number };

const moveEq = (a: Move, b: Move): boolean => JSON.stringify(a) === JSON.stringify(b);

const LOG_CAP = 120;
const teamName = (seat: number): string => (seat % 2 === 0 ? "Team A" : "Team B");
const teamLetter = (t: number): string => (t === 0 ? "A" : "B");

// Append entries (assigning monotonic ids), returning the extended state.
function attach(next: GameState, prevLog: LogEntry[], prevSeq: number, parts: Omit<LogEntry, "id">[]): HljState {
  let seq = prevSeq;
  const added = parts.map((p) => ({ id: ++seq, ...p }));
  const log = [...prevLog, ...added].slice(-LOG_CAP);
  return { ...(next as HljState), log, logSeq: seq };
}

// Derive the log rows produced by one move, from the before/after engine states.
function hljEntries(prev: HljState, next: GameState, move: Move): Omit<LogEntry, "id">[] {
  const out: Omit<LogEntry, "id">[] = [];

  // 1) the move itself
  if (move.type === "bid") out.push({ seat: move.seat, msg: `bid ${move.amount}` });
  else if (move.type === "pass") out.push({ seat: move.seat, msg: "passed" });
  else if (move.type === "selectTrump") out.push({ seat: move.seat, msg: "called trump", suit: move.suit });
  else if (move.type === "play") out.push({ seat: move.seat, msg: "played", cards: [move.card] });

  // 2) bidding resolved -> the winner takes the contract and leads
  if (
    next.winningBid &&
    (!prev.winningBid || prev.winningBid.seat !== next.winningBid.seat || prev.winningBid.amount !== next.winningBid.amount)
  ) {
    out.push({ seat: next.winningBid.seat, msg: `wins the bid at ${next.winningBid.amount}` });
  }

  // 3) trump fixed by the opening lead (when not declared explicitly)
  if (prev.trump === null && next.trump !== null && move.type === "play") {
    out.push({ seat: null, msg: "trump is", suit: next.trump });
  }

  // 4) a trick was just resolved
  if (next.tricksWon.length > prev.tricksWon.length) {
    const t = next.tricksWon[next.tricksWon.length - 1];
    out.push({ seat: t.seat, msg: "takes the trick" });
  }

  // 5) a hand was just scored
  if (next.lastHand && next.lastHand !== prev.lastHand) {
    const r = next.lastHand;
    out.push({ seat: null, msg: `${teamName(r.bidderSeat)} bid ${r.bid} \u2014 ${r.made ? "made it" : "set back"}` });
    const d = r.detail;
    const honors: string[] = [`High\u2192${teamLetter(d.high ?? 0)}`, `Low\u2192${teamLetter(d.low ?? 0)}`];
    if (d.jack !== null) honors.push(`Jack\u2192${teamLetter(d.jack)}`);
    if (d.bonhomme !== null) honors.push(`Joker\u2192${teamLetter(d.bonhomme)}`);
    if (d.game !== null) honors.push(`Game\u2192${teamLetter(d.game)}`);
    out.push({ seat: null, msg: honors.join("    ") });
    out.push({ seat: null, msg: `Score \u2014 A ${next.scores[0]}, B ${next.scores[1]}` });
    if (next.phase === "gameOver" && next.winner !== null) {
      out.push({ seat: null, msg: `${teamName(next.winner)} wins the game!` });
    } else if (next.dealerSeat !== prev.dealerSeat) {
      out.push({ seat: next.dealerSeat, msg: "deals the next hand" });
    }
  }

  return out;
}

export const hljModule: Game<HljState, Move, HLJConfig, PlayerView> = {
  meta: { id: "high-low-jack", name: "High Low Jack", supportedPlayerCounts: [4, 6, 8] },

  seatCount: (config) => config.players,

  createGame: (config, seed) => {
    const g = engineCreateGame(config.players, seed, config.target);
    return attach(g, [], 0, [{ seat: g.dealerSeat, msg: "deals the first hand" }]);
  },

  // Pitch's turn order: bidder during bidding, otherwise the player to act.
  seatToAct: (s) => (s.phase === "gameOver" ? null : s.phase === "bidding" ? s.bidTurn : s.turn),

  // Pitch's move set is tiny, so enumerate-and-compare is a fine authorizer.
  isLegal: (s, move) => legalMoves(s).some((m) => moveEq(m, move)),

  legalMoves: (s) => legalMoves(s),

  applyMove: (s, move) => {
    const next = engineApplyMove(s, move);
    return attach(next, s.log, s.logSeq, hljEntries(s, next, move));
  },

  isOver: (s) => s.phase === "gameOver",

  redact: (s, seat, meta) => redact(s, seat, { seats: meta.seats, hostSeat: meta.hostSeat, botReplacement: meta.botReplacement, disconnectedSeats: meta.disconnectedSeats }),

  lobbyView: (config, seat, meta) => {
    const g = engineCreateGame(config.players, 1, config.target);
    const blanked = { ...g, hands: g.hands.map(() => []), kitty: [], phase: "bidding" as const };
    return redact(blanked, seat, { seats: meta.seats, hostSeat: meta.hostSeat, botReplacement: meta.botReplacement, disconnectedSeats: meta.disconnectedSeats, phase: "lobby" });
  },

  aiMove: (s, seat) => aiMove(s, seat),

  // Hand signals: a non-turn side action that must preserve the log untouched.
  aux: {
    apply: (s, seat, payload) => {
      const next = setSignal(s, seat, payload as HandSignal);
      return { ...(next as HljState), log: s.log, logSeq: s.logSeq };
    },
    botAux: (s, seat) =>
      s.phase === "bidding" && s.signals[seat] == null ? handConfidence(s.hands[seat], s.players) : null,
  },
};
