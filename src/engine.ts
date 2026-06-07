// High Low Jack (Pitch variant) — pure rules engine.
//
// Design: the whole game is driven by one pure function,
//   applyMove(state, move) -> state
// plus createGame(...) to produce the initial state and legalMoves(state)
// to enumerate what the player-to-move may legally do. No I/O, no clocks,
// no randomness except a seeded PRNG threaded through `state.seed`, so the
// same seed + same moves always reproduce the same game. This is what lets
// single-player (run in the browser) and multiplayer (run on the PartyKit
// server) share identical logic, and what makes the whole thing testable.

// ---------- Cards ----------

export type Suit = "C" | "D" | "H" | "S";
export const SUITS: Suit[] = ["C", "D", "H", "S"];

// Ranks are 2..14 with J=11, Q=12, K=13, A=14. The joker is its own kind.
export type Card = { rank: number; suit: Suit } | { joker: true };

export const isJoker = (c: Card): c is { joker: true } => "joker" in c;

export function cardToStr(c: Card): string {
  if (isJoker(c)) return "JK";
  const r =
    c.rank === 14 ? "A" : c.rank === 13 ? "K" : c.rank === 12 ? "Q" : c.rank === 11 ? "J" : String(c.rank);
  return r + c.suit;
}

export function sameCard(a: Card, b: Card): boolean {
  if (isJoker(a) || isJoker(b)) return isJoker(a) && isJoker(b);
  return a.rank === b.rank && a.suit === b.suit;
}

// ---------- Deck sizing ----------
// Each player gets 6, the kitty gets 5, plus one joker. The deck is shortened
// by dropping the lowest ranks so it divides evenly:
//   ranksKept = (players*6 + 4) / 4   (must be a whole number)
//   lowRank   = 15 - ranksKept
// 4p -> 7 ranks, low 8 | 6p -> 10 ranks, low 5 | 8p -> 13 ranks, low 2.
export const SUPPORTED_PLAYERS = [4, 6, 8] as const;
export type PlayerCount = (typeof SUPPORTED_PLAYERS)[number];

export function lowRankFor(players: PlayerCount): number {
  const ranksKept = (players * 6 + 4) / 4;
  return 15 - ranksKept;
}

export function buildDeck(players: PlayerCount): Card[] {
  const low = lowRankFor(players);
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (let rank = low; rank <= 14; rank++) deck.push({ rank, suit });
  }
  deck.push({ joker: true });
  return deck;
}

// ---------- Seeded PRNG (mulberry32) ----------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Deterministic shuffle. Returns the shuffled deck plus the next seed so the
// caller can advance the PRNG across hands without mutating shared state.
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

// ---------- Trump logic ----------

// Trump strength for comparing cards within a trick. Only meaningful for
// trump cards. The joker is the LOWEST trump (this family's rule), so it sits
// below every natural trump.
export function trumpValue(c: Card, trump: Suit): number | null {
  if (isJoker(c)) return 0; // lowest trump
  if (c.suit === trump) return c.rank; // 2..14, all above the joker's 0
  return null; // not a trump
}

export function isTrump(c: Card, trump: Suit): boolean {
  return trumpValue(c, trump) !== null;
}

// Game-count value: 10 is worth 10, A 4, K 3, Q 2, J 1, everything else 0.
export function gameValue(c: Card): number {
  if (isJoker(c)) return 0;
  if (c.rank === 10) return 10;
  if (c.rank === 14) return 4;
  if (c.rank === 13) return 3;
  if (c.rank === 12) return 2;
  if (c.rank === 11) return 1;
  return 0;
}

// The "led suit" of a trick and whether trump was led. Leading the joker counts
// as leading trump.
export function ledInfo(leadCard: Card, trump: Suit): { ledSuit: Suit; trumpLed: boolean } {
  if (isJoker(leadCard)) return { ledSuit: trump, trumpLed: true };
  return { ledSuit: leadCard.suit, trumpLed: leadCard.suit === trump };
}

export type TrickPlay = { seat: number; card: Card };

