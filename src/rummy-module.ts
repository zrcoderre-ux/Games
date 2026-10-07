// rummy-module.ts — Rummy 500 (500 Rum) as a pure Game module.
//
// Pure and runtime-independent (imports only Suit/SUITS from engine.ts and the
// Game contract): no PartyServer, no I/O, randomness only via a seeded PRNG
// threaded through state.seed (plus any fresh entropy the room folds in, see
// reseed), so it is deterministic, testable, and reusable on the client for
// single-player.
//
// SCOPE:
//   - 2-8 players. One deck (52 cards + 2 wild jokers) for 2-4 players, two
//     decks (108 cards) for 5-8 — every card has a unique id, so duplicates
//     across decks are unambiguous. A set is 3-4 cards of one rank in distinct
//     suits, even with two decks; a run is 3+ cards of one suit in sequence
//     (Ace low or high, never both). Jokers fill in for any card.
//   - Scoring: A = 15, 10/J/Q/K = 10, 2-9 = pip value, joker = 15. Melded
//     cards score for whoever placed them (lay-offs score for the layer, not
//     the meld owner); cards left in hand at round end score against you.
//   - A round ends when a player goes out (empties their hand) OR the stock is
//     exhausted; the next round is dealt after the handComplete pause. The game
//     ends when one player alone leads with at least `target` (default 500); a
//     tie for that lead is played out with another round.
//
// A TURN is several moves by the same seat (seatToAct stays put until a discard
// advances it): draw -> any number of meld/layoff -> discard. Taking just the
// top discard carries no obligation (it may even go straight back). Taking a
// deeper card sweeps every card above it too, and that deepest card MUST be
// melded or laid off before the turn's discard. With requireDiscard a player
// must go out by discarding, so no meld or layoff may empty the hand.

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

// ---------- entropy-seeded PRNG (sfc32) ----------
// 32 bits of seed can be brute-forced from the cards a player sees, so live
// rooms fold fresh entropy into every deal (see reseed) and shuffle with this
// 128-bit generator instead. (Also duplicated from the HLJ engine.)

function sfc32(a: number, b: number, c: number, d: number): () => number {
  const next = () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 15; i++) next(); // mix the seed words before use
  return next;
}

// With entropy (4 uint32 words) the shuffle draws from sfc32; without, from the
// seed alone, so tests and harnesses replay exactly.
function shuffle<T>(items: T[], seed: number, entropy?: number[]): { shuffled: T[]; nextSeed: number } {
  const rng = entropy ? sfc32(seed ^ entropy[0], entropy[1], entropy[2], entropy[3]) : mulberry32(seed);
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  const nextSeed = Math.floor(rng() * 0xffffffff) >>> 0;
  return { shuffled: a, nextSeed };
}

// ---------- meld validity ----------

// A run treats an Ace as low (A-2-3) OR high (Q-K-A), never wrapping (K-A-2)
// and never both at once, so the longest run is 13 cards (A-K or 2-A).
// Jokers are wild: they fill internal gaps and extend either end. A run must
// still contain at least one natural card.
// Slots one Ace reading allows: ace low covers A(1)..K(13), ace high 2..A(14).
const minSlot = (aceRank: number): number => (aceRank === 1 ? 1 : 2);
const maxSlot = (aceRank: number): number => (aceRank === 1 ? 13 : 14);
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
    if ((low - minSlot(aceRank)) + (maxSlot(aceRank) - high) < extra) continue; // not enough room at the ends
    return true;
  }
  return false;
}

