// Wire protocol + the pure room logic shared by client and server.
//
// Everything here is runtime-independent (no PartyServer imports) so it can be
// unit-tested with plain Node and reused on the client. The two load-bearing
// pieces are:
//   - redact(state, seat): the ONLY view a given player is allowed to see. It
//     must never expose another player's hand or the kitty. This is what stops
//     a client from cheating by inspecting network traffic.
//   - advanceBots(state, isBot): runs AI moves while it's a bot's turn, so a
//     single human action can resolve all the bot responses that follow it.

import {
  legalMoves,
  applyMove,
  setSignal,
  type GameState,
  type Move,
  type Card,
  type Suit,
  type Phase,
  type HandResult,
  type HandSignal,
  type TrickPlay,
  type PlayerCount,
} from "./engine.ts";
import { aiMove, handConfidence } from "./ai.ts";
import type { LogEntry } from "./game.ts";

// ---------- seat occupancy ----------

export type SeatKind = "human" | "bot" | "empty";
export type SeatInfo = { kind: SeatKind; name: string | null };

// ---------- messages ----------

export type ClientMessage =
  | { t: "join"; pid: string; name: string } // identify (and reclaim a seat on reconnect)
  | { t: "sit"; seat: number } // take a specific empty seat
  | { t: "leave" } // give up your seat (becomes a bot if a game is running)
  | { t: "addBot"; seat: number } // host fills an empty lobby seat with an AI
  | { t: "removeBot"; seat: number } // host clears a bot from a lobby seat
  | { t: "start"; players: PlayerCount; target?: number } // host fills empty seats with bots and deals
  | { t: "move"; move: Move } // a game action
  | { t: "signal"; level: HandSignal } // broadcast your hand confidence (bidding only)
  | { t: "newGame" }; // after game over, reset to the lobby

export type ServerMessage =
  | { t: "view"; view: PlayerView }
  | { t: "error"; message: string };

// ---------- the redacted player view ----------

export type PlayerView = {
  you: number | null; // the recipient's seat, or null if only spectating
  players: PlayerCount;
  phase: Phase | "lobby";
  target: number;

  seats: SeatInfo[]; // who occupies each seat (public)
  hostSeat: number | null;

  scores: [number, number];
  winner: number | null;
  gamesWon: [number, number];
  winsNeeded: number;

  dealerSeat: number;
  trump: Suit | null;

  toAct: number | null; // whose turn it is (bidder during bidding)
  yourTurn: boolean;
  legalMoves: Move[]; // populated only when it's YOUR turn

  yourHand: Card[]; // ONLY the recipient's cards
  handCounts: number[]; // cards remaining per seat (public)

  highBid: { seat: number; amount: number } | null;
  bidHistory: { seat: number; type: "bid" | "pass"; amount?: number }[];
  signals: (HandSignal | null)[]; // public confidence signal per seat
  currentTrick: TrickPlay[]; // cards on the table (public)
  lastTrick: { winner: number; cards: Card[] } | null; // for animating the previous trick
  lastHand: HandResult | null; // scoring breakdown at hand end
  lastKitty: Card[] | null; // kitty revealed after the hand completes
  lastDealtHands: Card[][] | null; // each player's starting hand, revealed after hand
  log: LogEntry[]; // authoritative move log (public)
};

// Build the view a single seat is allowed to see. Whitelist fields explicitly;
// never spread `state` in, so hidden data (other hands, the kitty) can't leak.
export function redact(
  state: GameState,
  seat: number | null,
  meta: { seats: SeatInfo[]; hostSeat: number | null; phase?: PlayerView["phase"] },
): PlayerView {
  const phase = meta.phase ?? state.phase;
  const playing = phase === "bidding" || phase === "playing";
  const toAct = !playing ? null : state.phase === "bidding" ? state.bidTurn : state.turn;
  const yourTurn = seat !== null && toAct === seat;

  const tricks = state.tricksWon;
  const lastTrick = tricks.length ? { winner: tricks[tricks.length - 1].seat, cards: tricks[tricks.length - 1].cards } : null;

  return {
    you: seat,
    players: state.players,
    phase,
    target: state.target,
    seats: meta.seats,
    hostSeat: meta.hostSeat,
    scores: state.scores,
    winner: state.winner,
    gamesWon: state.gamesWon,
    winsNeeded: state.winsNeeded,
    dealerSeat: state.dealerSeat,
    trump: state.trump,
    toAct,
    yourTurn,
    legalMoves: yourTurn ? legalMoves(state) : [],
    yourHand: seat !== null && state.hands[seat] ? state.hands[seat] : [],
    handCounts: state.hands.map((h) => h.length),
    highBid: state.highBid,
    bidHistory: state.bidHistory ?? [],
    signals: state.signals,
    currentTrick: state.currentTrick,
    lastTrick,
    lastHand: state.lastHand,
    lastKitty: state.lastHand ? state.kitty : null,
    lastDealtHands: state.lastHand ? state.lastHand.dealtHands : null,
    log: (state as { log?: LogEntry[] }).log ?? [],
  };
}

// ---------- bot orchestration ----------

// Apply AI moves for as long as the seat to act is a bot. Returns the resulting
// state plus the moves taken (so the caller can animate / broadcast them). Pure.
export function advanceBots(
  state: GameState,
  isBot: (seat: number) => boolean,
): { state: GameState; moves: { seat: number; move: Move }[] } {
  let s = state;
  const moves: { seat: number; move: Move }[] = [];
  let guard = 0;
  while (s.phase !== "gameOver") {
    const seat = s.phase === "bidding" ? s.bidTurn : s.turn;
    if (!isBot(seat)) break;
    // A bot reveals its confidence as it comes to bid.
    if (s.phase === "bidding" && s.signals[seat] == null) {
      s = setSignal(s, seat, handConfidence(s.hands[seat], s.players));
    }
    const move = aiMove(s, seat);
    s = applyMove(s, move);
    moves.push({ seat, move });
    if (++guard > 10000) throw new Error("advanceBots failed to make progress");
  }
  return { state: s, moves };
}

// Apply exactly one bot move if the seat to act is a bot (for paced, one-at-a-
// time bot play driven by an alarm). Returns null if it's not a bot's turn.
export function stepBot(state: GameState, isBot: (seat: number) => boolean): { state: GameState; seat: number; move: Move } | null {
  if (state.phase === "gameOver") return null;
  const seat = state.phase === "bidding" ? state.bidTurn : state.turn;
  if (!isBot(seat)) return null;
  let st = state;
  if (st.phase === "bidding" && st.signals[seat] == null) {
    st = setSignal(st, seat, handConfidence(st.hands[seat], st.players));
  }
  const move = aiMove(st, seat);
  return { state: applyMove(st, move), seat, move };
}