// Winner of a completed trick. Highest trump wins; if no trump, highest card of
// the led suit wins (off-suit non-trump cards cannot win).
export function trickWinner(plays: TrickPlay[], trump: Suit): number {
  const { ledSuit } = ledInfo(plays[0].card, trump);
  const trumps = plays.filter((p) => isTrump(p.card, trump));
  if (trumps.length) {
    return trumps.reduce((best, p) =>
      trumpValue(p.card, trump)! > trumpValue(best.card, trump)! ? p : best,
    ).seat;
  }
  const followers = plays.filter((p) => !isJoker(p.card) && p.card.suit === ledSuit);
  return followers.reduce((best, p) =>
    (p.card as { rank: number }).rank > (best.card as { rank: number }).rank ? p : best,
  ).seat;
}

// ---------- Game state ----------

export type Phase = "bidding" | "playing" | "gameOver";

export type Bid = { seat: number; amount: number };

// Public hand-confidence signal a player may broadcast during bidding. It
// carries no mechanical effect — it's a team-communication device that the
// other team can also see (and exploit).
export type HandSignal = "weak" | "medium" | "strong";

export type HandResult = {
  bidderSeat: number;
  bidderTeam: number;
  bid: number;
  pointsByTeam: [number, number]; // raw points captured this hand
  made: boolean;
  deltaByTeam: [number, number]; // applied to running score
  detail: {
    high: number | null; // team that took High
    low: number | null;
    jack: number | null; // null if Jack not in play
    bonhomme: number | null; // null if joker not in play
    game: number | null; // null on a tie
    gameCount: [number, number]; // pip counts for both teams (for display)
  };
  dealtHands: Card[][]; // each player's starting hand, revealed post-hand
  kitty: Card[];        // kitty for this hand, revealed post-hand
};

// Per-seat statistics accumulated across hands, observable by the AI.
// Only public information is recorded: signals, bids, and outcomes.
export type PlayerProfile = {
  handsPlayed: number;
  // Signal calibration: for each signal level, how often did the bidder win the bid
  // and make it? Helps the AI judge whether a player's signal is trustworthy.
  signalRecord: {
    weak:   { bid: number; made: number };
    medium: { bid: number; made: number };
    strong: { bid: number; made: number };
  };
  // Bidding tendencies: total bids won and bids made (vs. set back).
  bidsWon: number;
  bidsMade: number;
  // Average points captured per hand (team points / hands), proxy for hand quality.
  totalTeamPoints: number;
};

export type GameState = {
  players: PlayerCount;
  target: number; // 21
  seed: number;
  phase: Phase;
  dealerSeat: number;
  scores: [number, number]; // team 0, team 1 (team = seat % 2)
  winner: number | null;
  gamesWon: [number, number]; // wins per team across the series
  winsNeeded: number; // wins required to win the series (1 = single game)

  // Per-hand state:
  hands: Card[][]; // hands[seat] = remaining cards
  kitty: Card[]; // dead cards, never played, kept only to know what's out of play
  trump: Suit | null;
  trumpRevealed: boolean; // true after selectTrump or the first card is played

  // Bidding:
  bidTurn: number; // seat to act during bidding
  bidsActed: number; // how many seats have acted this round
  highBid: Bid | null;
  winningBid: Bid | null;
  signals: (HandSignal | null)[]; // public confidence signal per seat; reset each hand

  // Trick play:
  turn: number; // seat to act (bid/selectTrump/play)
  leaderSeat: number; // who leads the current trick
  trickIndex: number; // 0..5
  currentTrick: TrickPlay[];
  tricksWon: { seat: number; plays: TrickPlay[] }[]; // resolved tricks this hand

  lastHand: HandResult | null;
  dealtHands: Card[][] | null; // starting hands this round, revealed at end of hand
  bidHistory: { seat: number; type: "bid" | "pass"; amount?: number }[];

  // Cross-hand player profiles, updated after each hand scores.
  profiles: PlayerProfile[];
};

export const teamOf = (seat: number): number => seat % 2;

// ---------- Moves ----------