// A set is 3+ cards of the same rank, jokers wild. Each rank+suit pair may
// appear at most once (even in a double-deck game). A set must contain at
// least one natural card.
function isSet(cards: RummyCard[]): boolean {
  if (cards.length < 3) return false;
  const naturals = cards.filter((c) => !c.joker);
  if (naturals.length === 0) return false;
  if (!naturals.every((c) => c.rank === naturals[0].rank)) return false;
  const suits = naturals.map((c) => c.suit);
  if (new Set(suits).size !== suits.length) return false; // no duplicate suits
  // A set has at most 4 cards (one per suit); jokers cannot push it past 4
  if (cards.length > 4) return false;
  return true;
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

// ---------- the forced card (deep discard pickup) ----------
// Sweeping the pile below its top card obliges the player to meld or lay off
// that deepest card before discarding. The pickup, and every meld or layoff
// made while the card is pending, is allowed only if some single move can
// still put it down — and, with requireDiscard, leave a card to discard. So a
// seat with a forced card always has a legal move.

// A three-card meld of `f` plus two of `others`, or null.
function trioWith(others: RummyCard[], f: RummyCard): RummyCard[] | null {
  if (f.joker) {
    // A joker melds with any two related naturals, or a second joker and any natural.
    const nats = others.filter((c) => !c.joker);
    const jk = others.find((c) => c.joker);
    if (jk && nats.length) return [f, jk, nats[0]];
    for (let i = 0; i < nats.length; i++)
      for (let j = i + 1; j < nats.length; j++) if (validMeld([f, nats[i], nats[j]])) return [f, nats[i], nats[j]];
    return null;
  }
  const pool = [f, ...others];
  const set = findSetContaining(pool, f)?.slice(0, 3) ?? null;
  if (set && isSet(set)) return set;
  const run = findRunContaining(pool, f);
  return run && run.length === 3 && isRun(run) ? run : null;
}

// The fewest `pool` cards that let `f` join the run `run`: none if it fits
// alone, else naturals of the suit on the ranks between the run and f, then
// jokers. null if it can't reach the run.
function runBridge(run: RummyCard[], f: RummyCard, pool: RummyCard[]): RummyCard[] | null {
  if (isRun([...run, f])) return [];
  const nat = run.filter((c) => !c.joker);
  if (f.joker || !nat.length || nat[0].suit !== f.suit) return null;
  const runJokers = run.length - nat.length;
  let best: RummyCard[] | null = null;
  for (const aceRank of [1, 14]) {
    const eff = (c: RummyCard) => (c.rank === 14 ? aceRank : c.rank);
    const ranks = new Set(nat.map(eff));
    if (ranks.has(eff(f))) continue; // a run can't hold a rank twice
    ranks.add(eff(f));
    const lo = Math.min(...ranks), hi = Math.max(...ranks);
    const holes: number[] = [];
    for (let r = lo + 1; r < hi; r++) if (!ranks.has(r)) holes.push(r);
    const need = holes.length - runJokers; // the run's own jokers fill the rest
    const bridge: RummyCard[] = [];
    for (const r of holes) {
      if (bridge.length >= need) break;
      const c = pool.find((x) => !x.joker && x.suit === f.suit && eff(x) === r);
      if (c) bridge.push(c);
    }
    for (const j of pool) if (j.joker && bridge.length < need) bridge.push(j);
    if (bridge.length < need || !isRun([...run, f, ...bridge])) continue;
    if (!best || bridge.length < best.length) best = bridge;
  }
  return best;
}

// One-move ways to put `f` down from `hand` (which holds it) onto `melds`: a
// new three-card meld (meldId null) or a layoff, each listing the hand cards
// it plays.
function forcedPlays(hand: RummyCard[], f: RummyCard, melds: Meld[]): { meldId: number | null; cards: RummyCard[] }[] {
  const others = hand.filter((c) => c.id !== f.id);
  const out: { meldId: number | null; cards: RummyCard[] }[] = [];
  const trio = trioWith(others, f);
  if (trio) out.push({ meldId: null, cards: trio });
  for (const m of melds) {
    if (m.kind === "set") {
      if (isSet([...m.cards, f])) out.push({ meldId: m.id, cards: [f] });
    } else {
      const bridge = runBridge(m.cards, f, others);
      if (bridge) out.push({ meldId: m.id, cards: [f, ...bridge] });
    }
  }
  return out;
}

// Can `f` still be put down in one move (keeping a card back to discard when
// requireDiscard is on)?
const forcedPlayable = (hand: RummyCard[], f: RummyCard, melds: Meld[], requireDiscard: boolean): boolean =>
  forcedPlays(hand, f, melds).some((p) => !requireDiscard || p.cards.length < hand.length);

// ---------- state, moves, config, view ----------

// `owner` is the seat that put the meld down; it stays put when others lay off
// onto it (cards[0] of a run changes as cards are laid off at its low end).
export type Meld = { id: number; kind: "set" | "run"; owner: number; cards: RummyCard[] };

export type RummyState = {
  players: number;
  target: number; // points to win, e.g. 500
  seed: number;
  phase: "playing" | "gameOver" | "handComplete";
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
  lastRound: { delta: number[]; outSeat: number | null; meldedPts: number[]; heldPts: number[]; heldCards: RummyCard[][]; lastMelds: { id: number; kind: "set" | "run"; owner: number; cards: RummyCard[] }[] } | null;

  requireDiscard: boolean; // must discard a card (not meld/layoff) to go out
  // Per-seat bot difficulty: 0=Easy, 1=Medium, 2=Hard, 3=Expert. Default 2 (Hard/Aggressive).
  botDifficulty: number[];

  nextMeldId: number;
  log: LogEntry[]; // authoritative move log
  logSeq: number; // monotonic id source for log entries

  // Fresh entropy (4 uint32 words) folded into the next deal's shuffle; absent
  // in seed-only (deterministic) play. See reseed.
  entropy?: number[];
  // True from createGame until the first reseed: the opening hand was shuffled
  // from the seed alone, so that reseed deals it again.
  seedOnlyDeal?: boolean;
};

export type RummyMove =
  | { type: "drawStock"; seat: number }
  | { type: "drawDiscard"; seat: number; cardId: number } // take this card + everything above it
  | { type: "meld"; seat: number; cards: number[] } // card ids from hand forming a new set/run
  | { type: "layoff"; seat: number; meldId: number; cards: number[] } // card ids onto an existing meld
  | { type: "discard"; seat: number; cardId: number } // ends the turn
  | { type: "advance"; seat: number }; // advance from handComplete to next deal

export type RummyConfig = {
  players: number;
  target: number;
  requireDiscard?: boolean; // if true, player must discard to go out (default: false)
  // Per-seat bot difficulty: 0=Easy, 1=Medium, 2=Hard, 3=Expert. Omit to default all to Hard.
  botDifficulty?: number[];
};

export type RummyView = {
  you: number | null;
  players: number;
  phase: "playing" | "gameOver" | "lobby" | "handComplete";
  target: number;
  seats: RoomMeta["seats"];
  hostSeat: number | null;
  botReplacement: boolean;
  disconnectedSeats: number[];
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
  lastRound: { delta: number[]; outSeat: number | null; meldedPts: number[]; heldPts: number[]; heldCards: RummyCard[][]; lastMelds: { id: number; kind: "set" | "run"; owner: number; cards: RummyCard[] }[] } | null;
  requireDiscard: boolean;
  botDifficulty: number[]; // per-seat difficulty (public, for lobby display)
  tiebreak: boolean; // target reached but the lead is shared: playing on until one seat leads alone
  log: LogEntry[]; // authoritative move log (public)
};

// ---------- setup / dealing ----------

const handSize = (players: number): number => (players === 2 ? 13 : 7);

function dealRound(prev: RummyState): RummyState {
  const { shuffled, nextSeed } = shuffle(buildDeck(decksFor(prev.players)), prev.seed, prev.entropy);
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

// Per-seat bot level 0-3. Anything else (missing, out of range, not a whole
// number) becomes 2 (Hard), so a bad lobby value can't break a bot.
const botLevels = (players: number, raw: unknown): number[] =>
  Array.from({ length: players }, (_, i) => {
    const d = Array.isArray(raw) ? raw[i] : undefined;
    return Number.isInteger(d) && d >= 0 && d <= 3 ? d : 2;
  });

// Highest "play to" a table may pick (a game is normally played to 500).
const MAX_TARGET = 1000;

// Validate the lobby options (throws with a message the lobby can show).
function createGame(config: RummyConfig, seed: number): RummyState {
  const players = config.players;
  if (!Number.isInteger(players) || players < 2 || players > 8) throw new Error(`Unsupported player count: ${players}`);
  const target = config.target === undefined ? 500 : config.target;
  if (!Number.isInteger(target) || target < 1 || target > MAX_TARGET) throw new Error(`Target must be a whole number from 1 to ${MAX_TARGET}`);
  const requireDiscard = config.requireDiscard ?? false;
  if (typeof requireDiscard !== "boolean") throw new Error("Must discard to go out must be on or off");
  const base: RummyState = {
    players,
    target,
    requireDiscard,
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
    scores: Array(players).fill(0),
    winner: null,
    lastRound: null,
    botDifficulty: botLevels(players, config.botDifficulty),
    nextMeldId: 0,
    log: [],
    logSeq: 0,
  };
  const dealt = dealRound(base);
  return { ...attachRummy(dealt, [], 0, [{ seat: dealt.dealerSeat, msg: "deals the first hand" }]), seedOnlyDeal: true };
}

// Fold fresh entropy (4 uint32 words from a CSPRNG) into the state: every later
// deal shuffles from it rather than from the seed chain, so no deal can be
// worked out from cards seen earlier. The room calls this right after
// createGame — before anyone has seen the opening hand, which was shuffled
// from the 32-bit seed alone — so that first call deals the hand again.
function reseed(state: RummyState, entropy: number[]): RummyState {
  if (!Array.isArray(entropy) || entropy.length < 4) return state;
  const next: RummyState = { ...state, entropy: entropy.slice(0, 4).map((w) => w >>> 0) };
  const untouched = state.phase === "playing" && state.logSeq === 1 && state.lastRound === null;
  if (!state.seedOnlyDeal || !untouched) return next;
  return { ...dealRound(next), seedOnlyDeal: false };
}

// Saved games from older deploys: fill in fields added since (meld owners,
// the move log) and normalize the options.
function migrate(raw: unknown): RummyState {
  const s = raw as RummyState;
  if (!s || typeof s !== "object" || !Number.isInteger(s.players) || s.players < 2 || s.players > 8) throw new Error("Not a Rummy 500 game");
  const log = Array.isArray(s.log) ? s.log : [];
  return {
    ...s,
    // Older melds took their owner from cards[0]; that's the best guess left.
    melds: (s.melds ?? []).map((m) => ({ ...m, owner: m.owner ?? s.cardOwner?.[m.cards[0]?.id] ?? -1 })),
    requireDiscard: s.requireDiscard === true,
    botDifficulty: botLevels(s.players, s.botDifficulty),
    log,
    logSeq: Number.isInteger(s.logSeq) ? s.logSeq : log.reduce((m, e) => Math.max(m, e.id), 0),
  };
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
      extraCards: extra ? taken.slice(1) : undefined,
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
    else if (next.dealerSeat !== prev.dealerSeat) {
      const max = Math.max(...next.scores); // past the target without a winner: a tie
      if (max >= next.target) out.push({ seat: null, msg: `Tied for the lead at ${max} \u2014 another round decides` });
      out.push({ seat: next.dealerSeat, msg: "deals a new round" });
    }
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
// Suit, then rank, jokers last.
const cardOrder = (a: RummyCard, b: RummyCard): number =>
  Number(!!a.joker) - Number(!!b.joker) || SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit) || a.rank - b.rank || a.id - b.id;

function endRound(state: RummyState, outSeat: number | null): RummyState {
  const meldedPts = state.scores.map((_, s) => meldedValue(state, s));
  const heldPts = state.scores.map((_, s) => heldValue(state, s));
  const delta = state.scores.map((_, s) => meldedPts[s] - heldPts[s]);
  // Held cards are shown sorted, so they reveal nothing of the deal order.
  const heldCards = state.hands.map((h) => [...h].sort(cardOrder));
  const scores = state.scores.map((v, s) => v + delta[s]);
  const lastMelds = state.melds.map((m) => ({ ...m }));
  const lastRound = { delta, outSeat, meldedPts, heldPts, heldCards, lastMelds };
  // The game ends once ONE player leads with at least the target. A tie for
  // that lead isn't broken by seat order: another round is played, and so on
  // until a single leader stands at or past the target.
  const max = Math.max(...scores);
  if (max >= state.target && scores.filter((v) => v === max).length === 1) {
    return { ...state, scores, phase: "gameOver", winner: scores.indexOf(max), lastRound };
  }
  const nextDealer = (state.dealerSeat + 1) % state.players;
  return { ...state, scores, phase: "handComplete", dealerSeat: nextDealer, lastRound };
}

// ---------- core interface functions ----------

const seatToAct = (s: RummyState): number | null =>
  (s.phase === "gameOver" || s.phase === "handComplete") ? null : s.turn;
const isOver = (s: RummyState): boolean => s.phase === "gameOver";

function isLegal(state: RummyState, move: RummyMove): boolean {
  if (move.type === "advance") return state.phase === "handComplete";
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
      // playable in one move from hand + everything taken (see forcedPlayable).
      return forcedPlayable([...hand, ...state.discard.slice(idx)], state.discard[idx], state.melds, state.requireDiscard);
    }
    case "meld": {
      if (state.turnPhase !== "play" || !move.cards || move.cards.length < 3) return false;
      if (new Set(move.cards).size !== move.cards.length) return false; // no card listed twice
      const objs = move.cards.map((id) => hand.find((c) => c.id === id));
      if (objs.some((o) => !o)) return false;
      if (!validMeld(objs as RummyCard[])) return false;
      // If a deep-pile pickup is outstanding, this meld must not strand the forced card —
      // afterwards it must still be playable in one move (on any existing meld OR on
      // the meld we're about to place).
      if (state.mustMeldCardId != null && !move.cards.includes(state.mustMeldCardId)) {
        const mustCard = hand.find((c) => c.id === state.mustMeldCardId);
        if (mustCard) {
          const remainHand = hand.filter((c) => !move.cards.includes(c.id));
          const newMeldCards = objs as RummyCard[];
          const newMeldKind: "set" | "run" = isSet(newMeldCards) ? "set" : "run";
          const allMelds = [...state.melds, { id: -1, kind: newMeldKind, owner: move.seat, cards: newMeldCards }];
          if (!forcedPlayable(remainHand, mustCard, allMelds, state.requireDiscard)) return false;
        }
      }
      // requireDiscard: block going out via meld alone (must keep ≥1 card to discard)
      if (state.requireDiscard) {
        const remainAfter = hand.filter((c) => !move.cards.includes(c.id));
        if (remainAfter.length === 0) return false;
      }
      return true;
    }
    case "layoff": {
      if (state.turnPhase !== "play" || !move.cards || move.cards.length < 1) return false;
      if (new Set(move.cards).size !== move.cards.length) return false; // no card listed twice
      const m = state.melds.find((x) => x.id === move.meldId);
      if (!m) return false;
      const objs = move.cards.map((id) => hand.find((c) => c.id === id));
      if (objs.some((o) => !o)) return false;
      const combined = [...m.cards, ...(objs as RummyCard[])];
      if (!(m.kind === "set" ? isSet(combined) : isRun(combined))) return false;
      // Same stranding check for layoffs: spending hand cards must not make the
      // forced card unplayable.
      if (state.mustMeldCardId != null && !move.cards.includes(state.mustMeldCardId)) {
        const mustCard = hand.find((c) => c.id === state.mustMeldCardId);
        if (mustCard) {
          const remainHand = hand.filter((c) => !move.cards.includes(c.id));
          const updatedMeldCards = m.kind === "run" ? orderRunCards(combined) : combined;
          const updatedMelds = state.melds.map((x) => x.id === move.meldId ? { ...x, cards: updatedMeldCards } : x);
          if (!forcedPlayable(remainHand, mustCard, updatedMelds, state.requireDiscard)) return false;
        }
      }
      // requireDiscard: block going out via layoff alone
      if (state.requireDiscard) {
        const remainAfter = hand.filter((c) => !move.cards.includes(c.id));
        if (remainAfter.length === 0) return false;
      }
      return true;
    }
    case "discard":
      // Can't discard until any card drawn from the discard pile is melded.
      return state.turnPhase === "play" && state.mustMeldCardId == null && hand.some((c) => c.id === move.cardId);
  }
  return false;
}

