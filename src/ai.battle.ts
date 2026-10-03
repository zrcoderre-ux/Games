// ai.battle.ts — A-vs-B battle harness for the High Low Jack bots.
//
// Compares two implementations of the HLJ module ("A" = candidate, "B" =
// baseline), each loaded by path, by playing full games to the target score
// exactly the way the room server drives bot seats:
//   - a pacing gate (seatToAct === null, e.g. trickComplete) is resolved by
//     applying pacing(state).move;
//   - before a bot acts, its side's aux.botAux may emit a hand signal, which is
//     applied with aux.apply (the server does this before every bot step);
//   - every seat calls ITS OWN side's aiMove; the move must pass isLegal.
// All state transitions use the candidate (A) module's rules.
//
// Seeds are PAIRED: every seed is played twice, once with A on team 0 (even
// seats) and once with A on team 1. The deal sequence depends only on the seed,
// so both games see the same cards and card luck cancels. Win rates carry a 95%
// confidence interval computed from the per-seed pair scores.
//
// Usage (Node 22 runs .ts directly):
//   node src/ai.battle.ts --a ./src/hlj-module.ts --b <baseline>/hlj-module.ts \
//        --players 4,6,8 --seeds 500 --start 1
// Options:
//   --target N         game target (default 21)
//   --pa NAME/--pb NAME  force one personality (aggressive|balanced|conservative)
//                      for every seat of side A / side B instead of the module's
//                      botPersonality table (uses the ai.ts next to that module)
//   --roundrobin       instead of A vs B, play the candidate's personalities
//                      against each other (the old personality round-robin)
//   --quiet            print only the summary lines

import type { GameState, Move } from "./engine.ts";
import type { Personality } from "./ai.ts";

// Node globals, declared locally so the Worker-oriented tsconfig (no
// @types/node) still type-checks this script.
declare const process: { argv: string[]; cwd(): string; exit(code?: number): never };

// ---------- CLI ----------

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const opt = (name: string, def: string): string => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
};

const A_PATH = opt("--a", "./src/hlj-module.ts");
const B_PATH = opt("--b", "");
const PLAYER_COUNTS = opt("--players", "4,6,8").split(",").map((n) => parseInt(n, 10) as 4 | 6 | 8);
const SEEDS = parseInt(opt("--seeds", "200"), 10);
const START = parseInt(opt("--start", "1"), 10);
const TARGET = parseInt(opt("--target", "21"), 10);
const PA = opt("--pa", "");
const PB = opt("--pb", "");
const ROUND_ROBIN = flag("--roundrobin");
const QUIET = flag("--quiet");

// ---------- loading implementations ----------

type HljLike = GameState & { log?: unknown; logSeq?: number };

// The slice of the Game interface the harness drives.
type Rules = {
  seatToAct(s: HljLike): number | null;
  isLegal(s: HljLike, m: Move): boolean;
  applyMove(s: HljLike, m: Move): HljLike;
  isOver(s: HljLike): boolean;
  createGame(config: { players: 4 | 6 | 8; target: number }, seed: number): HljLike;
  pacing?(s: HljLike): { move: Move } | null;
  aiMove(s: HljLike, seat: number): Move;
  aux?: { apply(s: HljLike, seat: number, p: unknown): HljLike; botAux?(s: HljLike, seat: number): unknown | null };
};

type AiLib = {
  aiMove(s: GameState, seat: number, rng?: () => number, p?: Personality): Move;
  PERSONALITIES: Record<string, Personality>;
};

// One side of a match: how its seats choose moves and signals.
type Side = {
  label: string;
  aiMove(s: HljLike, seat: number): Move;
  botAux?(s: HljLike, seat: number): unknown | null;
};

const fileUrl = (path: string): URL => new URL(path, "file://" + process.cwd() + "/");

async function loadImpl(path: string): Promise<{ rules: Rules; ai: AiLib }> {
  const url = fileUrl(path);
  const mod = await import(url.href);
  const ai = (await import(new URL("./ai.ts", url).href)) as AiLib;
  return { rules: mod.hljModule as Rules, ai };
}

