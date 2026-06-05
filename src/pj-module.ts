// pj-module.ts — Pegs and Jokers ("Jokers and Marbles") as a pure Game module.
//
// Pure and runtime-independent (imports only Suit/SUITS from engine.ts and the
// Game contract): randomness only via a seeded PRNG threaded through state.seed.
//
// BOARD. Modeled on a real sectional board: identical per-player PANELS joined
// into a loop. Each panel owns HPS track holes along the rail, an exit + castle
// turn, a straight castle ("heaven") aimed inward at the table, and a start
// ("home") row. The completed board is a RECTANGLE: one panel on each short end
// and (players-2)/2 panels on each long side, with the panels cut as trapezoids
// that narrow toward the hollow centre (so the side panels' castles run on a
// diagonal). 4 players = the "remove one panel per side" board; 6 = the full
// standard board. The geometry lives here (normalized coords in the view) so the
// client is a pure renderer.
//
// TEAMS. Two teams in alternating seats (even seats vs odd). 4 players -> two
// pairs; 6 players -> two trios. Once all your own marbles are home you play for
// a teammate; a team wins when all its marbles are home.
//
// RULES (this cut; documented extension points):
//   - A / K / Joker bring a marble out of start to the exit. Pips move forward
//     (A=1, 2..10, J=11, Q=12, K=13). 7 may split across two of your marbles.
//   - Joker may instead teleport one of your marbles (start or ring) onto ANY
//     opponent on the ring, bumping it home. Landing on an opponent on the ring
//     bumps it to its start; you can never land on your own/teammate's marble;
//     castle entry needs an exact count; start/castle holes are safe. Passing
//     your own marble inside the castle is allowed here (a simplification).
//   - Hand of HAND cards; play one (or forfeit one with no legal move), then
//     draw back up; the discard reshuffles into the stock when it runs out.

import { SUITS, type Suit } from "./engine.ts";
import type { Game, RoomMeta, LogEntry, LogCard } from "./game.ts";

// ---------- board constants ----------

const HPS = 12; // track holes per player panel
const HAND = 5;
const SUPPORTED = [4, 6];

const ringSize = (players: number): number => players * HPS;
const teamOf = (p: number): number => p % 2; // even seats vs odd seats
const teammatesOf = (p: number, players: number): number[] => {
  const out: number[] = [];
  for (let q = 0; q < players; q++) if (q !== p && teamOf(q) === teamOf(p)) out.push(q);
  return out;
};

// Castle turn at the middle of a panel; exit one hole later, so a marble laps
// the whole ring before turning up its own castle.
const castleEntry = (p: number): number => p * HPS + (HPS >> 1); // p*12 + 6
const exitHole = (p: number, players: number): number => (castleEntry(p) + 1) % ringSize(players);

// ---------- cards ----------

export type PJCard = { id: number; joker: true } | { id: number; rank: number; suit: Suit };
const isJokerCard = (c: PJCard): c is { id: number; joker: true } => "joker" in c;
const stepsOf = (c: PJCard): number => (isJokerCard(c) ? 0 : c.rank === 14 ? 1 : c.rank); // A=1
const isComeOutCard = (c: PJCard): boolean => isJokerCard(c) || (!isJokerCard(c) && (c.rank === 14 || c.rank === 13)); // A/K/Joker

function buildDeck(): PJCard[] {
  const deck: PJCard[] = [];
  let id = 0;
  for (let d = 0; d < 2; d++) for (const suit of SUITS) for (let rank = 2; rank <= 14; rank++) deck.push({ id: id++, rank, suit });
  for (let j = 0; j < 4; j++) deck.push({ id: id++, joker: true });
  return deck; // 2*52 + 4 = 108
}

// ---------- seeded PRNG (mulberry32) ----------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle<T>(items: T[], seed: number): { shuffled: T[]; nextSeed: number } {
  const rng = mulberry32(seed);
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return { shuffled: a, nextSeed: Math.floor(rng() * 0xffffffff) >>> 0 };
}