function applyMoveCore(state: RummyState, move: RummyMove): RummyState {
  if (state.phase === "gameOver") throw new Error("Game is over");
  if (!isLegal(state, move)) throw new Error(`Illegal move: ${JSON.stringify(move)}`);

  if (move.type === "advance") {
    if (state.phase !== "handComplete") throw new Error("Not in handComplete");
    return dealRound({ ...state });
  }

  if (seatToAct(state) !== move.seat) throw new Error("Not this seat's turn");

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
      const meld: Meld = { id: state.nextMeldId, kind, owner: seat, cards: kind === "run" ? orderRunCards(objs) : objs };
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
      const move: RummyMove = { type: "drawDiscard", seat, cardId: state.discard[i].id };
      if (isLegal(state, move)) moves.push(move);
    }
    return moves;
  }

  moves.push(...forcedMoves(state, seat)); // always one, while a forced card is pending
  const set = findSet(hand);
  if (set) moves.push({ type: "meld", seat, cards: set.map((c) => c.id) });
  const run = findRun(hand);
  if (run) moves.push({ type: "meld", seat, cards: run.map((c) => c.id) });
  for (const m of state.melds)
    for (const c of hand) moves.push({ type: "layoff", seat, meldId: m.id, cards: [c.id] });
  for (const c of hand) moves.push({ type: "discard", seat, cardId: c.id });
  return moves.filter((m) => isLegal(state, m));
}

// The legal moves that put down the pending forced card, if any.
function forcedMoves(state: RummyState, seat: number): RummyMove[] {
  const hand = state.hands[seat];
  const mc = hand.find((c) => c.id === state.mustMeldCardId);
  if (!mc) return [];
  const moves: RummyMove[] = forcedPlays(hand, mc, state.melds).map((p) => {
    const cards = p.cards.map((c) => c.id);
    return p.meldId == null ? { type: "meld", seat, cards } : { type: "layoff", seat, meldId: p.meldId, cards };
  });
  return moves.filter((m) => isLegal(state, m));
}

// ---------- redaction ----------

function redact(state: RummyState, seat: number | null, meta: RoomMeta): RummyView {
  const toAct = (state.phase === "gameOver" || state.phase === "handComplete") ? null : state.turn;
  const yours = seat !== null && state.phase === "playing" && toAct === seat;
  return {
    you: seat,
    players: state.players,
    phase: state.phase,
    target: state.target,
    seats: meta.seats,
    hostSeat: meta.hostSeat,
    botReplacement: meta.botReplacement,
    disconnectedSeats: meta.disconnectedSeats,
    scores: state.scores,
    winner: state.winner,
    dealerSeat: state.dealerSeat,
    toAct,
    turnPhase: state.turnPhase,
    yourTurn: yours && state.phase === "playing",
    legalMoves: yours && state.phase === "playing" ? legalMoves(state) : [],
    yourHand: seat !== null && state.hands[seat] ? state.hands[seat] : [],
    handCounts: state.hands.map((h) => h.length),
    stockCount: state.stock.length,
    discard: state.discard,
    melds: state.melds.map((m) => ({ id: m.id, kind: m.kind, owner: m.owner, cards: m.cards })),
    mustMeldCardId: yours ? state.mustMeldCardId : null,
    lastRound: state.lastRound,
    requireDiscard: state.requireDiscard,
    botDifficulty: state.botDifficulty,
    tiebreak: state.phase !== "gameOver" && Math.max(...state.scores) >= state.target,
    log: state.log,
  };
}

function lobbyView(config: RummyConfig, seat: number | null, meta: RoomMeta): RummyView {
  const players = config.players;
  return {
    you: seat,
    players,
    phase: "lobby",
    target: config.target,
    seats: meta.seats,
    hostSeat: meta.hostSeat,
    botReplacement: meta.botReplacement,
    disconnectedSeats: meta.disconnectedSeats,
    scores: Array(players).fill(0),
    winner: null,
    dealerSeat: 0,
    toAct: null,
    turnPhase: "draw",
    yourTurn: false,
    legalMoves: [],
    yourHand: [],
    handCounts: Array(players).fill(0),
    stockCount: 0,
    discard: [],
    melds: [],
    mustMeldCardId: null,
    lastRound: null,
    requireDiscard: config.requireDiscard === true,
    botDifficulty: botLevels(players, config.botDifficulty),
    tiebreak: false,
    log: [],
  };
}

// ---------- heuristic AI ----------
// One evaluation engine drives every difficulty level. Each decision scores a
// whole-turn outcome on a single points scale — points banked this turn plus
// the expected future worth of the cards still held — so drawing, melding and
// discarding all pull in the same direction:
//
//   * handValue() estimates, card by card, the chance a held card gets melded
//     before the round ends (sets, runs, extensions of table runs, wild jokers,
//     needed cards visible in the discard pile). The chance comes from the
//     cards still unseen BY THIS SEAT and an empirical horizon driven by the
//     opponents' hand sizes. A card that will likely meld is worth +value, one
//     likely to be caught in hand -value.
//   * planTurn() searches which melds / layoffs to put down this turn; going
//     out is worth the points the opponents are expected to be caught holding.
//   * feedRisk() prices a discard by how likely an opponent can use it — meld
//     it, lay it off, or use it to sweep the pile (sweepRisk) — from the unseen
//     cards and the cards they publicly picked up from the pile.
//   * chooseDraw() compares the expected value of an unseen stock card with
//     taking the top discard or sweeping deeper into the pile.
//
// Honesty: a bot reads only its own hand and public information (table melds,
// discard pile, hand/stock counts, the move log). Cards it cannot see are
// treated as equally likely to be anywhere it cannot see.
//
// Measured with src/rummy.battle.ts (paired seeds, candidate vs a baseline).

// Per-difficulty knobs. The 0-3 encoding (state.botDifficulty) is persisted in
// rooms and shown in the lobby, so it must stay stable.
type AiLevel = {
  /** Scales the empirical number of future draws (how patient the bot is). */
  horizonScale: number;
  /** Weight on an opponent's expected gain from our discard. */
  feedWeight: number;
  /** Weight on discards that would let an opponent sweep the pile (see sweepRisk). */
  sweepWeight: number;
  /** Deepest discard-pile pickup considered, in cards taken (sweeping the pile is the biggest skill). */
  pickupDepth: number;
  /** Probability of a deliberately non-best discard (human-like imperfection). */
  misplayRate: number;
};

const AI_LEVELS: AiLevel[] = [
  // 0 · Easy: short pile pickups only, ignores what its discards feed, slips often
  { horizonScale: 1, feedWeight: 0, sweepWeight: 0, pickupDepth: 2, misplayRate: 0.2 },
  // 1 · Medium: modest pickups, light discard caution, slips often
  { horizonScale: 1, feedWeight: 1, sweepWeight: 0, pickupDepth: 3, misplayRate: 0.2 },
  // 2 · Hard: the full evaluation, but sweeps at most 8 cards and slips now and then
  { horizonScale: 2.4, feedWeight: 1.5, sweepWeight: 0.3, pickupDepth: 8, misplayRate: 0.2 },
  // 3 · Expert: the full engine
  { horizonScale: 2.4, feedWeight: 1.5, sweepWeight: 0.3, pickupDepth: 99, misplayRate: 0 },
];

// Points an opponent gains beyond the card itself when they can use our
// discard (tempo toward going out).
const FEED_TEMPO = 4;
// Chance credited for a needed card sitting on top of the discard pile (it
// fades with depth): we may sweep it next turn if nobody else does.
const PILE_OUT = 0.5;
export const DIFFICULTY_LABELS = ["Easy", "Medium", "Hard", "Expert"] as const;

function aiLevel(state: RummyState, seat: number): AiLevel {
  return AI_LEVELS[botLevels(state.players, state.botDifficulty)[seat] ?? 2];
}

