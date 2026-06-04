// rummy-module.ts — Rummy 500 (500 Rum) as a pure Game module.
//
// Pure and runtime-independent (imports only Suit/SUITS from engine.ts and the
// Game contract): no PartyServer, no I/O, randomness only via a seeded PRNG
// threaded through state.seed, so it is deterministic, testable, and reusable
// on the client for single-player.
//
// SCOPE (remaining extension point: wild/joker cards, noted inline):
//   - 2-8 players, NO wild/joker cards. One 52-card deck for 2-4 players, two
//     decks (104 cards) for 5-8 — every card has a unique id, so duplicates
//     across decks are unambiguous. With two decks a set may exceed four cards
//     and repeat a suit; a run still forbids duplicate ranks.
//   - Scoring: A = 15, 10/J/Q/K = 10, 2-9 = pip value. Melded cards score for
//     whoever placed them (lay-offs score for the layer, not the meld owner);
//     cards left in hand at round end score against you.
//   - A round ends when a player goes out (empties their hand) OR the stock is
//     exhausted; then the next round is dealt automatically. Game ends when a
//     player reaches `target` (default 500); highest total wins.
//
// A TURN is several moves by the same seat (seatToAct stays put until a discard
// advances it): draw -> any number of meld/layoff -> discard. A card drawn from
// the discard pile MUST be melded or laid off before that turn's discard.

import { SUITS, type Suit } from "./engine.ts";
import type { Game, RoomMeta, LogEntry } from "./game.ts";

// ---------- cards ----------
// Every card carries a unique id so the discard pile ("take this card and all
// above it"), table melds, and per-card scoring ownership are unambiguous. This
// also makes a future double-deck (5-8 players) a non-event.

export type RummyCard = { id: number; rank: number; suit: Suit; joker?: boolean }; // rank 2..14, A = 14; jokers are wild

// A joker is worth 15 in hand (like an Ace) when caught at round end.
const cardValue = (c: RummyCard): number => (c.joker ? 15 : c.rank === 14 ? 15 : c.rank >= 10 ? 10 : c.rank);

// One standard deck per `decks`, each with 2 wild jokers (54 cards/deck). ids
// stay unique across decks so a double deck (5-8 players) has two
// distinguishable copies of every card.
function buildDeck(decks = 1): RummyCard[] {
  const deck: RummyCard[] = [];
  let id = 0;
  for (let d = 0; d < decks; d++) {
    for (const suit of SUITS) for (let rank = 2; rank <= 14; rank++) deck.push({ id: id++, rank, suit });
    for (let j = 0; j < 2; j++) deck.push({ id: id++, rank: 0, suit: "S", joker: true });
  }
  return deck;
}

const decksFor = (players: number): number => (players <= 4 ? 1 : 2);

// ---------- seeded PRNG (mulberry32) ----------
// (Duplicated from the HLJ engine for now; a shared rng.ts would dedupe it.)

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], seed: number): { shuffled: T[]; nextSeed: number } {
  const rng = mulberry32(seed);
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  const nextSeed = Math.floor(rng() * 0xffffffff) >>> 0;
  return { shuffled: a, nextSeed };
}

// ---------- meld validity ----------

// A run treats an Ace as low (A-2-3) OR high (Q-K-A), never wrapping (K-A-2).
// Jokers are wild: they fill internal gaps and extend either end. A run must
// still contain at least one natural card.
function isRun(cards: RummyCard[]): boolean {
  if (cards.length < 3) return false;
  const naturals = cards.filter((c) => !c.joker);
  const jokers = cards.length - naturals.length;
  if (naturals.length === 0) return false;
  const suit = naturals[0].suit;
  if (!naturals.every((c) => c.suit === suit)) return false;
  for (const aceRank of [1, 14]) {
    const ranks = naturals.map((c) => (c.rank === 14 ? aceRank : c.rank)).sort((a, b) => a - b);
    if (new Set(ranks).size !== ranks.length) continue; // a duplicate rank can't sit in one run
    const low = ranks[0], high = ranks[ranks.length - 1];
    if (low < 1 || high > 14) continue;
    const gaps = high - low + 1 - ranks.length; // interior slots a joker must fill
    if (gaps < 0 || gaps > jokers) continue;
    const extra = jokers - gaps; // leftover jokers extend the ends
    if (high - low + 1 + extra > 14) continue; // can't grow past a 14-rank span
    if ((low - 1) + (14 - high) < extra) continue; // not enough room at the ends
    return true;
  }
  return false;
}

