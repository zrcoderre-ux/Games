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
  ledInfo,
  SUITS,
  type GameState,
  type Move,
  type Card,
  type Suit,
  type HandSignal,
  type PlayerProfile,
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
  // The Joker counts as a protector: it can be held back to cover the Jack's trick.
  if (has(11)) {
    const protectors = [14, 13, 12].filter(has).length + (hasJoker ? 1 : 0);
    score += Math.min(0.9, 0.25 + 0.2 * protectors);
  }

  // Bonhomme (2 pts). If you hold it, you only keep it with trump control to
  // win the trick it lands in; if opponents hold it, strong trumps capture it.
  // Ace+Joker synergy: Ace establishes trump control first, making the Joker nearly
  // unlosable — add a significant bonus for holding both.
  if (hasJoker) score += Math.min(2.2, 0.3 + 0.25 * (n - 1) + (has(14) ? 1.15 : 0));
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
  for (const t of state.tricksWon) for (const p of t.plays) if (isTrump(p.card, trump)) seen.push(p.card);
  for (const p of state.currentTrick) if (isTrump(p.card, trump)) seen.push(p.card);

  const seenVals = new Set(seen.map((c) => trumpValue(c, trump)));
  const unseen = all.map((c) => trumpValue(c, trump)!).filter((v) => !seenVals.has(v));
  return unseen.length ? Math.max(...unseen) : -1;
}

// Count unseen trumps (not yet played and not in my hand).
function unseenTrumpCount(state: GameState, trump: Suit, myCards: Card[]): number {
  const low = lowRankFor(state.players);
  const totalTrumps = 1 + (14 - low + 1); // joker + natural trumps
  const seenInTricks = state.tricksWon.flatMap((t) => t.plays).filter((p) => isTrump(p.card, trump)).length
    + state.currentTrick.filter((p) => isTrump(p.card, trump)).length;
  const myTrumps = myCards.filter((c) => isTrump(c, trump)).length;
  return totalTrumps - seenInTricks - myTrumps;
}

// Seats that have shown trump-void: they played a non-trump when trump was led.
function trumpVoidSeats(state: GameState, trump: Suit): Set<number> {
  const voids = new Set<number>();
  for (const trick of state.tricksWon) {
    const { trumpLed } = ledInfo(trick.plays[0].card, trump);
    if (!trumpLed) continue;
    for (const p of trick.plays) {
      if (!isTrump(p.card, trump)) voids.add(p.seat);
    }
  }
  // Also check the in-progress trick
  if (state.currentTrick.length > 0) {
    const { trumpLed } = ledInfo(state.currentTrick[0].card, trump);
    if (trumpLed) {
      for (const p of state.currentTrick) {
        if (!isTrump(p.card, trump)) voids.add(p.seat);
      }
    }
  }
  return voids;
}

// Returns true if all trump cards that could beat `card` have already been
// played in completed tricks or are in the AI's own hand — i.e., no opponent
// can over-trump it. For the joker this means all other trumps are accounted for.
function higherTrumpsAllAccountedFor(state: GameState, trump: Suit, card: Card, myCards: Card[]): boolean {
  const cardVal = trumpValue(card, trump)!;
  const low = lowRankFor(state.players);
  const playedOrOwned = new Set<number>();
  for (const t of state.tricksWon) {
    for (const p of t.plays) {
      const v = trumpValue(p.card, trump);
      if (v !== null) playedOrOwned.add(v);
    }
  }
  for (const c of myCards) {
    const v = trumpValue(c, trump);
    if (v !== null) playedOrOwned.add(v);
  }
  // Check that every trump with higher value is accounted for
  if (isJoker(card)) {
    // Joker can't be beaten, but "safe to lead" = no other trump is floating in
    // an opponent's hand — i.e. all non-joker trumps played or in own hand
    for (let r = low; r <= 14; r++) {
      const v = trumpValue({ rank: r, suit: trump }, trump)!;
      if (!playedOrOwned.has(v)) return false;
    }
  } else {
    // Any trump with value > cardVal not yet played/owned is a threat
    for (let r = low; r <= 14; r++) {
      const v = trumpValue({ rank: r, suit: trump }, trump)!;
      if (v > cardVal && !playedOrOwned.has(v)) return false;
    }
    // Check joker
    const jokerVal = trumpValue({ joker: true }, trump)!;
    if (jokerVal > cardVal && !playedOrOwned.has(jokerVal)) return false;
  }
  return true;
}