// ---------- deterministic per-decision RNG ----------
// Derived from game seed + seat + log sequence so it's stable across replays
// but differs each decision and each seat.
function aiRng(state: RummyState, seat: number): () => number {
  const seed = ((state.seed >>> 0) ^ (seat * 0x9e3779b9) ^ (state.logSeq * 0x517cc1b7)) >>> 0;
  return mulberry32(seed);
}

// ---------- simple meld finders ----------
// Used by legalMoves() and as the bot's last-resort fallback. Every meld these
// return satisfies isSet/isRun.
const naturalsOf = (hand: RummyCard[]): RummyCard[] => hand.filter((c) => !c.joker);
const jokersOf = (hand: RummyCard[]): RummyCard[] => hand.filter((c) => c.joker);

// Deduplicate same-rank cards by suit — only one card per suit allowed in a set.
function uniqueBySuit(cards: RummyCard[]): RummyCard[] {
  const seen = new Map<string, RummyCard>();
  for (const c of cards) if (!seen.has(c.suit)) seen.set(c.suit, c);
  return [...seen.values()];
}
function findSet(hand: RummyCard[]): RummyCard[] | null {
  const jokers = jokersOf(hand);
  const byRank = new Map<number, RummyCard[]>();
  for (const c of naturalsOf(hand)) byRank.set(c.rank, [...(byRank.get(c.rank) ?? []), c]);
  let bestG: RummyCard[] | null = null;
  for (const g of byRank.values()) {
    const unique = uniqueBySuit(g);
    if (unique.length >= 3) return unique.slice(0, 4);
    if (!bestG || unique.length > bestG.length) bestG = unique;
  }
  if (bestG && bestG.length >= 1 && bestG.length + jokers.length >= 3)
    return [...bestG, ...jokers.slice(0, 3 - bestG.length)];
  return null;
}
function findSetContaining(hand: RummyCard[], c: RummyCard): RummyCard[] | null {
  if (c.joker) return null;
  // c must be included — use it as the representative for its own suit.
  const seen = new Map<string, RummyCard>([[c.suit, c]]);
  for (const x of hand) if (!x.joker && x.rank === c.rank && !seen.has(x.suit)) seen.set(x.suit, x);
  const g = [...seen.values()];
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
        if (lo === 1 && hi === 14) break; // the ace can't sit at both ends
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

// ---------- compact meld summaries ----------
// Cards are indexed by key = suit * 16 + rank (rank 2..14, ace = 14). Rank 1 is
// used only as the ace's low position inside run windows.

const SUIT_IDX: Record<Suit, number> = { C: 0, D: 1, H: 2, S: 3 };
const keyOf = (c: RummyCard): number => SUIT_IDX[c.suit] * 16 + c.rank;
const keyValue = (key: number): number => cardValue({ id: -1, rank: key & 15, suit: "C" });

function popcount(x: number): number {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

// A table (or planned) meld reduced to what extension checks need. Mirrors
// isSet / isRun exactly for single-card additions.
type MeldInfo = {
  run: boolean;
  suit: number; // run: suit index
  rank: number; // set: rank
  mask: number; // set: suits present; run: natural ranks present (bit 14 = ace)
  size: number;
  jokers: number;
  id: number; // table meld id, or -1 for a meld planned this turn
  view?: TableView; // lazily cached by meldView()
};

function meldInfo(cards: RummyCard[], run: boolean, id: number): MeldInfo {
  let mask = 0, jokers = 0, suit = -1, rank = 0;
  for (const c of cards) {
    if (c.joker) { jokers++; continue; }
    if (run) { suit = SUIT_IDX[c.suit]; mask |= 1 << c.rank; }
    else { rank = c.rank; mask |= 1 << SUIT_IDX[c.suit]; }
  }
  return { run, suit, rank, mask, size: cards.length, jokers, id };
}

// Run validity on a bitmask of natural ranks (ace = bit 14) plus wild jokers,
// mirroring isRun: ace low or high, interior gaps filled by jokers, leftover
// jokers extend the ends up to 13 cards in all. Returns the covered span of
// natural cards as a bitmask of effective ranks (ace low = bit 1), or 0.
function runSpan(nat: number, jokers: number): number {
  if (nat === 0) return 0;
  for (let mode = 0; mode < 2; mode++) {
    let m = nat;
    if (mode === 1) {
      if (!(m & (1 << 14))) break;
      m = (m & ~(1 << 14)) | 2;
    }
    const lo = 31 - Math.clz32(m & -m);
    const hi = 31 - Math.clz32(m);
    const gaps = hi - lo + 1 - popcount(m);
    if (gaps > jokers) continue;
    const extra = jokers - gaps;
    if (hi - lo + 1 + extra > 13) continue;
    return ((1 << (hi + 1)) - 1) & ~((1 << lo) - 1);
  }
  return 0;
}

// Can card `c` be laid off onto meld `m`?
function fits(m: MeldInfo, c: RummyCard): boolean {
  if (c.joker) return m.run ? runSpan(m.mask, m.jokers + 1) !== 0 : m.size < 4;
  if (!m.run) return c.rank === m.rank && m.size < 4 && !(m.mask & (1 << SUIT_IDX[c.suit]));
  return SUIT_IDX[c.suit] === m.suit && !(m.mask & (1 << c.rank)) && runSpan(m.mask | (1 << c.rank), m.jokers) !== 0;
}

function extend(m: MeldInfo, c: RummyCard): MeldInfo {
  if (c.joker) return { ...m, size: m.size + 1, jokers: m.jokers + 1, view: undefined };
  return { ...m, size: m.size + 1, mask: m.mask | (1 << (m.run ? c.rank : SUIT_IDX[c.suit])), view: undefined };
}

// What a set of table melds offers a single card: per suit, a bitmask of the
// ranks that could be laid off right now (`lay`) and of the ranks its runs
// already span (`anchors`). Cached on each meld (a MeldInfo is never changed
// once made) and per meld-list array, so a list must not be mutated once viewed.
type TableView = { lay: number[]; anchors: number[] };
const TABLE_VIEWS = new WeakMap<MeldInfo[], TableView>();

function meldView(m: MeldInfo): TableView {
  if (m.view) return m.view;
  const v: TableView = { lay: [0, 0, 0, 0], anchors: [0, 0, 0, 0] };
  if (m.run) {
    v.anchors[m.suit] = runSpan(m.mask, m.jokers);
    for (let r = 2; r <= 14; r++) if (!(m.mask & (1 << r)) && runSpan(m.mask | (1 << r), m.jokers)) v.lay[m.suit] |= 1 << r;
  } else if (m.size < 4) {
    for (let t = 0; t < 4; t++) if (!(m.mask & (1 << t))) v.lay[t] |= 1 << m.rank;
  }
  m.view = v;
  return v;
}

function tableView(tbl: MeldInfo[]): TableView {
  let v = TABLE_VIEWS.get(tbl);
  if (v) return v;
  v = { lay: [0, 0, 0, 0], anchors: [0, 0, 0, 0] };
  for (const m of tbl) {
    const mv = meldView(m);
    for (let t = 0; t < 4; t++) { v.lay[t] |= mv.lay[t]; v.anchors[t] |= mv.anchors[t]; }
  }
  TABLE_VIEWS.set(tbl, v);
  return v;
}

// ---------- what this seat knows ----------

// Opponents' cards that are public knowledge: everything they picked up from
// the discard pile this round and have not melded, laid off or discarded since
// (read from the public move log, as a human at the table would remember).
function revealedCards(state: RummyState, seat: number): RummyCard[][] {
  const held: Map<number, RummyCard>[] = Array.from({ length: state.players }, () => new Map());
  const log = state.log;
  let start = 0;
  for (let i = log.length - 1; i >= 0; i--) {
    const m = log[i].msg;
    if (m === "deals a new round" || m === "deals the first hand" || m.startsWith("goes out") || m.startsWith("Stock exhausted")) { start = i + 1; break; }
  }
  for (let i = start; i < log.length; i++) {
    const e = log[i];
    if (e.seat === null || e.seat === seat || !held[e.seat]) continue;
    const cards = [...(e.cards ?? []), ...(e.extraCards ?? [])] as unknown as RummyCard[];
    for (const c of cards) {
      if (typeof c?.id !== "number") continue;
      if (e.msg === "took") held[e.seat].set(c.id, c);
      else if (e.msg === "melded" || e.msg === "laid off" || e.msg === "discarded") held[e.seat].delete(c.id);
    }
  }
  return held.map((m) => [...m.values()]);
}

// Empirical (2-player self-play) number of further turns we get, indexed by the
// smallest opponent hand, and the chance an opponent holding h cards goes out
// on their next turn.
const HORIZON_BY_HAND = [0, 1.2, 2.1, 2.7, 3.3, 3.9, 4.8, 5.7, 5.7, 5.9, 6.7, 7, 7, 7.2];
const OUT_HAZARD = [1, 0.46, 0.25, 0.21, 0.09, 0.06, 0.04, 0.03, 0.02, 0.02, 0.01];

type OppInfo = {
  seat: number;
  rho: number; // P(a given unseen card is in this hand)
  jokerP: number; // P(this hand holds a joker)
  known: Int8Array; // per key: copies publicly known to be in this hand
};

type AiCtx = {
  state: RummyState;
  seat: number;
  lv: AiLevel;
  live: Int8Array; // per key: copies whose location is unknown to us
  liveJokers: number;
  unknown: number; // cards whose location is unknown (stock + unrevealed opponent cards)
  pileCredit: Float64Array; // per key: credit for a copy visible in the discard pile
  p1: Float64Array; // p1[k]: P(>=1 of k specific unseen cards arrives within the horizon)
  p2: Float64Array; // p2[k]: P(>=2 of them arrive)
  pairDraw: number; // correction for needing two different specific cards
  keep: number; // P(we get another turn): worth of a complete meld still in hand
  opps: OppInfo[];
  goOutBonus: number; // expected points the opponents are caught holding if we go out
  table: MeldInfo[];
  feedCache: Map<number, number>;
  leavesLeft: number; // search budget left for this decision (see planTurn)
};

function buildCtx(state: RummyState, seat: number, lv: AiLevel): AiCtx {
  const decks = decksFor(state.players);
  const live = new Int8Array(64);
  for (let s = 0; s < 4; s++) for (let r = 2; r <= 14; r++) live[s * 16 + r] = decks;
  let liveJokers = 2 * decks;
  const see = (c: RummyCard) => { if (c.joker) liveJokers--; else live[keyOf(c)]--; };
  const visible = new Set<number>();
  for (const c of state.hands[seat]) { see(c); visible.add(c.id); }
  for (const c of state.discard) { see(c); visible.add(c.id); }
  for (const m of state.melds) for (const c of m.cards) { see(c); visible.add(c.id); }

  const revealed = revealedCards(state, seat);
  const opps: OppInfo[] = [];
  const knownCount: number[] = [], knownJokers: number[] = [];
  for (let i = 1; i < state.players; i++) {
    const o = (seat + i) % state.players;
    const known = new Int8Array(64);
    let n = 0, jokers = 0;
    for (const c of revealed[o]) {
      if (visible.has(c.id)) continue;
      visible.add(c.id);
      see(c);
      n++;
      if (c.joker) jokers++; else known[keyOf(c)]++;
    }
    knownCount.push(n);
    knownJokers.push(jokers);
    opps.push({ seat: o, rho: 0, jokerP: jokers > 0 ? 1 : 0, known });
  }
  let unknown = liveJokers, liveVal = liveJokers * 15;
  for (let k = 0; k < 64; k++) if (live[k] > 0) { unknown += live[k]; liveVal += live[k] * keyValue(k); }
  unknown = Math.max(1, unknown);
  const avgVal = liveVal / unknown;

  // Horizon: further draws we expect before someone goes out or the stock ends.
  let minOpp = 99, pCont = 1, goOut = 0;
  opps.forEach((o, i) => {
    const h = state.hands[o.seat].length;
    minOpp = Math.min(minOpp, h);
    pCont *= 1 - OUT_HAZARD[Math.min(h, OUT_HAZARD.length - 1)];
    const hidden = Math.max(0, h - knownCount[i]);
    o.rho = hidden / unknown;
    if (o.jokerP < 1) o.jokerP = 1 - Math.pow(1 - o.rho, liveJokers);
    let knownVal = 0;
    for (let k = 0; k < 64; k++) knownVal += o.known[k] * keyValue(k);
    goOut += knownVal + 15 * knownJokers[i] + hidden * avgVal;
  });
  const horizon = Math.max(0, Math.min(
    state.stock.length / state.players,
    lv.horizonScale * HORIZON_BY_HAND[Math.min(minOpp, HORIZON_BY_HAND.length - 1)] / (1 + 0.2 * (opps.length - 1)),
  ));

  const p1 = new Float64Array(12), p2 = new Float64Array(12);
  for (let k = 0; k < 12; k++) {
    const p = Math.min(1, k / unknown);
    const miss = Math.pow(1 - p, horizon);
    p1[k] = 1 - miss;
    p2[k] = Math.max(0, 1 - miss - (p < 1 ? horizon * p * Math.pow(1 - p, horizon - 1) : 0));
  }

  const pileCredit = new Float64Array(64);
  const pile = state.discard;
  for (let i = 0; i < pile.length; i++) {
    const c = pile[i];
    if (c.joker) continue;
    const depth = pile.length - i;
    const credit = PILE_OUT / (1 + 0.25 * (depth - 1));
    if (credit > pileCredit[keyOf(c)]) pileCredit[keyOf(c)] = credit;
  }

  return {
    state, seat, lv, live, liveJokers, unknown, pileCredit, p1, p2,
    pairDraw: horizon > 1 ? (horizon - 1) / horizon : 0,
    keep: pCont,
    opps,
    goOutBonus: goOut,
    table: state.melds.map((m) => meldInfo(m.cards, m.kind === "run", m.id)),
    feedCache: new Map(),
    leavesLeft: DECISION_LEAVES,
  };
}

// ---------- hand evaluation ----------

// Scratch buffers reused across calls (fully rewritten on every use).
const HAS = new Int8Array(64); // natural copies held by key, ace mirrored at rank 1
const RANK_SUITS = new Int8Array(16); // per rank: bitmask of suits held
let PROB = new Float64Array(64);
let PROB2 = new Float64Array(64);

// Load `rest` into HAS / RANK_SUITS; returns how many jokers it holds.
function loadHand(rest: RummyCard[]): number {
  HAS.fill(0);
  RANK_SUITS.fill(0);
  let jokers = 0;
  for (const c of rest) {
    if (c.joker) { jokers++; continue; }
    const s = SUIT_IDX[c.suit];
    HAS[s * 16 + c.rank]++;
    if (c.rank === 14) HAS[s * 16 + 1]++;
    RANK_SUITS[c.rank] |= 1 << s;
  }
  if (PROB.length < rest.length) { PROB = new Float64Array(rest.length * 2); PROB2 = new Float64Array(rest.length * 2); }
  return jokers;
}

// Take one natural card out of (or back into) the loaded hand.
function shiftCard(c: RummyCard, delta: number): void {
  const s = SUIT_IDX[c.suit];
  HAS[s * 16 + c.rank] += delta;
  if (c.rank === 14) HAS[s * 16 + 1] += delta;
  if (HAS[s * 16 + c.rank] > 0) RANK_SUITS[c.rank] |= 1 << s;
  else RANK_SUITS[c.rank] &= ~(1 << s);
}

// Could a and b combine into a meld (same rank, or near each other in a suit)?
function related(a: RummyCard, b: RummyCard): boolean {
  if (a.rank === b.rank) return true;
  if (a.suit !== b.suit) return false;
  const d = Math.abs(a.rank - b.rank);
  return d <= 2 || (a.rank === 14 && b.rank <= 3) || (b.rank === 14 && a.rank <= 3);
}

// Chance that natural card `c` gets melded before the round ends, given the
// rest of the hand (already loaded into HAS / RANK_SUITS) and the table.
function meldChance(ctx: AiCtx, c: RummyCard, view: TableView): number {
  const s = SUIT_IDX[c.suit], r = c.rank;
  if ((view.lay[s] >> r) & 1) return ctx.keep; // can be laid off next turn
  const { live, pileCredit, p1, p2 } = ctx;

  // Set: other suits of this rank.
  const mask = RANK_SUITS[r];
  const k = popcount(mask);
  let pSet: number;
  if (k >= 3) pSet = ctx.keep;
  else {
    let outs = 0, pile = 0;
    for (let t = 0; t < 4; t++) {
      if (mask & (1 << t)) continue;
      outs += live[t * 16 + r];
      if (pileCredit[t * 16 + r] > pile) pile = pileCredit[t * 16 + r];
    }
    pSet = k === 2 ? Math.max(p1[outs], pile) : p2[outs];
  }

  // Run: every 3-rank window containing c, counting held cards and table runs
  // it could extend; the missing ranks must still be live (or in the pile).
  let pRun = 0;
  const own = view.anchors[s];
  for (let mode = 0; mode < (r === 14 ? 2 : 1); mode++) {
    const cr = mode === 1 ? 1 : r;
    const anc = own & (1 << cr) ? 0 : own; // c already inside a table run can't extend it
    for (let lo = Math.max(1, cr - 2); lo <= Math.min(cr, 12); lo++) {
      let miss = 0, a = 0, b = 0, fromPile = false, ok = true;
      for (let rr = lo; rr < lo + 3; rr++) {
        if (rr === cr || HAS[s * 16 + rr] || anc & (1 << rr)) continue;
        const key = s * 16 + (rr === 1 ? 14 : rr);
        const pd = p1[live[key]], pc = pileCredit[key];
        if (pd === 0 && pc === 0) { ok = false; break; }
        if (pc > pd) fromPile = true;
        if (miss === 0) a = Math.max(pd, pc); else b = Math.max(pd, pc);
        miss++;
      }
      if (!ok) continue;
      const pw = miss === 0 ? ctx.keep : miss === 1 ? a : a * b * (fromPile ? 1 : ctx.pairDraw);
      if (pw > pRun) pRun = pw;
    }
  }
  return 1 - (1 - pSet) * (1 - pRun);
}

// Each joker completes the most valuable two-card combo (pair or run
// connector) still short of a meld; `skip` marks a card left out of the hand.
// Returns the chance the jokers themselves get melded.
function applyJokers(ctx: AiCtx, rest: RummyCard[], P: Float64Array, jokers: number, skip: number, tableMelds: number): number {
  let usedJoker = false;
  const n = rest.length;
  for (let j = 0; j < jokers; j++) {
    let best = 0, bi = -1, bj = -1;
    for (let x = 0; x < n; x++) {
      const a = rest[x];
      if (x === skip || a.joker || P[x] >= ctx.keep) continue;
      for (let y = x + 1; y < n; y++) {
        const b = rest[y];
        if (y === skip || b.joker || P[y] >= ctx.keep || (a.rank === b.rank && a.suit === b.suit) || !related(a, b)) continue;
        const gain = cardValue(a) * (ctx.keep - P[x]) + cardValue(b) * (ctx.keep - P[y]);
        if (gain > best) { best = gain; bi = x; bj = y; }
      }
    }
    if (bi < 0) break;
    P[bi] = P[bj] = ctx.keep;
    usedJoker = true;
  }
  return usedJoker || tableMelds > 0 ? ctx.keep : 0.85 * ctx.keep;
}

function sumValue(rest: RummyCard[], P: Float64Array, jokerP: number, skip: number): number {
  let total = 0;
  for (let i = 0; i < rest.length; i++) {
    if (i === skip) continue;
    const c = rest[i];
    total += cardValue(c) * (2 * (c.joker ? jokerP : P[i]) - 1);
  }
  return total;
}

// Expected round worth of keeping `rest` in hand: each card counts +value if it
// will likely be melded, -value if it will likely be caught in hand.
function handValue(ctx: AiCtx, rest: RummyCard[], tbl: MeldInfo[]): number {
  if (rest.length === 0) return 0;
  const jokers = loadHand(rest);
  const view = tableView(tbl);
  for (let i = 0; i < rest.length; i++) PROB[i] = rest[i].joker ? 0 : meldChance(ctx, rest[i], view);
  const jokerP = jokers ? applyJokers(ctx, rest, PROB, jokers, -1, tbl.length) : 0;
  return sumValue(rest, PROB, jokerP, -1);
}

// ---------- discard risk ----------

// Ranks (2..14) that would complete a run with same-suit ranks a and b.
function thirdRanks(a: number, b: number): number[] {
  const out: number[] = [];
  for (let mode = 0; mode < 2; mode++) {
    if (mode === 1 && a !== 14 && b !== 14) break; // second pass: ace low
    const ea = mode === 1 && a === 14 ? 1 : a, eb = mode === 1 && b === 14 ? 1 : b;
    const lo = Math.min(ea, eb), hi = Math.max(ea, eb);
    if (hi - lo === 2) out.push(lo + 1);
    if (hi - lo === 1) { if (lo > 1) out.push(lo - 1); if (hi < 14) out.push(hi + 1); }
  }
  return out.map((r) => (r === 1 ? 14 : r));
}

// Expected points an opponent gains if our discard `c` lets them sweep the
// pile: c, a buried pile card t and one card they hold (or a joker) make a meld
// with t at the bottom, so they take t, everything above it, and c. `hold`
// gives the chance they hold a card by key.
function sweepRisk(ctx: AiCtx, c: RummyCard, hold: (key: number) => number, jokerP: number): number {
  const pile = ctx.state.discard;
  const s = SUIT_IDX[c.suit];
  let above = 0, best = 0;
  for (let i = pile.length - 1; i >= 0; i--) {
    const t = pile[i];
    if (!t.joker && related(t, c) && !(t.rank === c.rank && t.suit === c.suit)) {
      let none = 1; // P(they hold no completing card)
      if (t.rank === c.rank) {
        for (let u = 0; u < 4; u++) if (u !== s && u !== SUIT_IDX[t.suit]) none *= 1 - hold(u * 16 + c.rank);
      } else {
        for (const x of thirdRanks(t.rank, c.rank)) none *= 1 - hold(s * 16 + x);
      }
      const pX = 1 - none * (1 - jokerP);
      const gain = pX * (cardValue(t) + cardValue(c) + 0.3 * above);
      if (gain > best) best = gain;
    }
    above += cardValue(t);
  }
  return best;
}

// Expected points the opponents gain from our discarding `c`: for each
// opponent, the chance they can meld it (holding partners) or lay it off, times
// its value plus a tempo bonus; plus the chance it lets them sweep the pile
// (sweepRisk).
function feedRisk(ctx: AiCtx, c: RummyCard): number {
  if (c.joker) return 60; // never hand an opponent a wild card
  const cacheKey = keyOf(c);
  const hit = ctx.feedCache.get(cacheKey);
  if (hit !== undefined) return hit;
  const { live } = ctx;
  let layable = false;
  for (const m of ctx.table) if (fits(m, c)) { layable = true; break; }
  const s = SUIT_IDX[c.suit], r = c.rank;
  let risk = 0, pileRisk = 0;
  for (const o of ctx.opps) {
    let pUse = 1;
    const hold = (key: number): number => (o.known[key] > 0 ? 1 : live[key] > 0 ? 1 - Math.pow(1 - o.rho, live[key]) : 0);
    if (ctx.lv.sweepWeight > 0) pileRisk += sweepRisk(ctx, c, hold, o.jokerP);
    if (!layable) {
      // Set: at least two other suits of this rank, or one plus a joker.
      let p0 = 1, pOne = 0, pTwo = 0;
      for (let t = 0; t < 4; t++) {
        if (t === s) continue;
        const q = hold(t * 16 + r);
        pTwo += pOne * q;
        pOne = pOne * (1 - q) + p0 * q;
        p0 *= 1 - q;
      }
      const pSet = pTwo + pOne * o.jokerP;
      // Run: both other cards of some 3-rank window, or one plus a joker.
      let pRun = 0;
      for (let mode = 0; mode < (r === 14 ? 2 : 1); mode++) {
        const cr = mode === 1 ? 1 : r;
        for (let lo = Math.max(1, cr - 2); lo <= Math.min(cr, 12); lo++) {
          const need: number[] = [];
          for (let rr = lo; rr < lo + 3; rr++) if (rr !== cr) need.push(hold(s * 16 + (rr === 1 ? 14 : rr)));
          const pw = need[0] * need[1] + (need[0] + need[1] - 2 * need[0] * need[1]) * o.jokerP;
          if (pw > pRun) pRun = pw;
        }
      }
      pUse = 1 - (1 - pSet) * (1 - pRun);
    }
    risk += pUse;
  }
  risk = risk * (cardValue(c) + FEED_TEMPO) + ctx.lv.sweepWeight * pileRisk;
  ctx.feedCache.set(cacheKey, risk);
  return risk;
}

// ---------- turn planning ----------

// A meld that could be put down from the hand: natural card indices plus how
// many jokers it needs.
type Cand = { idx: number[]; jokers: number; run: boolean; pts: number };

// With `only` >= 0, just the candidates that use hand[only] (a natural card).
function meldCandidates(hand: RummyCard[], only = -1): Cand[] {
  const jokers = hand.filter((c) => c.joker).length;
  const oc = only >= 0 ? hand[only] : null;
  const allowSingles = hand.length <= 4; // one natural + two jokers: only worth it to go out
  const out: Cand[] = [];
  const seen = new Set<string>();
  const add = (idx: number[], jk: number, run: boolean) => {
    if (oc && !idx.includes(only)) return;
    if (jk > 0) { // a joker padding either end of the same naturals repeats a meld
      const sig = [...idx].sort((a, b) => a - b).join(",") + "/" + jk + (run ? "r" : "s");
      if (seen.has(sig)) return;
      seen.add(sig);
    }
    out.push({ idx, jokers: jk, run, pts: idx.reduce((a, i) => a + cardValue(hand[i]), 0) + 15 * jk });
  };

  // Sets: one card per suit of a rank (a second copy in a double deck waits for
  // a later plan), with up to one joker — or two for a lone natural.
  const byRank = new Map<number, number[]>();
  hand.forEach((c, i) => {
    if (c.joker || (oc && c.rank !== oc.rank)) return;
    const g = byRank.get(c.rank) ?? [];
    if (!g.some((j) => hand[j].suit === c.suit)) g.push(i);
    byRank.set(c.rank, g);
  });
  for (const g of byRank.values()) {
    const k = g.length;
    if (k >= 3) add(g, 0, false);
    if (k === 4) for (let skip = 0; skip < 4; skip++) add(g.filter((_, x) => x !== skip), 0, false);
    if (k === 3 && jokers >= 1) add(g, 1, false);
    if (jokers >= 1 && k >= 2) for (let x = 0; x < k; x++) for (let y = x + 1; y < k; y++) add([g[x], g[y]], 1, false);
    if (jokers >= 2 && allowSingles) for (const x of g) add([x], 2, false);
  }

  // Runs: every window of effective ranks with natural ends (jokers fill gaps),
  // plus three-card windows padded by a joker at one end.
  for (let s = 0; s < 4; s++) {
    if (oc && SUIT_IDX[oc.suit] !== s) continue;
    const at = new Array<number>(15).fill(-1);
    hand.forEach((c, i) => {
      if (c.joker || SUIT_IDX[c.suit] !== s) return;
      if (at[c.rank] < 0) at[c.rank] = i;
    });
    at[1] = at[14];
    for (let lo = 1; lo <= 12; lo++) {
      for (let hi = lo + 2; hi <= 14; hi++) {
        if (lo === 1 && hi === 14) break; // the ace can't sit at both ends
        let nat = 0;
        for (let r = lo; r <= hi; r++) if (at[r] >= 0) nat++;
        const missing = hi - lo + 1 - nat;
        if (missing > jokers) break; // widening only adds gaps
        if (nat === 0 || (nat === 1 && !allowSingles)) continue;
        const endsNatural = at[lo] >= 0 && at[hi] >= 0;
        if (!endsNatural && (hi - lo > 2 || (at[lo] < 0 && at[hi] < 0))) continue;
        const idx: number[] = [];
        for (let r = lo; r <= hi; r++) if (at[r] >= 0) idx.push(at[r]);
        add(idx, missing, true);
      }
    }
  }
  return out.sort((a, b) => b.pts - a.pts);
}

// A planned layoff: `at` indexes the plan's meld list (table melds, then the
// new melds); meldId is the table meld's id, or -1 for a new meld.
type Layoff = { card: RummyCard; meldId: number; at: number };

type Plan = {
  chosen: Cand[]; // the candidates the new melds came from
  melds: RummyCard[][]; // new melds, in play order
  layoffs: Layoff[]; // in an order that can be played
  rest: RummyCard[]; // cards still in hand afterwards
  tbl: MeldInfo[]; // table melds afterwards (existing + planned, with layoffs)
  banked: number; // points put on the table this turn
  value: number; // banked + worth of the rest (or the go-out bonus)
};

const PLAY_LEAVES = 1500; // search budget for a hand actually held
const DEEP_LEAVES = 400; // search budget per hypothetical deep pickup
const DECISION_LEAVES = 4000; // shared by every search in one decision (bounds CPU)
const MIN_LEAVES = 30; // a search always gets at least this many leaves

// Complete a plan from a chosen set of new melds: lay off whatever then fits,
// decide on joker layoffs, and value the result. null if the forced card
// (deep pickup) would be stranded or the plan breaks requireDiscard.
function planLeaf(ctx: AiCtx, hand: RummyCard[], forcedId: number | null, chosen: Cand[]): Plan | null {
  const n = hand.length;
  let banked = 0;
  // Assign real jokers to the chosen melds.
  const jokerIdx: number[] = [];
  hand.forEach((c, i) => { if (c.joker) jokerIdx.push(i); });
  let jx = 0;
  const melds: RummyCard[][] = [];
  let infos = ctx.table.slice();
  const inMeld = new Uint8Array(n);
  for (const cd of chosen) {
    const cards = cd.idx.map((i) => hand[i]);
    for (const i of cd.idx) inMeld[i] = 1;
    for (let k = 0; k < cd.jokers; k++) { const ji = jokerIdx[jx++]; cards.push(hand[ji]); inMeld[ji] = 1; }
    melds.push(cards);
    infos.push(meldInfo(cards, cd.run && cd.idx.length > 1, -1)); // 1 natural + 2 jokers counts as a set
    banked += cd.pts;
  }
  let rest: RummyCard[] = [];
  for (let i = 0; i < n; i++) if (!inMeld[i]) rest.push(hand[i]);

  const layoffs: Layoff[] = [];
  const layOff = (t: number, c: RummyCard) => {
    infos[t] = extend(infos[t], c);
    layoffs.push({ card: c, meldId: infos[t].id, at: t });
    banked += cardValue(c);
  };
  // A forced card not in a new meld is laid off first, onto a meld as it
  // stands: the rules check each layoff leaves it playable in one step.
  const fi = rest.findIndex((c) => c.id === forcedId);
  if (fi >= 0) {
    const t = infos.findIndex((m) => fits(m, rest[fi]));
    if (t < 0) return null; // forced card stranded
    layOff(t, rest[fi]);
    rest.splice(fi, 1);
  }
  // Lay off every natural card that fits (repeat: one layoff can open another).
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 0; i < rest.length; i++) {
      const c = rest[i];
      if (c.joker) continue;
      const t = infos.findIndex((m) => fits(m, c));
      if (t < 0) continue;
      layOff(t, c);
      rest.splice(i--, 1);
      changed = true;
    }
  }
  // Jokers: lay one off only when that beats keeping it for a combo.
  let restValue = handValue(ctx, rest, infos);
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (!c.joker) continue;
    const t = infos.findIndex((m) => fits(m, c));
    if (t < 0) continue;
    const without = rest.filter((x) => x !== c);
    const v = handValue(ctx, without, infos);
    if (v + cardValue(c) > restValue) {
      infos = infos.slice(); // already viewed by handValue: replace, don't mutate
      layOff(t, c);
      rest = without;
      restValue = v;
      i--;
    }
  }
  // Going out: no cards left, or one left to discard.
  if (rest.length === 0 && ctx.state.requireDiscard) {
    // Keep the last layoff back to discard (no later layoff builds on it). A
    // meld can't take the last card, and the forced card can't be discarded.
    if (!layoffs.length || layoffs[layoffs.length - 1].card.id === forcedId) return null;
    const back = layoffs.pop()!;
    banked -= cardValue(back.card);
    rest = [back.card];
  }
  const value = banked + (rest.length <= 1 ? ctx.goOutBonus : restValue);
  return { chosen: chosen.slice(), melds, layoffs, rest, tbl: infos, banked, value };
}