export type Move =
  | { type: "bid"; seat: number; amount: number }
  | { type: "pass"; seat: number }
  | { type: "selectTrump"; seat: number; suit: Suit }
  | { type: "play"; seat: number; card: Card };

// ---------- Setup / dealing ----------

function emptyProfile(): PlayerProfile {
  return {
    handsPlayed: 0,
    signalRecord: {
      weak:   { bid: 0, made: 0 },
      medium: { bid: 0, made: 0 },
      strong: { bid: 0, made: 0 },
    },
    bidsWon: 0,
    bidsMade: 0,
    totalTeamPoints: 0,
  };
}

export function createGame(players: PlayerCount, seed: number, target = 21, winsNeeded = 1): GameState {
  if (!SUPPORTED_PLAYERS.includes(players)) {
    throw new Error(`Unsupported player count: ${players}`);
  }
  const base: GameState = {
    players,
    target,
    seed,
    phase: "bidding",
    dealerSeat: seed % players,
    scores: [0, 0],
    winner: null,
    gamesWon: [0, 0],
    winsNeeded,
    hands: [],
    kitty: [],
    trump: null,
    trumpRevealed: false,
    bidTurn: 0,
    bidsActed: 0,
    highBid: null,
    winningBid: null,
    signals: [],
    turn: 0,
    leaderSeat: 0,
    trickIndex: 0,
    currentTrick: [],
    tricksWon: [],
    lastHand: null,
    dealtHands: null,
    bidHistory: [],
    profiles: Array.from({ length: players }, emptyProfile),
  };
  return deal(base);
}

// Deal a fresh hand. Dealer is already set; the opening bidder is to the
// dealer's left.
function deal(state: GameState): GameState {
  const deck = buildDeck(state.players);
  const { shuffled, nextSeed } = shuffle(deck, state.seed);

  const hands: Card[][] = Array.from({ length: state.players }, () => []);
  let i = 0;
  for (let c = 0; c < 6; c++) {
    for (let seat = 0; seat < state.players; seat++) hands[seat].push(shuffled[i++]);
  }
  const kitty = shuffled.slice(i, i + 5);

  const firstBidder = (state.dealerSeat + 1) % state.players;
  return {
    ...state,
    seed: nextSeed,
    phase: "bidding",
    hands,
    dealtHands: hands.map(h => [...h]),
    kitty,
    trump: null,
    trumpRevealed: false,
    bidTurn: firstBidder,
    bidsActed: 0,
    highBid: null,
    winningBid: null,
    signals: Array(state.players).fill(null),
    bidHistory: [],
    turn: firstBidder,
    leaderSeat: firstBidder,
    trickIndex: 0,
    currentTrick: [],
    tricksWon: [],
  };
}

// Record (or change) a seat's public confidence signal. Allowed only during
// bidding; outside that window there's nothing to signal about. Not a
// turn-taking move — a player may set it whenever during the bidding phase.
export function setSignal(state: GameState, seat: number, level: HandSignal): GameState {
  if (state.phase !== "bidding") throw new Error("Signals can only be set during bidding");
  if (seat < 0 || seat >= state.players) throw new Error("No such seat");
  const signals = state.signals.slice();
  signals[seat] = level;
  return { ...state, signals };
}

// ---------- Legal moves ----------