// ---------- marble locations ----------

export type Loc =
  | { z: "start"; i: number }
  | { z: "ring"; r: number }
  | { z: "castle"; i: number };

export type MarbleRef = { owner: number; idx: number };

function progress(owner: number, loc: Loc, players: number): number {
  if (loc.z === "start") return -1;
  const R = ringSize(players);
  if (loc.z === "ring") return (loc.r - exitHole(owner, players) + R) % R;
  return R + loc.i;
}
function locAtProgress(owner: number, prog: number, players: number): Loc {
  const R = ringSize(players);
  return prog < R ? { z: "ring", r: (exitHole(owner, players) + prog) % R } : { z: "castle", i: prog - R };
}

// ---------- state, moves, config, view ----------

export type PJState = {
  players: number;
  marbles: number;
  seed: number;
  phase: "playing" | "gameOver";
  turn: number;
  pos: Loc[][];
  hands: PJCard[][];
  stock: PJCard[];
  discard: PJCard[];
  winner: number | null; // winning team (0 or 1)
  lastBump: { by: number; victim: number } | null;

  // authoritative, append-only move log (rides through every { ...state } spread)
  log: LogEntry[];
  logSeq: number;
};

export type PJMove =
  | { type: "move"; seat: number; cardId: number; marble: MarbleRef; steps: number }
  | { type: "comeOut"; seat: number; cardId: number; marble: MarbleRef }
  | { type: "joker"; seat: number; cardId: number; marble: MarbleRef; target: number }
  | { type: "split7"; seat: number; cardId: number; a: { marble: MarbleRef; steps: number }; b: { marble: MarbleRef; steps: number } }
  | { type: "forfeit"; seat: number; cardId: number };

export type PJConfig = { players: number; marbles: number };

export type Hole = { x: number; y: number };
export type Seam = { x: number; y: number };
export type BoardLayout = {
  players: number;
  per_section: number;
  viewW: number;
  viewH: number;
  center: Hole;
  hollow: { x: number; y: number; w: number; h: number };
  ring: Hole[];
  starts: Hole[][];
  castles: Hole[][];
  exits: number[];
  castleEntries: number[];
  castleArmStarts: Hole[]; // where each castle arm begins (corner for 4p, rail midpoint for 6p)
  seams: Seam[]; // panel-boundary points on the rail; client draws each to centre
};

export type PegView = { owner: number; idx: number; team: number; loc: Loc };

export type PJView = {
  you: number | null;
  players: number;
  marbles: number;
  phase: "playing" | "gameOver" | "lobby";
  seats: RoomMeta["seats"];
  hostSeat: number | null;
  botReplacement: boolean;
  disconnectedSeats: number[];
  toAct: number | null;
  yourTurn: boolean;
  yourTeam: number | null;
  playingFor: number[];
  board: BoardLayout;
  pegs: PegView[];
  yourHand: PJCard[];
  handCounts: number[];
  stockCount: number;
  discardCount: number;
  legalMoves: PJMove[];
  homeCounts: number[];
  winner: number | null;
  lastBump: { by: number; victim: number } | null;
  log: LogEntry[]; // public move history, shipped to every client
};

// ---------- board layout: rectangle of trapezoidal panels ----------