// Tricks remaining in the hand (including the current in-progress trick).
// Uses the acting seat's own hand — all players have equal hand sizes throughout.
function tricksRemaining(state: GameState, seat: number): number {
  const handSize = state.hands[seat].length + state.tricksWon.length + (state.currentTrick.length > 0 ? 1 : 0);
  return handSize - state.tricksWon.length;
}

// Running game pip totals from completed tricks, indexed by team.
function gamePipTotals(state: GameState): [number, number] {
  const totals: [number, number] = [0, 0];
  for (const t of state.tricksWon) {
    const team = teamOf(t.seat) as 0 | 1;
    for (const p of t.plays) totals[team] += gameValue(p.card);
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
  // Off-suit tens are worth 10 game points — most valuable non-trump card to keep.
  if (c.rank === 10) return myTeamAhead ? 50 + p.tenProtectMargin : 50;
  if (c.rank === 14) return 25; // Ace: 4 game points, but can win tricks
  if (c.rank === 13) return 15; // King: 3 game points
  if (c.rank === 12) return 12; // Queen: 2 game points
  return c.rank;
}

// How valuable it is to drop a card onto a trick the partner is winning.
function loadValue(c: Card, trump: Suit): number {
  if (isJoker(c)) return 60; // secures the Bonhomme for our side
  if (!isJoker(c) && c.suit === trump && c.rank === 11) return 30; // Jack point
  return gameValue(c);
}

// How "expensive" a card is to spend winning a trick. Prefer cheapest winner.
// Joker gets a very high cost so a regular trump is always preferred over it;
// the Joker's 2 game-point value shouldn't be squandered when any other trump wins.
const winCost = (c: Card, trump: Suit): number =>
  isJoker(c) ? 1000 : isTrump(c, trump) ? trumpValue(c, trump)! : (c as { rank: number }).rank;

function pick<T>(items: T[], score: (t: T) => number, mode: "max" | "min"): T {
  return items.reduce((best, t) =>
    mode === "max" ? (score(t) > score(best) ? t : best) : score(t) < score(best) ? t : best,
  );
}

// Choose a discard that creates voids: prefer shortest non-trump suit,
// then least keepable card within that suit.
// Never discard a card worth 10+ game points (a ten) when any cheaper card exists.
function bestDiscard(cards: Card[], trump: Suit, low: number, p: Personality, myTeamAhead: boolean): Card {
  const offSuit = cards.filter((c) => !isTrump(c, trump) && !isJoker(c));
  if (!offSuit.length) return pick(cards, (c) => keepValue(c, trump, low, p, myTeamAhead), "min");

  // Never throw a ten (10 game points) when a cheaper card exists.
  const cheapOptions = offSuit.filter((c) => gameValue(c) < 10);
  const pool = cheapOptions.length ? cheapOptions : offSuit;

  // Count how many of each non-trump suit we hold (within the pool).
  const suitCounts: Record<string, number> = {};
  for (const c of pool) {
    const s = (c as { suit: string }).suit;
    suitCounts[s] = (suitCounts[s] ?? 0) + 1;
  }

  // Shortest suit first (void creation), break ties by lowest keepValue.
  const sorted = pool.slice().sort((a, b) => {
    const byLen = suitCounts[(a as { suit: string }).suit] - suitCounts[(b as { suit: string }).suit];
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

// ---------- profile-based signal calibration ----------

// Reliability score for a signal level: fraction of times the player bid and
// made it when they emitted that signal. Returns null if no data yet.
function signalReliability(prof: PlayerProfile, level: "weak" | "medium" | "strong"): number | null {
  const rec = prof.signalRecord[level];
  return rec.bid >= 3 ? rec.made / rec.bid : null;
}

// Calibrated signal strength [0..2]. Adjusts the raw signal up/down based on
// how reliable this player's signals have proven to be:
//   - "strong" from a player who rarely makes good on it → deflated toward 1
//   - "weak" from a player who always sandbags → inflated toward 1
// Falls back to the raw signal when there's not enough data.
function calibratedSignal(sig: HandSignal | null, prof: PlayerProfile): number {
  const raw = signalToNum(sig);
  const level = sig ?? "medium";
  const rel = signalReliability(prof, level);
  if (rel === null) return raw; // not enough history

  // Adjust: expected reliability for strong=0.7, medium=0.5, weak=0.2.
  const expected = level === "strong" ? 0.7 : level === "medium" ? 0.5 : 0.2;
  const delta = rel - expected; // positive = more reliable than expected
  // Each 0.1 delta moves the signal by 0.2 points, clamped to [0,2].
  return clamp(raw + delta * 2, 0, 2);
}

// Aggression index [0..1]: how often the player wins bids relative to hands
// played. High aggression means they grab the auction often, which is relevant
// for deciding whether to contest or yield.
function aggressionIndex(prof: PlayerProfile): number {
  return prof.handsPlayed >= 3 ? prof.bidsWon / prof.handsPlayed : 0.5;
}

const competeProb = (myConf: number, theirConf: number, stretchProb: number): number => {
  const gap = myConf - theirConf;
  return gap <= 0 ? stretchProb * 0.6 : gap === 1 ? stretchProb + 0.1 : stretchProb + 0.3;
};

// How dangerous it is to let the opponent keep their bid.
//   2 = game-winning: they reach or exceed the target if they make it
//   1 = game-threatening: within 2 of the target after the bid
//   0 = non-critical
function opponentThreatLevel(state: GameState, opponentSeat: number, bidAmount: number): 0 | 1 | 2 {
  const team = teamOf(opponentSeat);
  const after = state.scores[team] + bidAmount;
  if (after >= state.target) return 2;
  if (after >= state.target - 2) return 1;
  return 0;
}

// ---------- 6-bid probability ----------

// Estimate P(making all 6 points) for `hand` as the bidder.
// The dominant risk for strong hands is the Joker landing in the kitty — when
// it's in play and you hold A+K+Q+J you pull it almost every time (~99%).
// P(make 6) ≈ P(joker alive) × P(sweep | joker alive).
function estimateSixBidProb(hand: Card[], players: number): number {
  const { suit } = bestSuit(hand, players);
  const trumps = hand.filter(c => isTrump(c, suit));
  const has = (r: number) => trumps.some(c => !isJoker(c) && c.rank === r);
  const hasJoker = trumps.some(isJoker);
  const n = trumps.length;

  if (!has(14)) return 0; // no Ace → can't reliably control High or strip trumps

  // P(joker not buried in kitty): deckSize = players*6+5, remaining after your 6.
  const remaining = players * 6 + 5 - 6;
  const pJokerLive = hasJoker ? 1.0 : (remaining - 5) / remaining;

  // P(sweep all 6 pts | joker is in play).
  // Simulation result: A+K+Q+J makes 6 ≈99% when joker is in play, for all player counts.
  let sweepProb = 0.99;
  if (!hasJoker)   sweepProb -= 0.01;           // tiny extra risk vs. holding it
  if (!has(11))    sweepProb -= 0.30;           // Jack not held: must capture it from opponents
  if (!has(13) && !has(12)) sweepProb -= 0.12; // no K or Q: weaker capture control
  // Sparse trump count: heavy penalty when holding fewer than 3 trumps.
  // With only A+Joker you need perfect luck (Jack falls on Ace trick, game pips align).
  if (n < 3) sweepProb -= 0.35;
  else if (n < 4) sweepProb -= 0.15;
  sweepProb += 0.005 * Math.max(0, n - 4);     // each extra trump adds marginal safety
  sweepProb = clamp(sweepProb, 0, 0.99);

  return pJokerLive * sweepProb;
}

// ---------- decisions ----------

function decideBid(state: GameState, seat: number, rng: () => number, p: Personality): Move {
  const hand = state.hands[seat];
  const best = bestSuit(hand, state.players);

  // Desperation scaling: as the opponent team approaches 21, bid more aggressively.
  // Each point they're within 6 of winning adds a small safety reduction.
  const myTeam = teamOf(seat) as 0 | 1;
  const oppTeam = (1 - myTeam) as 0 | 1;
  const oppGap = state.target - state.scores[oppTeam];
  const desperationBonus = oppGap <= 6 ? (6 - oppGap) * 0.18 : 0;
  const effectiveSafety = Math.max(0, p.bidSafety - desperationBonus);

  const willing = clamp(Math.round(best.score - effectiveSafety), 0, 6);
  const myConf = confFromScore(best.score);

  const isDealer = seat === state.dealerSeat;
  const high = state.highBid;
  const highAmt = high?.amount ?? null;

  if (isDealer && highAmt === null) return { type: "bid", seat, amount: 2 };

  const needed = highAmt === null ? 2 : isDealer ? highAmt : highAmt + 1;
  if (needed > 6) return { type: "pass", seat };

  if (willing >= needed) return { type: "bid", seat, amount: needed };

  // Evaluate the threat posed by the current bid before deciding whether to stretch.
  if (high !== null) {
    const sameTeam = teamOf(high.seat) === teamOf(seat);
    const holderProf = state.profiles[high.seat];
    const theirConf = calibratedSignal(state.signals[high.seat], holderProf);

    if (!sameTeam) {
      const threat = opponentThreatLevel(state, high.seat, high.amount);

      // A game-winning opponent bid must be contested regardless of hand strength.
      // Taking a setback hurts; losing the game is worse.
      if (threat === 2 && needed <= 6) return { type: "bid", seat, amount: needed };

      // Game-threatening bid: contest if we have any reasonable hand (willing >= 1)
      // OR if the opponent's signal/profile suggests they'll actually make it —
      // in which case a setback is still preferable to handing them near-victory.
      if (threat === 1 && needed <= willing + 2) {
        // More willing to block a reliable opponent; still reluctant against an
        // unknown or bluffing opponent where they might get set for us.
        const blockProb = clamp(0.5 + theirConf * 0.2 - (2 - myConf) * 0.1, 0.2, 0.95);
        if (rng() < blockProb) return { type: "bid", seat, amount: needed };
      }

      // Non-critical stretch: standard logic, weighted by aggression and signal.
      if (needed <= willing + 1 && myConf >= theirConf) {
        const aggBonus = Math.max(0, aggressionIndex(holderProf) - 0.4) * 0.3;
        if (rng() < competeProb(myConf, theirConf, p.stretchProb + aggBonus))
          return { type: "bid", seat, amount: needed };
      }
    } else if (sameTeam && myConf === 2 && theirConf <= 0.5) {
      // Partner holds it but signals weak while we're strong: occasionally take over.
      if (rng() < p.stretchProb * 0.5) return { type: "bid", seat, amount: needed };
    }
  }

  // 6-bid on hand strength alone: use kitty-risk-aware probability rather than
  // the scalar score (which can't capture player-count-dependent risk).
  if (needed === 6) {
    const sixProb = estimateSixBidProb(hand, state.players);
    const myScore = state.scores[myTeam];
    const myGap   = state.target - myScore;

    // Lower threshold when a missed 6-bid won't send us in the hole.
    // Each point of cushion above 0 reduces risk — cap at score=12 (a miss lands at 6+).
    const safeFromHoleBonus = myScore >= 1 ? Math.min(0.10, myScore * 0.008) : 0;

    // Lower threshold when auto-win is available (making 6 ends the game now).
    const autoWinBonus = myScore >= 0 ? 0.07 : 0;

    // Lower threshold when opponent is dangerously close to winning.
    const despSixBonus = oppGap <= 4 ? 0.12 : oppGap <= 6 ? 0.06 : 0;

    // RAISE threshold when our score is high enough that we don't need a 6-bid.
    // At myGap ≤ 6 (score ≥ 15) we can win by simply taking the auction at any
    // amount and scoring 6 naturally — a risky 6-bid adds downside with little upside.
    // The penalty grows as we get closer to winning without it.
    // Exception: if opponent is also close (despSixBonus active), urgency overrides.
    const rawNearWinPenalty = myGap <= 6 ? (6 - myGap) * 0.10 : 0;
    const nearWinPenalty = rawNearWinPenalty * Math.max(0, 1 - despSixBonus * 5);

    // Base threshold: aggressive=0.70, balanced=0.80, conservative=0.90
    const sixThresh = clamp(
      0.65 + p.bidSafety * 0.2 - safeFromHoleBonus - autoWinBonus - despSixBonus + nearWinPenalty,
      0.48, 0.97,
    );
    if (sixProb >= sixThresh) return { type: "bid", seat, amount: 6 };
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

  const remaining = tricksRemaining(state, seat);
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

      if (topVal === boss && !conserve) {
        // Lead the boss trump only when it's safe.
        // For the Joker: hold back unless all opponents are known trump-void OR
        // all other trumps have been played/are in own hand (nothing can threaten).
        // For any other boss (e.g. Ace after Joker was played): always lead it.
        if (!isJoker(top)) return asMove(top);
        const voids = trumpVoidSeats(state, trump);
        const allOpponentsVoid = [...Array(state.players).keys()]
          .filter((i) => i !== seat && teamOf(i) !== myTeam)
          .every((i) => voids.has(i));
        if (allOpponentsVoid || higherTrumpsAllAccountedFor(state, trump, top, cards)) return asMove(top);
        // Fall through to find a safer lead.
      }

      if (shouldPullTrumps) {
        // Lead highest non-boss trump to strip opponents.
        const nonBoss = myTrumps.filter((c) => trumpValue(c, trump)! !== boss);
        if (nonBoss.length) {
          // Heuristic 3: never lead unprotected Jack unless higher trumps are all gone.
          const jack = myTrumps.find((c) => !isJoker(c) && c.rank === 11);
          const hasProtection = myTrumps.some((c) => !isJoker(c) && c.rank > 11);
          const jackSafe = jack && (hasProtection || higherTrumpsAllAccountedFor(state, trump, jack, cards));
          const safe = nonBoss.filter((c) => !(c === jack && !jackSafe));
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
    const partnerCalibrated = calibratedSignal(state.signals[partnerSeat], state.profiles[partnerSeat]);
    const winVal = trumpValue(winnerCard, trump);
    const partnerStrong = winVal !== null
      ? (winVal === boss || winVal! >= 12 || partnerCalibrated >= p.loadSignalThreshold)
      : partnerCalibrated >= p.loadSignalThreshold;

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
    // Use calibrated signal for opponents: a known bluffer gets less credit.
    const opponentConf = (state.signals as (HandSignal | null)[])
      .map((s, i) => teamOf(i) !== myTeam ? calibratedSignal(s, state.profiles[i]) : -1)
      .reduce((a, b) => Math.max(a, b), -1);
    if (opponentConf >= 2 && winners.every((c) => !isTrump(c, trump))) {
      // Opponent is very strong but we can only beat with a non-trump — skip it.
      return asMove(bestDiscard(cards, trump, low, p, myTeamAhead));
    }
    // Prefer regular trumps over the Joker to win; winCost already encodes this
    // (Joker costs 1000). Additional guard: if regular-trump winners exist AND
    // there are still unseen trumps that could over-trump the Joker later, don't
    // burn the Joker here.
    const regularWinners = winners.filter((c) => !isJoker(c));
    const jokerWinner = winners.find((c) => isJoker(c));
    if (jokerWinner && regularWinners.length === 0 && unseenTrumps > 0 && !isLast) {
      // Joker is the only trump winner, unseen trumps exist, and we're not last —
      // an opponent could over-trump us. Discard instead.
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
  if (state.trump === null) {
    // Lead the best trump card directly (establishes trump from the lead, matching Pitch rules).
    // Never use selectTrump — that would reveal trump before the first card is played.
    const trump = bestSuit(state.hands[seat], state.players).suit;
    const hand = state.hands[seat];
    const trumpCards = hand.filter((c): c is Extract<typeof c, { rank: number }> =>
      !isJoker(c) && c.suit === trump
    );
    // Lead highest trump to assert High; fall back to any non-joker card in the hand.
    const lead = trumpCards.length
      ? trumpCards.reduce((a, b) => a.rank >= b.rank ? a : b)
      : hand.filter((c) => !isJoker(c))[0];
    return { type: "play", seat, card: lead };
  }
  return decidePlay(state, seat, personality);
}

export { suitValue, bestSuit };

export function handConfidence(hand: Card[], players: number): HandSignal {
  const score = bestSuit(hand, players).score;
  if (score >= 3.0) return "strong";
  if (score >= 1.5) return "medium";
  return "weak";
}
