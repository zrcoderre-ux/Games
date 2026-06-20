import { heartsModule as G, __test } from "./hearts-module.ts";

function assert(cond, msg) { if (!cond) { console.error("FAIL:", msg); process.exit(1); } }

const C = (id, rank, suit) => ({ id, rank, suit });

// ---- rule unit checks ----
assert(__test.handSize(4) === 13 && __test.handSize(3) === 17 && __test.handSize(5) === 10, "hand sizes");
assert(__test.buildDeck(4).length === 52, "4p full deck");
assert(__test.buildDeck(3).length === 51, "3p deck (no 2D)");
assert(__test.buildDeck(5).length === 50, "5p deck (no 2D/2C)");
assert(__test.cardPoints(C(0, 12, "S")) === 13, "Q(S) is 13");
assert(__test.cardPoints(C(0, 7, "H")) === 1, "each heart is 1");
assert(__test.cardPoints(C(0, 14, "S")) === 0 && __test.cardPoints(C(0, 5, "C")) === 0, "non-points are 0");
// 26 points live in every deck variant.
for (const p of [3, 4, 5]) {
  const total = __test.buildDeck(p).reduce((a, c) => a + __test.cardPoints(c), 0);
  assert(total === 26, `26 points in the ${p}p deck (got ${total})`);
}
assert(__test.trickWinner([{ seat: 0, card: C(0, 5, "C") }, { seat: 1, card: C(1, 13, "C") }, { seat: 2, card: C(2, 9, "H") }]) === 1, "high card of led suit wins, off-suit can't");
// Pass rotation for 4p: left/across/right/hold, repeating; every 4th hand holds.
assert([0, 1, 2, 3, 4].map((h) => __test.passOffsetFor(h, 4)).join(",") === "1,2,3,0,1", "4p pass rotation");

// ---- conservation helpers ----
// Every completed trick removed exactly `players` cards, the in-progress trick
// holds currentTrick.length, the rest are in hands. That must equal the deck.
const cardsInPlay = (s) =>
  s.hands.reduce((a, h) => a + h.length, 0) + s.currentTrick.length + s.trickNo * s.players;

function playGame(players, seed) {
  let s = G.createGame({ players, target: 100 }, seed);
  const deck = __test.buildDeck(players).length;
  let moves = 0, hands = 1;
  while (!G.isOver(s)) {
    assert(cardsInPlay(s) === deck, `card conservation (players=${players}, move=${moves}) got ${cardsInPlay(s)}`);
    const before = s.handNo;
    let next;
    if (s.phase === "trickComplete") {
      // Between tricks the engine pauses on a gate: seatToAct is null and an explicit
      // advance (seat = trick winner) clears it. The last-trick advance is also what
      // scores the hand, so it flows through the same scoring check below.
      next = G.applyMove(s, { type: "advance", seat: s.trickWinner });
    } else {
      const seat = G.seatToAct(s);
      assert(seat !== null, "seatToAct non-null mid-game");
      const move = G.aiMove(s, seat);
      assert(G.isLegal(s, move), `aiMove produced a legal move (${JSON.stringify(move)})`);
      next = G.applyMove(s, move);
    }
    if (next.handNo !== before || next.phase === "gameOver") {
      // A hand was just scored: validate the delta against Hearts scoring.
      const { delta, shooter } = next.lastHand;
      if (shooter === null) {
        assert(delta.reduce((a, b) => a + b, 0) === 26, `non-moon hand totals 26 (p=${players} seed=${seed})`);
      } else {
        assert(delta[shooter] === 0, "moon shooter takes 0");
        assert(delta.every((d, i) => i === shooter || d === 26), "moon: everyone else takes 26");
      }
      hands++;
    }
    s = next;
    if (++moves > 2_000_000) { console.error("FAIL: game did not terminate"); process.exit(1); }
  }
  return { players, seed, moves, hands, scores: s.scores, winner: s.winner };
}

for (const players of [3, 4, 5]) {
  for (let seed = 1; seed <= 25; seed++) {
    const r = playGame(players, seed);
    const min = Math.min(...r.scores);
    assert(Math.max(...r.scores) >= 100, `someone crossed target (p=${players} seed=${seed})`);
    assert(r.winner !== null && r.scores[r.winner] === min, `winner has the lowest score (p=${players} seed=${seed})`);
  }
  const sample = playGame(players, 7);
  console.log(`players=${players}: terminated in ${sample.moves} moves over ${sample.hands} hands; ` +
              `final scores [${sample.scores.join(", ")}], winner seat ${sample.winner}`);
}

console.log("ALL OK: 75 full games, card count conserved every move, every aiMove legal, scoring sums to 26/hand.");