function boardLayout(players: number, marbles: number): BoardLayout {
  const W = 100;
  const ti = 8; // track inset from the outer frame edge
  // Long sides carry 2 panels each (6p) so the rail spacing matches the ends:
  // height grows to keep hole spacing roughly uniform. 4p is square.
  const H = players === 6 ? 2 * W - 2 * ti : 100;
  const cx = W / 2, cy = H / 2;
  const half = (H - 2 * ti) / 2;

  // Clockwise edge runs, one per panel, each parameterized t in [0,1).
  type Run = (t: number) => Hole;
  const runs: Run[] =
    players === 4
      ? [
          (t) => ({ x: ti + t * (W - 2 * ti), y: ti }), // top  L->R
          (t) => ({ x: W - ti, y: ti + t * (H - 2 * ti) }), // right T->B
          (t) => ({ x: W - ti - t * (W - 2 * ti), y: H - ti }), // bottom R->L
          (t) => ({ x: ti, y: H - ti - t * (H - 2 * ti) }), // left  B->T
        ]
      : [
          (t) => ({ x: ti + t * (W - 2 * ti), y: ti }), // S0 top
          (t) => ({ x: W - ti, y: ti + t * half }), // S1 right-upper
          (t) => ({ x: W - ti, y: ti + half + t * half }), // S2 right-lower
          (t) => ({ x: W - ti - t * (W - 2 * ti), y: H - ti }), // S3 bottom
          (t) => ({ x: ti, y: H - ti - t * half }), // S4 left-lower
          (t) => ({ x: ti, y: H - ti - half - t * half }), // S5 left-upper
        ];

  const ring: Hole[] = [];
  for (let p = 0; p < players; p++) for (let j = 0; j < HPS; j++) ring.push(runs[p]((j + 0.5) / HPS));

  const castles: Hole[][] = [];
  const starts: Hole[][] = [];
  const seams: Seam[] = [];
  const railSpacing = (W - 2 * ti) / HPS;

  // 4p: diagonal castle arms from each corner inward at 45°
  const S2 = 1 / Math.SQRT2;
  const corners4 = [
    { x: W - ti, y: ti,     dx: -S2,  dy:  S2  }, // top-right → SW
    { x: W - ti, y: H - ti, dx: -S2,  dy: -S2  }, // bottom-right → NW
    { x: ti,     y: H - ti, dx:  S2,  dy: -S2  }, // bottom-left → NE
    { x: ti,     y: ti,     dx:  S2,  dy:  S2  }, // top-left → SE
  ];
  const cstep4 = 4.8; // spacing between castle holes

  for (let p = 0; p < players; p++) {
    const cm = ring[castleEntry(p)];
    const dx = cx - cm.x, dy = cy - cm.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len; // inward unit vector (toward centre)
    const ax = -uy, ay = ux; // along-rail unit vector
    const reach = len * 0.6;
    const cstep = reach / (marbles + 0.5);
    const cas: Hole[] = [];
    if (players === 4) {
      // Diagonal from corner
      const c = corners4[p];
      for (let j = 0; j < marbles; j++) cas.push({ x: c.x + c.dx * cstep4 * (j + 1), y: c.y + c.dy * cstep4 * (j + 1) });
    } else {
      for (let j = 0; j < marbles; j++) cas.push({ x: cm.x + ux * cstep * (j + 1), y: cm.y + uy * cstep * (j + 1) });
    }
    castles.push(cas);

    // start group: 2D diamond inside the inner wood band, inward from the exit hole
    // rows go inward (ux,uy direction), cols run along the rail (ax,ay direction)
    const ex = ring[exitHole(p, players)];
    const rowSp = 4.5, colSp = 3.6;
    const row0n = Math.ceil(marbles / 2), row1n = Math.floor(marbles / 2);
    const st: Hole[] = [];
    for (let row = 0; row < 2; row++) {
      const n = row === 0 ? row0n : row1n;
      const inset = 5.5 + row * rowSp;
      for (let col = 0; col < n; col++) {
        const along = colSp * (col - (n - 1) / 2);
        st.push({ x: ex.x + ux * inset + ax * along, y: ex.y + uy * inset + ay * along });
      }
    }
    starts.push(st);

    seams.push(runs[p](0)); // panel boundary at the start of each section
  }

  const hi = ti + 4.5;
  return {
    players,
    per_section: HPS,
    viewW: W,
    viewH: H,
    center: { x: cx, y: cy },
    hollow: { x: hi, y: hi, w: W - 2 * hi, h: H - 2 * hi },
    ring,
    starts,
    castles,
    exits: Array.from({ length: players }, (_, p) => exitHole(p, players)),
    castleEntries: Array.from({ length: players }, (_, p) => castleEntry(p)),
    castleArmStarts: players === 4
      ? corners4.map(c => ({ x: c.x, y: c.y }))
      : Array.from({ length: players }, (_, p) => ring[castleEntry(p)]),
    seams,
  };
}