export function legalMoves(state: GameState): Move[] {
  if (state.phase === "gameOver") return [];

  if (state.phase === "bidding") {
    const seat = state.bidTurn;
    const isDealer = seat === state.dealerSeat;
    const high = state.highBid?.amount ?? null;
    const moves: Move[] = [];

    // Minimum a bid must reach. Non-dealers must EXCEED the high bid (or open
    // at 2). The dealer may MATCH the high bid to steal it.
    const min = high === null ? 2 : isDealer ? high : high + 1;
    for (let amt = min; amt <= 6; amt++) moves.push({ type: "bid", seat, amount: amt });

    // The dealer is forced to bid (>=2) if everyone else passed.
    const dealerStuck = isDealer && high === null;
    if (!dealerStuck) moves.push({ type: "pass", seat });
    return moves;
  }

  // phase === "playing"
  const seat = state.turn;
  const hand = state.hands[seat];

  // The bidder's opening action: trump is not yet set. They may either declare
  // a trump suit (then lead anything), or just lead — in which case the led
  // card's suit becomes trump. Either way the joker can't be the opening lead.
  if (state.trump === null) {
    const declares: Move[] = SUITS.map((suit) => ({ type: "selectTrump", seat, suit }));
    const leads: Move[] = hand.filter((c) => !isJoker(c)).map((card) => ({ type: "play", seat, card }));
    return [...declares, ...leads];
  }

  const trump = state.trump;
  const leading = state.currentTrick.length === 0;

  let playable: Card[];
  if (leading) {
    playable = hand.slice();
    // The Bonhomme may not be led to the very first trick of the hand.
    if (state.trickIndex === 0) playable = playable.filter((c) => !isJoker(c));
  } else {
    const { ledSuit, trumpLed } = ledInfo(state.currentTrick[0].card, trump);
    if (trumpLed) {
      const trumps = hand.filter((c) => isTrump(c, trump));
      playable = trumps.length ? trumps : hand.slice();
    } else {
      const ofLed = hand.filter((c) => !isJoker(c) && c.suit === ledSuit && c.suit !== trump);
      if (ofLed.length) {
        // Follow suit OR trump in (allowed any time you like).
        const trumps = hand.filter((c) => isTrump(c, trump));
        playable = [...ofLed, ...trumps];
      } else {
        playable = hand.slice();
      }
    }
  }
  return playable.map((card) => ({ type: "play", seat, card }));
}

function moveEq(a: Move, b: Move): boolean {
  if (a.type !== b.type || a.seat !== b.seat) return false;
  if (a.type === "bid" && b.type === "bid") return a.amount === b.amount;
  if (a.type === "selectTrump" && b.type === "selectTrump") return a.suit === b.suit;
  if (a.type === "play" && b.type === "play") return sameCard(a.card, b.card);
  return true; // pass
}

// ---------- Apply ----------

export function applyMove(state: GameState, move: Move): GameState {
  const legal = legalMoves(state);
  if (!legal.some((m) => moveEq(m, move))) {
    throw new Error(`Illegal move: ${JSON.stringify(move)} in phase ${state.phase}`);
  }

  if (state.phase === "bidding") return applyBid(state, move);
  if (state.phase === "playing") {
    // The bidder may declare a trump suit before leading (the uncommon case of
    // wanting to lead something other than trump). Otherwise they just lead and
    // applyPlay sets trump from that first card.
    if (move.type === "selectTrump") return { ...state, trump: move.suit, trumpRevealed: true };
    return applyPlay(state, move);
  }
  throw new Error("game over");
}

function applyBid(state: GameState, move: Move): GameState {
  let highBid = state.highBid;
  if (move.type === "bid") highBid = { seat: move.seat, amount: move.amount };

  const bidsActed = state.bidsActed + 1;
  const done = bidsActed === state.players;

  const entry = move.type === "bid"
    ? { seat: move.seat, type: "bid" as const, amount: move.amount }
    : { seat: move.seat, type: "pass" as const };
  const bidHistory = [...(state.bidHistory ?? []), entry];

  if (!done) {
    // A bid of 6 by a non-dealer skips remaining bidders — go straight to the dealer.
    const nextTurn = (state.bidTurn + 1) % state.players;
    const jumpToDealer = move.type === "bid" && move.amount === 6 && state.bidTurn !== state.dealerSeat;
    if (jumpToDealer) {
      // Insert implicit passes for every seat between nextTurn and dealerSeat.
      const skips: { seat: number; type: "pass" }[] = [];
      for (let seat = nextTurn; seat !== state.dealerSeat; seat = (seat + 1) % state.players) {
        skips.push({ seat, type: "pass" });
      }
      return {
        ...state,
        highBid,
        bidsActed: bidsActed + skips.length,
        bidHistory: [...bidHistory, ...skips],
        bidTurn: state.dealerSeat,
      };
    }
    return {
      ...state,
      highBid,
      bidsActed,
      bidHistory,
      bidTurn: nextTurn,
    };
  }

  // Bidding resolved (highBid is non-null; the dealer is forced if all passed).
  // Go straight to play: the bidder leads, and unless they declare a trump suit
  // first, the suit of their first card becomes trump.
  return {
    ...state,
    highBid,
    bidsActed,
    bidHistory,
    winningBid: highBid,
    phase: "playing",
    trump: null,
    turn: highBid!.seat,
    leaderSeat: highBid!.seat,
    trickIndex: 0,
    currentTrick: [],
  };
}

