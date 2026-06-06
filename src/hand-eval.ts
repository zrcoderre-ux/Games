// hand-eval.ts — Monte Carlo evaluation of specific HLJ hand archetypes.
//
// For each test hand, deals the remaining cards randomly to opponents + kitty,
// then plays the hand out with balanced AI on all sides and records whether
// the test seat scored all 6 points.
//
// Usage:
//   npx tsx src/hand-eval.ts
//   npx tsx src/hand-eval.ts --trials 2000

import {
  buildDeck, createGame, applyMove, scoreHand,
  legalMoves, lowRankFor, isJoker, isTrump, sameCard,
  SUITS, type Card, type Suit, type GameState,
} from "./engine.ts";
import { aiMove, suitValue, bestSuit, PERSONALITIES } from "./ai.ts";

const args = process.argv.slice(2);
const getArg = (flag: string, def: number) => {
  const i = args.indexOf(flag); return i >= 0 ? parseInt(args[i + 1], 10) : def;
};
const TRIALS = getArg("--trials", 1000);
const PLAYERS = 4 as 4 | 6 | 8;
const TARGET = 999; // never ends early on score

// ---------- hand construction helpers ----------

const C = (rank: number, suit: Suit): Card => ({ rank, suit });
const JK: Card = { joker: true };
const A = (s: Suit) => C(14, s);
const K = (s: Suit) => C(13, s);
const Q = (s: Suit) => C(12, s);
const J = (s: Suit) => C(11, s);
const T = (s: Suit) => C(10, s);
const low4 = lowRankFor(4); // 8 for 4-player

