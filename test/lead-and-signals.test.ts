// HLJ opening lead (trump by pitching) and the bots' bidding.
// Run with `npm test` (or `node --test test/lead-and-signals.test.ts`).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createGame,
  applyMove,
  legalMoves,
  isJoker,
  type GameState,
  type Move,
  type Card,
  type Suit,
} from "../src/engine.ts";
import { aiMove, bestSuit } from "../src/ai.ts";
import { hljModule, type HljState } from "../src/hlj-module.ts";

// The dealer rotates with the seed (dealerSeat = seed % players) and the
// opener sits to the dealer's left. The opener takes the bid at 2 and everyone
// else passes, so the opener is the bidder.
function resolveBidding(seed: number): GameState {
  let g = createGame(4, seed);
  const first = (g.dealerSeat + 1) % 4;
  for (let i = 0; i < 4; i++) {
    const seat = (first + i) % 4;
    g = applyMove(g, i === 0 ? { type: "bid", seat, amount: 2 } : { type: "pass", seat });
  }
  return g;
}
const bidderOf = (g: GameState): number => g.winningBid!.seat;

// ---------- trump on the opening lead ----------

test("after bidding, play begins with trump undeclared and the bidder to lead", () => {
  const g = resolveBidding(2);
  assert.equal(g.phase, "playing");
  assert.equal(g.trump, null);
  assert.equal(bidderOf(g), (g.dealerSeat + 1) % 4);
  assert.equal(g.turn, bidderOf(g));
  assert.equal(g.leaderSeat, bidderOf(g));
});

test("the bidder's opening options are: declare a trump, or lead a card (no joker)", () => {
  const g = resolveBidding(2);
  const moves = legalMoves(g);
  // All four trump declarations are offered.
  for (const suit of ["C", "D", "H", "S"] as Suit[]) {
    assert.ok(moves.some((m) => m.type === "selectTrump" && m.suit === suit));
  }
  // Lead options exist and never include the joker.
  const leads = moves.filter((m): m is Extract<Move, { type: "play" }> => m.type === "play");
  assert.ok(leads.length > 0);
  assert.ok(leads.every((m) => !("joker" in m.card)));
});

test("leading without declaring sets trump to the led card's suit", () => {
  const g = resolveBidding(2);
  const lead = legalMoves(g).find((m): m is Extract<Move, { type: "play" }> => m.type === "play")!;
  const led = lead.card as { rank: number; suit: Suit };
  const after = applyMove(g, lead);
  assert.equal(after.trump, led.suit); // the led suit became trump
  assert.equal(after.currentTrick.length, 1);
  assert.equal(after.currentTrick[0].card && (after.currentTrick[0].card as any).suit, led.suit);
});

test("declaring a trump first lets the bidder then lead an off-trump card", () => {
  let g = resolveBidding(2);
  const bidder = bidderOf(g);
  const suitsHeld = new Set(g.hands[bidder].filter((c) => !("joker" in c)).map((c) => (c as any).suit));
  const trumpSuit = (["C", "D", "H", "S"] as Suit[]).find((s) => suitsHeld.has(s))!;
  g = applyMove(g, { type: "selectTrump", seat: bidder, suit: trumpSuit });
  assert.equal(g.phase, "playing");
  assert.equal(g.trump, trumpSuit);
  // Now the bidder may lead any non-joker card, including off-trump ones.
  const leads = legalMoves(g).filter((m): m is Extract<Move, { type: "play" }> => m.type === "play");
  assert.ok(leads.length > 0);
  // selectTrump is no longer offered once trump is set.
  assert.ok(!legalMoves(g).some((m) => m.type === "selectTrump"));
});

test("the AI bidder names trump by leading from its best suit (never selectTrump)", () => {
  for (const seed of [2, 7, 13, 21]) {
    const g = resolveBidding(seed);
    const bidder = bidderOf(g);
    const hand = g.hands[bidder];
    const m = aiMove(g, bidder);
    assert.equal(m.type, "play", "a declaration would reveal trump before the first card");
    if (m.type !== "play") continue;
    assert.ok(!isJoker(m.card));
    const held = (s: Suit) => hand.some((c) => !isJoker(c) && c.suit === s);
    assert.equal((m.card as { suit: Suit }).suit, bestSuit(hand, 4, held).suit);
    assert.equal(applyMove(g, m).trump, (m.card as { suit: Suit }).suit);
  }
});

// ---------- Monte Carlo bidding ----------