// ---------- occupancy ----------

function ringOccupant(state: PJState, r: number): MarbleRef | null {
  for (let p = 0; p < state.players; p++)
    for (let i = 0; i < state.marbles; i++) {
      const l = state.pos[p][i];
      if (l.z === "ring" && l.r === r) return { owner: p, idx: i };
    }
  return null;
}
function castleOccupied(state: PJState, owner: number, i: number): boolean {
  return state.pos[owner].some((l) => l.z === "castle" && l.i === i);
}
function firstEmptyStart(state: PJState, owner: number): number {
  const used = new Set(state.pos[owner].filter((l) => l.z === "start").map((l) => (l as { i: number }).i));
  for (let i = 0; i < state.marbles; i++) if (!used.has(i)) return i;
  return 0;
}
const allHome = (state: PJState, owner: number): boolean => state.pos[owner].every((l) => l.z === "castle");

// Owners whose marbles `seat` may move: its own, or — once those are all home —
// its teammates who still have marbles out.
function movableOwners(state: PJState, seat: number): number[] {
  if (!allHome(state, seat)) return [seat];
  const helping = teammatesOf(seat, state.players).filter((q) => !allHome(state, q));
  return helping.length ? helping : [seat];
}

// ---------- move legality ----------

type Effect = { from: Loc; to: Loc; bump: MarbleRef | null };

function ordinaryEffect(state: PJState, ref: MarbleRef, steps: number): Effect | null {
  const loc = state.pos[ref.owner][ref.idx];
  if (loc.z === "start") return null;
  const prog = progress(ref.owner, loc, state.players);
  const np = prog + steps;
  if (steps <= 0 || np > ringSize(state.players) + state.marbles - 1) return null;
  const to = locAtProgress(ref.owner, np, state.players);
  if (to.z === "ring") {
    const occ = ringOccupant(state, to.r);
    if (occ && teamOf(occ.owner) === teamOf(ref.owner)) return null;
    return { from: loc, to, bump: occ && teamOf(occ.owner) !== teamOf(ref.owner) ? occ : null };
  }
  if (castleOccupied(state, ref.owner, to.i)) return null;
  return { from: loc, to, bump: null };
}
function comeOutEffect(state: PJState, ref: MarbleRef): Effect | null {
  const loc = state.pos[ref.owner][ref.idx];
  if (loc.z !== "start") return null;
  const r = exitHole(ref.owner, state.players);
  const occ = ringOccupant(state, r);
  if (occ && teamOf(occ.owner) === teamOf(ref.owner)) return null;
  return { from: loc, to: { z: "ring", r }, bump: occ ?? null };
}
function jokerEffect(state: PJState, ref: MarbleRef, target: number): Effect | null {
  const loc = state.pos[ref.owner][ref.idx];
  if (loc.z === "castle") return null;
  const occ = ringOccupant(state, target);
  if (!occ || teamOf(occ.owner) === teamOf(ref.owner)) return null;
  return { from: loc, to: { z: "ring", r: target }, bump: occ };
}

// ---------- legal-move enumeration ----------

