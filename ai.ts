// Heuristic AI for High Low Jack.
//
// Honesty rule: the AI may read ONLY its own hand (state.hands[seat]) and
// public information — the trump, the bids so far, the current trick, and the
// completed tricks. It never inspects other players' hands or the kitty. That
// keeps it fair and lets it run client-side in single-player without leaking
// hidden state.
//
// It is intentionally a "good club player," not a solver: bid conservatively
// (a missed bid costs the whole bid), choose the strongest trump suit, pull
// trumps with boss cards, capture point cards as cheaply as possible, feed
// points to a winning partner, and never hand the joker or tens to opponents.

import {
  legalMoves,
  trumpValue,
  isTrump,
  isJoker,
  gameValue,
  trickWinner,
  teamOf,
  lowRankFor,
  SUITS,
  type GameState,
  type Move,
  type Card,
  type Suit,
  type HandSignal,
} from "./engine.ts";

// How far below its point estimate the AI is willing to commit on a bid.
// Higher = more cautious (fewer set-backs, fewer bids won).
const BID_SAFETY = 0.75;

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

// ---------- hand evaluation ----------

// Estimate how many of the 6 points this hand can take if `suit` is trump.
// The joker is trump in every suit, so it contributes to each candidate.
function suitValue(hand: Card[], suit: Suit, players: number): number {
  const trumps = hand.filter((c) => isTrump(c, suit));
  const n = trumps.length;
  const has = (rank: number) => trumps.some((c) => !isJoker(c) && c.rank === rank);
  const hasJoker = trumps.some(isJoker);
  const highCount = trumps.filter((c) => !isJoker(c) && c.rank >= 12).length; // Q,K,A
  const lowest = lowRankFor(players as 4 | 6 | 8);
  const tens = hand.filter((c) => !isJoker(c) && c.rank === 10).length;

  let score = 0;

  // High: you own the High point if you hold the top trump in play.
  if (has(14)) score += 1.0;
  else if (has(13)) score += 0.4;
  else if (has(12)) score += 0.15;

  // Jack of trump (1 pt) — keepable if you have higher trumps to protect it.
  if (has(11)) {
    const protectors = [14, 13, 12].filter(has).length;
    score += Math.min(0.8, 0.25 + 0.2 * protectors);
  }

  // Bonhomme (2 pts). If you hold it, you only keep it with trump control to
  // win the trick it lands in; if opponents hold it, strong trumps capture it.
  if (hasJoker) score += Math.min(1.6, 0.3 + 0.25 * (n - 1));
  else score += Math.min(0.8, 0.15 * highCount);

  // Low (captured rule) — correlates with trump control; a touch more if you
  // hold the lowest possible trump and can time it.
  score += Math.min(0.7, 0.12 * n + (has(lowest) ? 0.15 : 0));

  // Game (most pips) — tens are gold; control helps sweep them in.
  score += Math.min(1.0, 0.1 * n + 0.15 * tens);

  // Sheer bulk of trumps is control.
  score += 0.1 * Math.max(0, n - 3);

  return score;
}

function bestSuit(hand: Card[], players: number): { suit: Suit; score: number } {
  let best = { suit: SUITS[0], score: -Infinity };
  for (const suit of SUITS) {
    const score = suitValue(hand, suit, players);
    if (score > best.score) best = { suit, score };
  }
  return best;
}

// ---------- public-information helpers ----------

// Highest trump value still unseen (not yet played in any trick). If the AI
// holds a card matching this value, leading it is guaranteed to win the trick.
function bossTrumpValue(state: GameState, trump: Suit): number {
  const low = lowRankFor(state.players);
  const all: Card[] = [{ joker: true }];
  for (let r = low; r <= 14; r++) all.push({ rank: r, suit: trump });

  const seen: Card[] = [];
  for (const t of state.tricksWon) for (const c of t.cards) if (isTrump(c, trump)) seen.push(c);
  for (const p of state.currentTrick) if (isTrump(p.card, trump)) seen.push(p.card);

  const seenVals = new Set(seen.map((c) => trumpValue(c, trump)));
  const unseen = all.map((c) => trumpValue(c, trump)!).filter((v) => !seenVals.has(v));
  return unseen.length ? Math.max(...unseen) : -1;
}

// How much the AI wants to KEEP a card (avoid dumping it to opponents).
function keepValue(c: Card, trump: Suit): number {
  if (isJoker(c)) return 100; // never feed the 2-point joker to an opponent
  if (c.suit === trump) {
    if (c.rank === 11) return 90; // Jack of trump (a point)
    if (c.rank === 14) return 85;
    return 40 + c.rank; // high trumps = control
  }
  if (c.rank === 10) return 30; // game pips
  if (c.rank === 14) return 25;
  return c.rank;
}

// How valuable it is to drop a card onto a trick the partner is winning.
function loadValue(c: Card, trump: Suit): number {
  if (isJoker(c)) return 60; // secures the Bonhomme for our side
  if (!isJoker(c) && c.suit === trump && c.rank === 11) return 30; // Jack point
  return gameValue(c);
}