// A set is 3+ cards of the same rank, jokers wild. No distinct-suit / size-4
// cap: with two decks a set can repeat a suit and run to more than four cards,
// and the physical card pool (plus the duplicate-id guard in isLegal) bounds
// it. A set must contain at least one natural card.
function isSet(cards: RummyCard[]): boolean {
  if (cards.length < 3) return false;
  const naturals = cards.filter((c) => !c.joker);
  if (naturals.length === 0) return false;
  return naturals.every((c) => c.rank === naturals[0].rank);
}

// Order a run's cards low->high, slotting jokers into the gaps/ends they fill,
// so a melded run always reads in sequence regardless of play order.
function orderRunCards(cards: RummyCard[]): RummyCard[] {
  const naturals = cards.filter((c) => !c.joker);
  const jokers = cards.filter((c) => c.joker);
  for (const aceRank of [1, 14]) {
    const eff = naturals.map((c) => ({ c, r: c.rank === 14 ? aceRank : c.rank })).sort((a, b) => a.r - b.r);
    const ranks = eff.map((x) => x.r);
    if (new Set(ranks).size !== ranks.length) continue;
    const low = ranks[0], high = ranks[ranks.length - 1];
    const gaps = high - low + 1 - ranks.length;
    if (gaps < 0 || gaps > jokers.length) continue;
    const extra = jokers.length - gaps;
    const after = Math.min(extra, 14 - high);
    const before = extra - after;
    if (before > low - 1) continue;
    const byRank = new Map(eff.map((x) => [x.r, x.c]));
    const jk = [...jokers];
    const out: RummyCard[] = [];
    for (let r = low - before; r <= high + after; r++) out.push(byRank.get(r) ?? jk.shift()!);
    if (out.length === cards.length && jk.length === 0) return out;
  }
  return cards;
}

const validMeld = (cards: RummyCard[]): boolean => isSet(cards) || isRun(cards);

// Can `target` be the bottom card of an immediate meld, given a pool of cards
// available this turn (used to validate a discard-pile draw)?
function canRunWith(pool: RummyCard[], target: RummyCard): boolean {
  if (target.joker) return false;
  const inSuit = pool.filter((c) => c.suit === target.suit && !c.joker);
  const jokers = pool.filter((c) => c.joker).length;
  for (const aceRank of [1, 14]) {
    const ranks = new Set(inSuit.map((c) => (c.rank === 14 ? aceRank : c.rank)));
    const tr = target.rank === 14 ? aceRank : target.rank;
    ranks.add(tr);
    for (let start = tr - 2; start <= tr; start++) {
      let ok = true, need = 0;
      for (let k = 0; k < 3; k++) { const r = start + k; if (r < 1 || r > 14) { ok = false; break; } if (!ranks.has(r)) need++; }
      if (ok && need <= jokers) return true;
    }
  }
  return false;
}

function canFormMeldWith(pool: RummyCard[], target: RummyCard): boolean {
  if (target.joker) return false;
  const sameRank = pool.filter((c) => !c.joker && c.rank === target.rank).length;
  const jokers = pool.filter((c) => c.joker).length;
  if (sameRank >= 1 && sameRank + jokers >= 3) return true;
  return canRunWith(pool, target);
}

function canLayoff(state: RummyState, target: RummyCard): boolean {
  return state.melds.some((m) =>
    m.kind === "set" ? isSet([...m.cards, target]) : isRun([...m.cards, target]),
  );
}

// ---------- state, moves, config, view ----------

export type Meld = { id: number; kind: "set" | "run"; cards: RummyCard[] };

