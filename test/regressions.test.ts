// Regression tests for server/module bugs fixed in the bug review, limited to
// what runs without the Workers runtime: the offline LocalRoom (same contract
// as RoomServer), the HLJ signal gate, Rummy's requireDiscard and tie rules,
// Hearts' tie rule, and the fresh-entropy reseed.
// Run with `npm test` (or `node --test test/regressions.test.ts`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { LocalRoom } from "../src/local-room.ts";
import { hljModule, type HljState } from "../src/hlj-module.ts";
import { sortCards, signalGateSeat } from "../src/engine.ts";
import { rummy500Module as rummy, type RummyState, type RummyCard } from "../src/rummy-module.ts";
import { heartsModule as hearts, type HeartsState } from "../src/hearts-module.ts";
import type { RoomMeta } from "../src/game.ts";

const E1 = [0x12345678, 0x9abcdef0, 0x0fedcba9, 0x87654321];
const E2 = [1, 2, 3, 4];

// A LocalRoom with its frames captured. Bots run on real timers, so every test
// closes its room when done.
function localRoom(game: any, config: any) {
  const frames: any[] = [];
  const room = new LocalRoom(game, config, (m: any) => frames.push(m));
  return {
    room,
    send: (m: any) => room.handle(m),
    view: () => frames.filter((m) => m.t === "view").at(-1)?.view,
    errors: () => frames.filter((m) => m.t === "error").map((m) => m.message),
  };
}

const metaFor = (n: number): RoomMeta => ({
  seats: Array.from({ length: n }, () => ({ kind: "human" as const, name: "P" })),
  hostSeat: 0, players: n, inLobby: false, botReplacement: false, disconnectedSeats: [],
});

// ---------- C1: lobby config merges, validated before anything changes ----------

test("setConfig merges over the current config and rejects bad options untouched", () => {
  const r = localRoom(rummy, { players: 4, target: 500 });
  r.send({ t: "join", name: "Host" });
  r.send({ t: "setConfig", config: { target: 300 } });
  assert.equal(r.view().target, 300);
  assert.equal(r.view().players, 4, "a target change keeps the table size");
  r.send({ t: "setConfig", config: { requireDiscard: true } });
  assert.equal(r.view().requireDiscard, true);
  assert.equal(r.view().target, 300, "a rules change keeps the target");

  r.send({ t: "setConfig", config: { players: 9 } });
  r.send({ t: "setConfig", config: { target: 0 } });
  r.send({ t: "setConfig", config: { requireDiscard: "yes" } });
  r.send({ t: "setConfig", config: JSON.parse('{"__proto__": {"target": 1}}') }); // as it arrives off the wire: ignored
  assert.deepEqual(r.errors(), [
    "Rummy 500 doesn't support 9 players",
    "Target must be a whole number from 1 to 10000",
    "Must discard to go out must be on or off",
  ]);
  const v = r.view();
  assert.equal(v.players, 4);
  assert.equal(v.target, 300);
  assert.equal(v.requireDiscard, true);
  assert.equal(v.seats.length, 4);
  r.room.close();
});

test("start merges its config over the stored one and commits nothing if the deal fails", () => {
  const r = localRoom(rummy, { players: 4, target: 500 });
  r.send({ t: "join", name: "Host" });
  r.send({ t: "setConfig", config: { target: 250, requireDiscard: true } });
  r.send({ t: "start", config: { target: -5 } });
  assert.equal(r.errors().at(-1), "Target must be a whole number from 1 to 10000");
  assert.equal(r.view().phase, "lobby");
  assert.equal(r.view().target, 250, "the failed start left the config alone");
  assert.ok(r.view().seats.every((s: any) => s.kind !== "bot"), "no bots were seated");

  r.send({ t: "start", config: { players: 3, botDifficulty: [2, 0, 3] } });
  const v = r.view();
  assert.equal(v.phase, "playing");
  assert.equal(v.players, 3);
  assert.equal(v.target, 250, "start kept the stored target");
  assert.equal(v.requireDiscard, true, "start kept the stored rules");
  assert.deepEqual(v.botDifficulty, [2, 0, 3]);
  assert.deepEqual(v.seats.map((s: any) => s.kind), ["human", "bot", "bot"]);
  r.room.close();
});