function legalBoardMoves(state: PJState): PJMove[] {
  const seat = state.turn;
  const owners = movableOwners(state, seat);
  const out: PJMove[] = [];
  const R = ringSize(state.players);

  for (const card of state.hands[seat]) {
    const cardId = card.id;
    if (isJokerCard(card)) {
      for (const owner of owners)
        for (let idx = 0; idx < state.marbles; idx++) {
          const ref = { owner, idx };
          if (comeOutEffect(state, ref)) out.push({ type: "comeOut", seat, cardId, marble: ref });
          for (let r = 0; r < R; r++) if (jokerEffect(state, ref, r)) out.push({ type: "joker", seat, cardId, marble: ref, target: r });
        }
      continue;
    }
    const steps = stepsOf(card);
    if (isComeOutCard(card))
      for (const owner of owners)
        for (let idx = 0; idx < state.marbles; idx++)
          if (comeOutEffect(state, { owner, idx })) out.push({ type: "comeOut", seat, cardId, marble: { owner, idx } });
    for (const owner of owners)
      for (let idx = 0; idx < state.marbles; idx++)
        if (ordinaryEffect(state, { owner, idx }, steps)) out.push({ type: "move", seat, cardId, marble: { owner, idx }, steps });

    if (!isJokerCard(card) && card.rank === 7) {
      const refs: MarbleRef[] = [];
      for (const owner of owners) for (let idx = 0; idx < state.marbles; idx++) refs.push({ owner, idx });
      for (let s1 = 1; s1 <= 6; s1++) {
        const s2 = 7 - s1;
        for (const a of refs)
          for (const b of refs) {
            if (a.owner === b.owner && a.idx === b.idx) continue;
            const e1 = ordinaryEffect(state, a, s1);
            if (!e1) continue;
            const mid = applyEffect(state, a, e1);
            if (ordinaryEffect(mid, b, s2)) out.push({ type: "split7", seat, cardId, a: { marble: a, steps: s1 }, b: { marble: b, steps: s2 } });
          }
      }
    }
  }
  return out;
}

function legalMoves(state: PJState): PJMove[] {
  if (state.phase !== "playing") return [];
  const board = legalBoardMoves(state);
  if (board.length) return board;
  return state.hands[state.turn].map((c) => ({ type: "forfeit", seat: state.turn, cardId: c.id }));
}

const moveEq = (a: PJMove, b: PJMove): boolean => JSON.stringify(a) === JSON.stringify(b);
const seatToAct = (s: PJState): number | null => (s.phase === "gameOver" ? null : s.turn);
const isOver = (s: PJState): boolean => s.phase === "gameOver";
function isLegal(state: PJState, move: PJMove): boolean {
  return state.phase === "playing" && move.seat === state.turn && legalMoves(state).some((m) => moveEq(m, move));
}

// ---------- move log ----------
// Same pattern as the other modules: append entries (with monotonic ids) at the
// module boundary; the log lives in state, so it persists across hibernation and
// is identical for every client.
const LOG_CAP = 120;
const teamLetter = (t: number): string => (t === 0 ? "A" : "B");
const lc = (c: PJCard): LogCard => (isJokerCard(c) ? { joker: true } : { rank: c.rank, suit: c.suit });

function describePlay(move: PJMove): { msg: string; tail?: string } {
  switch (move.type) {
    case "forfeit": return { msg: "forfeits \u2014 no legal play" };
    case "comeOut": return { msg: "brings a marble out" };
    case "joker": return { msg: "plays a joker" };
    case "split7": return { msg: "splits the seven" };
    case "move": return { msg: "plays", tail: `${move.steps} step${Math.abs(move.steps) === 1 ? "" : "s"}` };
  }
}

function attach(next: PJState, prev: PJState, parts: Omit<LogEntry, "id">[]): PJState {
  if (parts.length === 0) return { ...next, log: prev.log, logSeq: prev.logSeq };
  let seq = prev.logSeq;
  const added = parts.map((p) => ({ id: ++seq, ...p }));
  const log = [...prev.log, ...added].slice(-LOG_CAP);
  return { ...next, log, logSeq: seq };
}

// ---------- applying moves ----------

