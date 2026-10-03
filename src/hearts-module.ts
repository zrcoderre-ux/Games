// hearts-module.ts — Hearts ("Black Lady") as a pure Game module.
//
// Pure and runtime-independent (imports only Suit/SUITS from engine.ts and the
// Game contract): no PartyServer, no I/O, randomness only via a seeded PRNG
// threaded through state.seed, so it is deterministic, testable, and reusable
// on the client for single-player. Same shape as rummy-module.ts.
//
// SCOPE of this first cut (all are clean extension points, noted inline):
//   - 3, 4, or 5 players, single 52-card deck with the standard even-deal
//     trims: 4p uses all 52 (13 each); 3p removes 2D (17 each); 5p removes 2D
//     and 2C (10 each).
//   - The 3-card pass rotates each hand and every Nth hand is a "hold" (no pass).
//   - Scoring: each heart = 1, the Q(S) ("the Black Lady") = 13 — 26 points per
//     hand. Shooting the moon (one seat takes all 26) scores that seat 0 and
//     adds 26 to everyone else. Game ends when a seat reaches `target` (default
//     100); LOWEST total wins.
//   - Hearts "break" (become legal to lead) once a heart has been played to a
//     trick. The Q(S) does not break hearts (a common house rule that does; it
//     would be a one-line change in applyMove).
//   - No points may be played on the first trick unless a seat is void in the
//     led suit and holds nothing but point cards.
//
// A HAND has two phases: `passing` then `playing`. Passing is modeled as one
// move per seat (seatToAct walks the un-passed seats) so bots get scheduled by
// the room server exactly like any other turn; nobody's selection is revealed
// until all seats have chosen and the pass resolves simultaneously. (A truly
// simultaneous "ready/reveal" pass would need server support for collecting a
// move from every seat at once; serializing it keeps the single-actor contract
// honest and is invisible against bots, who fill any empty seat.)

import { SUITS, type Suit } from "./engine.ts";
import type { Game, RoomMeta, LogEntry, LogCard } from "./game.ts";

// ---------- cards ----------
// Every card carries a unique id so the trick log, the pass selection, and the
// per-seat hand are all unambiguous to reference by id over the wire.

export type HeartsCard = { id: number; rank: number; suit: Suit }; // rank 2..14, A = 14

const QUEEN = 12; // Q(S) is the Black Lady
const isQueenOfSpades = (c: HeartsCard): boolean => c.suit === "S" && c.rank === QUEEN;
const isHeart = (c: HeartsCard): boolean => c.suit === "H";
const isPoint = (c: HeartsCard): boolean => isHeart(c) || isQueenOfSpades(c);
const cardPoints = (c: HeartsCard): number => (isQueenOfSpades(c) ? 13 : isHeart(c) ? 1 : 0);

// Cards removed for a clean even deal, by player count.
function removedFor(players: number): { rank: number; suit: Suit }[] {
  if (players === 3) return [{ rank: 2, suit: "D" }];
  if (players === 5) return [{ rank: 2, suit: "D" }, { rank: 2, suit: "C" }];
  return []; // 4 players: full deck
}

function buildDeck(players: number): HeartsCard[] {
  const removed = removedFor(players);
  const isRemoved = (rank: number, suit: Suit) => removed.some((r) => r.rank === rank && r.suit === suit);
  const deck: HeartsCard[] = [];
  let id = 0;
  for (const suit of SUITS)
    for (let rank = 2; rank <= 14; rank++) {
      if (isRemoved(rank, suit)) continue;
      deck.push({ id: id++, rank, suit });
    }
  return deck;
}

const handSize = (players: number): number => buildDeck(players).length / players;

// ---------- move log ----------
// Same pattern as hlj-module / rummy-module: append entries (with monotonic
// ids) at the module boundary; the log lives in state so it persists across
// hibernation and is identical for every client.
const LOG_CAP = 120;
const lc = (c: HeartsCard): LogCard => ({ rank: c.rank, suit: c.suit });

function passDirLabel(offset: number, players: number): string {
  if (offset === 0) return "hold \u2014 no pass";
  if (offset === 1) return "passing left";
  if (offset === players - 1) return "passing right";
  return "passing across";
}

// Append entries to `prev`'s log, returning `next` carrying the extended log.
function attach(next: HeartsState, prev: HeartsState, parts: Omit<LogEntry, "id">[]): HeartsState {
  if (parts.length === 0) return { ...next, log: prev.log, logSeq: prev.logSeq };
  let seq = prev.logSeq;
  const added = parts.map((p) => ({ id: ++seq, ...p }));
  const log = [...prev.log, ...added].slice(-LOG_CAP);
  return { ...next, log, logSeq: seq };
}

// ---------- seeded PRNG (mulberry32) ----------
// (Duplicated from the HLJ engine / rummy module for now; a shared rng.ts would
// dedupe it across all three games.)

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

// ---------- state, moves, config, view ----------

export type TrickPlay = { seat: number; card: HeartsCard };
export type CompletedTrick = { cards: TrickPlay[]; winner: number };

export type HeartsState = {
  players: number;
  target: number; // points that ends the game (lowest total wins)
  seed: number;
  phase: "passing" | "playing" | "trickComplete" | "gameOver";

  handNo: number; // 0-based; drives the pass direction
  passOffset: number; // pass to (seat + passOffset) % players; 0 = hold (no pass)

  hands: HeartsCard[][]; // private per seat

  // passing phase
  selected: (number[] | null)[]; // per seat: the 3 chosen card ids, or null until chosen

  // playing phase
  leader: number; // seat that leads the current trick
  currentTrick: TrickPlay[]; // cards played to the trick in progress
  lastTrick: CompletedTrick | null; // the just-finished trick, kept for display
  trickWinner: number | null; // winner of currentTrick during trickComplete gate
  heartsBroken: boolean;
  trickNo: number; // 0-based trick index within the hand
  points: number[]; // point cards captured THIS hand, per seat

  scores: number[]; // running totals across hands
  winner: number | null;
  lastHand: { delta: number[]; shooter: number | null } | null;
  dealtHands: HeartsCard[][] | null; // each seat's starting hand this round, revealed post-hand

  // authoritative, append-only move log (rides through every { ...state } spread)
  log: LogEntry[];
  logSeq: number;
};