function applyPlay(state: GameState, move: Move): GameState {
  if (move.type !== "play") throw new Error("expected play");
  const seat = move.seat;

  // If the bidder leads without having declared a trump, the led card's suit
  // becomes trump (classic "pitching"). The joker can't be led on trick 1, so
  // this first card is always a natural, suited card.
  if (state.trump === null) {
    if (isJoker(move.card)) throw new Error("Cannot lead the joker on the first trick");
    state = { ...state, trump: move.card.suit, trumpRevealed: true };
  } else if (!state.trumpRevealed) {
    state = { ...state, trumpRevealed: true };
  }

  const hands = state.hands.map((h, s) =>
    s === seat ? h.filter((c) => !sameCard(c, move.card)) : h,
  );
  const currentTrick = [...state.currentTrick, { seat, card: move.card }];

  // Trick still in progress.
  if (currentTrick.length < state.players) {
    return { ...state, hands, currentTrick, turn: (seat + 1) % state.players };
  }

  // Trick complete — resolve it.
  const trump = state.trump!;
  const winnerSeat = trickWinner(currentTrick, trump);
  const tricksWon = [...state.tricksWon, { seat: winnerSeat, plays: [...currentTrick] }];
  const trickIndex = state.trickIndex + 1;

  // Hand still in progress.
  if (trickIndex < 6) {
    return {
      ...state,
      hands,
      currentTrick: [],
      tricksWon,
      trickIndex,
      leaderSeat: winnerSeat,
      turn: winnerSeat,
    };
  }

  // Hand complete — score it.
  return scoreHand({ ...state, hands, currentTrick: [], tricksWon, trickIndex });
}

// ---------- Scoring ----------