function applyEffect(state: PJState, ref: MarbleRef, eff: Effect): PJState {
  const pos = state.pos.map((row) => row.slice());
  pos[ref.owner][ref.idx] = eff.to;
  if (eff.bump) pos[eff.bump.owner][eff.bump.idx] = { z: "start", i: firstEmptyStart(state, eff.bump.owner) };
  return { ...state, pos };
}

function drawUp(state: PJState): PJState {
  let { stock, discard, seed } = state;
  const hands = state.hands.map((h) => h.slice());
  const seat = state.turn;
  while (hands[seat].length < HAND) {
    if (stock.length === 0) {
      if (discard.length === 0) break;
      const sh = shuffle(discard, seed);
      stock = sh.shuffled;
      seed = sh.nextSeed;
      discard = [];
    }
    hands[seat].push(stock[stock.length - 1]);
    stock = stock.slice(0, -1);
  }
  return { ...state, hands, stock, discard, seed };
}

function finishTurn(state: PJState, cardId: number, bump: { by: number; victim: number } | null): PJState {
  const seat = state.turn;
  const card = state.hands[seat].find((c) => c.id === cardId)!;
  const hands = state.hands.map((h, s) => (s === seat ? h.filter((c) => c.id !== cardId) : h));
  let ns: PJState = { ...state, hands, discard: [...state.discard, card], lastBump: bump };

  const myTeam = teamOf(seat);
  const teamHome = (t: number) => {
    for (let p = 0; p < ns.players; p++) if (teamOf(p) === t && !allHome(ns, p)) return false;
    return true;
  };
  if (teamHome(myTeam)) return { ...ns, phase: "gameOver", winner: myTeam };

  ns = drawUp(ns);
  return { ...ns, turn: (seat + 1) % ns.players };
}

function applyMove(state: PJState, move: PJMove): PJState {
  if (state.phase !== "playing") throw new Error("Game is over");
  if (seatToAct(state) !== move.seat) throw new Error("Not this seat's turn");
  if (!isLegal(state, move)) throw new Error(`Illegal move: ${JSON.stringify(move)}`);

  const seat = move.seat;
  const card = state.hands[seat].find((c) => c.id === move.cardId)!;
  const homeBefore = state.pos[seat].filter((l) => l.z === "castle").length;

  let ns = state;
  let bump: { by: number; victim: number } | null = null;
  const note = (owner: number, eff: Effect) => {
    if (eff.bump) bump = { by: teamOf(owner), victim: teamOf(eff.bump.owner) };
  };

  if (move.type === "move") {
    const eff = ordinaryEffect(ns, move.marble, move.steps)!;
    note(move.marble.owner, eff);
    ns = applyEffect(ns, move.marble, eff);
  } else if (move.type === "comeOut") {
    const eff = comeOutEffect(ns, move.marble)!;
    note(move.marble.owner, eff);
    ns = applyEffect(ns, move.marble, eff);
  } else if (move.type === "joker") {
    const eff = jokerEffect(ns, move.marble, move.target)!;
    note(move.marble.owner, eff);
    ns = applyEffect(ns, move.marble, eff);
  } else if (move.type === "split7") {
    const e1 = ordinaryEffect(ns, move.a.marble, move.a.steps)!;
    note(move.a.marble.owner, e1);
    ns = applyEffect(ns, move.a.marble, e1);
    const e2 = ordinaryEffect(ns, move.b.marble, move.b.steps)!;
    note(move.b.marble.owner, e2);
    ns = applyEffect(ns, move.b.marble, e2);
  }
  // forfeit: no board effect; finishTurn just discards the card and advances.

  const done = finishTurn(ns, move.cardId, bump);

  // Log: the play, any marble(s) reaching home, a bump, and a game-winning team.
  const d = describePlay(move);
  const ent: Omit<LogEntry, "id">[] = [{ seat, msg: d.msg, cards: [lc(card)], tail: d.tail }];
  const homeAfter = done.pos[seat].filter((l) => l.z === "castle").length;
  if (homeAfter > homeBefore) {
    ent.push({ seat, msg: `marble${homeAfter - homeBefore > 1 ? "s" : ""} home (${homeAfter}/${done.marbles})` });
  }
  if (bump) {
    const b = bump as { by: number; victim: number };
    ent.push({ seat: null, msg: `Team ${teamLetter(b.by)} sends a Team ${teamLetter(b.victim)} marble back to start` });
  }
  if (done.phase === "gameOver" && done.winner !== null) {
    ent.push({ seat: null, msg: `Team ${teamLetter(done.winner)} brings every marble home \u2014 wins the game!` });
  }
  return attach(done, state, ent);
}