export type HeartsMove =
  | { type: "pass"; seat: number; cards: number[] } // exactly 3 card ids from your hand
  | { type: "play"; seat: number; card: number } // one card id to the current trick
  | { type: "advance"; seat: number }; // clear the trickComplete gate; seat is the trick winner

export type HeartsConfig = { players: number; target: number };

export type HeartsView = {
  you: number | null;
  players: number;
  phase: "passing" | "playing" | "trickComplete" | "gameOver" | "lobby";
  target: number;
  seats: RoomMeta["seats"];
  hostSeat: number | null;
  botReplacement: boolean;
  disconnectedSeats: number[];

  scores: number[];
  winner: number | null;
  handNo: number;
  passOffset: number; // 0 = hold; otherwise pass left/across/etc.

  toAct: number | null;
  yourTurn: boolean;
  legalMoves: HeartsMove[]; // play moves only, on your turn (passing is client-driven)

  yourHand: HeartsCard[]; // ONLY the recipient's cards
  handCounts: number[]; // cards per seat (public)
  youPassed: boolean; // whether YOU have locked in your pass (yours only)

  leader: number;
  currentTrick: TrickPlay[]; // public
  lastTrick: CompletedTrick | null; // public
  trickWinner: number | null; // set during trickComplete gate
  heartsBroken: boolean;
  trickNo: number;
  points: number[]; // points captured this hand, per seat (public)

  lastHand: { delta: number[]; shooter: number | null } | null;
  log: LogEntry[]; // public move history, shipped to every client
};

// ---------- pass direction ----------
// Hand 0 passes one seat over; the offset grows each hand and the last hand of
// every cycle of `players` is a hold (no pass). For 4 players this gives
// left / across / right / hold, repeating.

function passOffsetFor(handNo: number, players: number): number {
  const m = handNo % players; // 0 .. players-1
  return m === players - 1 ? 0 : m + 1; // last in the cycle = hold; else 1..players-1
}

// ---------- setup / dealing ----------

// Seat holding the lowest club — they lead the first trick and are forced to
// open with it. (2C for 3p/4p; 3C for 5p, where 2C is removed.)
function lowestClubSeat(hands: HeartsCard[][]): number {
  let bestSeat = 0;
  let bestRank = Infinity;
  for (let s = 0; s < hands.length; s++)
    for (const c of hands[s]) if (c.suit === "C" && c.rank < bestRank) { bestRank = c.rank; bestSeat = s; }
  return bestSeat;
}

function dealHand(prev: HeartsState): HeartsState {
  const { shuffled, nextSeed } = shuffle(buildDeck(prev.players), prev.seed);
  const hands: HeartsCard[][] = Array.from({ length: prev.players }, () => []);
  const hs = handSize(prev.players);
  let i = 0;
  for (let k = 0; k < hs; k++) for (let s = 0; s < prev.players; s++) hands[s].push(shuffled[i++]);

  const passOffset = passOffsetFor(prev.handNo, prev.players);
  const base: HeartsState = {
    ...prev,
    seed: nextSeed,
    hands,
    dealtHands: hands.map((h) => h.slice()),
    passOffset,
    selected: Array.from({ length: prev.players }, () => null),
    currentTrick: [],
    lastTrick: null,
    heartsBroken: false,
    trickNo: 0,
    points: Array(prev.players).fill(0),
    winner: null,
    leader: 0, // real leader set when play begins (after any pass)
    phase: "passing",
  };

  // A hold hand skips passing and goes straight to play; the lowest club leads.
  if (passOffset === 0) return { ...base, phase: "playing", leader: lowestClubSeat(hands) };
  return base;
}

function createGame(config: HeartsConfig, seed: number): HeartsState {
  if (![3, 4, 5].includes(config.players)) throw new Error(`Unsupported player count: ${config.players}`);
  if (config.target <= 0) throw new Error("Target must be positive");
  const base: HeartsState = {
    players: config.players,
    target: config.target,
    seed,
    phase: "passing",
    handNo: 0,
    passOffset: 0,
    hands: [],
    selected: [],
    leader: 0,
    currentTrick: [],
    lastTrick: null,
    trickWinner: null,
    heartsBroken: false,
    trickNo: 0,
    points: Array(config.players).fill(0),
    scores: Array(config.players).fill(0),
    winner: null,
    lastHand: null,
    dealtHands: null,
    log: [],
    logSeq: 0,
  };
  const dealt = dealHand(base);
  return attach(dealt, dealt, [{ seat: null, msg: `first hand \u2014 ${passDirLabel(dealt.passOffset, dealt.players)}` }]);
}

// ---------- legality ----------

// The single source of truth for which cards `seat` may play right now. Used by
// isLegal, legalMoves, and the AI so they can never disagree.
function legalPlays(state: HeartsState, seat: number): HeartsCard[] {
  const hand = state.hands[seat];
  const firstTrick = state.trickNo === 0;
  const leading = state.currentTrick.length === 0;

  if (leading) {
    if (firstTrick) {
      // Opener must play the lowest club (they were dealt the global lowest).
      const clubs = hand.filter((c) => c.suit === "C");
      const lead = clubs.reduce((lo, c) => (c.rank < lo.rank ? c : lo), clubs[0]);
      return lead ? [lead] : hand.slice(); // hand has no club only if deck trimmed oddly — never for valid configs
    }
    if (!state.heartsBroken) {
      const nonHearts = hand.filter((c) => !isHeart(c));
      if (nonHearts.length) return nonHearts; // can't lead hearts until broken (unless that's all you hold)
    }
    return hand.slice();
  }

  // Following: must follow the led suit if able.
  const ledSuit = state.currentTrick[0].card.suit;
  const inSuit = hand.filter((c) => c.suit === ledSuit);
  let candidates = inSuit.length ? inSuit : hand.slice();

  if (firstTrick) {
    // No point cards on the opening trick unless you have nothing else.
    const nonPoints = candidates.filter((c) => !isPoint(c));
    if (nonPoints.length) candidates = nonPoints;
  }
  return candidates;
}

