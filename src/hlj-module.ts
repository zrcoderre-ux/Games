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
  reseed as engineReseed,
  legalMoves,
  setSignal,
  signalGateSeat,
  isHandSignal,
  emptyProfile,
  trickWinner,
  SUPPORTED_PLAYERS,
  type GameState,
  type Move,
  type PlayerCount,
  type PlayerProfile,
} from "./engine.ts";
import { redact, type PlayerView } from "./protocol.ts";
import { aiMove, handConfidence, PERSONALITIES, type Personality } from "./ai.ts";
import type { Game, LogEntry } from "./game.ts";

export type HLJConfig = { players: PlayerCount; target: number; bestOf?: number };

// The engine's state plus an authoritative, append-only move log, and the
// per-game seed the bots' personalities are drawn from (state.seed moves on
// every deal).
export type HljState = GameState & { log: LogEntry[]; logSeq: number; botSeed?: number };

const moveEq = (a: Move, b: Move): boolean => JSON.stringify(a) === JSON.stringify(b);

const LOG_CAP = 600;
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

  // 4) a trick was just resolved (read from the gate: the 6th trick's advance
  // scores the hand and deals the next, which empties tricksWon again)
  if (move.type === "advance" && prev.phase === "trickComplete" && prev.trickWinner != null) {
    out.push({ seat: prev.trickWinner, msg: "takes the trick" });
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
    // The hand's own totals: a game won mid-series has already reset next.scores.
    const scores = r.finalScores ?? next.scores;
    out.push({ seat: null, msg: `Score \u2014 A ${scores[0]}, B ${scores[1]}` });
    const [wonA, wonB] = next.gamesWon;
    if (next.phase === "gameOver" && next.winner !== null) {
      const what = next.winsNeeded > 1 ? `series ${Math.max(wonA, wonB)}\u2013${Math.min(wonA, wonB)}` : "game";
      out.push({ seat: null, msg: `${teamName(next.winner)} wins the ${what}!` });
    } else {
      if (r.gameWinner != null) {
        out.push({ seat: null, msg: `${teamName(r.gameWinner)} wins game ${wonA + wonB} \u2014 series A ${wonA}, B ${wonB}` });
      }
      if (next.dealerSeat !== prev.dealerSeat) out.push({ seat: next.dealerSeat, msg: "deals the next hand" });
    }
    // Retroactive dealt-hand entries so the log preserves every player's
    // starting hand for look-back. Appended after scoring so they appear
    // at the bottom of each hand's block (log is shown newest-first in UI).
    // scoreHand already sorted them (the deal order would reveal the shuffle).
    if (r.kitty.length) {
      out.push({ seat: null, msg: "kitty", cards: r.kitty });
    }
    for (let seat = 0; seat < r.dealtHands.length; seat++) {
      out.push({ seat, msg: "was dealt", cards: r.dealtHands[seat] });
    }
  }

  return out;
}

// Assign each bot a personality derived from the game seed + seat so bots vary
// naturally across games without needing UI controls. It stays fixed for the
// whole game (botSeed; games saved before it existed fall back to the hand seed).
// Weights: 40% aggressive, 40% balanced, 20% conservative. The personalities now
// differ mainly in how light a hand they bid and are close in strength (paired
// round-robin, `node src/ai.battle.ts --roundrobin`: aggressive ~53%, balanced
// ~50%, conservative ~48%), so the mix adds variety without a weak link.
const PERSONALITY_TABLE: Personality[] = [
  PERSONALITIES.aggressive,
  PERSONALITIES.balanced,
  PERSONALITIES.aggressive,
  PERSONALITIES.balanced,
  PERSONALITIES.conservative,
];
function botPersonality(state: HljState, seat: number): Personality {
  const h = (((state.botSeed ?? state.seed) >>> 0) ^ Math.imul(seat + 1, 0x9e3779b9)) >>> 0;
  return PERSONALITY_TABLE[h % PERSONALITY_TABLE.length];
}

// Validate the lobby options (throws with a message the lobby can show): the
// target is a whole number of points, bestOf (optional) an odd number of games.
function gameOptions(config: HLJConfig): { target: number; winsNeeded: number } {
  const target = config.target === undefined ? 21 : config.target;
  if (!Number.isInteger(target) || target < 1 || target > 10000) {
    throw new Error("Target must be a whole number from 1 to 10000");
  }
  const bestOf = config.bestOf ?? 1;
  if (!Number.isInteger(bestOf) || bestOf < 1 || bestOf > 9 || bestOf % 2 === 0) {
    throw new Error("Best of must be 1, 3, 5, 7 or 9 games");
  }
  return { target, winsNeeded: (bestOf + 1) / 2 };
}