test("start without a config deals the stored config", () => {
  const r = localRoom(hljModule, { players: 6, target: 21 });
  r.send({ t: "join", name: "Host" });
  r.send({ t: "setConfig", config: { target: 31 } });
  r.send({ t: "setConfig", config: { bestOf: 3 } });
  r.send({ t: "setConfig", config: { players: 4 } });
  r.send({ t: "start" });
  assert.deepEqual(r.errors(), []);
  const v = r.view();
  assert.equal(v.players, 4);
  assert.equal(v.target, 31);
  assert.equal(v.winsNeeded, 2);
  r.room.close();
});

test("each module validates its own options", () => {
  assert.throws(() => hljModule.createGame({ players: 4, target: 0 }, 1), /Target must be a whole number/);
  assert.throws(() => hljModule.createGame({ players: 4, target: null as never }, 1), /Target must be a whole number/);
  assert.throws(() => hljModule.createGame({ players: 4, target: 21, bestOf: 2 }, 1), /Best of must be/);
  assert.throws(() => hljModule.createGame({ players: 5 as never, target: 21 }, 1), /Unsupported player count/);
  assert.equal(hljModule.createGame({ players: 4, target: 21, bestOf: 5 }, 1).winsNeeded, 3);
  assert.throws(() => hearts.createGame({ players: 4, target: 10001 }, 1), /Target must be a whole number/);
  assert.throws(() => hearts.createGame({ players: 6, target: 100 }, 1), /Unsupported player count/);
  assert.throws(() => rummy.createGame({ players: 4, target: 2.5 }, 1), /Target must be a whole number/);
  assert.deepEqual(rummy.createGame({ players: 3, target: 500, botDifficulty: [3, "x" as never, 7] }, 1).botDifficulty, [3, 2, 2]);
});

// ---------- C3/C4: the HLJ confidence-pick gate belongs to the bidder ----------

// A 4-player game where seat `bidder` opens the bidding with a bid of 2 that
// opens the gate (its partner still bids after it).
function gatedHlj(): { s: HljState; bidder: number } {
  let s = hljModule.createGame({ players: 4, target: 21 }, 4); // dealer 0, seat 1 opens
  const bidder = 1;
  const move = { type: "bid" as const, seat: bidder, amount: 2 };
  s = hljModule.openHumanGate!(hljModule.applyMove(s, move), move)!;
  assert.ok(s, "gate opened");
  return { s, bidder };
}

test("while the signal gate is open nobody may act, and only the bidder may signal", () => {
  const { s, bidder } = gatedHlj();
  assert.equal(hljModule.seatToAct(s), null);
  for (let seat = 0; seat < 4; seat++) {
    const v = hljModule.redact(s, seat, metaFor(4));
    assert.equal(v.pendingSignal, true);
    assert.equal(v.pendingSignalSeat, bidder);
    assert.equal(v.toAct, null);
    assert.equal(v.yourTurn, false);
    assert.deepEqual(v.legalMoves, []);
  }
  // Aux is raw client input: only a real level, and only from the gated seat.
  assert.throws(() => hljModule.aux!.apply(s, bidder, "huge"), /Invalid signal/);
  assert.throws(() => hljModule.aux!.apply(s, bidder, { level: "strong" }), /Invalid signal/);
  assert.throws(() => hljModule.aux!.apply(s, 2, "strong"), /Waiting for the bidder to signal/);
  const picked = hljModule.aux!.apply(s, bidder, "strong");
  assert.equal(picked.pendingSignal, false);
  assert.equal(picked.signals[bidder], "strong");
  assert.equal(hljModule.seatToAct(picked), 2, "bidding resumes with the next seat");
  assert.deepEqual(picked.log, s.log, "a signal leaves the move log alone");
});

test("the gate's pacing is a 30 s safety net owned by the bidder", () => {
  const { s, bidder } = gatedHlj();
  const pace = hljModule.pacing!(s)!;
  assert.equal(pace.kind, "auto");
  assert.equal(pace.ms, 30000);
  assert.equal(pace.advanceSeat, bidder);
  const advanced = hljModule.applyMove(s, pace.move);
  assert.equal(advanced.pendingSignal, false);
  assert.equal(hljModule.seatToAct(advanced), 2);
  // A game saved before the gate stored its seat falls back to the last real bid.
  const legacy = { ...s, pendingSignalSeat: undefined };
  assert.equal(signalGateSeat(legacy), bidder);
  assert.equal(hljModule.pacing!(legacy)!.advanceSeat, bidder);
  assert.throws(() => hljModule.aux!.apply(legacy, 3, "weak"), /Waiting for the bidder to signal/);
});

