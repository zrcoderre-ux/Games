// hand-eval.ts — Monte Carlo evaluation of specific HLJ hand archetypes.
//
// Usage:
//   npx tsx src/hand-eval.ts
//   npx tsx src/hand-eval.ts --trials 2000 --players 6

import {
  buildDeck, createGame, applyMove,
  legalMoves, lowRankFor, isJoker, isTrump, sameCard,
  SUITS, type Card, type Suit, type GameState,
} from "./engine.ts";
import { aiMove, suitValue, bestSuit, PERSONALITIES } from "./ai.ts";

const args = process.argv.slice(2);
const getArg = (flag: string, def: number) => {
  const i = args.indexOf(flag); return i >= 0 ? parseInt(args[i + 1], 10) : def;
};
const TRIALS  = getArg("--trials", 2000);
const PLAYERS = getArg("--players", 4) as 4 | 6 | 8;
const TARGET  = 999;

// ---------- helpers ----------

const C  = (rank: number, suit: Suit): Card => ({ rank, suit });
const JK: Card = { joker: true };
const A  = (s: Suit) => C(14, s);
const K  = (s: Suit) => C(13, s);
const Q  = (s: Suit) => C(12, s);
const J  = (s: Suit) => C(11, s);
const T  = (s: Suit) => C(10, s);
const low = lowRankFor(PLAYERS);  // 8 for 4p, 5 for 6p, 2 for 8p
const LOW = (s: Suit) => C(low, s);

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

function dealFixed(fixedHand: Card[], seed: number): GameState | null {
  const deck = buildDeck(PLAYERS);
  const remaining = deck.filter(d => !fixedHand.some(f => sameCard(f, d)));
  if (remaining.length !== deck.length - fixedHand.length) return null;

  const shuffled = shuffle(remaining, seed);
  const hands: Card[][] = [fixedHand.slice()];
  let idx = 0;
  for (let seat = 1; seat < PLAYERS; seat++) {
    hands.push(shuffled.slice(idx, idx + 6));
    idx += 6;
  }
  const kitty = shuffled.slice(idx, idx + 5);

  const base = createGame(PLAYERS, seed, TARGET);
  return { ...base, hands, dealtHands: hands.map(h => [...h]), kitty, dealerSeat: 0, bidTurn: 1 };
}

function simulateHand(state: GameState): { pts: number; jokerInKitty: boolean } {
  const p   = PERSONALITIES.balanced;
  const fixedTrump = bestSuit(state.hands[0], PLAYERS).suit;
  const jokerInKitty = state.kitty.some(c => isJoker(c));

  let s = state;
  let moves = 0;

  while (s.phase === "bidding") {
    const seat = s.bidTurn;
    const lm   = legalMoves(s);
    let move;
    if (seat === 0) {
      const bidMoves = lm.filter(m => m.type === "bid");
      move = bidMoves.length ? bidMoves[bidMoves.length - 1] : lm.find(m => m.type === "pass")!;
    } else {
      move = aiMove(s, seat, undefined, p);
    }
    s = applyMove(s, move);
    if (++moves > 10_000) return { pts: -1, jokerInKitty };
  }

  if (s.winningBid?.seat !== 0) return { pts: -1, jokerInKitty };

  if (s.trump === null)
    s = applyMove(s, { type: "selectTrump", seat: 0, suit: fixedTrump });

  while (s.phase === "playing") {
    s = applyMove(s, aiMove(s, s.turn, undefined, p));
    if (++moves > 10_000) return { pts: -1, jokerInKitty };
  }

  return { pts: s.lastHand?.pointsByTeam[0] ?? 0, jokerInKitty };
}

// ---------- evaluate ----------

type HandSpec = { name: string; hand: Card[]; trump: Suit };

function evaluate(spec: HandSpec): void {
  const { name, hand, trump } = spec;
  if (hand.length !== 6) { console.log(`SKIP ${name}: need 6 cards`); return; }

  const evalScore = suitValue(hand, trump, PLAYERS).toFixed(2);

  let discarded = 0, made6 = 0, made5 = 0, made4 = 0, madeLess = 0;
  let jkKitty6 = 0, jkKitty5 = 0, jkKittyMiss = 0;
  let jkPlay6  = 0, jkPlay5  = 0, jkPlayMiss  = 0;

  for (let seed = 1; seed <= TRIALS; seed++) {
    const state = dealFixed(hand, seed);
    if (!state) { console.log(`SKIP ${name}: invalid`); return; }
    const { pts, jokerInKitty } = simulateHand(state);
    if (pts < 0) { discarded++; continue; }

    if (jokerInKitty) {
      if (pts >= 6) jkKitty6++; else if (pts >= 5) jkKitty5++; else jkKittyMiss++;
    } else {
      if (pts >= 6) jkPlay6++;  else if (pts >= 5) jkPlay5++;  else jkPlayMiss++;
    }

    if (pts >= 6) made6++;
    else if (pts >= 5) made5++;
    else if (pts >= 4) made4++;
    else madeLess++;
  }

  const total = made6 + made5 + made4 + madeLess;
  const jkK = jkKitty6 + jkKitty5 + jkKittyMiss;
  const jkP = jkPlay6  + jkPlay5  + jkPlayMiss;
  const pct = (n: number, d: number) => d ? (100*n/d).toFixed(1).padStart(5)+"%" : "   —%";

  console.log(`${name.padEnd(34)} score=${evalScore}  6pts=${pct(made6,total)}  5pts=${pct(made5,total)}  ≤4=${pct(made4+madeLess,total)}`);
  if (jkK > 0)
    console.log(`  ${"joker in kitty".padEnd(32)} (${jkK.toString().padStart(4)} trials)  6pts=${pct(jkKitty6,jkK)}  5pts=${pct(jkKitty5,jkK)}  ≤4=${pct(jkKittyMiss,jkK)}`);
  if (jkP > 0)
    console.log(`  ${"joker in play".padEnd(32)} (${jkP.toString().padStart(4)} trials)  6pts=${pct(jkPlay6,jkP)}  5pts=${pct(jkPlay5,jkP)}  ≤4=${pct(jkPlayMiss,jkP)}`);
}