// ---------- setup ----------

function createGame(config: PJConfig, seed: number): PJState {
  if (!SUPPORTED.includes(config.players)) throw new Error(`Pegs and Jokers supports ${SUPPORTED.join("/")} players (got ${config.players})`);
  const marbles = config.marbles;
  if (marbles < 2 || marbles > 5) throw new Error(`Unsupported marble count: ${marbles}`);
  const players = config.players;
  const { shuffled, nextSeed } = shuffle(buildDeck(), seed);
  const hands: PJCard[][] = Array.from({ length: players }, () => []);
  let i = 0;
  for (let k = 0; k < HAND; k++) for (let s = 0; s < players; s++) hands[s].push(shuffled[i++]);
  const stock = shuffled.slice(i);
  const pos: Loc[][] = Array.from({ length: players }, () => Array.from({ length: marbles }, (_, idx) => ({ z: "start", i: idx } as Loc)));
  const base: PJState = { players, marbles, seed: nextSeed, phase: "playing", turn: 0, pos, hands, stock, discard: [], winner: null, lastBump: null, log: [], logSeq: 0 };
  return attach(base, base, [{ seat: null, msg: "new game \u2014 come out with an Ace, King, or Joker" }]);
}

// ---------- redaction ----------

function pegs(state: PJState): PegView[] {
  const out: PegView[] = [];
  for (let p = 0; p < state.players; p++) for (let idx = 0; idx < state.marbles; idx++) out.push({ owner: p, idx, team: teamOf(p), loc: state.pos[p][idx] });
  return out;
}

function redact(state: PJState, seat: number | null, meta: RoomMeta): PJView {
  const toAct = state.phase === "gameOver" ? null : state.turn;
  const yours = seat !== null && toAct === seat;
  return {
    you: seat,
    players: state.players,
    marbles: state.marbles,
    phase: state.phase,
    seats: meta.seats,
    hostSeat: meta.hostSeat,
    botReplacement: meta.botReplacement,
    disconnectedSeats: meta.disconnectedSeats,
    toAct,
    yourTurn: yours,
    yourTeam: seat !== null ? teamOf(seat) : null,
    playingFor: yours ? movableOwners(state, seat) : [],
    board: boardLayout(state.players, state.marbles),
    pegs: pegs(state),
    yourHand: seat !== null && state.hands[seat] ? state.hands[seat] : [],
    handCounts: state.hands.map((h) => h.length),
    stockCount: state.stock.length,
    discardCount: state.discard.length,
    legalMoves: yours ? legalMoves(state) : [],
    homeCounts: state.pos.map((row) => row.filter((l) => l.z === "castle").length),
    winner: state.winner,
    lastBump: state.lastBump,
    log: state.log,
  };
}