// A bidding position: dealer 0 (seed % 4 === 0), seats 1 and 2 have acted and
// seat 3 is to act. `highSeat` (1 = partner, 2 = opponent) holds the bid at 2.
function bidPosition(seed: number, highSeat: 1 | 2, signal: "weak" | "strong" | null = null, hand?: Card[]): GameState {
  let g = createGame(4, seed * 4);
  g = applyMove(g, highSeat === 1 ? { type: "bid", seat: 1, amount: 2 } : { type: "pass", seat: 1 });
  g = applyMove(g, highSeat === 2 ? { type: "bid", seat: 2, amount: 2 } : { type: "pass", seat: 2 });
  const signals = g.signals.slice();
  signals[highSeat] = signal;
  return { ...g, signals, hands: hand ? g.hands.map((h, s) => (s === 3 ? hand : h)) : g.hands };
}

const POWER: Card[] = [
  { rank: 14, suit: "S" }, { rank: 13, suit: "S" }, { rank: 11, suit: "S" },
  { joker: true }, { rank: 10, suit: "S" }, { rank: 9, suit: "S" },
];
const JUNK: Card[] = [
  { rank: 9, suit: "C" }, { rank: 8, suit: "D" }, { rank: 9, suit: "H" },
  { rank: 8, suit: "S" }, { rank: 10, suit: "C" }, { rank: 9, suit: "D" },
];

test("a powerhouse overcalls and junk passes, whoever holds the bid", () => {
  for (const highSeat of [1, 2] as const) {
    for (const signal of ["weak", "strong"] as const) {
      const strong = aiMove(bidPosition(1, highSeat, signal, POWER), 3);
      assert.equal(strong.type, "bid");
      if (strong.type === "bid") assert.ok(strong.amount >= 3 && strong.amount <= 6);
      assert.equal(aiMove(bidPosition(1, highSeat, signal, JUNK), 3).type, "pass");
    }
  }
});

test("a dealer nobody bid to must bid, even holding junk", () => {
  let g = createGame(4, 4); // dealer 0
  for (const seat of [1, 2, 3]) g = applyMove(g, { type: "pass", seat });
  g = { ...g, hands: g.hands.map((h, s) => (s === 0 ? JUNK : h)) };
  const m = aiMove(g, 0);
  assert.equal(m.type, "bid");
  assert.ok(legalMoves(g).some((l) => JSON.stringify(l) === JSON.stringify(m)));
});

test("the same position always gets the same bid (state-seeded randomness)", () => {
  for (let seed = 1; seed <= 10; seed++) {
    const s = bidPosition(seed, 2, "weak");
    assert.deepEqual(aiMove(s, 3), aiMove(s, 3));
  }
});

test("bids read the auction: a partner's bid is overcalled less often than an opponent's", () => {
  // Same deals, same signal; only whose bid it is changes. Taking the hand
  // from a partner needs a premium (PARTNER_PREMIUM), so across a fixed set of
  // deals the bot overcalls its partner less often.
  let overPartner = 0, overOpponent = 0, signalMatters = 0;
  for (let seed = 1; seed <= 120; seed++) {
    if (aiMove(bidPosition(seed, 1, "weak"), 3).type === "bid") overPartner++;
    const vsWeak = aiMove(bidPosition(seed, 2, "weak"), 3).type;
    const vsStrong = aiMove(bidPosition(seed, 2, "strong"), 3).type;
    if (vsWeak === "bid") overOpponent++;
    if (vsWeak !== vsStrong) signalMatters++;
  }
  assert.ok(overPartner < overOpponent, `partner ${overPartner} vs opponent ${overOpponent}`);
  // Signals shape the worlds the bidder samples, so some decisions turn on them.
  assert.ok(signalMatters > 0, "the opponent's signal changed at least one decision");
});

test("all-bot games through the module are legal and terminate at every table size", () => {
  for (const players of [4, 6, 8] as const) {
    for (let seed = 1; seed <= 3; seed++) {
      let s: HljState = hljModule.createGame({ players, target: 21 }, seed * 333 + 1);
      for (let guard = 0; s.phase !== "gameOver"; guard++) {
        assert.ok(guard < 20000, "did not terminate");
        const seat = hljModule.seatToAct(s);
        if (seat === null) { s = hljModule.applyMove(s, hljModule.pacing!(s)!.move); continue; }
        const sig = hljModule.aux!.botAux!(s, seat);
        if (sig != null) s = hljModule.aux!.apply(s, seat, sig);
        const m = hljModule.aiMove(s, seat);
        assert.ok(hljModule.isLegal(s, m), `legal: ${JSON.stringify(m)}`);
        s = hljModule.applyMove(s, m);
      }
      assert.ok(s.winner === 0 || s.winner === 1);
    }
  }
});