export type RummyState = {
  players: number;
  target: number; // points to win, e.g. 500
  seed: number;
  phase: "playing" | "gameOver";
  dealerSeat: number;
  turn: number; // seat to act (whole turn)
  turnPhase: "draw" | "play";

  hands: RummyCard[][]; // private per seat
  stock: RummyCard[]; // face-down; only its count is public
  discard: RummyCard[]; // face-up, public; top = last element
  melds: Meld[]; // public table melds
  cardOwner: Record<number, number>; // cardId -> seat who placed it (drives scoring)
  mustMeldCardId: number | null; // card taken from discard that must be melded this turn

  scores: number[]; // running totals per seat
  winner: number | null;
  lastRound: { delta: number[]; outSeat: number | null; meldedPts: number[]; heldPts: number[]; heldCards: RummyCard[][] } | null;

  nextMeldId: number;
  log: LogEntry[]; // authoritative move log
  logSeq: number; // monotonic id source for log entries
};

export type RummyMove =
  | { type: "drawStock"; seat: number }
  | { type: "drawDiscard"; seat: number; cardId: number } // take this card + everything above it
  | { type: "meld"; seat: number; cards: number[] } // card ids from hand forming a new set/run
  | { type: "layoff"; seat: number; meldId: number; cards: number[] } // card ids onto an existing meld
  | { type: "discard"; seat: number; cardId: number }; // ends the turn

export type RummyConfig = { players: number; target: number };

export type RummyView = {
  you: number | null;
  players: number;
  phase: "playing" | "gameOver" | "lobby";
  target: number;
  seats: RoomMeta["seats"];
  hostSeat: number | null;
  scores: number[];
  winner: number | null;
  dealerSeat: number;
  toAct: number | null;
  turnPhase: "draw" | "play";
  yourTurn: boolean;
  legalMoves: RummyMove[]; // best-effort, only on your turn
  yourHand: RummyCard[]; // ONLY the recipient's cards
  handCounts: number[]; // cards per seat (public)
  stockCount: number; // public count, contents hidden
  discard: RummyCard[]; // public
  melds: { id: number; kind: "set" | "run"; owner: number; cards: RummyCard[] }[];
  mustMeldCardId: number | null; // meaningful only on your own turn
  lastRound: { delta: number[]; outSeat: number | null; meldedPts: number[]; heldPts: number[]; heldCards: RummyCard[][] } | null;
  log: LogEntry[]; // authoritative move log (public)
};

// ---------- setup / dealing ----------

const handSize = (players: number): number => (players === 2 ? 13 : 7);

function dealRound(prev: RummyState): RummyState {
  const { shuffled, nextSeed } = shuffle(buildDeck(decksFor(prev.players)), prev.seed);
  const hands: RummyCard[][] = Array.from({ length: prev.players }, () => []);
  const hs = handSize(prev.players);
  let i = 0;
  for (let k = 0; k < hs; k++) for (let s = 0; s < prev.players; s++) hands[s].push(shuffled[i++]);
  const discard = [shuffled[i++]];
  const stock = shuffled.slice(i);
  return {
    ...prev,
    seed: nextSeed,
    phase: "playing",
    turn: (prev.dealerSeat + 1) % prev.players,
    turnPhase: "draw",
    hands,
    stock,
    discard,
    melds: [],
    cardOwner: {},
    mustMeldCardId: null,
    winner: null,
    nextMeldId: 0,
  };
}

function createGame(config: RummyConfig, seed: number): RummyState {
  if (config.players < 2 || config.players > 8) throw new Error(`Unsupported player count: ${config.players}`);
  if (config.target <= 0) throw new Error("Target must be positive");
  const base: RummyState = {
    players: config.players,
    target: config.target,
    seed,
    phase: "playing",
    dealerSeat: 0,
    turn: 0,
    turnPhase: "draw",
    hands: [],
    stock: [],
    discard: [],
    melds: [],
    cardOwner: {},
    mustMeldCardId: null,
    scores: Array(config.players).fill(0),
    winner: null,
    lastRound: null,
    nextMeldId: 0,
    log: [],
    logSeq: 0,
  };
  const dealt = dealRound(base);
  return attachRummy(dealt, [], 0, [{ seat: dealt.dealerSeat, msg: "deals the first hand" }]);
}

// ---------- move log ----------

const LOG_CAP = 120;

function attachRummy(next: RummyState, prevLog: LogEntry[], prevSeq: number, parts: Omit<LogEntry, "id">[]): RummyState {
  let seq = prevSeq;
  const added = parts.map((p) => ({ id: ++seq, ...p }));
  return { ...next, log: [...prevLog, ...added].slice(-LOG_CAP), logSeq: seq };
}