test("offline: a human bid opens the gate, a stray advance is silent, the pick resumes play", () => {
  const r = localRoom(hljModule, { players: 4, target: 21 });
  r.send({ t: "join", name: "Host" });
  r.send({ t: "start", config: { seed: 3 } }); // dealer 3, so the human at seat 0 opens
  let v = r.view();
  assert.equal(v.toAct, 0);
  r.send({ t: "move", move: { type: "bid", seat: 0, amount: 2 } });
  v = r.view();
  assert.equal(v.pendingSignal, true);
  assert.equal(v.pendingSignalSeat, 0);
  assert.deepEqual(v.legalMoves, []);
  r.send({ t: "aux", payload: "loud" });
  assert.equal(r.errors().at(-1), "Invalid signal");
  r.send({ t: "aux", payload: "medium" });
  v = r.view();
  assert.equal(v.pendingSignal, false);
  assert.equal(v.signals[0], "medium");
  assert.equal(v.toAct, 1);
  const before = r.errors().length;
  r.send({ t: "advance" }); // nothing to advance: ignored without an error frame
  assert.equal(r.errors().length, before);
  r.room.close();
});

// ---------- Rummy: requireDiscard never strands a player ----------

let nextId = 1000;
const C = (rank: number, suit: RummyCard["suit"]): RummyCard => ({ id: nextId++, rank, suit });
function rummyAt(hand: RummyCard[], discard: RummyCard[], requireDiscard: boolean): RummyState {
  const s = rummy.createGame({ players: 2, target: 500, requireDiscard }, 1);
  return { ...s, turn: 0, turnPhase: "draw", hands: [hand, s.hands[1]], discard, melds: [], mustMeldCardId: null };
}

test("requireDiscard: a deep pickup whose card could only go down by emptying the hand is refused", () => {
  // Holding 8H, the pile is 2C 7H 9H: taking the 7H sweeps the 9H, and the only
  // play for the 7H (the run 7-8-9) would leave nothing to discard.
  const seven = C(7, "H");
  const s = rummyAt([C(8, "H")], [C(2, "C"), seven, C(9, "H")], true);
  assert.equal(rummy.isLegal(s, { type: "drawDiscard", seat: 0, cardId: seven.id }), false);
  assert.ok(!rummy.legalMoves(s).some((m) => m.type === "drawDiscard" && m.cardId === seven.id));
  // Without the option, going out on that meld is fine.
  assert.equal(rummy.isLegal({ ...s, requireDiscard: false }, { type: "drawDiscard", seat: 0, cardId: seven.id }), true);
});

test("requireDiscard: after a legal deep pickup there is always a legal move, and only the safe one", () => {
  // Hand 7H 9C 9D 9S, pile 2C 7S 7D: taking the 7S is fine (777 leaves cards),
  // but melding the 9s first would strand the 7s.
  const sevenS = C(7, "S");
  let s = rummyAt([C(7, "H"), C(9, "C"), C(9, "D"), C(9, "S")], [C(2, "C"), sevenS, C(7, "D")], true);
  assert.equal(rummy.isLegal(s, { type: "drawDiscard", seat: 0, cardId: sevenS.id }), true);
  s = rummy.applyMove(s, { type: "drawDiscard", seat: 0, cardId: sevenS.id });
  const ids = (rank: number) => s.hands[0].filter((c) => c.rank === rank).map((c) => c.id);
  assert.equal(rummy.isLegal(s, { type: "meld", seat: 0, cards: ids(9) }), false);
  assert.equal(rummy.isLegal(s, { type: "meld", seat: 0, cards: ids(7) }), true);
  const legal = rummy.legalMoves(s);
  assert.ok(legal.length > 0, "never zero legal moves");
  assert.ok(legal.every((m) => rummy.isLegal(s, m)), "legalMoves lists only legal moves");
  assert.ok(rummy.isLegal(s, rummy.aiMove(s, 0)), "the bot finds a legal move");
});

test("requireDiscard: no meld may empty the hand", () => {
  let s = rummyAt([C(4, "S"), C(5, "S"), C(6, "S")], [C(2, "C")], true);
  s = rummy.applyMove(s, { type: "drawDiscard", seat: 0, cardId: s.discard[0].id });
  const run = s.hands[0].filter((c) => c.suit === "S").map((c) => c.id);
  assert.equal(rummy.isLegal(s, { type: "meld", seat: 0, cards: run }), true, "keeps the 2C to discard");
  const t = rummyAt([C(4, "S"), C(5, "S"), C(6, "S")], [C(2, "C")], true);
  const played = { ...t, turnPhase: "play" as const };
  assert.equal(rummy.isLegal(played, { type: "meld", seat: 0, cards: played.hands[0].map((c) => c.id) }), false);
  assert.ok(rummy.legalMoves(played).length > 0, "a discard is still available");
});

