// AI for High Low Jack.
//
// Honesty rule: the AI may read ONLY its own hand (state.hands[seat]), the other
// hands' sizes, and public information — the trump, the bids and signals, the
// scores, the current trick, and the completed tricks. It never inspects other
// players' hands or the kitty. That keeps it fair and lets it run client-side in
// single-player without leaking hidden state.
//
// How it decides (the search itself lives in ai-sim.ts):
//   - Bidding: Monte Carlo. The unseen cards are dealt out many times, consistent
//     with the auction so far (signals, bids and passes), and the hand is played
//     out as if this seat won the bid. Every bid level is scored by the team's
//     resulting chance of winning the game (a made 6 wins outright, a set costs
//     the bid), and the best level is bid if it beats passing.
//   - The opening lead names trump: the top card of the best-valued suit.
//   - Card play: determinized Monte Carlo — each legal card is played out in
//     sampled deals of the unseen cards that respect the voids shown so far. The
//     classic heuristic below picks among (near-)ties.
// Every random choice comes from a PRNG seeded from the state, so the same state
// always yields the same move.
//
// Personalities set how light a hand the bot will bid and flavour its card-play
// heuristic. "Balanced" is the default for human-vs-AI games. Use the battle
// harness (ai.battle.ts) to measure implementations and personalities.

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
  isHandSignal,
  SUITS,
  type GameState,
  type Move,
  type Card,
  type Suit,
  type HandSignal,
  type PlayerProfile,
} from "./engine.ts";
import {
  buildContext,
  evaluatePlays,
  pointHistogram,
  otherBidderHistogram,
  handUtility,
  winProb,
  suitScore,
  signalLevel,
  cardsLeft,
  encodeCard,
  mulberry32,
  type HandStakes,
} from "./ai-sim.ts";

// ---------- personality ----------

export type Personality = {
  name: string;

  // Bidding: how far (in win-probability points, 0..100) the best bid's value
  // must clear the value of passing. Negative = bids lighter hands.
  bidMargin: number;

  // The remaining knobs shape the card-play heuristic, which breaks ties
  // between cards the search rates (nearly) equal.

  // Trump pulling: lead trumps after winning until opponents' supply looks exhausted.
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
    bidMargin: 3,
    trumpPullFrac: 0.5,
    lowKeepBonus: 40,
    endgameCutoff: 3,
    loadSignalThreshold: 2,
    tenProtectMargin: 5,
  },
  balanced: {
    name: "Balanced",
    bidMargin: 0,
    trumpPullFrac: 0.35,
    lowKeepBonus: 25,
    endgameCutoff: 2,
    loadSignalThreshold: 1,
    tenProtectMargin: 10,
  },
  aggressive: {
    name: "Aggressive",
    bidMargin: -3,
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
  return suitScore(hand.map(encodeCard), hand.length, SUITS.indexOf(suit), lowRankFor(players as 4 | 6 | 8));
}

function bestSuit(hand: Card[], players: number, allowed: (s: Suit) => boolean = () => true): { suit: Suit; score: number } {
  let best = { suit: SUITS[0], score: -Infinity };
  for (const suit of SUITS) {
    if (!allowed(suit)) continue;
    const score = suitValue(hand, suit, players);
    if (score > best.score) best = { suit, score };
  }
  return best;
}

