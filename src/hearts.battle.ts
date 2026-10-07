// hearts.battle.ts — paired-seed battle harness for the Hearts bots.
//
// Pits two implementations of the Hearts module against each other by path:
// "A" (the candidate) and "B" (the baseline). Every game is stepped exactly the
// way the room server steps a bot-only room: the seat to act gets its OWN
// module's aiMove (A seats ask A, B seats ask B), pacing gates are cleared with
// pacing(state).move, and botAux signals are applied where a module has them.
// All state transitions (applyMove / isLegal / pacing) use the CANDIDATE's rules
// so both sides play the same game; every move is checked with isLegal.
//
// Seeds are PAIRED: each seed's deal sequence (the deck order is threaded only
// through dealing, so every hand of a seed is the same deal no matter how it is
// played) is replayed once per seat assignment, so each side sits in every seat
// over the same cards and card luck cancels.
//   --mode solo  one A seat vs (players-1) B seats, A rotated through every seat
//                (players games per seed)
//   --mode duo   4 players only: A on seats {0,2} vs B on {1,3}, then swapped
//                (2 games per seed)
//
// Usage (Node 22 strips the types itself):
//   node src/hearts.battle.ts --b <baseline>/hearts-module.ts [--a ./src/hearts-module.ts]
//        [--players 4] [--mode solo|duo] [--seeds 200] [--start 1] [--target 100] [--workers 1]
//   node src/hearts.battle.ts --timing [--a ...] [--players 4] [--seeds 50] [--start 1]
//        (all seats play A, single-threaded; reports per-aiMove latency only)
//
// Reported (95% confidence intervals are over seeds, the independent unit):
//   pts/hand  average points a side's seat takes per hand (moon-adjusted delta)
//   diff      A pts/hand minus B pts/hand within the same games (negative = A better)
//   win share fraction of games a side's seats win (ties split), vs the fair share
//   moons     moon shots made by each side (in solo mode B's are the ones A allowed),
//             and how often each side's seats catch the Q(S)
//   timing    A's aiMove wall-clock latency: mean / p99 / max ms, with each
//             process's first call (before the JIT has warmed up) shown apart
// Tune on one seed range and confirm on a fresh one (e.g. --start 9000000).

// Node globals, declared locally so the Worker-typed tsc pass accepts this script.
declare const process: { argv: string[]; exit(code?: number): never };

type Card = { id: number; rank: number; suit: string };
type State = {
  players: number;
  phase: string;
  handNo: number;
  currentTrick: { seat: number; card: Card }[];
  trickWinner: number | null;
  scores: number[];
  lastHand: { delta: number[]; shooter: number | null } | null;
};
type Move = { type: string; seat: number };
type Module = {
  createGame(config: { players: number; target: number }, seed: number): State;
  seatToAct(s: State): number | null;
  isLegal(s: State, m: Move): boolean;
  applyMove(s: State, m: Move): State;
  isOver(s: State): boolean;
  aiMove(s: State, seat: number): Move;
  pacing?(s: State): { move: Move } | null;
  aux?: { apply(s: State, seat: number, p: unknown): State; botAux?(s: State, seat: number): unknown | null };
};

type Opts = {
  a: string; b: string; players: number; mode: "solo" | "duo";
  seeds: number; start: number; target: number; workers: number; timing: boolean;
};

// Per-game record, small enough to ship back from a worker.
type GameRec = {
  seed: number;
  sides: string; // e.g. "ABBB": which module owns each seat
  hands: number;
  pts: number[]; // per seat: sum of moon-adjusted hand deltas
  wins: number[]; // per seat: share of the game win (ties split)
  moons: number[]; // per seat: moons shot
  queens: number[]; // per seat: tricks won holding the Q(S)
};

// ---------- CLI ----------

function parseOpts(argv: string[]): Opts {
  const get = (flag: string, def: string): string => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
  };
  const o: Opts = {
    a: get("--a", "./src/hearts-module.ts"),
    b: get("--b", ""),
    players: +get("--players", "4"),
    mode: get("--mode", "solo") as Opts["mode"],
    seeds: +get("--seeds", "200"),
    start: +get("--start", "1"),
    target: +get("--target", "100"),
    workers: Math.max(1, +get("--workers", "1")),
    timing: argv.includes("--timing"),
  };
  if (!o.timing && !o.b) { console.error("missing --b <baseline module path>"); process.exit(2); }
  if (o.mode !== "solo" && o.mode !== "duo") { console.error(`unknown --mode ${o.mode}`); process.exit(2); }
  if (o.mode === "duo" && o.players !== 4) { console.error("--mode duo needs --players 4"); process.exit(2); }
  return o;
}