function lobbyView(config: PJConfig, seat: number | null, meta: RoomMeta): PJView {
  return {
    you: seat,
    players: config.players,
    marbles: config.marbles,
    phase: "lobby",
    seats: meta.seats,
    hostSeat: meta.hostSeat,
    botReplacement: meta.botReplacement,
    disconnectedSeats: meta.disconnectedSeats,
    toAct: null,
    yourTurn: false,
    yourTeam: seat !== null ? teamOf(seat) : null,
    playingFor: [],
    board: boardLayout(config.players, config.marbles),
    pegs: Array.from({ length: config.players }, (_, p) =>
      Array.from({ length: config.marbles }, (_, idx) => ({ owner: p, idx, team: teamOf(p), loc: { z: "start", i: idx } as Loc })),
    ).flat(),
    yourHand: [],
    handCounts: Array(config.players).fill(0),
    stockCount: 0,
    discardCount: 0,
    legalMoves: [],
    homeCounts: Array(config.players).fill(0),
    winner: null,
    lastBump: null,
    log: [],
  };
}

// ---------- heuristic AI (progress-seeking, convergent) ----------

const HOME_BONUS = 40;
const COMEOUT_BONUS = 12;
const BUMP_WEIGHT = 0.5;

function progAfter(owner: number, loc: Loc, players: number): number {
  if (loc.z === "start") return 0;
  if (loc.z === "ring") return 1 + progress(owner, loc, players);
  return 1 + ringSize(players) + loc.i + HOME_BONUS;
}
function gain(owner: number, from: Loc, to: Loc, players: number): number {
  return progAfter(owner, to, players) - progAfter(owner, from, players);
}
function moveScore(state: PJState, m: PJMove): number {
  const P = state.players;
  if (m.type === "forfeit") return -1000;
  if (m.type === "comeOut") {
    const e = comeOutEffect(state, m.marble)!;
    return COMEOUT_BONUS + gain(m.marble.owner, e.from, e.to, P) + (e.bump ? BUMP_WEIGHT * progAfter(e.bump.owner, e.from, P) : 0);
  }
  if (m.type === "joker") {
    const e = jokerEffect(state, m.marble, m.target)!;
    return gain(m.marble.owner, e.from, e.to, P) + BUMP_WEIGHT * (1 + progAfter(e.bump!.owner, { z: "ring", r: m.target }, P));
  }
  if (m.type === "split7") {
    const e1 = ordinaryEffect(state, m.a.marble, m.a.steps)!;
    const s1 = gain(m.a.marble.owner, e1.from, e1.to, P) + (e1.bump ? BUMP_WEIGHT * progAfter(e1.bump.owner, e1.from, P) : 0);
    const mid = applyEffect(state, m.a.marble, e1);
    const e2 = ordinaryEffect(mid, m.b.marble, m.b.steps)!;
    return s1 + gain(m.b.marble.owner, e2.from, e2.to, P) + (e2.bump ? BUMP_WEIGHT * progAfter(e2.bump.owner, e2.from, P) : 0);
  }
  const e = ordinaryEffect(state, m.marble, m.steps)!;
  return gain(m.marble.owner, e.from, e.to, P) + (e.bump ? BUMP_WEIGHT * progAfter(e.bump.owner, e.from, P) : 0);
}

function aiMove(state: PJState, seat: number): PJMove {
  if (state.phase === "gameOver") throw new Error("game is over");
  if (state.turn !== seat) throw new Error(`not seat ${seat}'s turn`);
  const moves = legalMoves(state);
  let best = moves[0];
  let bestScore = -Infinity;
  for (const m of moves) {
    const sc = moveScore(state, m);
    if (sc > bestScore) { bestScore = sc; best = m; }
  }
  return best;
}

// ---------- the module ----------

export const pegsAndJokersModule: Game<PJState, PJMove, PJConfig, PJView> = {
  meta: { id: "pegs-and-jokers", name: "Pegs and Jokers", supportedPlayerCounts: SUPPORTED },
  seatCount: (config) => config.players,
  createGame,
  seatToAct,
  isLegal,
  legalMoves,
  applyMove,
  isOver,
  redact,
  lobbyView,
  aiMove,
};

export const __test = {
  HPS, HAND, SUPPORTED, ringSize, exitHole, castleEntry, teamOf, teammatesOf,
  buildDeck, boardLayout, progress, locAtProgress, ringOccupant, allHome, movableOwners,
};