// ---------- test matrix ----------

const S: Suit = "S";

console.log(`\nHLJ Hand Eval  |  ${PLAYERS}p  |  low=${low}  |  ${TRIALS} trials\n`);
console.log("name".padEnd(34) + "         6pts    5pts    ≤4pts");
console.log("─".repeat(78));

if (PLAYERS === 4) {
  console.log("\n--- 4-player (low=8) ---");
  evaluate({ name: "A K Q J Low Joker (all 6)",    hand: [A(S),K(S),Q(S),J(S),LOW(S),JK],           trump: S });
  evaluate({ name: "A K Q J Low side",              hand: [A(S),K(S),Q(S),J(S),LOW(S),T("H")],       trump: S });
  evaluate({ name: "A K Q J Joker side",            hand: [A(S),K(S),Q(S),J(S),JK,T("H")],           trump: S });
  evaluate({ name: "A K Q J Joker 9",               hand: [A(S),K(S),Q(S),J(S),JK,C(9,S)],           trump: S });
  evaluate({ name: "A K Q J 9 side",                hand: [A(S),K(S),Q(S),J(S),C(9,S),T("H")],       trump: S });
  evaluate({ name: "A K Q J Low+1 (no Joker)",      hand: [A(S),K(S),Q(S),J(S),LOW(S),C(9,S)],       trump: S });
} else if (PLAYERS === 6) {
  console.log("\n--- 6-player (low=5) ---");
  evaluate({ name: "A K Q J Low Joker (all 6)",    hand: [A(S),K(S),Q(S),J(S),LOW(S),JK],           trump: S });
  evaluate({ name: "A K Q J Low side",              hand: [A(S),K(S),Q(S),J(S),LOW(S),T("H")],       trump: S });
  evaluate({ name: "A K Q J Joker side",            hand: [A(S),K(S),Q(S),J(S),JK,T("H")],           trump: S });
  evaluate({ name: "A K Q J Joker 9",               hand: [A(S),K(S),Q(S),J(S),JK,C(9,S)],           trump: S });
  evaluate({ name: "A K Q J side side",             hand: [A(S),K(S),Q(S),J(S),T("H"),A("H")],       trump: S });
  evaluate({ name: "A K Q J 9(S) side",             hand: [A(S),K(S),Q(S),J(S),C(9,S),T("H")],       trump: S });
  evaluate({ name: "A K Q J Low+1 (no Joker)",      hand: [A(S),K(S),Q(S),J(S),LOW(S),C(9,S)],       trump: S });
  evaluate({ name: "A K Q J 10 9 (bulk trumps)",    hand: [A(S),K(S),Q(S),J(S),T(S),C(9,S)],         trump: S });
  evaluate({ name: "A K Q J (+ 2 off-suit weak)",   hand: [A(S),K(S),Q(S),J(S),C(8,"H"),C(7,"C")],   trump: S });
  evaluate({ name: "A K Q 10 9 side (no J)",        hand: [A(S),K(S),Q(S),T(S),C(9,S),T("H")],       trump: S });
  evaluate({ name: "A K J Low Joker side (no Q)",   hand: [A(S),K(S),J(S),LOW(S),JK,T("H")],         trump: S });
} else {
  console.log("\n--- 8-player (low=2) ---");
  evaluate({ name: "A K Q J Low Joker (all 6)",    hand: [A(S),K(S),Q(S),J(S),LOW(S),JK],           trump: S });
  evaluate({ name: "A K Q J Low side",              hand: [A(S),K(S),Q(S),J(S),LOW(S),T("H")],       trump: S });
  evaluate({ name: "A K Q J Joker side",            hand: [A(S),K(S),Q(S),J(S),JK,T("H")],           trump: S });
  evaluate({ name: "A K Q J side side",             hand: [A(S),K(S),Q(S),J(S),T("H"),A("H")],       trump: S });
  evaluate({ name: "A K Q J 9(S) side",             hand: [A(S),K(S),Q(S),J(S),C(9,S),T("H")],       trump: S });
  evaluate({ name: "A K Q J Low+1 (no Joker)",      hand: [A(S),K(S),Q(S),J(S),LOW(S),C(9,S)],       trump: S });
}