// Shuffle array with seeded PRNG (mulberry32)
function shuffle<X>(arr: X[], seed: number): X[] {
  let a = seed >>> 0;
  const rng = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Force seat 0's hand to be `fixedHand`, deal remaining cards randomly.
function dealFixed(fixedHand: Card[], seed: number): GameState | null {
  const deck = buildDeck(PLAYERS);
  const remaining = deck.filter(d => !fixedHand.some(f => sameCard(f, d)));
  if (remaining.length !== deck.length - fixedHand.length) return null; // bad hand spec

  const shuffled = shuffle(remaining, seed);
  const hands: Card[][] = [fixedHand.slice()];
  let idx = 0;
  for (let seat = 1; seat < PLAYERS; seat++) {
    hands.push(shuffled.slice(idx, idx + 6));
    idx += 6;
  }
  const kitty = shuffled.slice(idx, idx + 5);

  // Build a synthetic state from createGame then override hands/kitty/seed.
  const base = createGame(PLAYERS, seed, TARGET);
  return {
    ...base,
    hands,
    dealtHands: hands.map(h => [...h]),
    kitty,
    dealerSeat: 0, // seat 0 bids first (after dealer), adjust as needed
    bidTurn: 1,    // dealer=0, so bidding starts at seat 1
  };
}

// Play one hand out with balanced AI and return how many points seat 0's team scored.
function simulateHand(state: GameState, seed: number): number {
  const p = PERSONALITIES.balanced;

  // Let seat 0 always declare the trump suit that maximises their hand score.
  const fixedTrump = bestSuit(state.hands[0], PLAYERS).suit;

  let s = state;
  let moves = 0;

  while (s.phase === "bidding") {
    const seat = s.bidTurn;
    const lm = legalMoves(s);
    let move;
    if (seat === 0) {
      // Seat 0: always bid the max (6) to guarantee they are the bidder and choose trump.
      const bidMoves = lm.filter(m => m.type === "bid");
      move = bidMoves.length ? bidMoves[bidMoves.length - 1] : lm.find(m => m.type === "pass")!;
    } else {
      move = aiMove(s, seat, undefined, p);
    }
    s = applyMove(s, move);
    if (++moves > 10000) return -1;
  }

  // If seat 0 didn't win the bid, this trial is discarded (we only care about
  // hands where seat 0 is the bidder and sets trump).
  if (s.winningBid?.seat !== 0) return -1;

  // Declare our chosen trump if not already set.
  if (s.trump === null) {
    s = applyMove(s, { type: "selectTrump", seat: 0, suit: fixedTrump });
  }

  while (s.phase === "playing") {
    const seat = s.turn;
    const move = aiMove(s, seat, undefined, p);
    s = applyMove(s, move);
    if (++moves > 10000) return -1;
  }

  // Extract points scored by team 0 (seats 0 and 2).
  const scored = s.lastHand?.pointsByTeam[0] ?? 0;
  return scored;
}

// ---------- evaluate a named hand ----------

type HandSpec = { name: string; hand: Card[]; trump: Suit };

function evaluate(spec: HandSpec): void {
  const { name, hand, trump } = spec;
  if (hand.length !== 6) { console.log(`SKIP ${name}: hand has ${hand.length} cards`); return; }

  const evalScore = suitValue(hand, trump, PLAYERS).toFixed(2);

  let discarded = 0, made6 = 0, made5 = 0, made4 = 0, madeLess = 0, total = 0;

  for (let seed = 1; seed <= TRIALS; seed++) {
    const state = dealFixed(hand, seed);
    if (!state) { console.log(`SKIP ${name}: invalid hand`); return; }
    const pts = simulateHand(state, seed);
    if (pts < 0) { discarded++; continue; }
    total++;
    if (pts >= 6) made6++;
    else if (pts >= 5) made5++;
    else if (pts >= 4) made4++;
    else madeLess++;
  }

  const pct = (n: number) => total ? (100 * n / total).toFixed(1).padStart(5) + "%" : "   —%";
  console.log(
    `${name.padEnd(36)} score=${evalScore}  6pts=${pct(made6)}  5pts=${pct(made5)}  ≤4=${pct(madeLess)}  (n=${total})`
  );
}

// ---------- test matrix ----------

console.log(`\nHand evaluation  |  ${PLAYERS}p  |  ${TRIALS} trials each\n`);
console.log("name".padEnd(36) + " score    6pts    5pts     ≤4");
console.log("─".repeat(80));

const S: Suit = "S"; // spades as trump for all tests

// Perfect / near-perfect hands
evaluate({ name: "A J Low Joker Q K (6 trumps)",     hand: [A(S), J(S), C(low4,S), JK, Q(S), K(S)],         trump: S });
evaluate({ name: "A J Low Joker K T(S) (T=trump)",   hand: [A(S), J(S), C(low4,S), JK, K(S), T(S)],         trump: S });
evaluate({ name: "A J Low Joker Q T(H) (side T)",    hand: [A(S), J(S), C(low4,S), JK, Q(S), T("H")],       trump: S });
evaluate({ name: "A J Low Joker K 9(S)",              hand: [A(S), J(S), C(low4,S), JK, K(S), C(9,S)],       trump: S });
evaluate({ name: "A J Low Joker Q 9(S)",              hand: [A(S), J(S), C(low4,S), JK, Q(S), C(9,S)],       trump: S });
evaluate({ name: "A J Low Joker Q 8(H) (side card)", hand: [A(S), J(S), C(low4,S), JK, Q(S), C(8,"H")],     trump: S });
evaluate({ name: "A J Low Joker 9 8 (4 nat trumps)", hand: [A(S), J(S), C(low4,S), JK, C(9,S), C(8,"C")],   trump: S });

console.log();

// Without Joker
evaluate({ name: "A J Low K Q + T(H) [no Joker]",    hand: [A(S), J(S), C(low4,S), K(S), Q(S), T("H")],     trump: S });
evaluate({ name: "A J Low K Q 9 [no Joker]",          hand: [A(S), J(S), C(low4,S), K(S), Q(S), C(9,S)],     trump: S });
evaluate({ name: "A J Low K T(S) + A(H) [no Joker]", hand: [A(S), J(S), C(low4,S), K(S), T(S), A("H")],     trump: S });

console.log();

// Without Jack
evaluate({ name: "A Low Joker K Q T(S) [no J]",      hand: [A(S), C(low4,S), JK, K(S), Q(S), T(S)],         trump: S });
evaluate({ name: "A Low Joker K Q A(H) [no J]",      hand: [A(S), C(low4,S), JK, K(S), Q(S), A("H")],       trump: S });

console.log();

// Good but not perfect
evaluate({ name: "A J Joker K Q (no Low)",            hand: [A(S), J(S), JK, K(S), Q(S), T("H")],            trump: S });
evaluate({ name: "A J Low K Q (no Joker, no Low)",    hand: [A(S), J(S), K(S), Q(S), T(S), T("H")],          trump: S });
evaluate({ name: "A J Joker K (4 trumps, no Low)",    hand: [A(S), J(S), JK, K(S), T("H"), A("H")],          trump: S });
