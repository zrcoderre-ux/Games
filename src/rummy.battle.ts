// rummy.battle.ts — paired-seed battle harness for Rummy 500 bots.
//
// Compares two implementations of the Rummy module ("A" = candidate, "B" =
// baseline), loaded by path, by playing full games to the target score.
//
// Usage (Node 22 runs .ts directly):
//   node src/rummy.battle.ts --a ./src/rummy-module.ts --b /path/to/baseline-src/rummy-module.ts
//   node src/rummy.battle.ts --players 4 --seeds 300 --start 9000000 --diffA 3 --diffB 3
//   node src/rummy.battle.ts --a ./src/rummy-module.ts --b ./src/rummy-module.ts --diffA 3 --diffB 2   # ladder
//
// Flags:
//   --a PATH / --b PATH  module files exporting `rummy500Module` (default: both ./src/rummy-module.ts)
//   --players N          table size, 2-8 (default 2)
//   --seeds N            number of deal seeds (default 200)
//   --start S            first seed (default 1); tune on low seeds, confirm on fresh ones (>= 9,000,000)
//   --diffA D / --diffB D  botDifficulty (0-3) used by each side's seats (default 2 = Hard)
//   --target T           points to win (default 500)
//   --requireDiscard     play with the "must discard to go out" option
//   --maxMoves M         per-game move cap; a capped game counts as a stall (default 20000)
//   --json               also print the summary as one JSON line
//
// Method. One candidate seat plays against N-1 baseline seats. For each seed the
// same deal sequence is replayed N times with the candidate rotated through every
// seat (for 2 players that is the classic "swap sides" pairing), so card luck
// cancels. Games are stepped exactly as the room server does: the candidate
// module's rules drive every transition (createGame / applyMove / isLegal), a
// pacing gate (handComplete) is cleared by applying pacing(state).move, aux
// botAux signals are applied when a module has them, and each seat asks its OWN
// side's aiMove. Every bot move is checked with isLegal.
//
// Win share is reported with a 95% CI computed over seeds (each seed's N rotated
// games form one paired sample), against the fair share 1/N. Secondary metrics:
// per-round score margin (candidate delta minus the mean baseline delta), final
// score margin, go-out rate, and aiMove timing for each side.

import type { Game, LogEntry } from "./game.ts";

// Node globals, declared locally so the Worker type-check (no @types/node) passes.
declare const process: { argv: string[]; cwd(): string; exit(code: number): never };

type Card = { id: number; rank: number; suit: string; joker?: boolean };
type State = {
  players: number;
  phase: string;
  scores: number[];
  winner: number | null;
  stock: Card[];
  lastRound: { delta: number[]; outSeat: number | null } | null;
  log: LogEntry[];
};
type Move = { type: string; seat: number };
type Config = { players: number; target: number; requireDiscard?: boolean; botDifficulty?: number[] };
type RummyGame = Game<State, Move, Config, unknown>;

// ---------- CLI ----------

const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(name);
const opt = (name: string, def: string): string => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
};
const num = (name: string, def: number): number => Number(opt(name, String(def)));

const PATH_A = opt("--a", "./src/rummy-module.ts");
const PATH_B = opt("--b", "./src/rummy-module.ts");
const PLAYERS = num("--players", 2);
const SEEDS = num("--seeds", 200);
const START = num("--start", 1);
const DIFF_A = num("--diffA", 2);
const DIFF_B = num("--diffB", 2);
const TARGET = num("--target", 500);
const MAX_MOVES = num("--maxMoves", 20000);
const REQUIRE_DISCARD = flag("--requireDiscard");

async function loadModule(path: string): Promise<RummyGame> {
  const url = path.startsWith("/") ? `file://${path}` : new URL(path, `file://${process.cwd()}/`).href;
  const mod = await import(url);
  if (!mod.rummy500Module) throw new Error(`${path} does not export rummy500Module`);
  return mod.rummy500Module as RummyGame;
}

// ---------- statistics ----------

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
function ci95(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const v = xs.reduce((a, x) => a + (x - m) * (x - m), 0) / (xs.length - 1);
  return 1.96 * Math.sqrt(v / xs.length);
}
function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

type Timing = number[];
const timingSummary = (t: Timing): string => {
  const s = [...t].sort((a, b) => a - b);
  return `mean ${mean(s).toFixed(3)} ms, p99 ${percentile(s, 0.99).toFixed(3)} ms, max ${(s[s.length - 1] ?? 0).toFixed(3)} ms (${s.length} calls)`;
};

// ---------- one game ----------

type GameResult = {
  candidateWon: boolean;
  stalled: boolean;
  rounds: number;
  roundMargins: number[]; // per round: candidate delta - mean baseline delta
  finalMargin: number; // candidate final score - mean baseline final score
  candidateOuts: number; // rounds the candidate went out
  baselineOuts: number; // rounds some baseline seat went out
};

