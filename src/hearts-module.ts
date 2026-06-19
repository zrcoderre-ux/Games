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

// ---------- heuristic AI ----------
// A "decent club player": shed danger when passing; lead low; duck under tricks
// to dodge points; when void, slough the most dangerous card (Q(S) first, then
// high hearts, then the bare spade honors that could later catch the Queen).

// Higher = more eager to be rid of the card.
function danger(c: HeartsCard): number {
  if (isQueenOfSpades(c)) return 1000; // the Black Lady — dump first
  if (c.suit === "S" && c.rank >= 13) return 500 + c.rank; // A/K of spades: can win the Queen onto you
  if (isHeart(c)) return 100 + c.rank; // hearts, highest first
  return c.rank; // otherwise just shed your highest
}

function aiPass(state: HeartsState, seat: number): HeartsMove {
  const hand = state.hands[seat];
  const chosen: HeartsCard[] = [];
  // 1. Always shed the Black Lady first if held.
  const qs = hand.find(isQueenOfSpades);
  if (qs) chosen.push(qs);
  // 2. Void the shortest non-heart suit we can fully empty within our remaining passes —
  //    a void lets us dump hearts / the Queen later. Repeat while slots remain.
  let progress = true;
  while (chosen.length < 3 && progress) {
    progress = false;
    const slots = 3 - chosen.length;
    let bestSuit: Suit | null = null, bestLen = Infinity;
    for (const su of ["S", "D", "C"] as Suit[]) {
      const rem = hand.filter((c) => c.suit === su && !chosen.includes(c));
      if (rem.length >= 1 && rem.length <= slots && rem.length < bestLen) { bestLen = rem.length; bestSuit = su; }
    }
    if (bestSuit) {
      for (const c of hand.filter((c) => c.suit === bestSuit && !chosen.includes(c))) chosen.push(c);
      progress = true;
    }
  }
  // 3. Fill any remaining slots by danger (high spades → high hearts → high cards).
  if (chosen.length < 3) {
    const rest = hand.filter((c) => !chosen.includes(c)).sort((a, b) => danger(b) - danger(a));
    for (const c of rest) { if (chosen.length >= 3) break; chosen.push(c); }
  }
  return { type: "pass", seat, cards: chosen.slice(0, 3).map((c) => c.id) };
}

function aiPlay(state: HeartsState, seat: number): HeartsMove {
  const legal = legalPlays(state, seat);
  const play = (c: HeartsCard): HeartsMove => ({ type: "play", seat, card: c.id });
  const lowestBy = (cards: HeartsCard[], key: (c: HeartsCard) => number) =>
    cards.reduce((lo, c) => (key(c) < key(lo) ? c : lo), cards[0]);
  const highestBy = (cards: HeartsCard[], key: (c: HeartsCard) => number) =>
    cards.reduce((hi, c) => (key(c) > key(hi) ? c : hi), cards[0]);

  // Leading: prefer to lead a low non-heart; fall back to the lowest legal card.
  if (state.currentTrick.length === 0) {
    const nonHearts = legal.filter((c) => !isHeart(c));
    const pool = nonHearts.length ? nonHearts : legal;
    return play(lowestBy(pool, (c) => c.rank));
  }

  // Moon defense: if one opponent already holds the Queen (>=13 pts) and ALL points so far, and
  // we're following a points-carrying trick they're currently winning, overtake as cheaply as we
  // can to grab the points and break the moon — far better than letting them collect all 26.
  {
    const pts = state.points;
    const others = pts.map((p, i) => ({ i, p })).filter((o) => o.i !== seat);
    const shooter = others.reduce((a, b) => (b.p > a.p ? b : a), others[0]);
    const threat = shooter.p >= 13 && pts[seat] === 0
      && !others.some((o) => o.i !== shooter.i && o.p > 0)
      && pts.reduce((a, b) => a + b, 0) < 26;
    if (threat) {
      const ledSuit = state.currentTrick[0].card.suit;
      const inLed = state.currentTrick.filter((tp) => tp.card.suit === ledSuit);
      const curWin = inLed.reduce((hi, tp) => (tp.card.rank > hi.card.rank ? tp : hi), inLed[0]);
      const trickPts = state.currentTrick.reduce((a, tp) => a + cardPoints(tp.card), 0);
      const winners = legal.filter((c) => c.suit === ledSuit && c.rank > curWin.card.rank);
      if (trickPts > 0 && curWin.seat === shooter.i && winners.length) {
        return play(winners.reduce((lo, c) => (c.rank < lo.rank ? c : lo), winners[0]));
      }
    }
  }

  const ledSuit = state.currentTrick[0].card.suit;
  const inSuit = legal.filter((c) => c.suit === ledSuit);

  if (inSuit.length) {
    // Must follow suit. Duck as high as we safely can; if we can't avoid
    // winning, win as cheaply as possible.
    const curWin = state.currentTrick
      .filter((p) => p.card.suit === ledSuit)
      .reduce((hi, p) => (p.card.rank > hi.card.rank ? p : hi), state.currentTrick[0]);
    const losing = inSuit.filter((c) => c.rank < curWin.card.rank);
    if (losing.length) return play(highestBy(losing, (c) => c.rank)); // shed our highest safe card
    return play(lowestBy(inSuit, (c) => c.rank)); // forced to win — take it cheaply
  }

  // Void in the led suit: throw away the most dangerous card we're allowed to.
  return play(highestBy(legal, danger));
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
