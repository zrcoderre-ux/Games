import { pegsAndJokersModule as G, __test } from "./pj-module.ts";

function assert(cond, msg) { if (!cond) { console.error("FAIL:", msg); process.exit(1); } }

const { HPS, teamOf, ringSize } = __test;

assert(__test.buildDeck().length === 108, "108-card deck");
for (const players of [4, 6]) {
  const R = ringSize(players);
  assert(R === players * HPS, `ring size ${players}p`);
  for (let p = 0; p < players; p++) assert((__test.exitHole(p, players) - 1 + R) % R === __test.castleEntry(p), `exit/entry adjacency ${players}p p${p}`);
  // Layout: rectangle, one panel per end + (players-2)/2 per long side; 6p is portrait.
  const lay = __test.boardLayout(players, 5);
  assert(lay.ring.length === R && lay.castles.length === players && lay.starts[0].length === 5, `layout shape ${players}p`);
  assert(players === 6 ? lay.viewH > lay.viewW : lay.viewH === lay.viewW, `aspect ${players}p`);
  assert(lay.seams.length === players, `one seam per panel ${players}p`);
  // Castles head inward (toward centre): the last castle hole is closer to centre than the first.
  for (let p = 0; p < players; p++) {
    const c = lay.center, a = lay.castles[p][0], b = lay.castles[p][lay.marbles ? 4 : 4];
    const d0 = Math.hypot(a.x - c.x, a.y - c.y), d1 = Math.hypot(b.x - c.x, b.y - c.y);
    assert(d1 < d0, `castle ${players}p p${p} heads inward`);
  }
}

function invariants(s, tag) {
  const { players, marbles } = s;
  const R = ringSize(players);
  let total = 0;
  const ringSeen = new Set();
  for (let p = 0; p < players; p++) {
    const startSeen = new Set(), castleSeen = new Set();
    for (let i = 0; i < marbles; i++) {
      const l = s.pos[p][i]; total++;
      if (l.z === "start") { assert(l.i >= 0 && l.i < marbles && !startSeen.has(l.i), `${tag}: start dup`); startSeen.add(l.i); }
      else if (l.z === "castle") { assert(l.i >= 0 && l.i < marbles && !castleSeen.has(l.i), `${tag}: castle dup`); castleSeen.add(l.i); }
      else { assert(l.r >= 0 && l.r < R && !ringSeen.has(l.r), `${tag}: ring ${l.r} double-occupied`); ringSeen.add(l.r); }
    }
  }
  assert(total === players * marbles, `${tag}: marble count ${total}`);
}

function playGame(players, marbles, seed) {
  let s = G.createGame({ players, marbles }, seed);
  let moves = 0;
  let prevHome = s.pos.map(() => 0);
  while (!G.isOver(s)) {
    invariants(s, `${players}p m=${marbles} seed=${seed} mv=${moves}`);
    const seat = G.seatToAct(s);
    assert(seat === s.turn && seat !== null, "seatToAct == turn");
    const mv = G.aiMove(s, seat);
    assert(G.isLegal(s, mv), `aiMove legal ${JSON.stringify(mv)}`);
    const next = G.applyMove(s, mv);
    if (!G.isOver(next)) assert(next.turn === (seat + 1) % players, "turn rotation");
    const home = next.pos.map((row) => row.filter((l) => l.z === "castle").length);
    for (let p = 0; p < players; p++) assert(home[p] >= prevHome[p], "castle marbles stay home");
    prevHome = home;
    s = next;
    if (++moves > 3_000_000) return { players, marbles, seed, moves, done: false };
  }
  const t = s.winner;
  for (let p = 0; p < players; p++) if (teamOf(p) === t) assert(__test.allHome(s, p), `winning team ${t} all home (${players}p m=${marbles} seed=${seed})`);
  return { players, marbles, seed, moves, done: true, winner: t };
}

let completed = 0, total = 0;
for (const players of [4, 6]) {
  for (const marbles of [3, 4, 5]) {
    let movesSum = 0, n = 0;
    for (let seed = 1; seed <= 15; seed++) {
      const r = playGame(players, marbles, seed);
      total++;
      if (r.done) { completed++; movesSum += r.moves; n++; } else console.error(`  (no terminate: ${players}p m=${marbles} seed=${seed})`);
    }
    const sample = playGame(players, marbles, 5);
    console.log(`${players}p marbles=${marbles}: ${n}/15 done, avg ${Math.round(movesSum / Math.max(n, 1))} moves; sample(seed5): team ${sample.winner} in ${sample.moves}.`);
  }
}
assert(completed === total, `all games completed (${completed}/${total})`);
console.log(`ALL OK: ${total} full games (4p & 6p), invariants held every move, every aiMove legal.`);