const winCost = (c: Card, trump: Suit): number => (isTrump(c, trump) ? trumpValue(c, trump)! : (c as { rank: number }).rank);

function pick<T>(items: T[], score: (t: T) => number, mode: "max" | "min"): T {
  return items.reduce((best, t) =>
    mode === "max" ? (score(t) > score(best) ? t : best) : score(t) < score(best) ? t : best,
  );
}

// ---------- decisions ----------

function decideBid(state: GameState, seat: number): Move {
  const hand = state.hands[seat];
  const best = bestSuit(hand, state.players);
  const willing = clamp(Math.floor(best.score - BID_SAFETY), 0, 6);

  const isDealer = seat === state.dealerSeat;
  const high = state.highBid?.amount ?? null;

  // Forced bid: dealer stuck when everyone passed. Bidding the floor of 2 is
  // strictly safest — you still score whatever you actually take.
  if (isDealer && high === null) return { type: "bid", seat, amount: 2 };

  // Minimum needed to take the auction (dealer may match; others must exceed).
  const needed = high === null ? 2 : isDealer ? high : high + 1;
  if (needed <= 6 && willing >= needed) return { type: "bid", seat, amount: needed };
  return { type: "pass", seat };
}

function decidePlay(state: GameState, seat: number): Move {
  const trump = state.trump!;
  const players = state.players;
  const cards = legalMoves(state)
    .filter((m): m is Extract<Move, { type: "play" }> => m.type === "play")
    .map((m) => m.card);

  const boss = bossTrumpValue(state, trump);
  const asMove = (card: Card): Move => ({ type: "play", seat, card });

  // ----- leading -----
  if (state.currentTrick.length === 0) {
    const myTrumps = cards.filter((c) => isTrump(c, trump));
    if (myTrumps.length) {
      const top = pick(myTrumps, (c) => trumpValue(c, trump)!, "max");
      // Hold the boss trump? Lead it: it wins and strips opponents of trumps.
      if (trumpValue(top, trump) === boss) return asMove(top);
    }
    // A side-suit ace tends to win a plain trick and bank game pips.
    const sideAces = cards.filter((c) => !isTrump(c, trump) && !isJoker(c) && c.rank === 14);
    if (sideAces.length) return asMove(sideAces[0]);
    // Otherwise lead the least valuable card and keep the good stuff.
    return asMove(pick(cards, (c) => keepValue(c, trump), "min"));
  }

  // ----- following -----
  const winnerSeat = trickWinner(state.currentTrick, trump);
  const winnerCard = state.currentTrick.find((p) => p.seat === winnerSeat)!.card;
  const partnerWinning = teamOf(winnerSeat) === teamOf(seat);
  const isLast = state.currentTrick.length === players - 1;

  const wouldWin = (c: Card) => trickWinner([...state.currentTrick, { seat, card: c }], trump) === seat;
  const winners = cards.filter(wouldWin);
  const trickHasValue = state.currentTrick.some((p) => isTrump(p.card, trump) || gameValue(p.card) >= 4);

  if (partnerWinning) {
    const strong =
      isTrump(winnerCard, trump) && (trumpValue(winnerCard, trump) === boss || trumpValue(winnerCard, trump)! >= 12);
    const safe = cards.filter((c) => !wouldWin(c)); // don't overtake your own partner
    const pool = safe.length ? safe : cards;
    if (strong || isLast) return asMove(pick(pool, (c) => loadValue(c, trump), "max")); // load points to partner
    return asMove(pick(pool, (c) => keepValue(c, trump), "min")); // else conserve, play low
  }

  // Opponent is winning: take the trick cheaply if it carries value, else dump
  // the least valuable card and protect point cards.
  if (winners.length && trickHasValue) {
    return asMove(pick(winners, (c) => winCost(c, trump), "min"));
  }
  return asMove(pick(cards, (c) => keepValue(c, trump), "min"));
}

// Single entry point: returns the move the AI plays for `seat`. Throws if it is
// not that seat's turn (a guard against wiring mistakes).
export function aiMove(state: GameState, seat: number): Move {
  if (state.phase === "gameOver") throw new Error("game is over");
  const turnSeat = state.phase === "bidding" ? state.bidTurn : state.turn;
  if (turnSeat !== seat) throw new Error(`not seat ${seat}'s turn (it is seat ${turnSeat}'s)`);

  if (state.phase === "bidding") return decideBid(state, seat);
  if (state.phase === "selectTrump") return { type: "selectTrump", seat, suit: bestSuit(state.hands[seat], state.players).suit };
  return decidePlay(state, seat);
}

export { suitValue, bestSuit }; // exported for testing/tuning

// Map the AI's best-suit evaluation onto the public confidence signal. The
// thresholds line up with how it bids: a "strong" hand is one it would open on,
// "weak" is a clear pass.
export function handConfidence(hand: Card[], players: number): HandSignal {
  const score = bestSuit(hand, players).score;
  if (score >= 3.0) return "strong";
  if (score >= 1.5) return "medium";
  return "weak";
}