// A saved profile with any fields an older deploy didn't record filled in.
function migrateProfile(p: Partial<PlayerProfile> | undefined): PlayerProfile {
  const base = emptyProfile();
  if (!p || typeof p !== "object") return base;
  const rec: Partial<PlayerProfile["signalRecord"]> = p.signalRecord ?? {};
  return {
    ...base,
    ...p,
    signalRecord: {
      weak: { ...base.signalRecord.weak, ...rec.weak },
      medium: { ...base.signalRecord.medium, ...rec.medium },
      strong: { ...base.signalRecord.strong, ...rec.strong },
    },
  };
}

export const hljModule: Game<HljState, Move, HLJConfig, PlayerView> = {
  meta: { id: "high-low-jack", name: "High Low Jack", supportedPlayerCounts: [4, 6, 8] },

  seatCount: (config) => config.players,

  // Scale bot delay so total wait per trick stays roughly constant regardless of player count.
  // Base 1600ms for 4p: 6p → ~1067ms, 8p → 800ms.
  botStepMs: (s) => Math.round(1600 * 4 / s.players),

  createGame: (config, seed) => {
    const { target, winsNeeded } = gameOptions(config);
    const g = engineCreateGame(config.players, seed, target, winsNeeded);
    return { ...attach(g, [], 0, [{ seat: g.dealerSeat, msg: "deals the first hand" }]), botSeed: seed };
  },

  // Fresh entropy for the shuffle (the log and botSeed ride through the spread).
  reseed: (s, entropy) => engineReseed(s, entropy) as HljState,

  // Saved games from older deploys: fill in fields added since (log, profiles,
  // series counters...) and drop any signal that isn't a real level.
  migrate: (raw) => {
    const s = raw as HljState;
    if (!s || typeof s !== "object" || !SUPPORTED_PLAYERS.includes(s.players)) throw new Error("Not a High Low Jack game");
    const log = Array.isArray(s.log) ? s.log : [];
    return {
      ...s,
      gamesWon: s.gamesWon ?? [0, 0],
      winsNeeded: s.winsNeeded ?? 1,
      bidHistory: s.bidHistory ?? [],
      signals: Array.from({ length: s.players }, (_, i) => (isHandSignal(s.signals?.[i]) ? s.signals[i] : null)),
      profiles: Array.from({ length: s.players }, (_, i) => migrateProfile(s.profiles?.[i])),
      lastHand: s.lastHand ?? null,
      dealtHands: s.dealtHands ?? null,
      trickWinner: s.phase === "trickComplete" && s.trickWinner == null ? trickWinner(s.currentTrick, s.trump!) : (s.trickWinner ?? null),
      log,
      logSeq: Number.isInteger(s.logSeq) ? s.logSeq : log.reduce((m, e) => Math.max(m, e.id), 0),
      botSeed: s.botSeed ?? s.seed,
    };
  },

  // Pitch's turn order: bidder during bidding, otherwise the player to act.
  // No seat acts during the trickComplete gate — the driver auto-advances it.
  seatToAct: (s) => ((s.phase === "gameOver" || s.phase === "trickComplete" || s.pendingSignal) ? null : s.phase === "bidding" ? s.bidTurn : s.turn),

  // Pacing contract for non-player gate phases. The driver owns the single timer.
  // Every completed trick lingers so players can read it; the final trick lingers
  // longer so the game never snaps to the win screen. A stack tap (advance) skips ahead.
  pacing: (s) => {
    // Confidence-pick gate: only the bidder's pick (aux) or tap clears it. The
    // 30 s auto-advance is the safety net, and the driver applies it at once if
    // that seat stops being a connected human.
    if (s.pendingSignal) {
      const seat = signalGateSeat(s);
      const move: Move = { type: "advance", seat: seat ?? s.bidTurn };
      return seat === null ? { kind: "auto", ms: 30000, move } : { kind: "auto", ms: 30000, move, advanceSeat: seat };
    }
    if (s.phase !== "trickComplete") return null;
    const lastTrick = s.trickIndex >= 5;
    return { kind: "auto", ms: lastTrick ? 2600 : 1500, move: { type: "advance", seat: s.trickWinner ?? 0 } };
  },

  // Pitch's move set is tiny, so enumerate-and-compare is a fine authorizer.
  isLegal: (s, move) => legalMoves(s).some((m) => moveEq(m, move)),

  legalMoves: (s) => legalMoves(s),

  applyMove: (s, move) => {
    // Clear pendingSignal gate via advance move (30s server safety-net path).
    if (move.type === "advance" && s.pendingSignal) {
      return { ...s, pendingSignal: false, pendingSignalSeat: null };
    }
    const next = engineApplyMove(s, move);
    return attach(next, s.log, s.logSeq, hljEntries(s, next, move));
  },

  // Called by the driver after a HUMAN bid to open the confidence-pick gate.
  // Bots set their signal via botAux and never need the gate.
  openHumanGate: (s, move) => {
    if (move.type !== "bid") return null;
    const hs = s as HljState;
    const n = hs.players;
    const dealer = hs.dealerSeat;
    if (move.seat === dealer) return null;
    const actedSeats = new Set(hs.bidHistory.map((b) => b.seat));
    let teammateLeft = false;
    if (move.amount === 6) {
      teammateLeft = dealer % 2 === move.seat % 2 && !actedSeats.has(dealer);
    } else {
      for (let i = 1; i <= n; i++) {
        const s2 = (move.seat + i) % n;
        if (!actedSeats.has(s2) && s2 % 2 === move.seat % 2) { teammateLeft = true; break; }
        if (s2 === dealer) break;
      }
    }
    return teammateLeft ? { ...s, pendingSignal: true, pendingSignalSeat: move.seat } : null;
  },

  isOver: (s) => s.phase === "gameOver",

  redact: (s, seat, meta) => redact(s, seat, { seats: meta.seats, hostSeat: meta.hostSeat, botReplacement: meta.botReplacement, disconnectedSeats: meta.disconnectedSeats }),

  lobbyView: (config, seat, meta) => {
    // Stored configs are validated before they're accepted; one saved by an
    // older deploy falls back to the defaults rather than fail to render.
    let opts = { target: 21, winsNeeded: 1 };
    try { opts = gameOptions(config); } catch { /* keep the defaults */ }
    const g = engineCreateGame(config.players, 1, opts.target, opts.winsNeeded);
    const blanked = { ...g, hands: g.hands.map(() => []), kitty: [], phase: "bidding" as const };
    return redact(blanked, seat, { seats: meta.seats, hostSeat: meta.hostSeat, botReplacement: meta.botReplacement, disconnectedSeats: meta.disconnectedSeats, phase: "lobby" });
  },

  aiMove: (s, seat) => aiMove(s, seat, undefined, botPersonality(s, seat)),

  // Hand signals: a non-turn side action that must preserve the log untouched.
  // The payload is raw client input (and keys the bots' signal records), so only
  // a real level is accepted; while the confidence gate is open only the bidder
  // it waits on may signal, and that pick clears it.
  aux: {
    apply: (s, seat, payload) => {
      if (!isHandSignal(payload)) throw new Error("Invalid signal");
      const gate = signalGateSeat(s);
      if (gate !== null && seat !== gate) throw new Error("Waiting for the bidder to signal");
      const next = setSignal(s, seat, payload);
      return { ...(next as HljState), log: s.log, logSeq: s.logSeq, pendingSignal: false, pendingSignalSeat: null };
    },
    botAux: (s, seat) => {
      if (s.phase !== "bidding" || s.signals[seat] != null) return null;
      // Only signal if a teammate still has a bid turn coming after this seat.
      const n = s.players;
      const dealer = s.dealerSeat;
      if (seat === dealer) return null; // dealer bids last, nobody to signal
      const actedSeats = new Set(s.bidHistory.map((b) => b.seat));
      for (let i = 1; i <= n; i++) {
        const s2 = (seat + i) % n;
        if (!actedSeats.has(s2) && s2 % 2 === seat % 2) return handConfidence(s.hands[seat], s.players);
        if (s2 === dealer) break;
      }
      return null;
    },
  },

  loggableHand(prev, next) {
    if (!next.lastHand || next.lastHand === prev.lastHand) return null;
    return {
      game: "high-low-jack",
      target: next.target,
      hand: next.lastHand,      // bidderSeat, bid, made, deltaByTeam, detail, dealtHands, kitty, lastTrick
      bidHistory: prev.bidHistory, // prev still holds the finished hand's auction; next's is reset
      log: next.log,
      scores: next.lastHand.finalScores ?? next.scores, // before a won game resets them
      gameWinner: next.lastHand.gameWinner ?? null,     // team that won a game with this hand
      gamesWon: next.gamesWon,
      gameOver: next.phase === "gameOver",
    };
  },
};