const seatToAct = (s: HeartsState): number | null => {
  if (s.phase === "gameOver" || s.phase === "trickComplete") return null;
  if (s.phase === "passing") {
    const idx = s.selected.findIndex((sel) => sel === null);
    return idx === -1 ? null : idx; // all passed -> resolution happens inside applyMove
  }
  return (s.leader + s.currentTrick.length) % s.players;
};

const isOver = (s: HeartsState): boolean => s.phase === "gameOver";

function isLegal(state: HeartsState, move: HeartsMove): boolean {
  if (state.phase === "gameOver") return false;

  if (move.type === "advance") return state.phase === "trickComplete";

  if (seatToAct(state) !== move.seat) return false;

  if (move.type === "pass") {
    if (state.phase !== "passing" || state.passOffset === 0) return false;
    if (state.selected[move.seat] !== null) return false;
    const ids = move.cards;
    if (!ids || ids.length !== 3 || new Set(ids).size !== 3) return false;
    const hand = state.hands[move.seat];
    return ids.every((id) => hand.some((c) => c.id === id));
  }

  // play
  if (state.phase !== "playing") return false;
  const card = state.hands[move.seat].find((c) => c.id === move.card);
  if (!card) return false;
  return legalPlays(state, move.seat).some((c) => c.id === move.card);
}

// ---------- trick / hand resolution ----------

function trickWinner(cards: TrickPlay[]): number {
  const ledSuit = cards[0].card.suit;
  let best = cards[0];
  for (const p of cards) if (p.card.suit === ledSuit && p.card.rank > best.card.rank) best = p;
  return best.seat;
}

function endHand(state: HeartsState): HeartsState {
  const points = state.points;
  const moon = points.findIndex((p) => p === 26); // took all 26: shot the moon
  const delta =
    moon >= 0 ? points.map((_, s) => (s === moon ? 0 : 26)) : points.slice();
  const scores = state.scores.map((v, s) => v + delta[s]);
  const lastHand = { delta, shooter: moon >= 0 ? moon : null };

  if (Math.max(...scores) >= state.target) {
    const min = Math.min(...scores);
    return { ...state, scores, phase: "gameOver", winner: scores.indexOf(min), lastHand }; // lowest wins
  }
  return dealHand({ ...state, scores, lastHand, handNo: state.handNo + 1 });
}

// ---------- the pure transition ----------

function applyMove(state: HeartsState, move: HeartsMove): HeartsState {
  if (state.phase === "gameOver") throw new Error("Game is over");

  // Advance clears the trickComplete gate; it is not seat-gated.
  if (move.type === "advance") {
    if (state.phase !== "trickComplete") throw new Error("Not in trickComplete phase");
    const winner = state.trickWinner!;
    const won = state.currentTrick.reduce((a, p) => a + cardPoints(p.card), 0);
    const points = state.points.map((v, s) => (s === winner ? v + won : v));
    const trickNo = state.trickNo + 1;
    const ns: HeartsState = {
      ...state,
      currentTrick: [],
      lastTrick: { cards: state.currentTrick, winner },
      leader: winner,
      trickNo,
      points,
      phase: "playing",
      trickWinner: null,
    };
    if (trickNo !== handSize(state.players)) return attach(ns, state, []);

    // Last trick of the hand — score it and log the outcome.
    const scored = endHand(ns);
    const scoreEnt: Omit<LogEntry, "id">[] = [];
    const moon = ns.points.findIndex((p) => p === 26);
    if (moon >= 0) {
      scoreEnt.push({ seat: moon, msg: "shoots the moon! — everyone else +26" });
    } else {
      const delta = scored.lastHand ? scored.lastHand.delta : ns.points;
      for (let s = 0; s < ns.players; s++) if (delta[s] > 0) scoreEnt.push({ seat: s, msg: `+${delta[s]} this hand` });
    }
    scoreEnt.push({ seat: null, msg: `scores: ${scored.scores.join(" / ")}` });
    if (scored.phase === "gameOver" && scored.winner !== null) {
      scoreEnt.push({ seat: scored.winner, msg: "wins the game — lowest score!" });
    } else {
      scoreEnt.push({ seat: null, msg: `next hand — ${passDirLabel(scored.passOffset, scored.players)}` });
    }
    return attach(scored, state, scoreEnt);
  }

  if (seatToAct(state) !== move.seat) throw new Error("Not this seat's turn");
  if (!isLegal(state, move)) throw new Error(`Illegal move: ${JSON.stringify(move)}`);

  const ent: Omit<LogEntry, "id">[] = [];

  if (move.type === "pass") {
    const selected = state.selected.map((sel, s) => (s === move.seat ? move.cards.slice() : sel));
    const everyone = selected.every((sel) => sel !== null);
    ent.push({ seat: move.seat, msg: "passed 3 cards" }); // which cards stay hidden until the exchange
    if (!everyone) return attach({ ...state, selected }, state, ent);

    // All seats chose — exchange simultaneously, then begin play.
    const offset = state.passOffset;
    const N = state.players;
    const given: HeartsCard[][] = selected.map((ids, s) => ids!.map((id) => state.hands[s].find((c) => c.id === id)!));
    const hands = state.hands.map((h, s) => h.filter((c) => !selected[s]!.includes(c.id)));
    for (let s = 0; s < N; s++) {
      const giver = (s - offset + N) % N; // whoever passes toward seat s
      hands[s].push(...given[giver]);
    }
    const leader = lowestClubSeat(hands);
    ent.push({ seat: null, msg: `cards exchanged \u2014 ${passDirLabel(offset, N)}` });
    ent.push({ seat: leader, msg: "leads with the lowest club" });
    return attach(
      { ...state, hands, selected: Array.from({ length: N }, () => null), phase: "playing", leader },
      state,
      ent,
    );
  }

  // play
  const seat = move.seat;
  const card = state.hands[seat].find((c) => c.id === move.card)!;
  const hands = state.hands.map((h, s) => (s === seat ? h.filter((c) => c.id !== move.card) : h));
  const currentTrick = [...state.currentTrick, { seat, card }];
  const heartsBroken = state.heartsBroken || isHeart(card);
  ent.push({ seat, msg: "played", cards: [lc(card)] });
  if (!state.heartsBroken && isHeart(card)) ent.push({ seat: null, msg: "hearts are broken" });

  // Trick still in progress.
  if (currentTrick.length < state.players) {
    return attach({ ...state, hands, currentTrick, heartsBroken }, state, ent);
  }

 // Trick complete — gate on trickComplete so players can read the cards before they're swept.
  const winner = trickWinner(currentTrick);
  const won = currentTrick.reduce((a, p) => a + cardPoints(p.card), 0);
  ent.push({ seat: winner, msg: "takes the trick", tail: won > 0 ? `+${won}` : undefined });
  const ns: HeartsState = {
    ...state,
    hands,
    heartsBroken,
    currentTrick,
    phase: "trickComplete",
    trickWinner: winner,
  };
  return attach(ns, state, ent);
}