// Resolve a CLI path (relative to the shell's cwd) to an importable file URL.
async function loadModule(path: string): Promise<Module> {
  const nodePath = "node:path"; // non-literal specifiers keep tsc from needing @types/node
  const nodeUrl = "node:url";
  const { resolve } = await import(nodePath);
  const { pathToFileURL } = await import(nodeUrl);
  const mod = await import(pathToFileURL(resolve(path)).href);
  const game = Object.values(mod).find((v: any) => v && typeof v === "object" && typeof v.aiMove === "function");
  if (!game) throw new Error(`no Game module exported by ${path}`);
  return game as Module;
}

// Seat assignments played for every seed.
function assignments(o: Opts): string[] {
  if (o.timing) return ["A".repeat(o.players)];
  if (o.mode === "duo") return ["ABAB", "BABA"];
  return Array.from({ length: o.players }, (_, k) => Array.from({ length: o.players }, (_, s) => (s === k ? "A" : "B")).join(""));
}

// ---------- one game, stepped like the room server ----------

function playGame(A: Module, B: Module, o: Opts, seed: number, sides: string, times: number[]): GameRec {
  const N = o.players;
  let s = A.createGame({ players: N, target: o.target }, seed);
  const rec: GameRec = {
    seed, sides, hands: 0,
    pts: Array(N).fill(0), wins: Array(N).fill(0), moons: Array(N).fill(0), queens: Array(N).fill(0),
  };
  let steps = 0;
  while (!A.isOver(s)) {
    if (++steps > 100_000) throw new Error(`seed ${seed} ${sides}: game did not terminate`);
    const seat = A.seatToAct(s);
    let next: State;
    if (seat === null) {
      // A pacing gate (trickComplete): note who catches the Q(S), then advance.
      const pace = A.pacing ? A.pacing(s) : null;
      if (!pace) throw new Error(`seed ${seed}: no seat to act and no pacing move`);
      if (s.phase === "trickComplete" && s.trickWinner !== null && s.currentTrick.some((p) => p.card.suit === "S" && p.card.rank === 12))
        rec.queens[s.trickWinner]++;
      next = A.applyMove(s, pace.move);
    } else {
      const mod = sides[seat] === "A" ? A : B;
      if (mod.aux?.botAux && A.aux) {
        const payload = mod.aux.botAux(s, seat);
        if (payload != null) s = A.aux.apply(s, seat, payload);
      }
      const t0 = performance.now();
      const move = mod.aiMove(s, seat);
      if (sides[seat] === "A") times.push(performance.now() - t0);
      if (!A.isLegal(s, move)) throw new Error(`seed ${seed} ${sides}: illegal ${sides[seat]} move ${JSON.stringify(move)}`);
      next = A.applyMove(s, move);
    }
    if (next.lastHand && next.lastHand !== s.lastHand) {
      rec.hands++;
      next.lastHand.delta.forEach((d, i) => (rec.pts[i] += d));
      if (next.lastHand.shooter !== null) rec.moons[next.lastHand.shooter]++;
    }
    s = next;
  }
  const min = Math.min(...s.scores);
  const tied = s.scores.filter((v) => v === min).length;
  s.scores.forEach((v, i) => { if (v === min) rec.wins[i] = 1 / tied; });
  return rec;
}

// The first aiMove of a process runs before V8 has optimized anything, so it is
// reported apart (`cold`) from the steady-state latencies (`times`).
type Run = { games: GameRec[]; times: number[]; cold: number[] };

async function runSeeds(o: Opts, from: number, count: number): Promise<Run> {
  const A = await loadModule(o.a);
  const B = o.timing ? A : await loadModule(o.b);
  const games: GameRec[] = [];
  const times: number[] = [];
  for (let seed = from; seed < from + count; seed++)
    for (const sides of assignments(o)) games.push(playGame(A, B, o, seed, sides, times));
  const cold = times.splice(0, 1);
  return { games, times, cold };
}

// ---------- statistics ----------

function meanCI(xs: number[]): { mean: number; half: number } {
  const n = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const v = n > 1 ? xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1) : 0;
  return { mean, half: 1.96 * Math.sqrt(v / n) };
}

const fmt = (m: { mean: number; half: number }, d = 3) => `${m.mean.toFixed(d)} ± ${m.half.toFixed(d)}`;

function timingLine(times: number[], cold: number[]): string {
  if (!times.length) return "no A decisions timed";
  const t = Float64Array.from(times).sort();
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  const coldMax = Math.max(...cold);
  const p99 = t[Math.min(t.length - 1, Math.floor(t.length * 0.99))];
  return `A aiMove ms: mean ${mean.toFixed(3)}  p99 ${p99.toFixed(3)}  max ${t[t.length - 1].toFixed(3)}  (${times.length} calls)` +
    `   first call per process (cold JIT): max ${coldMax.toFixed(3)}`;
}