const findCard = (list: RummyCard[], id: number): RummyCard | undefined => list.find((c) => c.id === id);

// Derive the log rows produced by one move, from the before/after states.
function rummyEntries(prev: RummyState, next: RummyState, move: RummyMove): Omit<LogEntry, "id">[] {
  const out: Omit<LogEntry, "id">[] = [];
  const seat = move.seat;
  const hand = prev.hands[seat] ?? [];

  if (move.type === "drawStock") {
    out.push({ seat, msg: "drew from the stock" });
  } else if (move.type === "drawDiscard") {
    const idx = prev.discard.findIndex((c) => c.id === move.cardId);
    const taken = idx >= 0 ? prev.discard.slice(idx) : [];
    const target = idx >= 0 ? prev.discard[idx] : undefined;
    const extra = Math.max(0, taken.length - 1);
    out.push({
      seat,
      msg: "took",
      cards: target ? [target] : [],
      tail: extra ? `+${extra} more from the discard` : "from the discard",
    });
  } else if (move.type === "meld") {
    out.push({ seat, msg: "melded", cards: move.cards.map((id) => findCard(hand, id)).filter(Boolean) as RummyCard[] });
  } else if (move.type === "layoff") {
    out.push({ seat, msg: "laid off", cards: move.cards.map((id) => findCard(hand, id)).filter(Boolean) as RummyCard[] });
  } else if (move.type === "discard") {
    const c = findCard(hand, move.cardId);
    out.push({ seat, msg: "discarded", cards: c ? [c] : [] });
  }

  // round end / game end
  if (next.lastRound && next.lastRound !== prev.lastRound) {
    const lr = next.lastRound;
    if (lr.outSeat != null) out.push({ seat: lr.outSeat, msg: `goes out (+${lr.delta[lr.outSeat]} this round)` });
    else out.push({ seat: null, msg: "Stock exhausted \u2014 round scored" });
    if (next.phase === "gameOver" && next.winner !== null) out.push({ seat: next.winner, msg: "wins the game!" });
    else if (next.dealerSeat !== prev.dealerSeat) out.push({ seat: next.dealerSeat, msg: "deals a new round" });
  }

  return out;
}

// ---------- scoring / round end ----------

function meldedValue(state: RummyState, seat: number): number {
  let v = 0;
  for (const m of state.melds) for (const c of m.cards) if (state.cardOwner[c.id] === seat) v += cardValue(c);
  return v;
}
const heldValue = (state: RummyState, seat: number): number =>
  state.hands[seat].reduce((a, c) => a + cardValue(c), 0);

function endRound(state: RummyState, outSeat: number | null): RummyState {
  const meldedPts = state.scores.map((_, s) => meldedValue(state, s));
  const heldPts = state.scores.map((_, s) => heldValue(state, s));
  const delta = state.scores.map((_, s) => meldedPts[s] - heldPts[s]);
  const heldCards = state.hands.map((h) => [...h]);
  const scores = state.scores.map((v, s) => v + delta[s]);
  const lastRound = { delta, outSeat, meldedPts, heldPts, heldCards };
  const max = Math.max(...scores);
  if (max >= state.target) {
    return { ...state, scores, phase: "gameOver", winner: scores.indexOf(max), lastRound };
  }
  return dealRound({ ...state, scores, lastRound, dealerSeat: (state.dealerSeat + 1) % state.players });
}

// ---------- core interface functions ----------

const seatToAct = (s: RummyState): number | null => (s.phase === "gameOver" ? null : s.turn);
const isOver = (s: RummyState): boolean => s.phase === "gameOver";

