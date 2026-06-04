// Heuristic AI for High Low Jack.
//
// Honesty rule: the AI may read ONLY its own hand (state.hands[seat]) and
// public information — the trump, the bids so far, the current trick, and the
// completed tricks. It never inspects other players' hands or the kitty. That
// keeps it fair and lets it run client-side in single-player without leaking
// hidden state.
//
// Personalities tune every heuristic along a conservative→aggressive axis.
// "Balanced" is the default for human-vs-AI games. Use the test harness
// (ai.battle.ts) to measure win rates across matchups.

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

// ---------- personality ----------

export type Personality = {
  name: string;

  // Bidding
  bidSafety: number;       // subtracted from score before rounding to willing bid (higher = fewer bids)
  stretchProb: number;     // base probability of stretching one beyond safe estimate [0,1]

  // Trump pulling: lead trumps after winning until opponents' supply looks exhausted.
  // 0 = never pull, 1 = pull aggressively (requires bossTrumpFrac below to be met)
  trumpPullFrac: number;   // fraction of unseen trumps that must still be out to keep pulling

  // Low awareness: how much to inflate keepValue for the Low trump card.
  lowKeepBonus: number;    // added to keepValue when card is the Low point (default trump 40+rank)

  // Endgame trump conservation: stop leading boss trump when tricks remaining ≤ this.
  endgameCutoff: number;   // 0 = always lead boss, 3 = stop with 3+ tricks left in hand

  // Signal reading: minimum partner signal level to treat a "modest" partner win as safe to load.
  // 0 = always load, 1 = load if partner ≥ medium, 2 = load only if partner strong
  loadSignalThreshold: number;

  // Game-pip consciousness: protect tens when ahead by this margin in game pips.
  tenProtectMargin: number; // 0 = never protect, 10 = protect when clearly ahead on pips
};

export const PERSONALITIES: Record<string, Personality> = {
  conservative: {
    name: "Conservative",
    bidSafety: 1.25,
    stretchProb: 0.15,
    trumpPullFrac: 0.5,
    lowKeepBonus: 40,
    endgameCutoff: 3,
    loadSignalThreshold: 2,
    tenProtectMargin: 5,
  },
  balanced: {
    name: "Balanced",
    bidSafety: 0.75,
    stretchProb: 0.35,
    trumpPullFrac: 0.35,
    lowKeepBonus: 25,
    endgameCutoff: 2,
    loadSignalThreshold: 1,
    tenProtectMargin: 10,
  },
  aggressive: {
    name: "Aggressive",
    bidSafety: 0.25,
    stretchProb: 0.60,
    trumpPullFrac: 0.20,
    lowKeepBonus: 10,
    endgameCutoff: 1,
    loadSignalThreshold: 0,
    tenProtectMargin: 20,
  },
};

// ---------- hand evaluation ----------

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

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

  // Low (captured rule). The Ace forces Low to surface (opponents holding the
  // lowest trump must follow and expose it). King also threatens to force Low.
  score += Math.min(0.7, 0.12 * n + (has(lowest) ? 0.15 : 0) + (has(14) ? 0.65 : has(13) ? 0.25 : 0));

  // Game (most pips) — tens are gold; Ace guarantees at least one pip trick.
  score += Math.min(1.0, 0.1 * n + 0.15 * tens + (has(14) ? 0.50 : 0));

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

// Count unseen trumps (not yet played and not in my hand).
function unseenTrumpCount(state: GameState, trump: Suit, myCards: Card[]): number {
  const low = lowRankFor(state.players);
  const totalTrumps = 1 + (14 - low + 1); // joker + natural trumps
  const seenInTricks = state.tricksWon.flatMap((t) => t.cards).filter((c) => isTrump(c, trump)).length
    + state.currentTrick.filter((p) => isTrump(p.card, trump)).length;
  const myTrumps = myCards.filter((c) => isTrump(c, trump)).length;
  return totalTrumps - seenInTricks - myTrumps;
}

