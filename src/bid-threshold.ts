// bid-threshold.ts — Find minimum hand strength for each bid level (4, 5, 6).
// npx tsx src/bid-threshold.ts --players 6 --trials 2000

import {
  buildDeck, createGame, applyMove, legalMoves,
  lowRankFor, isJoker, sameCard,
  type Card, type Suit, type GameState,
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

function simulate(hand: Card[]): { p4: number; p5: number; p6: number } {
  const p = PERSONALITIES.balanced;
  const fixedTrump = bestSuit(hand, PLAYERS).suit;
  let m4=0, m5=0, m6=0, total=0;
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
    total++;
    if (pts >= 4) m4++;
    if (pts >= 5) m5++;
    if (pts >= 6) m6++;
  }
  return total ? { p4: m4/total, p5: m5/total, p6: m6/total } : { p4:0, p5:0, p6:0 };
}

function pct(r: number) { return (100*r).toFixed(0).padStart(3)+"%"; }
function mark(r: number, t: number) { return r >= t ? "✓" : r >= t-0.15 ? "~" : " "; }

function test(name: string, hand: Card[]) {
  const { p4, p5, p6 } = simulate(hand);
  const tags = [mark(p4,0.70),mark(p5,0.70),mark(p6,0.70)].join("");
  console.log(`  ${tags}  ${pct(p4)} ${pct(p5)} ${pct(p6)}   ${name}`);
}

console.log(`\nBid Success Rates  |  ${PLAYERS}p  |  low=${low}  |  ${TRIALS} trials`);
console.log(`(✓ = ≥70%, ~ = 55–69%)\n`);
console.log(`         ≥4   ≥5   ≥6   hand`);
console.log("─".repeat(70));

// ── 6-point hands ────────────────────────────────────────────────────────────
console.log("\n[All 6 trump (A K Q J low Joker)]");
test("A K Q J low Joker",              [C(14,S),C(13,S),C(12,S),C(11,S),C(low,S),JK]);

// ── Strong 5-trump hands ──────────────────────────────────────────────────────
console.log("\n[5 key trumps]");
test("A K Q J Joker + filler",         [C(14,S),C(13,S),C(12,S),C(11,S),JK,C(10,"H")]);
test("A K Q J low + filler",           [C(14,S),C(13,S),C(12,S),C(11,S),C(low,S),C(10,"H")]);
test("A K Q J 9(S) + filler",          [C(14,S),C(13,S),C(12,S),C(11,S),C(9,S),C(10,"H")]);

// ── 4 key trumps ─────────────────────────────────────────────────────────────
console.log("\n[4 key trumps]");
test("A K Q J (2 fillers)",            [C(14,S),C(13,S),C(12,S),C(11,S),C(10,"H"),C(9,"H")]);
test("A K Q Joker (2 fillers)",        [C(14,S),C(13,S),C(12,S),JK,C(10,"H"),C(9,"H")]);
test("A K J Joker (2 fillers)",        [C(14,S),C(13,S),C(11,S),JK,C(10,"H"),C(9,"H")]);
test("A Q J Joker (2 fillers)",        [C(14,S),C(12,S),C(11,S),JK,C(10,"H"),C(9,"H")]);
test("A K Q low (2 fillers)",          [C(14,S),C(13,S),C(12,S),C(low,S),C(10,"H"),C(9,"H")]);
test("A K J low (2 fillers)",          [C(14,S),C(13,S),C(11,S),C(low,S),C(10,"H"),C(9,"H")]);

// ── 3 key trumps ─────────────────────────────────────────────────────────────
console.log("\n[3 key trumps]");
test("A K Q (3 fillers)",              [C(14,S),C(13,S),C(12,S),C(10,"H"),C(9,"H"),C(8,"H")]);
test("A K J (3 fillers)",              [C(14,S),C(13,S),C(11,S),C(10,"H"),C(9,"H"),C(8,"H")]);
test("A K Joker (3 fillers)",          [C(14,S),C(13,S),JK,C(10,"H"),C(9,"H"),C(8,"H")]);
test("A J Joker (3 fillers)",          [C(14,S),C(11,S),JK,C(10,"H"),C(9,"H"),C(8,"H")]);
test("A Q J (3 fillers)",              [C(14,S),C(12,S),C(11,S),C(10,"H"),C(9,"H"),C(8,"H")]);
test("K Q J Joker (2 fillers)",        [C(13,S),C(12,S),C(11,S),JK,C(10,"H"),C(9,"H")]);
test("A low Joker (3 fillers)",        [C(14,S),C(low,S),JK,C(10,"H"),C(9,"H"),C(8,"H")]);

// ── 2 key trumps ─────────────────────────────────────────────────────────────
console.log("\n[2 key trumps]");
test("A K (4 fillers)",                [C(14,S),C(13,S),C(10,"H"),C(9,"H"),C(8,"H"),C(7,"H")]);
test("A J (4 fillers)",                [C(14,S),C(11,S),C(10,"H"),C(9,"H"),C(8,"H"),C(7,"H")]);
test("A Joker (4 fillers)",            [C(14,S),JK,C(10,"H"),C(9,"H"),C(8,"H"),C(7,"H")]);
test("K J Joker (3 fillers)",          [C(13,S),C(11,S),JK,C(10,"H"),C(9,"H"),C(8,"H")]);