function isLegal(state: RummyState, move: RummyMove): boolean {
  if (state.phase !== "playing" || move.seat !== state.turn) return false;
  const hand = state.hands[move.seat];
  switch (move.type) {
    case "drawStock":
      return state.turnPhase === "draw" && state.stock.length > 0;
    case "drawDiscard": {
      if (state.turnPhase !== "draw") return false;
      const idx = state.discard.findIndex((c) => c.id === move.cardId);
      if (idx < 0) return false;
      // The top card may always be taken, even if it can't be played this turn.
      if (idx === state.discard.length - 1) return true;
      // Taking deeper sweeps everything above too; the bottom card taken must be
      // immediately meldable/layable (with hand + everything taken).
      const taken = state.discard.slice(idx);
      const target = state.discard[idx];
      return canFormMeldWith([...hand, ...taken], target) || canLayoff(state, target);
    }
    case "meld": {
      if (state.turnPhase !== "play" || !move.cards || move.cards.length < 3) return false;
      if (new Set(move.cards).size !== move.cards.length) return false; // no card listed twice
      const objs = move.cards.map((id) => hand.find((c) => c.id === id));
      if (objs.some((o) => !o)) return false;
      return validMeld(objs as RummyCard[]);
    }
    case "layoff": {
      if (state.turnPhase !== "play" || !move.cards || move.cards.length < 1) return false;
      if (new Set(move.cards).size !== move.cards.length) return false; // no card listed twice
      const m = state.melds.find((x) => x.id === move.meldId);
      if (!m) return false;
      const objs = move.cards.map((id) => hand.find((c) => c.id === id));
      if (objs.some((o) => !o)) return false;
      const combined = [...m.cards, ...(objs as RummyCard[])];
      return m.kind === "set" ? isSet(combined) : isRun(combined);
    }
    case "discard":
      // Can't discard until any card drawn from the discard pile is melded.
      return state.turnPhase === "play" && state.mustMeldCardId == null && hand.some((c) => c.id === move.cardId);
  }
  return false;
}

function applyMoveCore(state: RummyState, move: RummyMove): RummyState {
  if (state.phase !== "playing") throw new Error("Game is over");
  if (seatToAct(state) !== move.seat) throw new Error("Not this seat's turn");
  if (!isLegal(state, move)) throw new Error(`Illegal move: ${JSON.stringify(move)}`);

  const seat = move.seat;
  const handsWith = (h: RummyCard[]): RummyCard[][] => state.hands.map((x, s) => (s === seat ? h : x));
  const clears = (ids: number[]): number | null =>
    state.mustMeldCardId != null && ids.includes(state.mustMeldCardId) ? null : state.mustMeldCardId;

  switch (move.type) {
    case "drawStock": {
      const stock = state.stock.slice(0, -1);
      const drawn = state.stock[state.stock.length - 1];
      return { ...state, stock, hands: handsWith([...state.hands[seat], drawn]), turnPhase: "play" };
    }
    case "drawDiscard": {
      const idx = state.discard.findIndex((c) => c.id === move.cardId);
      const taken = state.discard.slice(idx);
      return {
        ...state,
        discard: state.discard.slice(0, idx),
        hands: handsWith([...state.hands[seat], ...taken]),
        turnPhase: "play",
        // Taking just the top card carries no obligation; sweeping deeper means
        // the bottom card must be melded/laid off before discarding.
        mustMeldCardId: taken.length > 1 ? move.cardId : null,
      };
    }
    case "meld": {
      const objs = move.cards.map((id) => state.hands[seat].find((c) => c.id === id)!);
      const newHand = state.hands[seat].filter((c) => !move.cards.includes(c.id));
      const kind = isSet(objs) ? "set" : "run";
      const meld: Meld = { id: state.nextMeldId, kind, cards: kind === "run" ? orderRunCards(objs) : objs };
      const cardOwner = { ...state.cardOwner };
      for (const id of move.cards) cardOwner[id] = seat;
      const ns: RummyState = {
        ...state,
        hands: handsWith(newHand),
        melds: [...state.melds, meld],
        cardOwner,
        nextMeldId: state.nextMeldId + 1,
        mustMeldCardId: clears(move.cards),
      };
      return newHand.length === 0 ? endRound(ns, seat) : ns;
    }
    case "layoff": {
      const objs = move.cards.map((id) => state.hands[seat].find((c) => c.id === id)!);
      const newHand = state.hands[seat].filter((c) => !move.cards.includes(c.id));
      const melds = state.melds.map((m) =>
        m.id === move.meldId
          ? { ...m, cards: m.kind === "run" ? orderRunCards([...m.cards, ...objs]) : [...m.cards, ...objs] }
          : m,
      );
      const cardOwner = { ...state.cardOwner };
      for (const id of move.cards) cardOwner[id] = seat;
      const ns: RummyState = { ...state, hands: handsWith(newHand), melds, cardOwner, mustMeldCardId: clears(move.cards) };
      return newHand.length === 0 ? endRound(ns, seat) : ns;
    }
    case "discard": {
      const card = state.hands[seat].find((c) => c.id === move.cardId)!;
      const newHand = state.hands[seat].filter((c) => c.id !== move.cardId);
      const discard = [...state.discard, card];
      if (newHand.length === 0) return endRound({ ...state, hands: handsWith(newHand), discard }, seat); // went out
      const ns: RummyState = {
        ...state,
        hands: handsWith(newHand),
        discard,
        turn: (seat + 1) % state.players,
        turnPhase: "draw",
        mustMeldCardId: null,
      };
      return ns.stock.length === 0 ? endRound(ns, null) : ns; // stock exhausted -> score the round
    }
  }
}