// ---------- legal-move enumeration (for UI / simple bots) ----------
// Plays are a tiny set, so we enumerate them. Passing is a 3-of-hand choice
// (combinatorial) the client composes itself; the server authorizes via isLegal.

function legalMoves(state: HeartsState): HeartsMove[] {
  if (state.phase !== "playing") return [];
  const seat = seatToAct(state);
  if (seat === null) return [];
  return legalPlays(state, seat).map((c) => ({ type: "play", seat, card: c.id }));
}

// ---------- redaction ----------

function redact(state: HeartsState, seat: number | null, meta: RoomMeta): HeartsView {
  const toAct = seatToAct(state);
  const yours = seat !== null && toAct === seat;
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
    handNo: state.handNo,
    passOffset: state.passOffset,
    toAct,
    yourTurn: yours,
    legalMoves: yours && state.phase === "playing" ? legalMoves(state) : [],
    yourHand: seat !== null && state.hands[seat] ? state.hands[seat] : [],
    handCounts: state.hands.map((h) => h.length),
    youPassed: seat !== null && state.selected[seat] != null,
    leader: state.leader,
    currentTrick: state.currentTrick,
    lastTrick: state.lastTrick,
    trickWinner: state.trickWinner,
    heartsBroken: state.heartsBroken,
    trickNo: state.trickNo,
    points: state.points,
    lastHand: state.lastHand,
    log: state.log,
  };
}

function lobbyView(config: HeartsConfig, seat: number | null, meta: RoomMeta): HeartsView {
  return {
    you: seat,
    players: config.players,
    phase: "lobby",
    target: config.target,
    seats: meta.seats,
    hostSeat: meta.hostSeat,
    botReplacement: meta.botReplacement,
    disconnectedSeats: meta.disconnectedSeats,
    scores: Array(config.players).fill(0),
    winner: null,
    handNo: 0,
    passOffset: 0,
    toAct: null,
    yourTurn: false,
    legalMoves: [],
    yourHand: [],
    handCounts: Array(config.players).fill(0),
    youPassed: false,
    leader: 0,
    currentTrick: [],
    lastTrick: null,
    trickWinner: null,
    heartsBroken: false,
    trickNo: 0,
    points: Array(config.players).fill(0),
    lastHand: null,
    log: [],
  };
}

// ---------- AI ----------
// The bot reads only what a human in its seat could know: its own hand, the
// hand it was dealt (so it knows which cards it passed, and to whom), and public
// information — every card played this hand (rebuilt from the move log), the
// trick in progress, points taken, hand sizes, and whether hearts are broken.
// From the played cards it infers which seats have shown out of which suits.
//
// Play is a determinized Monte-Carlo search (aiPlay): deal the cards this seat
// cannot see among the other seats in many ways consistent with what it knows,
// try every distinct legal card in each deal, finish the hand with a fast
// heuristic policy for every seat (HandSim), and keep the card that costs the
// fewest points on average. Passing (aiPass) works the same way over whole
// hands: it tries the likely 3-card sets against random deals. Cards are 13-bit
// masks per suit (bit rank-2), so a rollout costs about a microsecond; the work
// per decision is capped so each aiMove fits the bot CPU budget. Randomness
// comes only from a PRNG seeded from the state, so the same state always yields
// the same move.

// Suit indexes follow SUITS (C, D, H, S).
const CLUBS = 0, DIAMONDS = 1, HEARTS = 2, SPADES = 3;
const NON_HEARTS = [CLUBS, DIAMONDS, SPADES];
const SUIT_INDEX: Record<Suit, number> = { C: 0, D: 1, H: 2, S: 3 };
const Q_BIT = 1 << (QUEEN - 2); // the Black Lady within the spade mask
const AK_BITS = (1 << 11) | (1 << 12); // K and A of a suit
const ALL_RANKS = (1 << 13) - 1;

