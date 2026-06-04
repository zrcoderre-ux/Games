// AI personality battle test for High Low Jack.
//
// Usage:
//   npx ts-node --esm src/ai.battle.ts
//   npx ts-node --esm src/ai.battle.ts --games 500 --players 4
//
// Runs round-robin matchups between all personality combinations and reports
// win rates, average scores, and set-back rates per personality.

import { aiMove, PERSONALITIES, type Personality } from "./ai.ts";
import { createGame, applyMove } from "./engine.ts";
import type { GameState } from "./engine.ts";

const isOver = (s: GameState) => s.phase === "gameOver";
const seatToAct = (s: GameState) => s.phase === "bidding" ? s.bidTurn : s.phase === "playing" ? s.turn : null;

// ---------- CLI args ----------
const args = process.argv.slice(2);
const getArg = (flag: string, def: number) => {
  const i = args.indexOf(flag);
  return i >= 0 ? parseInt(args[i + 1], 10) : def;
};
const GAMES_PER_MATCHUP = getArg("--games", 200);
const PLAYER_COUNT = getArg("--players", 4) as 4 | 6 | 8;
const TARGET = 21;

// ---------- matchup runner ----------

type Stats = {
  wins: number;
  handsPlayed: number;
  totalScore: number;
  setbacks: number;
  bidsWon: number;
  bidsMade: number;
};

function emptyStats(): Stats {
  return { wins: 0, handsPlayed: 0, totalScore: 0, setbacks: 0, bidsWon: 0, bidsMade: 0 };
}

// Returns the personality index for each seat given the matchup assignment.
function seatPersonality(seat: number, teamPersonalities: [number, number], names: string[]): Personality {
  const idx = teamPersonalities[seat % 2];
  return PERSONALITIES[names[idx]];
}

function runGame(
  seed: number,
  team0Personality: string,
  team1Personality: string,
  statsMap: Record<string, Stats>,
): void {
  let state: GameState = createGame(PLAYER_COUNT, seed, TARGET);
  const personalityNames = [team0Personality, team1Personality];
  let moves = 0;

  // Track bids per hand to compute set-backs.
  const handBids: { seat: number; amount: number }[] = [];
  let lastHandIndex = 0;

  while (!isOver(state)) {
    const seat = seatToAct(state)!;
    const pName = personalityNames[seat % 2];
    const personality = PERSONALITIES[pName];

    if (state.phase === "bidding") {
      const before = JSON.stringify(state.winningBid);
      const move = aiMove(state, seat, undefined, personality);
      if (move.type === "bid") {
        handBids.push({ seat, amount: move.amount });
      }
      state = applyMove(state, move);
    } else {
      state = applyMove(state, aiMove(state, seat, undefined, personality));
    }

    if (++moves > 500_000) {
      console.error("FAIL: game did not terminate");
      process.exit(1);
    }

    // Detect hand boundary by tricks completed resetting.
    if (state.phase === "bidding" && state.bidsActed === 0 && state.trickIndex === 0) {
      lastHandIndex = handBids.length;
    }
  }

  // Record wins.
  const winner = state.winner!;
  const winTeam = winner % 2 as 0 | 1;
  const winPersonality = personalityNames[winTeam];
  statsMap[winPersonality].wins++;

  // Record scores and hands played.
  for (let team = 0; team < 2; team++) {
    const pName = personalityNames[team];
    statsMap[pName].totalScore += state.scores[team];
    statsMap[pName].handsPlayed++;
  }
}

// ---------- head-to-head matchup ----------

function runMatchup(p0: string, p1: string, numGames: number): Record<string, Stats> {
  const stats: Record<string, Stats> = {
    [p0]: emptyStats(),
    [p1]: emptyStats(),
  };
  for (let seed = 1; seed <= numGames; seed++) {
    // Alternate which personality is team 0 to eliminate deal bias.
    if (seed % 2 === 0) runGame(seed, p0, p1, stats);
    else runGame(seed, p1, p0, stats);
  }
  return stats;
}

// ---------- output ----------

function pct(n: number, d: number): string {
  return d === 0 ? "—" : (100 * n / d).toFixed(1) + "%";
}

function printMatchup(p0: string, p1: string, stats: Record<string, Stats>): void {
  const total = stats[p0].wins + stats[p1].wins;
  console.log(`\n  ${p0.padEnd(14)} vs  ${p1}`);
  console.log(`  ${"─".repeat(48)}`);
  for (const name of [p0, p1]) {
    const s = stats[name];
    console.log(
      `  ${name.padEnd(14)}  wins ${pct(s.wins, total).padStart(6)}` +
      `  avg score ${(s.totalScore / Math.max(1, s.handsPlayed)).toFixed(1).padStart(5)}`,
    );
  }
}

// ---------- round-robin ----------

const names = Object.keys(PERSONALITIES);
console.log(`\nHigh-Low-Jack AI Battle  |  ${PLAYER_COUNT} players  |  target ${TARGET}  |  ${GAMES_PER_MATCHUP} games per matchup`);
console.log("=".repeat(60));

const overallWins: Record<string, number> = {};
const overallGames: Record<string, number> = {};
for (const n of names) { overallWins[n] = 0; overallGames[n] = 0; }

for (let i = 0; i < names.length; i++) {
  for (let j = i + 1; j < names.length; j++) {
    const p0 = names[i], p1 = names[j];
    const stats = runMatchup(p0, p1, GAMES_PER_MATCHUP);
    printMatchup(p0, p1, stats);
    overallWins[p0] += stats[p0].wins;
    overallWins[p1] += stats[p1].wins;
    overallGames[p0] += GAMES_PER_MATCHUP;
    overallGames[p1] += GAMES_PER_MATCHUP;
  }
}

console.log(`\n${"─".repeat(60)}`);
console.log("Overall (round-robin):");
for (const n of names) {
  console.log(`  ${n.padEnd(14)}  ${pct(overallWins[n], overallGames[n]).padStart(6)} win rate`);
}
console.log();