// Choose which melds and layoffs to put down from `hand`: a depth-first search
// over disjoint meld candidates (biggest first), each leaf completed by
// planLeaf. Every plan places the forced card if there is one; null when none can.
function planTurn(ctx: AiCtx, hand: RummyCard[], forcedId: number | null, maxLeaves: number): Plan | null {
  const cands = meldCandidates(hand);
  const used = new Uint8Array(hand.length);
  const chosen: Cand[] = [];
  let jokersLeft = hand.filter((c) => c.joker).length;
  let best: Plan | null = null;
  let leaves = 0;
  maxLeaves = Math.max(MIN_LEAVES, Math.min(maxLeaves, ctx.leavesLeft));
  const dfs = (start: number) => {
    leaves++;
    const p = planLeaf(ctx, hand, forcedId, chosen);
    if (p && (!best || p.value > best.value)) best = p;
    for (let j = start; j < cands.length && leaves < maxLeaves; j++) {
      const cd = cands[j];
      if (cd.jokers > jokersLeft || cd.idx.some((i) => used[i])) continue;
      for (const i of cd.idx) used[i] = 1;
      jokersLeft -= cd.jokers;
      chosen.push(cd);
      dfs(j + 1);
      chosen.pop();
      jokersLeft += cd.jokers;
      for (const i of cd.idx) used[i] = 0;
    }
  };
  dfs(0);
  ctx.leavesLeft -= leaves;
  return best;
}