// Tricks remaining in the hand (including the current in-progress trick).
function tricksRemaining(state: GameState): number {
  const handSize = state.hands[0].length + state.tricksWon.length + (state.currentTrick.length > 0 ? 1 : 0);
  return handSize - state.tricksWon.length;
}

// Running game pip totals from completed tricks, indexed by team.
function gamePipTotals(state: GameState): [number, number] {
  const totals: [number, number] = [0, 0];
  for (const t of state.tricksWon) {
    const team = teamOf(t.seat) as 0 | 1;
    for (const c of t.cards) totals[team] += gameValue(c);
  }
  return totals;
}

// How much the AI wants to KEEP a card (avoid dumping it to opponents).
function keepValue(c: Card, trump: Suit, low: number, p: Personality, myTeamAhead: boolean): number {
  if (isJoker(c)) return 100; // never feed the 2-point joker to an opponent
  if (c.suit === trump) {
    if (c.rank === 11) return 90;  // Jack of trump (a point)
    if (c.rank === 14) return 85;
    if (c.rank === low) return 40 + c.rank + p.lowKeepBonus; // Low point — protect it
    return 40 + c.rank;
  }
  // Ten protection: if our team is clearly ahead on pips, hold tens more tightly.
  if (c.rank === 10) return myTeamAhead ? 30 + p.tenProtectMargin : 30;
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

// Choose a discard that creates voids: prefer shortest non-trump suit,
// then least keepable card within that suit.
function bestDiscard(cards: Card[], trump: Suit, low: number, p: Personality, myTeamAhead: boolean): Card {
  const offSuit = cards.filter((c) => !isTrump(c, trump) && !isJoker(c));
  if (!offSuit.length) return pick(cards, (c) => keepValue(c, trump, low, p, myTeamAhead), "min");

  // Count how many of each non-trump suit we hold.
  const suitCounts: Record<string, number> = {};
  for (const c of offSuit) suitCounts[c.suit] = (suitCounts[c.suit] ?? 0) + 1;

  // Shortest suit first (void creation), break ties by lowest keepValue.
  const sorted = offSuit.slice().sort((a, b) => {
    const byLen = suitCounts[a.suit] - suitCounts[b.suit];
    if (byLen !== 0) return byLen;
    return keepValue(a, trump, low, p, myTeamAhead) - keepValue(b, trump, low, p, myTeamAhead);
  });
  return sorted[0];
}

// ---------- bidding randomness ----------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function stateRng(state: GameState, seat: number): () => number {
  let h = (state.seed ^ Math.imul(seat + 1, 0x9e3779b1) ^ Math.imul(state.bidsActed + 1, 0x85ebca77)) >>> 0;
  for (const c of state.hands[seat]) h = (Math.imul(h, 31) + (isJoker(c) ? 53 : c.rank * 4 + SUITS.indexOf(c.suit))) >>> 0;
  return mulberry32(h);
}

const confFromScore = (score: number): number => (score >= 3.0 ? 2 : score >= 1.5 ? 1 : 0);
const signalToNum = (sig: HandSignal | null): number => (sig === "strong" ? 2 : sig === "weak" ? 0 : 1);
const competeProb = (myConf: number, theirConf: number, stretchProb: number): number => {
  const gap = myConf - theirConf;
  return gap <= 0 ? stretchProb * 0.6 : gap === 1 ? stretchProb + 0.1 : stretchProb + 0.3;
};

// ---------- decisions ----------