// Public transition: apply the move, then append the resulting log rows.
function applyMoveWithLog(state: RummyState, move: RummyMove): RummyState {
  const next = applyMoveCore(state, move);
  return attachRummy(next, state.log, state.logSeq, rummyEntries(state, next, move));
}

// ---------- legal-move enumeration (best-effort, for the UI / simple bots) ----------
// Not exhaustive for melds (that space is combinatorial); the server authorizes
// via isLegal, so a client may submit any valid meld this list didn't surface.

function legalMoves(state: RummyState): RummyMove[] {
  if (state.phase === "gameOver") return [];
  const seat = state.turn;
  const hand = state.hands[seat];
  const moves: RummyMove[] = [];

  if (state.turnPhase === "draw") {
    if (state.stock.length > 0) moves.push({ type: "drawStock", seat });
    const top = state.discard[state.discard.length - 1];
    if (top) moves.push({ type: "drawDiscard", seat, cardId: top.id }); // top is always takeable
    // Whole-pile pickup: any non-top card is legal if it can be immediately melded/laid off
    // using the hand plus all cards swept above it.
    for (let i = 0; i < state.discard.length - 1; i++) {
      const target = state.discard[i];
      const taken = state.discard.slice(i);
      if (canFormMeldWith([...hand, ...taken], target) || canLayoff(state, target))
        moves.push({ type: "drawDiscard", seat, cardId: target.id });
    }
    return moves;
  }

  const set = findSet(hand);
  if (set) moves.push({ type: "meld", seat, cards: set.map((c) => c.id) });
  const run = findRun(hand);
  if (run) moves.push({ type: "meld", seat, cards: run.map((c) => c.id) });
  for (const m of state.melds)
    for (const c of hand) {
      const combined = [...m.cards, c];
      if (m.kind === "set" ? isSet(combined) : isRun(combined))
        moves.push({ type: "layoff", seat, meldId: m.id, cards: [c.id] });
    }
  if (state.mustMeldCardId == null) for (const c of hand) moves.push({ type: "discard", seat, cardId: c.id });
  return moves;
}

// ---------- redaction ----------

function redact(state: RummyState, seat: number | null, meta: RoomMeta): RummyView {
  const toAct = state.phase === "gameOver" ? null : state.turn;
  const yours = seat !== null && toAct === seat;
  return {
    you: seat,
    players: state.players,
    phase: state.phase,
    target: state.target,
    seats: meta.seats,
    hostSeat: meta.hostSeat,
    scores: state.scores,
    winner: state.winner,
    dealerSeat: state.dealerSeat,
    toAct,
    turnPhase: state.turnPhase,
    yourTurn: yours,
    legalMoves: yours ? legalMoves(state) : [],
    yourHand: seat !== null && state.hands[seat] ? state.hands[seat] : [],
    handCounts: state.hands.map((h) => h.length),
    stockCount: state.stock.length,
    discard: state.discard,
    melds: state.melds.map((m) => ({ id: m.id, kind: m.kind, owner: state.cardOwner[m.cards[0].id] ?? -1, cards: m.cards })),
    mustMeldCardId: yours ? state.mustMeldCardId : null,
    lastRound: state.lastRound,
    log: state.log,
  };
}