// Plan for `hand` plus one extra card (appended last), searched locally around
// `base` (the plan for `hand` alone): keep the base melds and either hold or
// lay off the new card, or swap in one meld that uses it.
function planWithExtra(ctx: AiCtx, hand: RummyCard[], base: Plan): Plan | null {
  const n = hand.length - 1;
  const jokers = hand.filter((c) => c.joker).length;
  let best = planLeaf(ctx, hand, null, base.chosen);
  for (const cd of meldCandidates(hand, n)) {
    const kept = base.chosen.filter((b) => !b.idx.some((i) => cd.idx.includes(i)));
    let jk = cd.jokers;
    const fit = kept.filter((b) => (jk + b.jokers <= jokers ? ((jk += b.jokers), true) : false));
    const p = planLeaf(ctx, hand, null, [...fit, cd]);
    if (p && (!best || p.value > best.value)) best = p;
  }
  return best;
}

// Discards ranked best-first: keep the most promising hand, avoid feeding
// opponents. handValue(rest - d) is computed incrementally: removing d only
// changes the chances of cards that could combine with it.
function rankDiscards(ctx: AiCtx, rest: RummyCard[], tbl: MeldInfo[], avoidId: number | null): { card: RummyCard; score: number }[] {
  const n = rest.length;
  const jokers = loadHand(rest);
  const view = tableView(tbl);
  for (let i = 0; i < n; i++) PROB[i] = rest[i].joker ? 0 : meldChance(ctx, rest[i], view);
  const anyNatural = rest.some((c) => !c.joker && c.id !== avoidId);
  const out: { card: RummyCard; score: number }[] = [];
  for (let d = 0; d < n; d++) {
    const card = rest[d];
    if (anyNatural ? card.joker || card.id === avoidId : false) continue;
    PROB2.set(PROB.subarray(0, n));
    let jokersLeft = jokers;
    if (card.joker) jokersLeft--;
    else {
      shiftCard(card, -1);
      for (let i = 0; i < n; i++) if (i !== d && !rest[i].joker && related(rest[i], card)) PROB2[i] = meldChance(ctx, rest[i], view);
      shiftCard(card, +1);
    }
    const jokerP = jokersLeft ? applyJokers(ctx, rest, PROB2, jokersLeft, d, tbl.length) : 0;
    out.push({ card, score: sumValue(rest, PROB2, jokerP, d) - ctx.lv.feedWeight * feedRisk(ctx, card) });
  }
  return out.sort((a, b) => b.score - a.score);
}

