// six-threshold.ts — Find the minimum hand that makes 6 pts ≥50% of the time.
// npx tsx src/six-threshold.ts --players 6 --trials 2000

import {
  buildDeck, createGame, applyMove, legalMoves,
  lowRankFor, isJoker, sameCard,
  SUITS, type Card, type Suit, type GameState,
} from "./engine.ts";
import { aiMove, bestSuit, PERSONALITIES } from "./ai.ts";

const args = process.argv.slice(2);
const getArg = (flag: string, def: number) => { const i = args.indexOf(flag); return i >= 0 ? parseInt(args[i+1],10) : def; };
const TRIALS  = getArg("--trials", 2000);
const PLAYERS = getArg("--players", 6) as 4|6|8;
const TARGET  = 999;

const C  = (rank: number, suit: Suit): Card => ({ rank, suit });
const JK: Card = { joker: true };
const S: Suit = "S";
const low = lowRankFor(PLAYERS);

function shuffle<X>(arr: X[], seed: number): X[] {
  let a = seed >>> 0;
  const rng = () => { a=(a+0x6d2b79f5)|0; let t=Math.imul(a^(a>>>15),1|a); t=(t+Math.imul(t^(t>>>7),61|t))^t; return ((t^(t>>>14))>>>0)/4294967296; };
  const out = arr.slice();
  for (let i=out.length-1;i>0;i--) { const j=Math.floor(rng()*(i+1)); [out[i],out[j]]=[out[j],out[i]]; }
  return out;
}

function dealFixed(fixedHand: Card[], seed: number): GameState|null {
  const deck = buildDeck(PLAYERS);
  const remaining = deck.filter(d => !fixedHand.some(f => sameCard(f,d)));
  if (remaining.length !== deck.length - fixedHand.length) return null;
  const shuffled = shuffle(remaining, seed);
  const hands: Card[][] = [fixedHand.slice()];
  let idx = 0;
  for (let seat=1;seat<PLAYERS;seat++) { hands.push(shuffled.slice(idx,idx+6)); idx+=6; }
  const kitty = shuffled.slice(idx,idx+5);
  const base = createGame(PLAYERS, seed, TARGET);
  return { ...base, hands, dealtHands: hands.map(h=>[...h]), kitty, dealerSeat:0, bidTurn:1 };
}

function simulate(hand: Card[]): number {
  const p = PERSONALITIES.balanced;
  const fixedTrump = bestSuit(hand, PLAYERS).suit;
  let made6 = 0, total = 0;
  for (let seed=1;seed<=TRIALS;seed++) {
    const state = dealFixed(hand, seed);
    if (!state) continue;
    let s = state;
    let moves = 0;
    while (s.phase === "bidding") {
      const seat = s.bidTurn;
      const lm = legalMoves(s);
      let move;
      if (seat === 0) {
        const bids = lm.filter(m=>m.type==="bid");
        move = bids.length ? bids[bids.length-1] : lm.find(m=>m.type==="pass")!;
      } else move = aiMove(s, seat, undefined, p);
      s = applyMove(s, move);
      if (++moves > 10_000) break;
    }
    if (s.winningBid?.seat !== 0) continue;
    if (s.trump === null) s = applyMove(s, { type:"selectTrump", seat:0, suit:fixedTrump });
    while (s.phase === "playing") { s = applyMove(s, aiMove(s, s.turn, undefined, p)); if (++moves>10_000) break; }
    const pts = s.lastHand?.pointsByTeam[0] ?? 0;
    if (pts >= 0) { total++; if (pts >= 6) made6++; }
  }
  return total ? made6/total : 0;
}

function label(hand: Card[]): string {
  return hand.map(c => "joker" in c ? "JK" : `${["","","2","3","4","5","6","7","8","9","T","J","Q","K","A"][c.rank]}${c.suit}`).join(" ");
}

function test(name: string, hand: Card[]) {
  const rate = simulate(hand);
  const pct = (100*rate).toFixed(1).padStart(5);
  const mark = rate>=0.50 ? " ✓" : "  ";
  console.log(`${mark} ${pct}%  ${name.padEnd(36)} [${label(hand)}]`);
}

console.log(`\n6-bid Make Rate  |  ${PLAYERS}p  |  low=${low}  |  ${TRIALS} trials\n`);
console.log("      make6   hand");
console.log("─".repeat(70));

// All tested with a neutral off-suit 10H as filler when needed

if (PLAYERS === 6 || PLAYERS === 4 || PLAYERS === 8) {
  // Perfect hands
  test("A K Q J Joker + filler",      [C(14,S),C(13,S),C(12,S),C(11,S),JK,C(10,"H")]);
  test("A K Q J + low(S) + filler",   [C(14,S),C(13,S),C(12,S),C(11,S),C(low,S),C(10,"H")]);
  test("A K Q J + 4 trumps only",     [C(14,S),C(13,S),C(12,S),C(11,S),C(10,S),C(9,S)]);
  console.log();

  // No Jack
  test("A K Q Joker + 2 filler",      [C(14,S),C(13,S),C(12,S),JK,C(10,"H"),C(9,"H")]);
  test("A K Q Joker + low(S) + fill", [C(14,S),C(13,S),C(12,S),JK,C(low,S),C(10,"H")]);
  test("A K Q + 3 trumps (no J/JK)",  [C(14,S),C(13,S),C(12,S),C(10,S),C(9,S),C(10,"H")]);
  console.log();

  // No Queen
  test("A K J Joker + 2 filler",      [C(14,S),C(13,S),C(11,S),JK,C(10,"H"),C(9,"H")]);
  test("A K J + low(S) + 2 filler",   [C(14,S),C(13,S),C(11,S),C(low,S),C(10,"H"),C(9,"H")]);
  test("A K J Joker + low + filler",  [C(14,S),C(13,S),C(11,S),JK,C(low,S),C(10,"H")]);
  console.log();

  // No King
  test("A Q J Joker + 2 filler",      [C(14,S),C(12,S),C(11,S),JK,C(10,"H"),C(9,"H")]);
  test("A Q J + low + 2 filler",      [C(14,S),C(12,S),C(11,S),C(low,S),C(10,"H"),C(9,"H")]);
  console.log();

  // Weaker still
  test("A K Joker + 3 filler",        [C(14,S),C(13,S),JK,C(10,"H"),C(9,"H"),C(8,"H")]);
  test("A J Joker + 3 filler",        [C(14,S),C(11,S),JK,C(10,"H"),C(9,"H"),C(8,"H")]);
  test("A Joker + 4 filler",          [C(14,S),JK,C(10,"H"),C(9,"H"),C(8,"H"),C(7,"H")]);
}
