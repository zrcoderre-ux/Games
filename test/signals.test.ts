// HLJ hand signals: the engine rules, the bots' signalling, and the view.
// Run with `npm test` (or `node --test test/signals.test.ts`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGame, applyMove, setSignal, type Card, type GameState, type Move } from "../src/engine.ts";
import { handConfidence } from "../src/ai.ts";
import { redact, type SeatInfo } from "../src/protocol.ts";
import { hljModule, type HljState } from "../src/hlj-module.ts";

const seatsOf = (n: number, humans: number[] = []): SeatInfo[] =>
  Array.from({ length: n }, (_, s) => (humans.includes(s) ? { kind: "human", name: `P${s}` } : { kind: "bot", name: `Bot ${s}` }));

// The dealer rotates with the seed (dealerSeat = seed % players), and the
// bidding opens to the dealer's left.
const opener = (g: GameState): number => (g.dealerSeat + 1) % g.players;

// Every seat in bidding order passes except the opener, who bids 2.
function resolveBidding(g: GameState): GameState {
  const first = opener(g);
  for (let i = 0; i < g.players; i++) {
    const seat = (first + i) % g.players;
    g = applyMove(g, i === 0 ? { type: "bid", seat, amount: 2 } : { type: "pass", seat });
  }
  return g;
}

// One room-driver step for an all-bot table, as RoomServer/LocalRoom do it: a
// pacing gate applies its move; otherwise the bot may signal (botAux) and then
// plays its aiMove.
function botStep(s: HljState): HljState {
  const seat = hljModule.seatToAct(s);
  if (seat === null) return hljModule.applyMove(s, hljModule.pacing!(s)!.move);
  const sig = hljModule.aux!.botAux!(s, seat);
  if (sig != null) s = hljModule.aux!.apply(s, seat, sig);
  const move = hljModule.aiMove(s, seat);
  assert.ok(hljModule.isLegal(s, move), `bot move is legal: ${JSON.stringify(move)}`);
  return hljModule.applyMove(s, move);
}

test("signals start empty each hand and can be set during bidding", () => {
  const g = createGame(4, 1);
  assert.deepEqual(g.signals, [null, null, null, null]);
  const s = setSignal(g, 2, "strong");
  assert.equal(s.signals[2], "strong");
  // Other seats untouched; the original state is not mutated.
  assert.deepEqual(s.signals, [null, null, "strong", null]);
  assert.equal(g.signals[2], null);
});

test("a signal can be changed while bidding is open", () => {
  let g = createGame(4, 1);
  g = setSignal(g, 0, "weak");
  g = setSignal(g, 0, "medium");
  assert.equal(g.signals[0], "medium");
});

test("only real levels from real seats are accepted", () => {
  const g = createGame(4, 1);
  assert.throws(() => setSignal(g, 0, "huge" as never), /Invalid signal/);
  assert.throws(() => setSignal(g, 4, "weak"), /No such seat/);
  assert.throws(() => setSignal(g, -1, "weak"), /No such seat/);
});

test("signals cannot be set outside the bidding phase", () => {
  const g = resolveBidding(createGame(4, 2));
  // Bidding resolves straight into play: the bidder names trump by leading.
  assert.equal(g.phase, "playing");
  assert.throws(() => setSignal(g, opener(g), "strong"), /only.*bidding/i);
});

test("signals reset when the next hand is dealt", () => {
  let s = hljModule.createGame({ players: 4, target: 21 }, 7);
  s = hljModule.aux!.apply(s, opener(s), "strong");
  assert.equal(s.signals[opener(s)], "strong");
  // Play the all-bot hand out; the deal of the next hand clears every signal.
  for (let guard = 0; !s.lastHand; guard++) {
    assert.ok(guard < 500, "hand finished");
    s = botStep(s);
  }
  assert.equal(s.phase, "bidding");
  assert.equal(s.bidsActed, 0);
  assert.deepEqual(s.signals, [null, null, null, null]);
});

test("handConfidence: junk reads weak, a powerhouse reads strong", () => {
  const junk: Card[] = [
    { rank: 9, suit: "C" },
    { rank: 8, suit: "D" },
    { rank: 9, suit: "H" },
    { rank: 8, suit: "S" },
  ];
  const power: Card[] = [
    { rank: 14, suit: "S" },
    { rank: 13, suit: "S" },
    { rank: 11, suit: "S" },
    { joker: true },
    { rank: 10, suit: "S" },
    { rank: 9, suit: "S" },
  ];
  assert.equal(handConfidence(junk, 4), "weak");
  assert.equal(handConfidence(power, 4), "strong");
});

test("signals are public: every seat sees every signal in its view", () => {
  let g = createGame(4, 11);
  g = setSignal(g, 1, "strong");
  g = setSignal(g, 3, "weak");
  const meta = { seats: seatsOf(4, [0]), hostSeat: 0 };
  for (let seat = 0; seat < 4; seat++) {
    const view = redact(g, seat, meta);
    assert.deepEqual(view.signals, [null, "strong", null, "weak"]);
  }
});

test("a bot signals only while a teammate still has a bid to make", () => {
  // 4 players, dealer d: the bidding runs d+1, d+2, d+3, d. Seats d+1 and d+3
  // are partners, as are d+2 and the dealer.
  const s = hljModule.createGame({ players: 4, target: 21 }, 8);
  const d = s.dealerSeat;
  const seat = (k: number) => (d + k) % 4;
  const botAux = hljModule.aux!.botAux!;
  assert.equal(botAux(s, seat(1)), handConfidence(s.hands[seat(1)], 4), "partner d+3 still bids");
  assert.equal(botAux(s, seat(2)), handConfidence(s.hands[seat(2)], 4), "partner (the dealer) still bids");
  assert.equal(botAux(s, seat(3)), null, "partner d+1 already bid before d+3");
  assert.equal(botAux(s, d), null, "the dealer bids last; nobody left to tell");
  // Nor does a bot repeat a signal it has already sent.
  const signalled = hljModule.aux!.apply(s, seat(1), "weak");
  assert.equal(botAux(signalled, seat(1)), null);
});

test("a human bid opens the confidence gate only when a teammate bids later", () => {
  const s = hljModule.createGame({ players: 4, target: 21 }, 8);
  const d = s.dealerSeat;
  const bid = (seat: number): Move => ({ type: "bid", seat, amount: 2 });
  const first = (d + 1) % 4;
  const afterFirst = hljModule.applyMove(s, bid(first));
  const gated = hljModule.openHumanGate!(afterFirst, bid(first));
  assert.ok(gated, "opener's partner still to bid: gate opens");
  assert.equal(gated.pendingSignal, true);
  assert.equal(gated.pendingSignalSeat, first);
  // Seat d+3 bids after its partner already acted: no gate.
  let late: HljState = hljModule.applyMove(s, { type: "pass", seat: first });
  late = hljModule.applyMove(late, { type: "pass", seat: (d + 2) % 4 });
  const third = (d + 3) % 4;
  const afterThird = hljModule.applyMove(late, bid(third));
  assert.equal(hljModule.openHumanGate!(afterThird, bid(third)), null);
  // Passes never open it.
  assert.equal(hljModule.openHumanGate!(late, { type: "pass", seat: first }), null);
});