// ---------- ties at the target play on ----------

test("Rummy: a tie for the lead at the target deals another round; a single leader wins", () => {
  // Seat 0 goes out by discarding its last card; seat 1 is caught holding V.
  const base = rummy.createGame({ players: 2, target: 500 }, 1);
  const held = [C(10, "H"), C(5, "C")]; // 10 + 5 = 15 against seat 1
  const last = C(3, "D");
  const at = (scores: number[]): RummyState => ({
    ...base, turn: 0, turnPhase: "play", hands: [[last], held], melds: [], cardOwner: {}, mustMeldCardId: null, scores,
  });
  const tied = rummy.applyMove(at([500, 515]), { type: "discard", seat: 0, cardId: last.id });
  assert.deepEqual(tied.scores, [500, 500]);
  assert.equal(tied.phase, "handComplete");
  assert.equal(tied.winner, null);
  assert.ok(tied.log.some((e) => e.msg === "Tied for the lead at 500 — another round decides"));
  const next = rummy.applyMove(tied, rummy.pacing!(tied)!.move);
  assert.equal(next.phase, "playing", "another round is dealt");

  const won = rummy.applyMove(at([500, 514]), { type: "discard", seat: 0, cardId: last.id });
  assert.equal(won.phase, "gameOver");
  assert.equal(won.winner, 0);
});

test("Hearts: a shared low score at the target plays another hand; a single low wins", () => {
  // Bots play one hand up to its last trick's gate, then the scores are set so
  // the hand ends with seats 0 and 1 tied for low and seat 2 past the target.
  let s: HeartsState = hearts.createGame({ players: 4, target: 100 }, 3);
  for (let guard = 0; !(s.phase === "trickComplete" && s.trickNo === 12); guard++) {
    assert.ok(guard < 1000);
    const seat = hearts.seatToAct(s);
    s = hearts.applyMove(s, seat === null ? hearts.pacing!(s)!.move : hearts.aiMove(s, seat));
  }
  const delta = hearts.applyMove(s, hearts.pacing!(s)!.move).lastHand!.delta;
  const finish = (finals: number[]): HeartsState =>
    hearts.applyMove({ ...s, scores: finals.map((f, i) => f - delta[i]) }, hearts.pacing!(s)!.move);

  const tied = finish([50, 50, 120, 80]);
  assert.notEqual(tied.phase, "gameOver");
  assert.equal(tied.winner, null);
  assert.equal(tied.handNo, s.handNo + 1, "another hand is dealt");
  assert.equal(hearts.redact(tied, 0, metaFor(4)).tiebreak, true);
  assert.ok(tied.log.some((e) => e.seat === null && e.msg === "no outright winner — playing another hand"));

  const won = finish([50, 51, 120, 80]);
  assert.equal(won.phase, "gameOver");
  assert.equal(won.winner, 0);
  assert.equal(hearts.redact(won, 0, metaFor(4)).tiebreak, false);
});

// ---------- C2: fresh entropy changes future deals; no entropy stays deterministic ----------

// Play bots until a new hand is dealt (lastHand changes), with no reseeds.
function nextHljDeal(s: HljState): HljState {
  const first = s.lastHand;
  for (let guard = 0; s.lastHand === first; guard++) {
    assert.ok(guard < 2000);
    const seat = hljModule.seatToAct(s);
    if (seat === null) { s = hljModule.applyMove(s, hljModule.pacing!(s)!.move); continue; }
    const sig = hljModule.aux!.botAux!(s, seat);
    if (sig != null) s = hljModule.aux!.apply(s, seat, sig);
    s = hljModule.applyMove(s, hljModule.aiMove(s, seat));
  }
  return s;
}

test("without entropy every deal replays from the seed", () => {
  const a = hljModule.createGame({ players: 4, target: 21 }, 99);
  const b = hljModule.createGame({ players: 4, target: 21 }, 99);
  assert.deepEqual(a, b);
  assert.deepEqual(nextHljDeal(a).hands, nextHljDeal(b).hands);
  assert.deepEqual(rummy.createGame({ players: 4, target: 500 }, 5).hands, rummy.createGame({ players: 4, target: 500 }, 5).hands);
  assert.deepEqual(hearts.createGame({ players: 4, target: 100 }, 5).hands, hearts.createGame({ players: 4, target: 100 }, 5).hands);
});