// The bidder names trump by leading: the top card of its best suit (only suits
// it holds a natural card in qualify — the joker can't be led to trick 1). When
// that top card is the Jack it would be led bare into the Q/K/A, so lead a low
// trump instead (the Low itself only as a last resort) and keep the Jack back.
function openingLead(hand: Card[], players: number): Extract<Card, { rank: number }> {
  const naturals = hand.filter((c): c is Extract<Card, { rank: number }> => !isJoker(c));
  const suit = bestSuit(hand, players, (s) => naturals.some((c) => c.suit === s)).suit;
  const inSuit = naturals.filter((c) => c.suit === suit).sort((a, b) => a.rank - b.rank);
  const top = inSuit[inSuit.length - 1];
  if (top.rank !== 11) return top;
  const low = lowRankFor(players as 4 | 6 | 8);
  return inSuit.find((c) => c.rank !== 11 && c.rank !== low) ?? inSuit.find((c) => c.rank === low) ?? top;
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

// Highest trump value nobody has shown and this seat doesn't hold (-1 if none):
// a trump above it can't be beaten by anyone. Unlike bossTrumpValue, the cards
// on the table count as shown, so a winning card can itself be unbeatable.
function hiddenTopTrump(state: GameState, trump: Suit, myCards: Card[]): number {
  const low = lowRankFor(state.players);
  const known = new Set<number>();
  const note = (c: Card) => {
    const v = trumpValue(c, trump);
    if (v !== null) known.add(v);
  };
  for (const t of state.tricksWon) for (const p of t.plays) note(p.card);
  for (const p of state.currentTrick) note(p.card);
  for (const c of myCards) note(c);
  for (let r = 14; r >= low; r--) if (!known.has(r)) return r;
  return known.has(0) ? -1 : 0; // only the joker (the lowest trump) left
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
    // The Joker is the lowest trump, so it's safe to lead only when no other
    // trump is floating in an opponent's hand — all played or in own hand.
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
function loadValue(c: Card, trump: Suit, low: number): number {
  if (isJoker(c)) return 60; // secures the Bonhomme for our side
  if (c.suit === trump && c.rank === 11) return 30; // Jack point
  if (c.suit === trump && c.rank === low) return 30; // Low point (goes to whoever captures it)
  return gameValue(c);
}

// How "expensive" a card is to spend winning a trick. Prefer cheapest winner.
// Joker gets a very high cost so a regular trump is always preferred over it;
// the Joker's 2 game-point value shouldn't be squandered when any other trump wins.
// The trump Jack and Low are points too: while a later seat could still
// over-trump them they cost more than any other winner (when playing last they
// are safe, and winning with them banks the point).
const winCost = (c: Card, trump: Suit, low: number, isLast: boolean): number => {
  if (isJoker(c)) return 1000;
  if (!isTrump(c, trump)) return (c as { rank: number }).rank;
  const pointCard = c.rank === 11 || c.rank === low;
  return c.rank + (pointCard && !isLast ? 200 : 0);
};

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

// ---------- search randomness ----------

// A PRNG seeded from the game seed, the seat, how far the hand has progressed
// and the seat's own cards: the same state always produces the same move.
function stateRng(state: GameState, seat: number): () => number {
  const progress = state.bidsActed * 64 + state.trickIndex * 8 + state.currentTrick.length + 1;
  let h = (state.seed ^ Math.imul(seat + 1, 0x9e3779b1) ^ Math.imul(progress, 0x85ebca77)) >>> 0;
  for (const c of state.hands[seat]) h = (Math.imul(h, 31) + encodeCard(c)) >>> 0;
  return mulberry32(h);
}

const signalToNum = (sig: HandSignal | null): number => (sig === "strong" ? 2 : sig === "weak" ? 0 : 1);

// ---------- profile-based signal calibration ----------

// Reliability score for a signal level: fraction of times the player bid and
// made it when they emitted that signal. Returns null if no data yet.
function signalReliability(prof: PlayerProfile, level: "weak" | "medium" | "strong"): number | null {
  const rec = prof?.signalRecord?.[level];
  return rec && rec.bid >= 3 ? rec.made / rec.bid : null;
}

// Calibrated signal strength [0..2]. Adjusts the raw signal up/down based on
// how reliable this player's signals have proven to be:
//   - "strong" from a player who rarely makes good on it → deflated toward 1
//   - "weak" from a player who always sandbags → inflated toward 1
// Falls back to the raw signal when there's not enough data.
function calibratedSignal(sig: HandSignal | null, prof: PlayerProfile): number {
  const raw = signalToNum(sig);
  const level = isHandSignal(sig) ? sig : "medium";
  const rel = signalReliability(prof, level);
  if (rel === null) return raw; // not enough history

  // Adjust: expected reliability for strong=0.7, medium=0.5, weak=0.2.
  const expected = level === "strong" ? 0.7 : level === "medium" ? 0.5 : 0.2;
  const delta = rel - expected; // positive = more reliable than expected
  // Each 0.1 delta moves the signal by 0.2 points, clamped to [0,2].
  return clamp(raw + delta * 2, 0, 2);
}

// ---------- heuristic card play ----------

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

  const remaining = tricksRemaining(state, seat);
  const unseenTrumps = unseenTrumpCount(state, trump, state.hands[seat]);
  const myTrumps = cards.filter((c) => isTrump(c, trump));
  const isLast = state.currentTrick.length === players - 1;

  // ---------- leading ----------
  if (state.currentTrick.length === 0) {
    // Heuristic 1: trump pulling.
    // If enough unseen trumps remain (relative to hand size), keep leading trumps.
    const isDeclarer = state.winningBid?.seat === seat;
    const earlyDeclarerPull = isDeclarer && state.trickIndex <= 1 && myTrumps.length >= 2;
    const shouldPullTrumps = earlyDeclarerPull || (myTrumps.length > 0
      && unseenTrumps > 0
      && unseenTrumps / (remaining * (players - 1)) >= p.trumpPullFrac);

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
          // Never lead the Joker while opponents still hold higher trump — it loses the trick.
          const voids = trumpVoidSeats(state, trump);
          const allOppsVoid = [...Array(players).keys()]
            .filter((i) => i !== seat && teamOf(i) !== myTeam)
            .every((i) => voids.has(i));
          const jokerSafeToLead = allOppsVoid || higherTrumpsAllAccountedFor(state, trump, { joker: true } as Card, cards);
          const safe = nonBoss.filter((c) => !(c === jack && !jackSafe) && !(isJoker(c) && !jokerSafeToLead));
          if (safe.length) return asMove(pick(safe, (c) => trumpValue(c, trump)!, "max"));
        }
      }

      // Heuristic 2 (Low bait): if we don't hold Low and trumps need pulling,
      // lead the second-lowest trump to force Low out — unless that is an
      // unprotected Jack (Heuristic 3 still holds).
      const myLow = myTrumps.find((c) => !isJoker(c) && c.rank === low);
      if (!myLow && shouldPullTrumps && myTrumps.length >= 2) {
        const byVal = myTrumps.slice().sort((a, b) => trumpValue(a, trump)! - trumpValue(b, trump)!);
        // Second-lowest (index 1) baits Low without giving it away.
        const bait = byVal[1];
        const bareJack = !isJoker(bait) && bait.rank === 11
          && !myTrumps.some((c) => !isJoker(c) && c.rank > 11)
          && !higherTrumpsAllAccountedFor(state, trump, bait, state.hands[seat]);
        if (!bareJack) return asMove(bait);
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
  const trumpLedThisTrick = isTrump(state.currentTrick[0].card, trump);

  // The Joker is safe to play only when it cannot be over-trumped:
  //   – trump was led (trick is already a trump trick), OR
  //   – all opponents are known trump-void, OR
  //   – every other trump is accounted for in completed tricks or own hand, OR
  //   – we are the last to play.
  const voids = trumpVoidSeats(state, trump);
  const allOpponentsVoid = [...Array(players).keys()]
    .filter((i) => i !== seat && teamOf(i) !== myTeam)
    .every((i) => voids.has(i));
  const jokerSafe = trumpLedThisTrick
    || allOpponentsVoid
    || higherTrumpsAllAccountedFor(state, trump, { joker: true } as Card, cards)
    || isLast;

  const wouldWin = (c: Card) => trickWinner([...state.currentTrick, { seat, card: c }], trump) === seat;
  // Never volunteer the Joker to win unless it's safe.
  const winners = cards.filter((c) => wouldWin(c) && (!isJoker(c) || jokerSafe));

  if (partnerWinning) {
    // Heuristic 6: read the winning teammate's signal to judge whether a modest
    // win is safe to load.
    const partnerSeat = winnerSeat;
    const partnerCalibrated = calibratedSignal(state.signals[partnerSeat], state.profiles[partnerSeat]);
    const winVal = trumpValue(winnerCard, trump);
    // A trump above every trump still hidden from us can't be beaten.
    const partnerStrong = winVal !== null
      ? (winVal > hiddenTopTrump(state, trump, state.hands[seat]) || winVal >= 12 || partnerCalibrated >= p.loadSignalThreshold)
      : partnerCalibrated >= p.loadSignalThreshold;

    // Don't overtake partner — except, playing last, with the Joker, Jack or
    // Low: the trick is ours whoever takes it, so they bank their points.
    const banks = (c: Card) => isJoker(c) || (c.suit === trump && (c.rank === 11 || c.rank === low));
    const safe = cards.filter((c) => !wouldWin(c) || (isLast && banks(c)));
    const pool = safe.length ? safe : cards;

    if (partnerStrong || isLast) {
      // Load the most valuable card onto the trick (an over-trump is
      // impossible once we're last).
      return asMove(pick(pool, (c) => loadValue(c, trump, low), "max"));
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
    return asMove(pick(winners, (c) => winCost(c, trump, low, isLast), "min"));
  }
  return asMove(bestDiscard(cards, trump, low, p, myTeamAhead));
}

// ---------- Monte Carlo card play ----------

// Rollout work per decision, in simulated card plays (about a millisecond in
// Node); worlds = budget / (candidates * cards left), clamped.
const PLAY_BUDGET = 12000;
const MIN_WORLDS = 12;
const MAX_WORLDS = 120;
// Utility (win-probability points) by which the search must beat the
// heuristic's card before it overrides it.
const TIE_MARGIN = 0.1;

function stakesFor(state: GameState, seat: number): HandStakes {
  return {
    myTeam: teamOf(seat),
    bidderTeam: teamOf(state.winningBid!.seat),
    bid: state.winningBid!.amount,
    scores: state.scores,
    target: state.target,
  };
}

// Pick a card by sampling worlds consistent with what this seat has seen and
// playing each candidate out. The heuristic choice wins ties (and near-ties),
// so the search only overrides it when it finds a clearly better card.
function decidePlayMC(state: GameState, seat: number, rng: () => number, p: Personality): Move {
  const legal = legalMoves(state)
    .filter((m): m is Extract<Move, { type: "play" }> => m.type === "play")
    .map((m) => m.card);
  const heuristic = decidePlay(state, seat, p);
  if (legal.length === 1 || heuristic.type !== "play") return heuristic;

  const ctx = buildContext(state, seat, state.trump!);
  const cands = legal.map(encodeCard);
  const worlds = clamp(Math.floor(PLAY_BUDGET / (cands.length * cardsLeft(ctx))), MIN_WORLDS, MAX_WORLDS);
  const values = evaluatePlays(ctx, cands, stakesFor(state, seat), worlds, rng);

  const h = cands.indexOf(encodeCard(heuristic.card));
  let best = 0;
  for (let i = 1; i < cands.length; i++) if (values[i] > values[best]) best = i;
  return { type: "play", seat, card: legal[values[best] > values[h] + TIE_MARGIN ? best : h] };
}

// ---------- Monte Carlo bidding ----------

// Worlds per estimate: about BID_BUDGET simulated card plays, kept within
// [200, 250] — fewer measurably weakened bidding, more bought nothing. That is
// 250 worlds with 4 players and 200 with 6 or 8.
const BID_BUDGET = 7200;
const BID_MIN_WORLDS = 200;
const BID_MAX_WORLDS = 250;
const DEALER_WORLD_SHARE = 0.6;
// Extra margin a non-dealer needs to outbid its own partner.
const PARTNER_PREMIUM = 4;

// Mean utility of a point histogram (see ai-sim pointHistogram) under `stakes`.
function expectedUtility(hist: Float64Array, stakes: HandStakes): number {
  let u = 0, total = 0;
  for (let a = 0; a < 7; a++) {
    for (let b = 0; a + b <= 6; b++) {
      const h = hist[a * 7 + b];
      if (h) {
        u += h * handUtility(stakes, a, b);
        total += h;
      }
    }
  }
  return u / total;
}

function decideBid(state: GameState, seat: number, rng: () => number, p: Personality): Move {
  const isDealer = seat === state.dealerSeat;
  const high = state.highBid;
  const needed = high === null ? 2 : isDealer ? high.amount : high.amount + 1;
  if (needed > 6) return { type: "pass", seat };

  // Value of each bid level if we win the auction and lead our best suit. Both
  // estimates below sample the same worlds (same seed), so they compare fairly.
  const myTeam = teamOf(seat);
  const hand = state.hands[seat];
  const lead = openingLead(hand, state.players);
  const ctx = buildContext(state, seat, lead.suit);
  // A dealer facing a bid runs two estimates; on shared worlds the comparison
  // is less noisy, so each can use fewer of them.
  const share = isDealer && high !== null ? DEALER_WORLD_SHARE : 1;
  const worlds = Math.round(share * clamp(Math.floor(BID_BUDGET / cardsLeft(ctx)), BID_MIN_WORLDS, BID_MAX_WORLDS));
  const seed = Math.floor(rng() * 0x100000000);
  const outlook = pointHistogram(ctx, encodeCard(lead), worlds, mulberry32(seed));
  const value = (bid: number) =>
    expectedUtility(outlook, { myTeam, bidderTeam: myTeam, bid, scores: state.scores, target: state.target });
  let bestBid = needed;
  for (let b = needed + 1; b <= 6; b++) if (value(b) > value(bestBid)) bestBid = b;

  // The dealer can't pass a hand nobody bid.
  if (isDealer && high === null) return { type: "bid", seat, amount: bestBid };

  // Value of passing. The dealer's pass is final — the high bidder plays its
  // contract — so simulate exactly that. Earlier seats can't know who will end
  // up with the hand; they compare against the pre-hand win probability, and
  // need a premium to take the contract from their own partner.
  let passValue: number;
  if (isDealer && high !== null) {
    const passOutlook = otherBidderHistogram(ctx, high.seat, worlds, mulberry32(seed));
    passValue = expectedUtility(passOutlook, {
      myTeam,
      bidderTeam: teamOf(high.seat),
      bid: high.amount,
      scores: state.scores,
      target: state.target,
    });
  } else {
    const opp = 1 - myTeam;
    passValue = 100 * winProb(state.target - state.scores[myTeam], state.target - state.scores[opp], state.target);
    if (high !== null && teamOf(high.seat) === myTeam) passValue += PARTNER_PREMIUM;
  }
  return value(bestBid) >= passValue + p.bidMargin ? { type: "bid", seat, amount: bestBid } : { type: "pass", seat };
}

// ---------- public entry points ----------

export function aiMove(
  state: GameState,
  seat: number,
  rng: () => number = stateRng(state, seat),
  personality: Personality = PERSONALITIES.balanced,
): Move {
  if (state.phase === "gameOver") throw new Error("game is over");
  // A completed trick waiting on the table: the only move is to advance it.
  if (state.phase === "trickComplete") return legalMoves(state)[0];
  const turnSeat = state.phase === "bidding" ? state.bidTurn : state.turn;
  if (turnSeat !== seat) throw new Error(`not seat ${seat}'s turn (it is seat ${turnSeat}'s)`);

  if (state.phase === "bidding") return decideBid(state, seat, rng, personality);
  // Name trump by leading it (never selectTrump — that would reveal trump
  // before the first card is played).
  if (state.trump === null) return { type: "play", seat, card: openingLead(state.hands[seat], state.players) };
  return decidePlayMC(state, seat, rng, personality);
}

export { suitValue, bestSuit };

// The public hand signal a bot sends while bidding (hlj-module botAux).
export function handConfidence(hand: Card[], players: number): HandSignal {
  return (["weak", "medium", "strong"] as const)[signalLevel(bestSuit(hand, players).score)];
}