function playGame(rules: RummyGame, sides: RummyGame[], seed: number, candSeat: number, timeA: Timing, timeB: Timing): GameResult {
  const botDifficulty = Array.from({ length: PLAYERS }, (_, s) => (s === candSeat ? DIFF_A : DIFF_B));
  let state = rules.createGame({ players: PLAYERS, target: TARGET, requireDiscard: REQUIRE_DISCARD, botDifficulty }, seed);
  const roundMargins: number[] = [];
  let candidateOuts = 0, baselineOuts = 0, moves = 0;

  while (!rules.isOver(state)) {
    if (++moves > MAX_MOVES) {
      return { candidateWon: false, stalled: true, rounds: roundMargins.length, roundMargins, finalMargin: 0, candidateOuts, baselineOuts };
    }
    const seat = rules.seatToAct(state);
    let next: State;
    if (seat === null) {
      // Gate phase (handComplete): the room server applies the pacing move.
      const pace = rules.pacing?.(state);
      if (!pace) throw new Error(`no seat to act and no pacing move (seed ${seed}, phase ${state.phase})`);
      next = rules.applyMove(state, pace.move);
    } else {
      const side = sides[seat];
      let s = state;
      const aux = side.aux?.botAux?.(s, seat);
      if (aux != null && rules.aux) s = rules.aux.apply(s, seat, aux);
      const t0 = performance.now();
      const move = side.aiMove(s, seat);
      const dt = performance.now() - t0;
      (seat === candSeat ? timeA : timeB).push(dt);
      if (!rules.isLegal(s, move)) {
        throw new Error(`illegal move from ${seat === candSeat ? "A" : "B"} (seed ${seed}, seat ${seat}): ${JSON.stringify(move)}`);
      }
      next = rules.applyMove(s, move);
    }
    // A round was scored when lastRound is replaced.
    if (next.lastRound && next.lastRound !== state.lastRound) {
      const d = next.lastRound.delta;
      const others = d.filter((_, s) => s !== candSeat);
      roundMargins.push(d[candSeat] - mean(others));
      const out = next.lastRound.outSeat;
      if (out === candSeat) candidateOuts++;
      else if (out !== null) baselineOuts++;
    }
    state = next;
  }
  const others = state.scores.filter((_, s) => s !== candSeat);
  return {
    candidateWon: state.winner === candSeat,
    stalled: false,
    rounds: roundMargins.length,
    roundMargins,
    finalMargin: state.scores[candSeat] - mean(others),
    candidateOuts,
    baselineOuts,
  };
}

// ---------- main ----------

async function main() {
  const A = await loadModule(PATH_A);
  const B = await loadModule(PATH_B);
  const timeA: Timing = [], timeB: Timing = [];

  const seedShares: number[] = []; // per seed: candidate wins / games
  const seedRoundMargins: number[] = []; // per seed: mean round margin
  const seedFinalMargins: number[] = [];
  let games = 0, wins = 0, stalls = 0, rounds = 0, candOuts = 0, baseOuts = 0;

  for (let i = 0; i < SEEDS; i++) {
    const seed = START + i;
    let seedWins = 0, seedGames = 0;
    const rm: number[] = [], fm: number[] = [];
    for (let candSeat = 0; candSeat < PLAYERS; candSeat++) {
      const sides = Array.from({ length: PLAYERS }, (_, s) => (s === candSeat ? A : B));
      const r = playGame(A, sides, seed, candSeat, timeA, timeB);
      games++;
      if (r.stalled) { stalls++; continue; }
      seedGames++;
      if (r.candidateWon) { wins++; seedWins++; }
      rounds += r.rounds;
      candOuts += r.candidateOuts;
      baseOuts += r.baselineOuts;
      rm.push(...r.roundMargins);
      fm.push(r.finalMargin);
    }
    if (seedGames > 0) {
      seedShares.push(seedWins / seedGames);
      seedRoundMargins.push(mean(rm));
      seedFinalMargins.push(mean(fm));
    }
  }

  const fair = 1 / PLAYERS;
  const share = mean(seedShares), shareCi = ci95(seedShares);
  const pct = (x: number) => (100 * x).toFixed(1) + "%";
  const label = (p: string, d: number) => `${p} [diff ${d}]`;
  console.log(`Rummy 500 battle: ${PLAYERS} players, target ${TARGET}${REQUIRE_DISCARD ? ", requireDiscard" : ""}, seeds ${START}..${START + SEEDS - 1}`);
  console.log(`  A (candidate): ${label(PATH_A, DIFF_A)}  x1 seat, rotated through all ${PLAYERS}`);
  console.log(`  B (baseline):  ${label(PATH_B, DIFF_B)}  x${PLAYERS - 1} seats`);
  console.log(`games ${games} (${stalls} stalled), rounds ${rounds}`);
  console.log(`candidate win share ${pct(share)} ± ${pct(shareCi)} (fair ${pct(fair)}; edge ${(100 * (share - fair)).toFixed(1)} pts)`);
  console.log(`round margin (A - mean B) ${mean(seedRoundMargins).toFixed(2)} ± ${ci95(seedRoundMargins).toFixed(2)} pts/round`);
  console.log(`final margin (A - mean B) ${mean(seedFinalMargins).toFixed(1)} ± ${ci95(seedFinalMargins).toFixed(1)} pts/game`);
  console.log(`go-outs: A ${pct(candOuts / Math.max(1, rounds))} of rounds, B (any seat) ${pct(baseOuts / Math.max(1, rounds))}`);
  console.log(`timing A: ${timingSummary(timeA)}`);
  console.log(`timing B: ${timingSummary(timeB)}`);
  if (flag("--json")) {
    const sa = [...timeA].sort((a, b) => a - b), sb = [...timeB].sort((a, b) => a - b);
    console.log(JSON.stringify({
      players: PLAYERS, start: START, seeds: SEEDS, diffA: DIFF_A, diffB: DIFF_B, games, stalls, wins,
      share, shareCi, roundMargin: mean(seedRoundMargins), roundMarginCi: ci95(seedRoundMargins),
      finalMargin: mean(seedFinalMargins), timingA: { mean: mean(sa), p99: percentile(sa, 0.99), max: sa[sa.length - 1] ?? 0 },
      timingB: { mean: mean(sb), p99: percentile(sb, 0.99), max: sb[sb.length - 1] ?? 0 },
    }));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