function lobbyView(config: RummyConfig, seat: number | null, meta: RoomMeta): RummyView {
  return {
    you: seat,
    players: config.players,
    phase: "lobby",
    target: config.target,
    seats: meta.seats,
    hostSeat: meta.hostSeat,
    scores: Array(config.players).fill(0),
    winner: null,
    dealerSeat: 0,
    toAct: null,
    turnPhase: "draw",
    yourTurn: false,
    legalMoves: [],
    yourHand: [],
    handCounts: Array(config.players).fill(0),
    stockCount: 0,
    discard: [],
    melds: [],
    mustMeldCardId: null,
    lastRound: null,
    log: [],
  };
}

// ---------- heuristic AI ----------
// A "decent club player": draw from the discard only when the top card can be
// used immediately, lay down melds as it gets them (held points are at risk),
// lay off where it can, then discard the highest-value least-connected card.

// The AI spends its wild jokers, but sparingly: it always prefers a meld made
// of natural cards and only fills gaps/ends with jokers when that's what it
// takes to lay something down. Every meld these return satisfies isSet/isRun.
const naturalsOf = (hand: RummyCard[]): RummyCard[] => hand.filter((c) => !c.joker);
const jokersOf = (hand: RummyCard[]): RummyCard[] => hand.filter((c) => c.joker);

function findSet(hand: RummyCard[]): RummyCard[] | null {
  const jokers = jokersOf(hand);
  const byRank = new Map<number, RummyCard[]>();
  for (const c of naturalsOf(hand)) byRank.set(c.rank, [...(byRank.get(c.rank) ?? []), c]);
  for (const g of byRank.values()) if (g.length >= 3) return g.slice(0, 4); // natural set first
  // otherwise complete the largest natural group with jokers
  let bestG: RummyCard[] | null = null;
  for (const g of byRank.values()) if (!bestG || g.length > bestG.length) bestG = g;
  if (bestG && bestG.length >= 1 && bestG.length + jokers.length >= 3)
    return [...bestG, ...jokers.slice(0, 3 - bestG.length)];
  return null;
}
function findSetContaining(hand: RummyCard[], c: RummyCard): RummyCard[] | null {
  if (c.joker) return null;
  const g = hand.filter((x) => !x.joker && x.rank === c.rank);
  if (g.length >= 3) return g.slice(0, 4);
  const jokers = jokersOf(hand);
  if (g.length >= 1 && g.length + jokers.length >= 3) return [...g, ...jokers.slice(0, 3 - g.length)];
  return null;
}

// Best run we can build in one suit, optionally spending some of `jokers`.
// Scans every window; prefers more natural cards, then fewer jokers used.
function bestRunInSuit(naturals: RummyCard[], jokers: RummyCard[]): RummyCard[] | null {
  let best: RummyCard[] | null = null;
  let bestScore = -Infinity;
  for (const aceRank of [1, 14]) {
    const byRank = new Map<number, RummyCard>();
    for (const c of naturals) { const r = c.rank === 14 ? aceRank : c.rank; if (!byRank.has(r)) byRank.set(r, c); }
    if (!byRank.size) continue;
    for (let lo = 1; lo <= 12; lo++) {
      for (let hi = lo + 2; hi <= 14; hi++) {
        const span = hi - lo + 1;
        let nat = 0;
        for (let r = lo; r <= hi; r++) if (byRank.has(r)) nat++;
        const missing = span - nat;
        if (nat < 1 || missing > jokers.length) continue;
        const score = nat * 100 - missing; // favor natural cards, minimize wilds spent
        if (score <= bestScore) continue;
        const jk = [...jokers];
        const cards: RummyCard[] = [];
        for (let r = lo; r <= hi; r++) cards.push(byRank.has(r) ? byRank.get(r)! : jk.shift()!);
        best = cards;
        bestScore = score;
      }
    }
  }
  return best;
}
function findRun(hand: RummyCard[]): RummyCard[] | null {
  const jokers = jokersOf(hand);
  for (const s of SUITS) {
    const r = bestRunInSuit(hand.filter((c) => c.suit === s && !c.joker), jokers);
    if (r) return r;
  }
  return null;
}
function findRunContaining(hand: RummyCard[], c: RummyCard): RummyCard[] | null {
  if (c.joker) return null;
  const inSuit = hand.filter((x) => x.suit === c.suit && !x.joker);
  const jokers = jokersOf(hand);
  for (const aceRank of [1, 14]) {
    const byRank = new Map<number, RummyCard>();
    for (const x of inSuit) { const r = x.rank === 14 ? aceRank : x.rank; if (!byRank.has(r)) byRank.set(r, x); }
    const cr = c.rank === 14 ? aceRank : c.rank;
    byRank.set(cr, c); // ensure c is the card used for its rank
    for (let lo = Math.max(1, cr - 2); lo <= cr; lo++) {
      for (let hi = cr; hi <= Math.min(14, cr + 2); hi++) {
        if (hi - lo + 1 < 3) continue;
        let nat = 0;
        for (let r = lo; r <= hi; r++) if (byRank.has(r)) nat++;
        const missing = hi - lo + 1 - nat;
        if (nat < 1 || missing > jokers.length) continue;
        const jk = [...jokers];
        const cards: RummyCard[] = [];
        for (let r = lo; r <= hi; r++) cards.push(byRank.has(r) ? byRank.get(r)! : jk.shift()!);
        if (cards.includes(c)) return cards;
      }
    }
  }
  return null;
}
function layoffOnto(state: RummyState, m: Meld, c: RummyCard, seat: number): RummyMove | null {
  const combined = [...m.cards, c];
  const ok = m.kind === "set" ? isSet(combined) : isRun(combined);
  return ok ? { type: "layoff", seat, meldId: m.id, cards: [c.id] } : null;
}
function worstDiscard(hand: RummyCard[]): RummyCard {
  const score = (c: RummyCard): number => {
    if (c.joker) return -100; // a wild is far too useful to throw away
    let keep = 0;
    const mates = hand.filter((x) => x.rank === c.rank && x.id !== c.id).length;
    keep += mates >= 2 ? 8 : mates === 1 ? 3 : 0;
    keep += hand.filter((x) => x.suit === c.suit && x.id !== c.id && Math.abs(x.rank - c.rank) <= 2).length * 2;
    return cardValue(c) - keep; // higher == more discardable
  };
  return [...hand].sort((a, b) => score(b) - score(a))[0];
}