// A side that plays like the deployed bots (module aiMove + botAux), or with
// one personality forced onto every seat.
function makeSide(label: string, impl: { rules: Rules; ai: AiLib }, personality: string): Side {
  const botAux = impl.rules.aux?.botAux?.bind(impl.rules.aux);
  if (!personality) return { label, aiMove: (s, seat) => impl.rules.aiMove(s, seat), botAux };
  const p = impl.ai.PERSONALITIES[personality];
  if (!p) throw new Error(`unknown personality "${personality}" in ${label}`);
  return { label, aiMove: (s, seat) => impl.ai.aiMove(s, seat, undefined, p), botAux };
}

// ---------- statistics ----------

type SideStats = {
  games: number;
  wins: number;
  hands: number;      // hands played
  points: number;     // raw points captured (High/Low/Jack/Joker/Game)
  bidsWon: number;    // hands this side won the auction
  bidsMade: number;
  sixBids: number;    // contracts of 6
  sixMade: number;
  bidTotal: number;   // sum of winning bid amounts
  times: number[];    // aiMove wall time per call (ms)
};

const emptyStats = (): SideStats => ({
  games: 0, wins: 0, hands: 0, points: 0, bidsWon: 0, bidsMade: 0, sixBids: 0, sixMade: 0, bidTotal: 0, times: [],
});

// Play one game; sides[t] controls every seat of team t. Returns the winning team.
function playGame(rules: Rules, sides: [Side, Side], stats: [SideStats, SideStats], players: 4 | 6 | 8, seed: number): number {
  let s = rules.createGame({ players, target: TARGET }, seed);
  let steps = 0;
  while (!rules.isOver(s)) {
    if (++steps > 100_000) throw new Error(`seed ${seed}: game did not terminate`);
    const seat = rules.seatToAct(s);
    let next: HljLike;
    if (seat === null) {
      // Pacing gate (completed trick): the server auto-applies the gate move.
      const pace = rules.pacing?.(s);
      if (!pace) throw new Error(`seed ${seed}: no seat to act and no pacing move`);
      next = rules.applyMove(s, pace.move);
    } else {
      const team = seat % 2;
      const side = sides[team];
      // The server lets a bot emit its aux signal right before it acts.
      const sig = side.botAux?.(s, seat);
      if (sig != null) s = rules.aux!.apply(s, seat, sig);
      const t0 = performance.now();
      const move = side.aiMove(s, seat);
      stats[team].times.push(performance.now() - t0);
      if (!rules.isLegal(s, move)) {
        throw new Error(`seed ${seed}: ${side.label} made an illegal move ${JSON.stringify(move)} in phase ${s.phase}`);
      }
      next = rules.applyMove(s, move);
    }
    // A hand was just scored: record per-side outcomes.
    const r = next.lastHand;
    if (r && r !== s.lastHand) {
      for (const t of [0, 1]) {
        stats[t].hands++;
        stats[t].points += r.pointsByTeam[t];
      }
      const bt = stats[r.bidderTeam];
      bt.bidsWon++;
      bt.bidTotal += r.bid;
      if (r.made) bt.bidsMade++;
      if (r.bid === 6) {
        bt.sixBids++;
        if (r.made) bt.sixMade++;
      }
    }
    s = next;
  }
  const winner = s.winner!;
  stats[0].games++;
  stats[1].games++;
  stats[winner].wins++;
  return winner;
}

// Paired match between two sides over seeds [start, start+n). Returns per-side
// stats and the pair scores of side X (1 = won both seats, 0.5 = split, 0 = lost both).
function runMatch(rules: Rules, X: Side, Y: Side, players: 4 | 6 | 8, start: number, n: number) {
  const sx = emptyStats(), sy = emptyStats();
  const pairs: number[] = [];
  for (let seed = start; seed < start + n; seed++) {
    let score = 0;
    // X on team 0, then X on team 1 — same deal sequence both times.
    if (playGame(rules, [X, Y], [sx, sy], players, seed) === 0) score++;
    if (playGame(rules, [Y, X], [sy, sx], players, seed) === 1) score++;
    pairs.push(score / 2);
  }
  return { sx, sy, pairs };
}

