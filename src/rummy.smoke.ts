import { rummy500Module as G, __test } from "./rummy-module.ts";

function assert(cond, msg) { if (!cond) { console.error("FAIL:", msg); process.exit(1); } }

// ---- meld-rule unit checks ----
const C = (id, rank, suit) => ({ id, rank, suit });
assert(__test.isRun([C(0,5,"H"),C(1,6,"H"),C(2,7,"H")]), "5-6-7 run");
assert(!__test.isRun([C(0,5,"H"),C(1,6,"H"),C(2,7,"S")]), "mixed-suit not a run");
assert(__test.isRun([C(0,14,"S"),C(1,2,"S"),C(2,3,"S")]), "ace-low A-2-3");
assert(__test.isRun([C(0,12,"S"),C(1,13,"S"),C(2,14,"S")]), "ace-high Q-K-A");
assert(!__test.isRun([C(0,13,"S"),C(1,14,"S"),C(2,2,"S")]), "no wrap K-A-2");
assert(__test.isSet([C(0,9,"H"),C(1,9,"S"),C(2,9,"D")]), "three 9s a set");
assert(!__test.isSet([C(0,9,"H"),C(1,9,"H"),C(2,9,"S")]), "duplicate suit in set is invalid");
assert(!__test.isSet([C(0,9,"H"),C(1,9,"S"),C(2,9,"D"),C(3,9,"C"),C(4,9,"H")]), "5-card set with repeated suit is invalid");
assert(!__test.isSet([C(0,9,"H"),C(1,8,"S"),C(2,9,"D")]), "mixed ranks not a set");
assert(__test.cardValue(C(0,14,"S")) === 15 && __test.cardValue(C(0,13,"S")) === 10 && __test.cardValue(C(0,5,"S")) === 5, "values");
assert(__test.buildDeck().length === 54, "single deck = 52 + 2 jokers");
assert(__test.buildDeck(2).length === 108, "double deck = 104 + 4 jokers");
assert(new Set(__test.buildDeck(2).map((c) => c.id)).size === 108, "double-deck ids all unique");
assert(__test.buildDeck().filter((c) => c.joker).length === 2, "single deck has 2 jokers");

// ---- wild-card (joker) checks ----
const J = (id) => ({ id, rank: 0, suit: "S", joker: true });
assert(__test.isRun([C(0,5,"H"),J(1),C(2,7,"H")]), "joker fills run gap 5-_-7");
assert(__test.isRun([C(0,5,"H"),C(1,6,"H"),J(2)]), "joker extends run end 5-6-_");
assert(__test.isSet([C(0,9,"H"),C(1,9,"S"),J(2)]), "joker completes a set");
assert(!__test.isRun([J(0),J(1),J(2)]), "all-joker is not a run");
assert(!__test.isSet([J(0),J(1),J(2)]), "all-joker is not a set");
assert(__test.cardValue(J(0)) === 15, "joker worth 15 in hand");

const totalCards = (s) =>
  s.hands.reduce((a, h) => a + h.length, 0) +
  s.stock.length + s.discard.length +
  s.melds.reduce((a, m) => a + m.cards.length, 0);

function playGame(players, seed) {
  const expected = players <= 4 ? 54 : 108;
  let s = G.createGame({ players, target: 500 }, seed);
  let moves = 0, rounds = 1;
  while (!G.isOver(s)) {
    assert(totalCards(s) === expected, `card conservation (players=${players}, move=${moves}) got ${totalCards(s)} want ${expected}`);
    const seat = G.seatToAct(s);
    assert(seat !== null, "seatToAct non-null mid-game");
    const before = s.scores.slice();
    const move = G.aiMove(s, seat);
    assert(G.isLegal(s, move), `aiMove produced legal move (${JSON.stringify(move)})`);
    const next = G.applyMove(s, move);
    if (next.scores.some((v, i) => v !== before[i])) rounds++; // a round was scored + redealt
    s = next;
    if (++moves > 2_000_000) { console.error("FAIL: game did not terminate"); process.exit(1); }
  }
  return { players, seed, moves, rounds, scores: s.scores, winner: s.winner };
}

let totalGames = 0;
for (const players of [2, 3, 4, 5, 6, 7, 8]) {
  const nSeeds = players <= 4 ? 25 : 8;
  let sample;
  for (let seed = 1; seed <= nSeeds; seed++) {
    const r = playGame(players, seed);
    assert(r.winner !== null && r.scores[r.winner] >= 500, `winner crossed target (p=${players} seed=${seed})`);
    totalGames++;
    sample = r;
  }
  const decks = players <= 4 ? "1 deck" : "2 decks";
  console.log(`players=${players} (${decks}): e.g. ${sample.moves} moves / ~${sample.rounds} rounds, ` +
              `winner seat ${sample.winner} @ ${sample.scores[sample.winner]}`);
}

console.log(`ALL OK: ${totalGames} full games, deck size conserved every move, every aiMove legal.`);