// Value of a whole turn after drawing: the plan's banked points plus the best
// discard (or the go-out bonus when at most one card is left).
function planValue(ctx: AiCtx, plan: Plan): number {
  if (plan.rest.length <= 1) return plan.value;
  return plan.banked + rankDiscards(ctx, plan.rest, plan.tbl, null)[0].score;
}

const handPoints = (cards: RummyCard[]): number => cards.reduce((a, c) => a + cardValue(c), 0);

const planUses = (plan: Plan, id: number): boolean =>
  plan.melds.some((m) => m.some((c) => c.id === id)) || plan.layoffs.some((l) => l.card.id === id);

// ---------- draw decision ----------

// Does a drawn natural card interact with the hand or table at all (same rank,
// a nearby card of its suit, a layoff or a table run within reach)?
function relatedCard(hand: RummyCard[], key: number, view: TableView): boolean {
  const s = key >> 4, r = key & 15;
  if ((view.lay[s] >> r) & 1) return true;
  const near = (x: number, y: number) => Math.abs(x - y) <= 2 || (x === 14 && y <= 3) || (y === 14 && x <= 3);
  for (let t = Math.max(1, r - 2); t <= Math.min(14, r + 2); t++) if (view.anchors[s] & (1 << t)) return true;
  if (r === 14 && view.anchors[s] & 0b1110) return true; // ace low next to a 2-3 run
  let jokers = 0;
  for (const c of hand) {
    if (c.joker) { jokers++; continue; }
    if (c.rank === r || (SUIT_IDX[c.suit] === s && near(c.rank, r))) return true;
  }
  return jokers >= 2;
}