// ---------- reporting ----------

const pct = (n: number, d: number): string => (d === 0 ? "   —  " : ((100 * n) / d).toFixed(1).padStart(5) + "%");

function winCI(pairs: number[]): { mean: number; lo: number; hi: number } {
  const n = pairs.length;
  const mean = pairs.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? pairs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  const half = 1.96 * Math.sqrt(variance / n);
  return { mean, lo: mean - half, hi: mean + half };
}

function timingLine(times: number[]): string {
  if (!times.length) return "—";
  const sorted = times.slice().sort((a, b) => a - b);
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  const p99 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))];
  return `mean ${mean.toFixed(3)} ms  p99 ${p99.toFixed(3)} ms  max ${sorted[sorted.length - 1].toFixed(2)} ms  (${times.length} calls)`;
}

function report(title: string, xName: string, yName: string, r: ReturnType<typeof runMatch>): void {
  const ci = winCI(r.pairs);
  const f = (v: number) => (100 * v).toFixed(1) + "%";
  console.log(
    `${title}  ${xName} win ${f(ci.mean)}  95% CI [${f(ci.lo)}, ${f(ci.hi)}]  (${r.pairs.length} seeds, ${r.sx.games} games)`,
  );
  if (QUIET) return;
  const row = (name: string, s: SideStats) =>
    `  ${name.padEnd(12)} bids won ${String(s.bidsWon).padStart(5)}  made ${pct(s.bidsMade, s.bidsWon)}` +
    `  set ${pct(s.bidsWon - s.bidsMade, s.hands)} of hands  avg bid ${(s.bidTotal / Math.max(1, s.bidsWon)).toFixed(2)}` +
    `  pts/hand ${(s.points / Math.max(1, s.hands)).toFixed(3)}  6-bids ${s.sixBids} (${pct(s.sixMade, s.sixBids)} made)`;
  console.log(row(xName, r.sx));
  console.log(row(yName, r.sy));
  console.log(`  ${xName.padEnd(12)} aiMove ${timingLine(r.sx.times)}`);
  console.log(`  ${yName.padEnd(12)} aiMove ${timingLine(r.sy.times)}`);
}

// ---------- main ----------

const A = await loadImpl(A_PATH);
const rules = A.rules;

if (ROUND_ROBIN) {
  const names = Object.keys(A.ai.PERSONALITIES);
  for (const players of PLAYER_COUNTS) {
    console.log(`\nPersonality round-robin (${A_PATH})  |  ${players} players  |  target ${TARGET}  |  seeds ${START}..${START + SEEDS - 1}`);
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const X = makeSide(names[i], A, names[i]);
        const Y = makeSide(names[j], A, names[j]);
        report(`  ${players}p`, names[i], names[j], runMatch(rules, X, Y, players, START, SEEDS));
      }
    }
  }
} else {
  if (!B_PATH) {
    console.error("usage: node src/ai.battle.ts --a <candidate hlj-module.ts> --b <baseline hlj-module.ts> [--players 4,6,8] [--seeds N] [--start S]");
    process.exit(2);
  }
  const B = await loadImpl(B_PATH);
  const X = makeSide("A", A, PA);
  const Y = makeSide("B", B, PB);
  const desc = (p: string) => (p ? ` [${p}]` : "");
  console.log(`A = ${A_PATH}${desc(PA)}\nB = ${B_PATH}${desc(PB)}\ntarget ${TARGET}  |  seeds ${START}..${START + SEEDS - 1} (each played twice, teams swapped)`);
  for (const players of PLAYER_COUNTS) {
    report(`${players}p`, "A", "B", runMatch(rules, X, Y, players, START, SEEDS));
  }
}