function report(o: Opts, { games, times, cold }: Run): void {
  console.log(`\nHearts battle  |  ${o.players}p  |  mode ${o.mode}  |  seeds ${o.start}..${o.start + o.seeds - 1}  |  target ${o.target}  |  ${games.length} games`);
  console.log(`  A = ${o.a}\n  B = ${o.b}`);

  // Group games by seed (the independent, paired unit) for the CIs.
  const bySeed = new Map<number, GameRec[]>();
  for (const g of games) bySeed.set(g.seed, [...(bySeed.get(g.seed) ?? []), g]);
  const diff: number[] = [], aPPH: number[] = [], bPPH: number[] = [], aWin: number[] = [];
  const tot = { A: { pts: 0, sh: 0, win: 0, seats: 0, moons: 0, queens: 0 }, B: { pts: 0, sh: 0, win: 0, seats: 0, moons: 0, queens: 0 } };
  for (const group of bySeed.values()) {
    const g = { A: { pts: 0, sh: 0, win: 0, seats: 0 }, B: { pts: 0, sh: 0, win: 0, seats: 0 } };
    for (const r of group)
      for (let i = 0; i < o.players; i++) {
        const side = r.sides[i] as "A" | "B";
        g[side].pts += r.pts[i]; g[side].sh += r.hands; g[side].win += r.wins[i]; g[side].seats++;
        tot[side].pts += r.pts[i]; tot[side].sh += r.hands; tot[side].win += r.wins[i]; tot[side].seats++;
        tot[side].moons += r.moons[i]; tot[side].queens += r.queens[i];
      }
    aPPH.push(g.A.pts / g.A.sh);
    bPPH.push(g.B.pts / g.B.sh);
    diff.push(g.A.pts / g.A.sh - g.B.pts / g.B.sh);
    aWin.push(g.A.win / group.length);
  }
  const aSeats = o.mode === "duo" ? 2 : 1;
  const fair = aSeats / o.players;
  const w = meanCI(aWin);
  console.log(`  pts/hand   A ${fmt(meanCI(aPPH))}   B ${fmt(meanCI(bPPH))}`);
  console.log(`  diff A-B   ${fmt(meanCI(diff))} pts/hand   (negative = candidate better)`);
  console.log(`  win share  A ${(100 * w.mean).toFixed(1)}% ± ${(100 * w.half).toFixed(1)}%   fair ${(100 * fair).toFixed(1)}%   (A seats combined)`);
  console.log(`  moons shot   A ${tot.A.moons} (${(100 * tot.A.moons / tot.A.sh).toFixed(2)}/100 seat-hands)   B ${tot.B.moons} (${(100 * tot.B.moons / tot.B.sh).toFixed(2)}/100)`);
  console.log(`  Q(S) caught per seat-hand   A ${(tot.A.queens / tot.A.sh).toFixed(3)}   B ${(tot.B.queens / tot.B.sh).toFixed(3)}`);
  console.log(`  ${timingLine(times, cold)}`);
}

// ---------- entry: single process, a pool of workers, or a worker itself ----------

const wtName = "node:worker_threads";
const wt = await import(wtName);

if (!wt.isMainThread) {
  const { o, from, count } = wt.workerData as { o: Opts; from: number; count: number };
  wt.parentPort.postMessage(await runSeeds(o, from, count));
} else {
  const o = parseOpts(process.argv.slice(2));
  if (o.timing) o.workers = 1; // latency numbers need an otherwise idle thread
  let run: Run = { games: [], times: [], cold: [] };
  if (o.workers === 1) {
    run = await runSeeds(o, o.start, o.seeds);
  } else {
    const per = Math.ceil(o.seeds / o.workers);
    const jobs: Promise<Run>[] = [];
    for (let k = 0; k < o.workers; k++) {
      const from = o.start + k * per;
      const count = Math.min(per, o.start + o.seeds - from);
      if (count <= 0) break;
      jobs.push(new Promise((res, rej) => {
        const w = new wt.Worker(new URL((import.meta as { url: string }).url), { workerData: { o, from, count } });
        w.once("message", res);
        w.once("error", rej);
      }));
    }
    for (const r of await Promise.all(jobs))
      run = { games: run.games.concat(r.games), times: run.times.concat(r.times), cold: run.cold.concat(r.cold) };
  }
  if (o.timing) {
    console.log(`\nHearts aiMove timing  |  ${o.players}p  |  ${run.games.length} all-A games  |  ${o.a}`);
    console.log(`  ${timingLine(run.times, run.cold)}`);
  } else {
    report(o, run);
  }
}