function aiMove(state: RummyState, seat: number): RummyMove {
  const hand = state.hands[seat];

  if (state.turnPhase === "draw") {
    const top = state.discard[state.discard.length - 1];
    if (top && (canFormMeldWith([...hand, top], top) || canLayoff(state, top)))
      return { type: "drawDiscard", seat, cardId: top.id };
    if (state.stock.length > 0) return { type: "drawStock", seat };
    if (top) return { type: "drawDiscard", seat, cardId: top.id }; // last resort (round usually ended)
    return { type: "drawStock", seat };
  }

  // Place the forced (discard-drawn) card first.
  if (state.mustMeldCardId != null) {
    const mc = hand.find((c) => c.id === state.mustMeldCardId);
    if (mc) {
      const s2 = findSetContaining(hand, mc);
      if (s2) return { type: "meld", seat, cards: s2.map((c) => c.id) };
      const r2 = findRunContaining(hand, mc);
      if (r2) return { type: "meld", seat, cards: r2.map((c) => c.id) };
      for (const m of state.melds) { const lo = layoffOnto(state, m, mc, seat); if (lo) return lo; }
    }
  }

  // Lay down a complete meld if we have one.
  const set = findSet(hand);
  const run = findRun(hand);
  const pick = run && (!set || run.length >= set.length) ? run : set;
  if (pick) return { type: "meld", seat, cards: pick.map((c) => c.id) };

  // Lay off any single card that fits an existing meld.
  for (const m of state.melds) for (const c of hand) { const lo = layoffOnto(state, m, c, seat); if (lo) return lo; }

  // Otherwise discard.
  return { type: "discard", seat, cardId: worstDiscard(hand).id };
}

// ---------- the module ----------

export const rummy500Module: Game<RummyState, RummyMove, RummyConfig, RummyView> = {
  meta: { id: "rummy-500", name: "Rummy 500", supportedPlayerCounts: [2, 3, 4, 5, 6, 7, 8] },
  botStepMs: 400,
  seatCount: (config) => config.players,
  createGame,
  seatToAct,
  isLegal,
  legalMoves,
  applyMove: applyMoveWithLog,
  isOver,
  redact,
  lobbyView,
  aiMove,
  // no `aux`: Rummy has no non-turn side actions
};

// Exposed for unit tests / tuning.
export const __test = { isRun, isSet, cardValue, buildDeck, orderRunCards };