function decideBid(state: GameState, seat: number, rng: () => number, p: Personality): Move {
  const hand = state.hands[seat];
  const best = bestSuit(hand, state.players);
  const willing = clamp(Math.round(best.score - p.bidSafety), 0, 6);
  const myConf = confFromScore(best.score);

  const isDealer = seat === state.dealerSeat;
  const high = state.highBid;
  const highAmt = high?.amount ?? null;

  if (isDealer && highAmt === null) return { type: "bid", seat, amount: 2 };

  const needed = highAmt === null ? 2 : isDealer ? highAmt : highAmt + 1;
  if (needed > 6) return { type: "pass", seat };

  if (willing >= needed) return { type: "bid", seat, amount: needed };

  // Marginal stretch.
  if (high !== null && needed <= willing + 1) {
    const sameTeam = teamOf(high.seat) === teamOf(seat);
    const theirConf = signalToNum(state.signals[high.seat]);
    if (!sameTeam && myConf >= theirConf) {
      if (rng() < competeProb(myConf, theirConf, p.stretchProb))
        return { type: "bid", seat, amount: needed };
    } else if (sameTeam && myConf === 2 && theirConf === 0) {
      if (rng() < p.stretchProb * 0.5) return { type: "bid", seat, amount: needed };
    }
  }
  return { type: "pass", seat };
}