test("the first reseed re-deals the untouched opening hand, later ones keep it", () => {
  for (const [game, config] of [[hljModule, { players: 4, target: 21 }], [rummy, { players: 4, target: 500 }], [hearts, { players: 4, target: 100 }]] as const) {
    const g = game as any;
    const s0 = g.createGame(config, 7);
    const s1 = g.reseed(s0, E1);
    assert.notDeepEqual(s1.hands, s0.hands, `${g.meta.id}: the seed-only opening deal is replaced`);
    assert.deepEqual(g.reseed(s0, E1).hands, s1.hands, `${g.meta.id}: same entropy, same deal`);
    assert.deepEqual(g.reseed(s1, E2).hands, s1.hands, `${g.meta.id}: a later reseed never reshuffles a dealt hand`);
    assert.deepEqual(g.reseed(s1, E2).entropy, E2);
  }
});

test("entropy changes the next deal; the same entropy replays it", () => {
  // Keep the opening hand (as if already reseeded) so all runs play the same
  // first hand: the bots' own randomness comes from state.seed, not entropy.
  const s0 = { ...hljModule.createGame({ players: 4, target: 21 }, 11), seedOnlyDeal: false };
  const plain = nextHljDeal(s0);
  const withE1 = nextHljDeal(hljModule.reseed!(s0, E1));
  const withE1Again = nextHljDeal(hljModule.reseed!(s0, E1));
  const withE2 = nextHljDeal(hljModule.reseed!(s0, E2));
  assert.deepEqual(withE1.lastHand!.dealtHands, plain.lastHand!.dealtHands, "same first hand in every run");
  assert.notDeepEqual(withE1.hands, plain.hands);
  assert.notDeepEqual(withE1.hands, withE2.hands);
  assert.deepEqual(withE1.hands, withE1Again.hands);

  // Rummy: the round after handComplete is dealt from the entropy too.
  const base = rummy.createGame({ players: 2, target: 500 }, 1);
  const done = rummy.applyMove(
    { ...base, turn: 0, turnPhase: "play", hands: [[C(3, "D")], base.hands[1]], melds: [], cardOwner: {}, mustMeldCardId: null },
    { type: "discard", seat: 0, cardId: nextId - 1 },
  );
  assert.equal(done.phase, "handComplete");
  const adv = rummy.pacing!(done)!.move;
  const r0 = rummy.applyMove(done, adv);
  const r1 = rummy.applyMove(rummy.reseed!(done, E1), adv);
  assert.deepEqual(rummy.applyMove(done, adv).hands, r0.hands);
  assert.notDeepEqual(r1.hands, r0.hands);
  assert.deepEqual(rummy.applyMove(rummy.reseed!(done, E1), adv).hands, r1.hands);
});

test("offline rooms reseed: two games from the same seed get different opening deals", () => {
  const deal = () => {
    const r = localRoom(hljModule, { players: 4, target: 21 });
    r.send({ t: "join", name: "Host" });
    r.send({ t: "start", config: { seed: 3 } });
    const hand = r.view().yourHand;
    r.room.close();
    return hand;
  };
  assert.notDeepEqual(deal(), deal());
});

// ---------- revealed hands never show the deal order ----------

test("revealed hands are sorted (HLJ result, Hearts game log)", () => {
  const s = nextHljDeal(hljModule.createGame({ players: 4, target: 21 }, 21));
  for (const h of s.lastHand!.dealtHands) assert.deepEqual(h, sortCards(h));
  assert.deepEqual(s.lastHand!.kitty, sortCards(s.lastHand!.kitty));

  let h: HeartsState = hearts.createGame({ players: 4, target: 100 }, 2);
  let rec: any = null;
  for (let guard = 0; !rec; guard++) {
    assert.ok(guard < 1000);
    const seat = hearts.seatToAct(h);
    const next = hearts.applyMove(h, seat === null ? hearts.pacing!(h)!.move : hearts.aiMove(h, seat));
    rec = hearts.loggableHand!(h, next);
    h = next;
  }
  const order = { S: 0, H: 1, D: 2, C: 3 } as const;
  for (const hand of rec.dealtHands) {
    const keys = hand.map((c: any) => order[c.suit as keyof typeof order] * 16 + c.rank);
    assert.deepEqual(keys, [...keys].sort((a, b) => a - b));
  }
});