const bitOf = (c: HeartsCard): number => 1 << (c.rank - 2);
const lowest = (m: number): number => m & -m;
const highest = (m: number): number => 1 << (31 - Math.clz32(m));
const bitsAbove = (b: number): number => ALL_RANKS & ~(b * 2 - 1);
function bitCount(m: number): number {
  m -= (m >>> 1) & 0x55555555;
  m = (m & 0x33333333) + ((m >>> 2) & 0x33333333);
  return (((m + (m >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}
// A card packed as suit << 4 | (rank - 2), the rollout's move currency.
const pack = (suit: number, bit: number): number => (suit << 4) | (31 - Math.clz32(bit));

// ---------- what one seat knows ----------

type SeatView = {
  N: number;
  seat: number;
  hand: number[]; // [suit] this seat's cards
  unseen: number[]; // [suit] cards still in other seats' hands
  known: number[]; // [seat * 4 + suit] cards known to be in that seat's hand (ones we passed there)
  ban: number[]; // [seat * 4 + suit] cards the seat cannot hold (suits it has shown out of)
  counts: number[]; // [seat] cards left in hand (public)
};

// Rebuild the seat's knowledge. Returns null only if the log no longer holds
// every card played this hand (it always does: a hand logs < LOG_CAP entries).
function readSeatView(state: HeartsState, seat: number): SeatView | null {
  const N = state.players;
  const hand = [0, 0, 0, 0];
  for (const c of state.hands[seat]) hand[SUIT_INDEX[c.suit]] |= bitOf(c);
  const unseen = [ALL_RANKS, ALL_RANKS, ALL_RANKS, ALL_RANKS];
  for (const r of removedFor(N)) unseen[SUIT_INDEX[r.suit]] &= ~(1 << (r.rank - 2));
  for (let u = 0; u < 4; u++) unseen[u] &= ~hand[u];
  const ban: number[] = Array(N * 4).fill(0);
  const known: number[] = Array(N * 4).fill(0);

  // Every card played this hand, oldest first: the newest "played" log entries.
  const want = state.phase === "passing" ? 0 : state.trickNo * N + state.currentTrick.length;
  const plays: { seat: number; suit: number; bit: number; points: boolean }[] = [];
  for (let i = state.log.length - 1; i >= 0 && plays.length < want; i--) {
    const e = state.log[i];
    const c = e.cards?.[0];
    if (e.msg !== "played" || e.seat === null || !c || "joker" in c) continue;
    plays.push({ seat: e.seat, suit: SUIT_INDEX[c.suit as Suit], bit: 1 << (c.rank - 2), points: c.suit === "H" || (c.suit === "S" && c.rank === QUEEN) });
  }
  if (plays.length < want) return null;
  plays.reverse();

  // Shown voids: not following the led suit; leading a heart before they are
  // broken (only hearts left); dumping points on the first trick (only points left).
  const mine = [0, 0, 0, 0];
  let broken = false;
  for (let i = 0; i < plays.length; i++) {
    const p = plays[i];
    const lead = plays[i - (i % N)];
    const o = p.seat * 4;
    unseen[p.suit] &= ~p.bit;
    if (p.seat === seat) mine[p.suit] |= p.bit;
    if (i % N === 0) {
      if (p.suit === HEARTS && !broken) for (const u of NON_HEARTS) ban[o + u] = ALL_RANKS;
    } else if (p.suit !== lead.suit) {
      ban[o + lead.suit] = ALL_RANKS;
      if (i < N && p.points) {
        ban[o + DIAMONDS] = ALL_RANKS;
        if (p.suit === SPADES) ban[o + SPADES] = ALL_RANKS; // the Q(S) went, hearts are all that's left
      }
    }
    if (p.suit === HEARTS) broken = true;
  }

  // The cards we passed sit in the receiver's hand until they show up in a trick.
  if (state.phase !== "passing" && state.passOffset !== 0 && state.dealtHands) {
    const to = (seat + state.passOffset) % N;
    for (const c of state.dealtHands[seat]) {
      const u = SUIT_INDEX[c.suit], b = bitOf(c);
      if (!(hand[u] & b) && !(mine[u] & b)) known[to * 4 + u] |= b & unseen[u];
    }
  }
  return { N, seat, hand, unseen, known, ban, counts: state.hands.map((h) => h.length) };
}

// Deals the cards this seat cannot see to the other seats (into
// world[seat * 4 + suit]), once per sampled world of a decision. It honours
// known cards, hand sizes, and the suits each seat has shown out of: cards that
// fewer seats can hold are placed first (shuffled within each such group) and
// each lands on an eligible seat weighted by its open slots. After a few dead
// ends (rare) a card with no eligible seat left goes to any seat with room.
class Dealer {
  private readonly v: SeatView;
  private readonly cards: number[] = []; // packed card | (mask of seats that may hold it) << 8
  private readonly groups: number[] = [0]; // bounds of the runs of equally constrained cards
  private readonly need0: number[]; // open slots per seat once known cards are placed
  private readonly need: number[];
  private readonly others: number; // mask of the seats being dealt to

  constructor(v: SeatView) {
    const { N, seat } = v;
    this.v = v;
    this.need0 = v.counts.map((n, s) => {
      for (let u = 0; u < 4; u++) n -= bitCount(v.known[s * 4 + u]);
      return s === seat ? 0 : n;
    });
    this.need = this.need0.slice();
    let others = 0;
    for (let s = 0; s < N; s++) if (this.need0[s] > 0) others |= 1 << s;
    this.others = others;
    const byEligible: number[][] = Array.from({ length: N + 1 }, () => []);
    for (let u = 0; u < 4; u++) {
      let free = v.unseen[u];
      for (let s = 0; s < N; s++) free &= ~v.known[s * 4 + u];
      for (let m = free; m; m &= m - 1) {
        const b = lowest(m);
        let mask = 0;
        for (let s = 0; s < N; s++) if (others & (1 << s) && !(v.ban[s * 4 + u] & b)) mask |= 1 << s;
        byEligible[bitCount(mask)].push(pack(u, b) | (mask << 8));
      }
    }
    for (const g of byEligible) if (g.length) { this.cards.push(...g); this.groups.push(this.cards.length); }
  }

  deal(rng: () => number, world: Int32Array): void {
    const { v, cards, need } = this;
    for (let attempt = 0; ; attempt++) {
      const strict = attempt < 6;
      for (let s = 0; s < v.N; s++) {
        need[s] = this.need0[s];
        for (let u = 0; u < 4; u++) world[s * 4 + u] = s === v.seat ? v.hand[u] : v.known[s * 4 + u];
      }
      for (let g = 1; g < this.groups.length; g++) {
        for (let i = this.groups[g] - 1; i > this.groups[g - 1]; i--) {
          const j = this.groups[g - 1] + Math.floor(rng() * (i - this.groups[g - 1] + 1));
          const t = cards[i]; cards[i] = cards[j]; cards[j] = t;
        }
      }
      let ok = true;
      for (const c of cards) {
        let mask = c >> 8, total = 0;
        for (let s = 0; s < v.N; s++) if (mask & (1 << s)) total += need[s];
        if (total === 0 && strict) { ok = false; break; }
        if (total === 0) {
          mask = this.others;
          for (let s = 0; s < v.N; s++) if (mask & (1 << s)) total += need[s];
        }
        let r = rng() * total, to = -1;
        for (let s = 0; s < v.N; s++) {
          if (mask & (1 << s) && need[s] > 0) { to = s; r -= need[s]; if (r < 0) break; }
        }
        world[to * 4 + ((c >> 4) & 3)] |= 1 << (c & 15);
        need[to]--;
      }
      if (ok) return;
    }
  }
}

// ---------- rollout simulator ----------
// One hand from the current position on, every seat played by the heuristic
// policy below (which, like a real player, looks only at its own hand and the
// cards already played). Mutable and reused across rollouts of one decision.

class HandSim {
  readonly N: number;
  readonly tricks: number;
  readonly hand: Int32Array; // [seat * 4 + suit]
  readonly out = new Int32Array(4); // [suit] cards not yet played (all hands)
  readonly pts: Int32Array; // points taken this hand
  broken = false;
  trickNo = 0;
  leader = 0;
  len = 0; // cards in the trick in progress
  led = 0; // its suit
  winBit = 0; // its winning card's bit, and seat
  winSeat = 0;
  trickPts = 0;

  constructor(N: number) {
    this.N = N;
    this.tricks = handSize(N);
    this.hand = new Int32Array(N * 4);
    this.pts = new Int32Array(N);
  }

  // Start from `root` (a HandSim holding the real position) with `world`'s hands.
  load(root: HandSim, world: Int32Array): void {
    this.hand.set(world);
    this.out.set(root.out);
    this.pts.set(root.pts);
    this.broken = root.broken; this.trickNo = root.trickNo; this.leader = root.leader;
    this.len = root.len; this.led = root.led; this.winBit = root.winBit; this.winSeat = root.winSeat;
    this.trickPts = root.trickPts;
  }

  play(seat: number, suit: number, bit: number): void {
    this.hand[seat * 4 + suit] &= ~bit;
    this.out[suit] &= ~bit;
    if (this.len === 0) { this.led = suit; this.winBit = bit; this.winSeat = seat; this.trickPts = 0; }
    else if (suit === this.led && bit > this.winBit) { this.winBit = bit; this.winSeat = seat; }
    if (suit === HEARTS) { this.trickPts++; this.broken = true; }
    else if (suit === SPADES && bit === Q_BIT) this.trickPts += 13;
    if (++this.len === this.N) {
      this.pts[this.winSeat] += this.trickPts;
      this.leader = this.winSeat;
      this.len = 0;
      this.trickNo++;
    }
  }

  toAct(): number { return (this.leader + this.len) % this.N; }

  // Play the hand out with the policy, stopping once every point card has been
  // taken (the tricks after that can't change the score).
  finish(): void {
    while (this.len > 0 || (this.trickNo < this.tricks && (this.out[HEARTS] | (this.out[SPADES] & Q_BIT)))) {
      const seat = this.toAct();
      const c = this.pick(seat);
      this.play(seat, c >> 4, 1 << (c & 15));
    }
  }

  // Final points for `seat`, moon-adjusted (a shooter takes 0, everyone else 26).
  score(seat: number): number {
    for (let s = 0; s < this.N; s++) if (this.pts[s] === 26) return s === seat ? 0 : 26;
    return this.pts[seat];
  }

  // The rollout policy: a packed legal card for `seat`.
  pick(seat: number): number {
    if (this.len === 0) return this.pickLead(seat);
    const mine = this.hand[seat * 4 + this.led];
    return mine ? this.pickFollow(this.led, mine) : this.pickDiscard(seat);
  }

  // Lead the suit whose lowest card is least likely to win the trick; fish for
  // the Queen with spades below her when we can't be the one to catch her.
  private pickLead(seat: number): number {
    const o = seat * 4, H = this.hand;
    if (this.trickNo === 0 && H[o + CLUBS]) return pack(CLUBS, lowest(H[o + CLUBS])); // opener's lowest club
    const qOut = (this.out[SPADES] & Q_BIT) !== 0;
    const holdQ = (H[o + SPADES] & Q_BIT) !== 0;
    const onlyHearts = !(H[o + CLUBS] | H[o + DIAMONDS] | H[o + SPADES]);
    let best = -1, bestScore = Infinity;
    for (let u = 0; u < 4; u++) {
      const m = H[o + u];
      if (!m || (u === HEARTS && !this.broken && !onlyHearts)) continue;
      const others = this.out[u] & ~m;
      let b = lowest(m);
      let score = 0;
      if (u === SPADES && qOut) {
        if (holdQ) score += 1;
        else if (m & AK_BITS) score += 0.5;
        else { b = highest(m); score -= 1; } // all our spades are below her: flush her out
      }
      const overs = bitCount(others & bitsAbove(b));
      const unders = bitCount(others & (b - 1));
      score += overs === 0 ? (others ? 1 : 4) : unders / (overs + unders);
      if (u === HEARTS) score += 0.1;
      score += bitCount(m) * 0.25; // prefer emptying short suits
      if (score < bestScore) { bestScore = score; best = pack(u, b); }
    }
    return best;
  }

  // Following suit: drop the Queen under a played A/K; otherwise duck with our
  // highest card under the winner, or unload the top card on a clean trick we
  // close.
  private pickFollow(led: number, mine: number): number {
    const w = this.winBit;
    if (led === SPADES && (mine & Q_BIT) && w > Q_BIT) return pack(SPADES, Q_BIT);
    const last = this.len === this.N - 1;
    const below = mine & (w - 1);
    if (below) {
      const top = mine & ~below & ~Q_BIT;
      if (last && this.trickPts === 0 && led !== HEARTS && top) return pack(led, highest(top));
      return pack(led, highest(below));
    }
    // Forced over: if we're last, or the trick looks clean (no points yet, no
    // Queen to catch, enough cards out for everyone behind us to follow), we win
    // it with our top card; otherwise go over as low as we can.
    const safe = mine & ~Q_BIT || mine;
    const clean = this.trickPts === 0 && led !== HEARTS && (led !== SPADES || !(this.out[SPADES] & Q_BIT))
      && bitCount(this.out[led] & ~mine) >= 2 * (this.N - 1 - this.len);
    return pack(led, last || clean ? highest(safe) : lowest(safe));
  }

  // Void in the led suit: Queen first, then A/K of spades while she is out, then
  // the highest heart, then the highest card left (shorter suit on ties).
  private pickDiscard(seat: number): number {
    const o = seat * 4, H = this.hand;
    const qOut = (this.out[SPADES] & Q_BIT) !== 0;
    const spades = H[o + SPADES];
    const firstTrick = this.trickNo === 0 && (H[o + DIAMONDS] | (spades & ~Q_BIT)) !== 0; // no points allowed
    if (!firstTrick) {
      if (spades & Q_BIT) return pack(SPADES, Q_BIT);
      if (qOut && spades & AK_BITS) return pack(SPADES, highest(spades & AK_BITS));
      if (H[o + HEARTS]) return pack(HEARTS, highest(H[o + HEARTS]));
    } else if (qOut && spades & AK_BITS) return pack(SPADES, highest(spades & AK_BITS));
    let best = -1, bestKey = -Infinity;
    for (const u of NON_HEARTS) {
      const m = u === SPADES ? spades & ~Q_BIT : H[o + u];
      if (!m) continue;
      const key = highest(m) * 16 - bitCount(m);
      if (key > bestKey) { bestKey = key; best = pack(u, highest(m)); }
    }
    return best >= 0 ? best : pack(HEARTS, highest(H[o + HEARTS])); // first trick, only points
  }
}

// The real position as a HandSim: our own hand, the other hands empty (they
// are filled per sampled world).
function rootSim(state: HeartsState, v: SeatView): HandSim {
  const root = new HandSim(state.players);
  for (let u = 0; u < 4; u++) root.out[u] = v.unseen[u] | v.hand[u];
  for (let u = 0; u < 4; u++) root.hand[v.seat * 4 + u] = v.hand[u];
  root.pts.set(state.points);
  root.broken = state.heartsBroken;
  root.trickNo = state.trickNo;
  root.leader = state.leader;
  // Replay the trick in progress onto empty hands (play() only clears bits).
  for (const p of state.currentTrick) root.play(p.seat, SUIT_INDEX[p.card.suit], bitOf(p.card));
  return root;
}

// ---------- passing ----------
// passOrder ranks a hand by how eager we are to pass each card: the Queen and
// A/K of spades first unless four spades below her can hide them, then high
// hearts and high minors (shorter minors first, toward a void); low spades are
// protection and come last. aiPass tries every 3-card set drawn from the top
// PASS_POOL cards over the same deals (the cards we can't see dealt at random,
// every other seat passing its own top three, the whole hand played out by the
// rollout policy), gives the most promising sets more deals, and passes the
// set that costs the fewest points on average.

function passOrder(hand: HeartsCard[]): HeartsCard[] {
  const length = [0, 0, 0, 0];
  let lowSpades = 0;
  for (const c of hand) {
    length[SUIT_INDEX[c.suit]]++;
    if (c.suit === "S" && c.rank < QUEEN) lowSpades++;
  }
  const shortSpades = lowSpades < 4;
  const eagerness = (c: HeartsCard): number => {
    if (c.suit === "S") {
      if (shortSpades && isQueenOfSpades(c)) return 1000;
      if (c.rank > QUEEN) return shortSpades ? 500 + c.rank : c.rank - 10;
      return c.rank - 20;
    }
    if (isHeart(c)) return c.rank + 1;
    return c.rank + 2 * (4 - length[SUIT_INDEX[c.suit]]);
  };
  return hand.map((c) => ({ c, e: eagerness(c) })).sort((a, b) => b.e - a.e).map((x) => x.c);
}

const PASS_POOL = 7;
const PASS_DEALS = 32; // deals every set is tried on,
const PASS_KEEP = 8; // after which the best this many sets
const PASS_MORE = 64; // get this many more

function aiPass(state: HeartsState, seat: number): HeartsMove {
  const N = state.players;
  const offset = state.passOffset;
  const pool = passOrder(state.hands[seat]).slice(0, PASS_POOL);
  const sets: HeartsCard[][] = []; // sets[0] is the plain top three
  for (let i = 0; i < pool.length; i++)
    for (let j = i + 1; j < pool.length; j++)
      for (let k = j + 1; k < pool.length; k++) sets.push([pool[i], pool[j], pool[k]]);

  const mine = new Set(state.hands[seat].map((c) => c.id));
  const unseen = buildDeck(N).filter((c) => !mine.has(c.id));
  const rng = mulberry32((state.seed ^ Math.imul(state.handNo + 1, 0x9e3779b1) ^ Math.imul(seat + 1, 0x85ebca6b)) >>> 0);
  const root = new HandSim(N);
  for (const c of buildDeck(N)) root.out[SUIT_INDEX[c.suit]] |= bitOf(c);
  const sim = new HandSim(N);
  const world = new Int32Array(N * 4);
  const give = (w: Int32Array, from: number, to: number, cards: HeartsCard[]) => {
    for (const c of cards) {
      const u = SUIT_INDEX[c.suit];
      if (from >= 0) w[from * 4 + u] &= ~bitOf(c);
      w[to * 4 + u] |= bitOf(c);
    }
  };
  const lowClub = (w: Int32Array, s: number) => lowest(w[s * 4 + CLUBS]) || 1 << 13;
  const total = new Float64Array(sets.length);
  const hs = handSize(N);
  let alive = sets.map((_, i) => i);
  for (let d = 0; d < PASS_DEALS + PASS_MORE; d++) {
    if (d === PASS_DEALS) alive = alive.sort((a, b) => total[a] - total[b] || a - b).slice(0, PASS_KEEP);
    // Deal the unseen cards, then let every other seat pass its own top three.
    for (let i = unseen.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [unseen[i], unseen[j]] = [unseen[j], unseen[i]];
    }
    world.fill(0);
    give(world, -1, seat, state.hands[seat]);
    let next = 0;
    const passes: HeartsCard[][] = [];
    for (let s = 0; s < N; s++) {
      if (s === seat) continue;
      const hand = unseen.slice(next, (next += hs));
      give(world, -1, s, hand);
      passes[s] = passOrder(hand).slice(0, 3);
    }
    for (let s = 0; s < N; s++) if (s !== seat) give(world, s, (s + offset) % N, passes[s]);
    for (const i of alive) {
      sim.load(root, world);
      give(sim.hand, seat, (seat + offset) % N, sets[i]);
      // The lowest club leads the first trick.
      let lead = 0;
      for (let s = 1; s < N; s++) if (lowClub(sim.hand, s) < lowClub(sim.hand, lead)) lead = s;
      sim.leader = lead;
      sim.finish();
      total[i] += sim.score(seat);
    }
  }
  let best = alive[0];
  for (const i of alive) if (total[i] < total[best] || (total[i] === total[best] && i < best)) best = i;
  return { type: "pass", seat, cards: sets[best].map((c) => c.id) };
}

// ---------- playing ----------

// Rollout work per decision, in simulated card plays, and the bounds on the
// number of deals. Sized so aiMove stays well inside the bot CPU budget (about
// 1 ms on average, a few ms at worst).
const PLAY_BUDGET = 120000;
const MIN_DEALS = 12;
const MAX_DEALS = 300;

// Legal cards with interchangeable ones merged: two cards of a suit with no
// unseen card ranked between them win and lose exactly the same tricks (the
// Q(S) never merges, she carries 13 points).
function distinctPlays(legal: HeartsCard[], v: SeatView): HeartsCard[] {
  const sorted = legal.slice().sort((a, b) => SUIT_INDEX[a.suit] - SUIT_INDEX[b.suit] || a.rank - b.rank);
  const out: HeartsCard[] = [];
  for (const c of sorted) {
    const prev = out[out.length - 1];
    if (prev && prev.suit === c.suit && !isQueenOfSpades(prev) && !isQueenOfSpades(c)) {
      const between = (bitOf(c) - 1) & ~(bitOf(prev) * 2 - 1);
      if (!(v.unseen[SUIT_INDEX[c.suit]] & between)) continue;
    }
    out.push(c);
  }
  return out;
}

function aiPlay(state: HeartsState, seat: number): HeartsMove {
  const legal = legalPlays(state, seat);
  const play = (c: HeartsCard): HeartsMove => ({ type: "play", seat, card: c.id });
  if (legal.length === 1) return play(legal[0]);
  const v = readSeatView(state, seat);
  if (!v) return play(legal[0]); // unreachable: the log always covers the hand
  const cands = distinctPlays(legal, v);
  if (cands.length === 1) return play(cands[0]);

  const N = state.players;
  const root = rootSim(state, v);
  const sim = new HandSim(N);
  const world = new Int32Array(N * 4);
  const dealer = new Dealer(v);
  const rng = mulberry32((state.seed ^ Math.imul(state.logSeq + 1, 0x9e3779b1) ^ Math.imul(seat + 1, 0x85ebca6b)) >>> 0);
  const remaining = (root.tricks - root.trickNo) * N - root.len;
  const deals = Math.max(MIN_DEALS, Math.min(MAX_DEALS, Math.floor(PLAY_BUDGET / (remaining * cands.length))));

  // The policy's own choice (it reads only our hand) breaks ties; it may be a
  // merged card, so map it to its group's representative (the lowest of it).
  const pick = root.pick(seat);
  let preferred = 0;
  cands.forEach((c, i) => { if (SUIT_INDEX[c.suit] === pick >> 4 && c.rank - 2 <= (pick & 15)) preferred = i; });
  // Every candidate is scored over the same deals, the policy playing on.
  const total = new Float64Array(cands.length);
  for (let d = 0; d < deals; d++) {
    dealer.deal(rng, world);
    for (let i = 0; i < cands.length; i++) {
      const c = cands[i];
      sim.load(root, world);
      sim.play(seat, SUIT_INDEX[c.suit], bitOf(c));
      sim.finish();
      total[i] += sim.score(seat);
    }
  }
  let best = preferred;
  for (let i = 0; i < cands.length; i++) if (total[i] < total[best] - 1e-9) best = i;
  return play(cands[best]);
}

function aiMove(state: HeartsState, seat: number): HeartsMove {
  if (state.phase === "gameOver") throw new Error("game is over");
  if (seatToAct(state) !== seat) throw new Error(`not seat ${seat}'s turn`);
  return state.phase === "passing" ? aiPass(state, seat) : aiPlay(state, seat);
}

// ---------- pacing ----------

function pacing(s: HeartsState): { kind: "auto" | "wait"; ms: number; move: HeartsMove } | null {
  if (s.phase !== "trickComplete") return null;
  // Last trick of the hand lingers a bit longer; any trick lingers for bot-only games too.
  const isLastTrick = s.trickNo + 1 >= Math.floor(buildDeck(s.players).length / s.players);
  return { kind: "auto", ms: isLastTrick ? 5000 : 5000, move: { type: "advance", seat: s.trickWinner! } };
}

// ---------- the module ----------

export const heartsModule: Game<HeartsState, HeartsMove, HeartsConfig, HeartsView> = {
  meta: { id: "hearts", name: "Hearts", supportedPlayerCounts: [3, 4, 5] },
  botStepMs: (s) => s.phase === "passing" ? 350 : Math.round(1600 * 4 / s.players),
  seatCount: (config) => config.players,
  createGame,
  seatToAct,
  isLegal,
  legalMoves,
  applyMove,
  isOver,
  redact,
  lobbyView,
  aiMove,
  pacing,
  loggableHand(prev, next) {
    if (!next.lastHand || next.lastHand === prev.lastHand) return null;
    return {
      game: "hearts",
      target: next.target,
      dealtHands: prev.dealtHands, // prev still holds this hand's deal; next has the new deal
      lastHand: next.lastHand,     // delta per seat + shooter (if moon)
      log: next.log,
      scores: next.scores,
      gameOver: next.phase === "gameOver",
    };
  },
  // no `aux`: Hearts has no non-turn side actions
};

// Exposed for unit tests / tuning.
export const __test = {
  buildDeck,
  handSize,
  cardPoints,
  isPoint,
  isQueenOfSpades,
  legalPlays,
  trickWinner,
  passOffsetFor,
  lowestClubSeat,
};