function decidePlay(state: GameState, seat: number, p: Personality): Move {
  const trump = state.trump!;
  const players = state.players;
  const low = lowRankFor(players as 4 | 6 | 8);
  const cards = legalMoves(state)
    .filter((m): m is Extract<Move, { type: "play" }> => m.type === "play")
    .map((m) => m.card);

  const boss = bossTrumpValue(state, trump);
  const asMove = (card: Card): Move => ({ type: "play", seat, card });

  const pips = gamePipTotals(state);
  const myTeam = teamOf(seat) as 0 | 1;
  const myTeamAhead = (pips[myTeam] - pips[1 - myTeam]) >= p.tenProtectMargin;
  const kv = (c: Card) => keepValue(c, trump, low, p, myTeamAhead);

  const remaining = tricksRemaining(state);
  const unseenTrumps = unseenTrumpCount(state, trump, cards);
  const myTrumps = cards.filter((c) => isTrump(c, trump));
  const isLast = state.currentTrick.length === players - 1;

  // ---------- leading ----------
  if (state.currentTrick.length === 0) {
    // Heuristic 1: trump pulling.
    // If enough unseen trumps remain (relative to hand size), keep leading trumps.
    const shouldPullTrumps = myTrumps.length > 0
      && unseenTrumps > 0
      && unseenTrumps / (remaining * (players - 1)) >= p.trumpPullFrac;

    if (myTrumps.length) {
      const top = pick(myTrumps, (c) => trumpValue(c, trump)!, "max");
      const topVal = trumpValue(top, trump)!;

      // Heuristic 5: endgame conservation — don't spend boss in last few tricks
      // unless the trick would contain a point card (impossible to predict here,
      // so we just stop leading boss near the end).
      const conserve = remaining <= p.endgameCutoff;

      if (topVal === boss && !conserve) return asMove(top);

      if (shouldPullTrumps) {
        // Lead highest non-boss trump to strip opponents.
        const nonBoss = myTrumps.filter((c) => trumpValue(c, trump)! !== boss);
        if (nonBoss.length) {
          // Heuristic 3: never lead unprotected Jack.
          const hasProtection = myTrumps.some((c) => !isJoker(c) && c.rank > 11);
          const jack = myTrumps.find((c) => !isJoker(c) && c.rank === 11);
          const safe = nonBoss.filter((c) => !(c === jack && !hasProtection));
          if (safe.length) return asMove(pick(safe, (c) => trumpValue(c, trump)!, "max"));
        }
      }

      // Heuristic 2 (Low bait): if we don't hold Low and trumps need pulling,
      // lead the second-lowest trump to force Low out.
      const myLow = myTrumps.find((c) => !isJoker(c) && c.rank === low);
      if (!myLow && shouldPullTrumps && myTrumps.length >= 2) {
        const byVal = myTrumps.slice().sort((a, b) => trumpValue(a, trump)! - trumpValue(b, trump)!);
        // Second-lowest (index 1) baits Low without giving it away.
        return asMove(byVal[1]);
      }
    }

    // Side-suit ace tends to win and bank game pips.
    const sideAces = cards.filter((c) => !isTrump(c, trump) && !isJoker(c) && c.rank === 14);
    if (sideAces.length) return asMove(sideAces[0]);

    // Lead least valuable; prefer creating voids over random dumping.
    return asMove(bestDiscard(cards, trump, low, p, myTeamAhead));
  }

  // ---------- following ----------
  const winnerSeat = trickWinner(state.currentTrick, trump);
  const winnerCard = state.currentTrick.find((p) => p.seat === winnerSeat)!.card;
  const partnerWinning = teamOf(winnerSeat) === teamOf(seat);
  const trickHasValue = state.currentTrick.some((p) => isTrump(p.card, trump) || gameValue(p.card) >= 4);

  const wouldWin = (c: Card) => trickWinner([...state.currentTrick, { seat, card: c }], trump) === seat;
  const winners = cards.filter(wouldWin);

  if (partnerWinning) {
    // Heuristic 6: read partner's signal to judge whether modest win is safe to load.
    // Nearest same-team seat as a proxy for partner signal (good enough for any count).
    const partnerSeat = (seat % 2 === 0 ? 1 : 0);
    const partnerSignal = signalToNum(state.signals[partnerSeat]);
    const winVal = trumpValue(winnerCard, trump);
    const partnerStrong = winVal !== null
      ? (winVal === boss || winVal! >= 12 || partnerSignal >= p.loadSignalThreshold)
      : partnerSignal >= p.loadSignalThreshold;

    const safe = cards.filter((c) => !wouldWin(c));
    const pool = safe.length ? safe : cards;

    if (partnerStrong || isLast) {
      // Heuristic 3: if we're last but partner's win isn't strong, skip loading
      // the Joker — an over-trump is impossible now (we're last) but the Joker
      // is safe; load it freely. Just use standard load ordering.
      return asMove(pick(pool, (c) => loadValue(c, trump), "max"));
    }
    // Partner winning but not strong: conserve, dump cheapest.
    return asMove(bestDiscard(pool, trump, low, p, myTeamAhead));
  }

  // Opponent winning.
  if (winners.length && trickHasValue) {
    // Heuristic 6: if an opponent signaled strong, reconsider fighting for the trick.
    const opponentConf = (state.signals as (HandSignal | null)[])
      .map((s, i) => teamOf(i) !== myTeam ? signalToNum(s) : -1)
      .reduce((a, b) => Math.max(a, b), -1);
    if (opponentConf >= 2 && winners.every((c) => !isTrump(c, trump))) {
      // Opponent is very strong but we can only beat with a non-trump — skip it.
      return asMove(bestDiscard(cards, trump, low, p, myTeamAhead));
    }
    return asMove(pick(winners, (c) => winCost(c, trump), "min"));
  }
  return asMove(bestDiscard(cards, trump, low, p, myTeamAhead));
}

// ---------- public entry points ----------

export function aiMove(
  state: GameState,
  seat: number,
  rng: () => number = stateRng(state, seat),
  personality: Personality = PERSONALITIES.balanced,
): Move {
  if (state.phase === "gameOver") throw new Error("game is over");
  const turnSeat = state.phase === "bidding" ? state.bidTurn : state.turn;
  if (turnSeat !== seat) throw new Error(`not seat ${seat}'s turn (it is seat ${turnSeat}'s)`);

  if (state.phase === "bidding") return decideBid(state, seat, rng, personality);
  if (state.trump === null)
    return { type: "selectTrump", seat, suit: bestSuit(state.hands[seat], state.players).suit };
  return decidePlay(state, seat, personality);
}

export { suitValue, bestSuit };

export function handConfidence(hand: Card[], players: number): HandSignal {
  const score = bestSuit(hand, players).score;
  if (score >= 3.0) return "strong";
  if (score >= 1.5) return "medium";
  return "weak";
}