// Exported for unit testing. Expects a state whose hand is finished
// (tricksWon has 6 entries) and computes scoring, set-backs, win conditions,
// and either ends the game or rotates the dealer and deals the next hand.
export function scoreHand(state: GameState): GameState {
  const trump = state.trump!;
  const bidderSeat = state.winningBid!.seat;
  const bidderTeam = teamOf(bidderSeat);
  const bid = state.winningBid!.amount;

  // Which trump cards are in play (dealt), i.e. not buried in the dead kitty.
  const kittyHasTrump = (c: Card) => state.kitty.some((k) => sameCard(k, c));
  const low = lowRankFor(state.players);

  const naturalTrumpRanksInPlay: number[] = [];
  for (let r = low; r <= 14; r++) {
    const card: Card = { rank: r, suit: trump };
    if (!kittyHasTrump(card)) naturalTrumpRanksInPlay.push(r);
  }
  const highRank = Math.max(...naturalTrumpRanksInPlay);
  const lowRank = Math.min(...naturalTrumpRanksInPlay);
  const jackInPlay = naturalTrumpRanksInPlay.includes(11);
  const jokerInPlay = !state.kitty.some((k) => isJoker(k));

  // Find the team that captured a given card.
  const capturingTeam = (target: Card): number | null => {
    for (const t of state.tricksWon) {
      if (t.plays.some((p) => sameCard(p.card, target))) return teamOf(t.seat);
    }
    return null;
  };

  const highTeam = capturingTeam({ rank: highRank, suit: trump });
  const lowTeam = capturingTeam({ rank: lowRank, suit: trump });
  const jackTeam = jackInPlay ? capturingTeam({ rank: 11, suit: trump }) : null;
  const bonhommeTeam = jokerInPlay ? capturingTeam({ joker: true }) : null;

  // Game point: most card-count pips; tie scores for nobody.
  const gameCount: [number, number] = [0, 0];
  for (const t of state.tricksWon) {
    const team = teamOf(t.seat);
    for (const p of t.plays) gameCount[team] += gameValue(p.card);
  }
  const gameTeam = gameCount[0] === gameCount[1] ? null : gameCount[0] > gameCount[1] ? 0 : 1;

  const pointsByTeam: [number, number] = [0, 0];
  const add = (team: number | null, n: number) => {
    if (team !== null) pointsByTeam[team] += n;
  };
  add(highTeam, 1);
  add(lowTeam, 1);
  add(jackTeam, 1);
  add(bonhommeTeam, 2);
  add(gameTeam, 1);

  const made = pointsByTeam[bidderTeam] >= bid;
  const other = 1 - bidderTeam;

  const preScore = state.scores[bidderTeam];
  const deltaByTeam: [number, number] = [0, 0];
  deltaByTeam[bidderTeam] = made ? pointsByTeam[bidderTeam] : -bid;
  deltaByTeam[other] = pointsByTeam[other]; // opponents always keep what they took

  const scores: [number, number] = [
    state.scores[0] + deltaByTeam[0],
    state.scores[1] + deltaByTeam[1],
  ];

  const result: HandResult = {
    bidderSeat,
    bidderTeam,
    bid,
    pointsByTeam,
    made,
    deltaByTeam,
    detail: { high: highTeam, low: lowTeam, jack: jackTeam, bonhomme: bonhommeTeam, game: gameTeam, gameCount },
    dealtHands: state.dealtHands ?? [],
    kitty: state.kitty,
  };

  // Win conditions.
  // Bid-6 auto-win: only if the bidding team made it AND was not "in the hole"
  // (score >= 0) at the moment of the bid.
  const autoWin = bid === 6 && made && preScore >= 0;

  let winner: number | null = null;
  if (autoWin) {
    winner = bidderTeam;
  } else {
    const bidderOut = scores[bidderTeam] >= state.target;
    const otherOut = scores[other] >= state.target;
    if (bidderOut && otherOut) winner = bidderTeam; // bidder wins simultaneous crossings
    else if (bidderOut) winner = bidderTeam;
    else if (otherOut) winner = other;
  }

  // Update per-seat profiles with this hand's observable data.
  const profiles = state.profiles.map((prof, seat): PlayerProfile => {
    const p = {
      ...prof,
      signalRecord: {
        weak:   { ...prof.signalRecord.weak },
        medium: { ...prof.signalRecord.medium },
        strong: { ...prof.signalRecord.strong },
      },
      handsPlayed: prof.handsPlayed + 1,
      totalTeamPoints: prof.totalTeamPoints + pointsByTeam[teamOf(seat)],
    };
    const sig = state.signals[seat];
    const level = sig ?? "medium";
    if (seat === bidderSeat) {
      p.bidsWon++;
      if (made) p.bidsMade++;
      p.signalRecord[level].bid++;
      if (made) p.signalRecord[level].made++;
    }
    return p;
  });

  if (winner !== null) {
    const gamesWon: [number, number] = [state.gamesWon[0], state.gamesWon[1]];
    gamesWon[winner]++;
    const seriesWinner = gamesWon[winner] >= state.winsNeeded ? winner : null;
    if (seriesWinner !== null) {
      return { ...state, scores, gamesWon, phase: "gameOver", winner: seriesWinner, lastHand: result, profiles };
    }
    // Series continues: reset scores and deal the next game.
    const next: GameState = {
      ...state,
      scores: [0, 0],
      gamesWon,
      winner: null,
      lastHand: result,
      profiles,
      dealerSeat: (state.dealerSeat + 1) % state.players,
    };
    return deal(next);
  }

  // Otherwise rotate the dealer to the left and deal the next hand.
  const next: GameState = {
    ...state,
    scores,
    lastHand: result,
    profiles,
    dealerSeat: (state.dealerSeat + 1) % state.players,
  };
  return deal(next);
}