// Expected turn value of drawing an unseen stock card: every live card is
// equally likely. Each outcome is planned locally around the plan for the
// current hand (a full search for a drawn joker, which reshapes everything).
// A card unrelated to the hand changes nothing else: we either throw it
// straight back or keep it and make the base plan's best discard.
function stockValue(ctx: AiCtx, hand: RummyCard[]): number {
  const base = planTurn(ctx, hand, null, PLAY_LEAVES);
  if (!base) return -Infinity;
  const view = tableView(ctx.table);
  const keepRest = base.rest.length ? handValue(ctx, base.rest, base.tbl) : 0;
  const baseDiscard = base.rest.length ? rankDiscards(ctx, base.rest, base.tbl, null)[0].score : 0;
  let sum = 0;
  for (let k = 0; k < 64; k++) {
    if (ctx.live[k] <= 0) continue;
    const card: RummyCard = { id: -1000 - k, rank: k & 15, suit: SUITS[k >> 4] };
    let v: number;
    if (relatedCard(hand, k, view)) {
      const p = planWithExtra(ctx, [...hand, card], base);
      if (!p) continue;
      v = planValue(ctx, p);
    } else if (!base.rest.length) {
      v = base.banked + ctx.goOutBonus; // everything else melds: discard it and go out
    } else {
      const solo = handValue(ctx, [card], base.tbl);
      v = base.banked + Math.max(keepRest - ctx.lv.feedWeight * feedRisk(ctx, card), baseDiscard + solo);
    }
    sum += ctx.live[k] * v;
  }
  if (ctx.liveJokers > 0) {
    const p = planTurn(ctx, [...hand, { id: -2000, rank: 0, suit: "S", joker: true }], null, DEEP_LEAVES);
    if (p) sum += ctx.liveJokers * planValue(ctx, p);
  }
  return sum / ctx.unknown;
}

function chooseDraw(ctx: AiCtx): RummyMove {
  const { state, seat } = ctx;
  const hand = state.hands[seat];
  const pile = state.discard;
  let bestMove: RummyMove | null = null;
  let bestValue = -Infinity;
  const consider = (move: RummyMove, value: number) => { if (value > bestValue) { bestValue = value; bestMove = move; } };

  if (state.stock.length > 0) consider({ type: "drawStock", seat }, stockValue(ctx, hand));
  if (pile.length > 0) {
    // Top card: only worth taking when it goes straight onto the table.
    const top = pile[pile.length - 1];
    const tp = planTurn(ctx, [...hand, top], null, PLAY_LEAVES);
    if (tp && (planUses(tp, top.id) || state.stock.length === 0)) consider({ type: "drawDiscard", seat, cardId: top.id }, planValue(ctx, tp));
    // Deeper (as far as this level looks): the bottom card taken must be
    // melded or laid off this turn.
    for (let i = Math.max(0, pile.length - ctx.lv.pickupDepth); i < pile.length - 1; i++) {
      const target = pile[i];
      const move: RummyMove = { type: "drawDiscard", seat, cardId: target.id };
      if (!isLegal(state, move)) continue;
      const dp = planTurn(ctx, [...hand, ...pile.slice(i)], target.id, DEEP_LEAVES);
      if (dp) consider(move, planValue(ctx, dp));
    }
  }
  return bestMove ?? { type: "drawStock", seat };
}

// ---------- play phase ----------

// The single-card take from the pile this turn, if any (never thrown straight back).
function takenTopThisTurn(state: RummyState, seat: number): number | null {
  for (let i = state.log.length - 1; i >= 0 && state.log[i].seat === seat; i--) {
    const e = state.log[i];
    if (e.msg === "took" && !e.extraCards?.length) return (e.cards?.[0] as unknown as RummyCard | undefined)?.id ?? null;
  }
  return null;
}

function choosePlay(ctx: AiCtx, rng: () => number): RummyMove | null {
  const { state, seat } = ctx;
  const forced = state.mustMeldCardId;
  const plan = planTurn(ctx, state.hands[seat], forced, PLAY_LEAVES);
  if (!plan) return null;

  // Put the forced card down first (its own meld, its layoff, or the new meld
  // it goes onto), then the biggest melds, then layoffs onto melds already on
  // the table in plan order, which puts a card before any it makes room for
  // (layoffs onto new melds follow on the next call).
  const forcedMeld = plan.melds.find((m) => m.some((c) => c.id === forced));
  const forcedLay = plan.layoffs.find((l) => l.card.id === forced);
  if (forcedMeld) return { type: "meld", seat, cards: forcedMeld.map((c) => c.id) };
  if (forcedLay && forcedLay.meldId >= 0) return { type: "layoff", seat, meldId: forcedLay.meldId, cards: [forced!] };
  if (forcedLay) return { type: "meld", seat, cards: plan.melds[forcedLay.at - ctx.table.length].map((c) => c.id) };
  if (plan.melds.length) {
    const biggest = plan.melds.reduce((a, b) => (handPoints(b) > handPoints(a) ? b : a));
    return { type: "meld", seat, cards: biggest.map((c) => c.id) };
  }
  const lay = plan.layoffs.find((l) => l.meldId >= 0);
  if (lay) return { type: "layoff", seat, meldId: lay.meldId, cards: [lay.card.id] };
  if (forced != null || !plan.rest.length) return null;

  const ranked = rankDiscards(ctx, plan.rest, ctx.table, takenTopThisTurn(state, seat));
  let pick = ranked[0];
  if (ranked.length > 1 && rng() < ctx.lv.misplayRate) pick = ranked[1 + Math.floor(rng() * Math.min(3, ranked.length - 1))]; // a plausible slip: one of the next three
  return { type: "discard", seat, cardId: pick.card.id };
}

// Last resort when the planner has nothing legal: put a forced card down (the
// rules guarantee a way), else discard the costliest non-joker, else any legal move.
function fallbackMove(state: RummyState, seat: number): RummyMove {
  const hand = state.hands[seat];
  const legal = (m: RummyMove) => isLegal(state, m);
  if (state.turnPhase === "draw") {
    const stock: RummyMove = { type: "drawStock", seat };
    if (legal(stock)) return stock;
  } else {
    const forced = forcedMoves(state, seat);
    if (forced.length) return forced[0];
    const costly = hand.filter((c) => !c.joker).sort((a, b) => cardValue(b) - cardValue(a))[0] ?? hand[0];
    if (costly) {
      const m: RummyMove = { type: "discard", seat, cardId: costly.id };
      if (legal(m)) return m;
    }
  }
  return legalMoves(state).find(legal) ?? { type: "drawStock", seat };
}

function aiMove(state: RummyState, seat: number): RummyMove {
  const ctx = buildCtx(state, seat, aiLevel(state, seat));
  const move = state.turnPhase === "draw" ? chooseDraw(ctx) : choosePlay(ctx, aiRng(state, seat));
  return move && isLegal(state, move) ? move : fallbackMove(state, seat);
}

// ---------- pacing ----------

function pacing(s: RummyState): { kind: "auto" | "wait"; ms: number; move: RummyMove } | null {
  if (s.phase !== "handComplete") return null;
  return { kind: "wait", ms: 30000, move: { type: "advance", seat: s.turn } };
}

// ---------- the module ----------

export const rummy500Module: Game<RummyState, RummyMove, RummyConfig, RummyView> = {
  meta: { id: "rummy-500", name: "Rummy 500", supportedPlayerCounts: [2, 3, 4, 5, 6, 7, 8] },
  botStepMs: 900,
  seatCount: (config) => config.players,
  createGame,
  reseed,
  migrate,
  seatToAct,
  isLegal,
  legalMoves,
  applyMove: applyMoveWithLog,
  isOver,
  redact,
  lobbyView,
  aiMove,
  pacing,
  // no `aux`: Rummy has no non-turn side actions
  loggableHand(prev, next) {
    if (!next.lastRound || next.lastRound === prev.lastRound) return null;
    return {
      game: "rummy-500",
      target: next.target,
      lastRound: next.lastRound,
      scores: next.scores,
      gameOver: next.phase === "gameOver",
      winner: next.winner ?? null,
    };
  },
};

// Exposed for unit tests / tuning.
export const __test = { isRun, isSet, cardValue, buildDeck, orderRunCards };
