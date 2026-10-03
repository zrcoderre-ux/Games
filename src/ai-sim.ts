// ai-sim.ts — fast determinized Monte Carlo search for the High Low Jack bots.
//
// The heuristic bot in ai.ts asks this module to evaluate its candidate card
// plays. For each candidate we:
//   1. sample a "world": deal the cards this seat has NOT seen (everything
//      except its own hand and the cards already played) to the other seats and
//      the 5-card dead kitty, respecting the public constraints — each seat's
//      card count and the suit voids it has shown by failing to follow;
//   2. play the rest of the hand out with a fast rollout policy for every seat;
//   3. score the hand exactly like engine.scoreHand and convert the result to a
//      utility for the searching team (score swing, plus a bonus/penalty when
//      the hand would end the game).
// The same sampled worlds are reused for every candidate (common random
// numbers), so the comparison between candidates is far less noisy than the
// absolute values.
//
// Honesty: the only inputs read from GameState are the searching seat's own
// hand, the OTHER seats' hand SIZES, and public information (trump, tricks,
// the current trick, bids, scores). The true hidden cards are never read; the
// sampled worlds come only from the set of cards unseen by that seat.
//
// Speed: cards are small integers and all rollout state lives in preallocated
// typed arrays, so a rollout costs a few microseconds. Callers size the number
// of worlds from the work per rollout (see playouts budget in ai.ts), and the
// PRNG is seeded from the state, so the same state always yields the same move.

import { isJoker, lowRankFor, SUITS, ledInfo, type Card, type GameState, type Suit } from "./engine.ts";

// ---------- card encoding ----------

// Natural card = suit index * 16 + rank (2..14); the joker is 64.
export const JOKER = 64;
export const encodeCard = (c: Card): number => (isJoker(c) ? JOKER : SUITS.indexOf(c.suit) * 16 + c.rank);
export const decodeCard = (n: number): Card => (n === JOKER ? { joker: true } : { rank: n & 15, suit: SUITS[n >> 4] });

// Game pips by rank (index 0 doubles as the joker, which counts nothing).
const PIP = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 10, 1, 2, 3, 4];

const MAXP = 8;
const HAND = 6;
const TRUMP_VOID = 16; // void bit for "no trumps at all" (natural trumps + joker)

// ---------- deterministic PRNG ----------

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- utility of a finished hand ----------

// What the searching team gets out of a hand, given both teams' raw points.
export type HandStakes = {
  myTeam: number;
  bidderTeam: number;
  bid: number;
  scores: [number, number];
  target: number;
  endBonus: number; // utility added (subtracted) when the hand wins (loses) the game
};

export function handUtility(st: HandStakes, pts0: number, pts1: number): number {
  const bt = st.bidderTeam;
  const pts = bt === 0 ? pts0 : pts1;
  const other = bt === 0 ? pts1 : pts0;
  const made = pts >= st.bid;
  const dBid = made ? pts : -st.bid;
  const nBid = st.scores[bt] + dBid;
  const nOther = st.scores[1 - bt] + other;
  let winner = -1;
  if (st.bid === 6 && made && st.scores[bt] >= 0) winner = bt; // bid-6 auto-win
  else if (nBid >= st.target) winner = bt; // bidder wins simultaneous crossings
  else if (nOther >= st.target) winner = 1 - bt;
  let u = st.myTeam === bt ? dBid - other : other - dBid;
  if (winner === st.myTeam) u += st.endBonus;
  else if (winner >= 0) u -= st.endBonus;
  return u;
}

// ---------- simulation state (module-level scratch, single-threaded) ----------

let P = 4; // players
let T = 0; // trump suit index
let LOW = 8; // lowest rank in the deck
let lowCard = 0; // the Low trump actually in play in the current world
let jackCard = 0;
let startTrick = 0; // trick index at the decision point

const hand = new Int8Array(MAXP * HAND); // hand[seat * 6 + i]
const len = new Int8Array(MAXP);
const worldHand = new Int8Array(MAXP * HAND);
const worldLen = new Int8Array(MAXP);
const inKitty = new Uint8Array(65);
const cap = new Int8Array(65); // team that captured each trump card (-1 = not yet)
const baseCap = new Int8Array(65);
let pips0 = 0, pips1 = 0, basePips0 = 0, basePips1 = 0;

// Current trick.
const tSeat = new Int8Array(MAXP);
const tCard = new Int8Array(MAXP);
let tLen = 0, ledSuit = 0, trumpLed = false, winSeat = 0, winTv = 0, winRank = 0;
let trickIdx = 0;

// Trump strength: 0 = not trump, joker 1 (lowest trump), natural trump = rank.
const tv = (c: number): number => (c === JOKER ? 1 : c >> 4 === T ? c & 15 : 0);
const pip = (c: number): number => (c === JOKER ? 0 : PIP[c & 15]);

function removeFromHand(seat: number, c: number): void {
  const o = seat * HAND;
  const n = len[seat];
  for (let i = 0; i < n; i++) {
    if (hand[o + i] === c) {
      hand[o + i] = hand[o + n - 1];
      len[seat] = n - 1;
      return;
    }
  }
}

function playCard(seat: number, c: number): void {
  removeFromHand(seat, c);
  const v = tv(c);
  if (tLen === 0) {
    trumpLed = v > 0;
    ledSuit = c === JOKER ? T : c >> 4;
    winSeat = seat;
    winTv = v;
    winRank = c & 15;
  } else if (v > winTv) {
    winSeat = seat;
    winTv = v;
    winRank = c & 15;
  } else if (winTv === 0 && v === 0 && c >> 4 === ledSuit && (c & 15) > winRank) {
    winSeat = seat;
    winRank = c & 15;
  }
  tSeat[tLen] = seat;
  tCard[tLen] = c;
  tLen++;
}

// Close the full trick: credit pips and trump captures to the winning team.
function resolveTrick(): number {
  const team = winSeat & 1;
  for (let i = 0; i < tLen; i++) {
    const c = tCard[i];
    if (team === 0) pips0 += pip(c);
    else pips1 += pip(c);
    if (tv(c) > 0) cap[c] = team;
  }
  tLen = 0;
  trickIdx++;
  return winSeat;
}

// Raw points [team0, team1] of the finished world, as engine.scoreHand counts them.
function finalPoints(out: Int32Array): void {
  out[0] = 0;
  out[1] = 0;
  const base = T * 16;
  for (let r = 14; r >= LOW; r--) {
    if (!inKitty[base + r]) { out[cap[base + r]]++; break; } // High
  }
  for (let r = LOW; r <= 14; r++) {
    if (!inKitty[base + r]) { out[cap[base + r]]++; break; } // Low
  }
  if (!inKitty[jackCard]) out[cap[jackCard]]++;
  if (!inKitty[JOKER]) out[cap[JOKER]] += 2;
  if (pips0 > pips1) out[0]++;
  else if (pips1 > pips0) out[1]++;
}

// ---------- rollout policy ----------

function maxTvOf(q: number): number {
  let m = 0;
  const o = q * HAND;
  for (let i = 0; i < len[q]; i++) {
    const v = tv(hand[o + i]);
    if (v > m) m = v;
  }
  return m;
}

// Can seat q beat a trick currently won by (wTv, wRank)?
function canBeat(q: number, wTv: number, wRank: number): boolean {
  const o = q * HAND;
  for (let i = 0; i < len[q]; i++) {
    const c = hand[o + i];
    const v = tv(c);
    if (wTv > 0) {
      if (v > wTv) return true;
    } else if (v > 0 || (c >> 4 === ledSuit && (c & 15) > wRank)) {
      return true;
    }
  }
  return false;
}

// Would the winner of the trick, if it stays at (wTv, wRank), survive every
// opponent of `team` still to play after position `pos`? The rollouts are
// double-dummy: every seat sees the sampled world.
function safeFrom(team: number, pos: number, wTv: number, wRank: number): boolean {
  const lead = tLen > 0 ? tSeat[0] : -1;
  for (let k = pos + 1; k < P; k++) {
    const q = (lead + k) % P;
    if ((q & 1) !== team && canBeat(q, wTv, wRank)) return false;
  }
  return true;
}

function isLegal(seat: number, c: number): boolean {
  if (tLen === 0) return c !== JOKER || trickIdx > 0;
  const o = seat * HAND;
  if (trumpLed) {
    if (tv(c) > 0) return true;
    for (let i = 0; i < len[seat]; i++) if (tv(hand[o + i]) > 0) return false;
    return true;
  }
  if (tv(c) > 0 || c >> 4 === ledSuit) return true;
  for (let i = 0; i < len[seat]; i++) {
    const h = hand[o + i];
    if (h !== JOKER && h >> 4 === ledSuit) return false;
  }
  return true;
}

// How much a seat hates giving a card away (dumping it on a lost trick).
function keepCost(c: number): number {
  if (c === JOKER) return 100;
  if (c === jackCard) return 90;
  if (c === lowCard) return 70;
  const v = tv(c);
  if (v > 0) return 30 + v;
  const r = c & 15;
  return r === 10 ? 40 : r >= 11 ? r : r * 0.3;
}

// How good a card is to drop onto a trick the partner has safely won.
function loadValue(c: number): number {
  if (c === JOKER) return 25;
  if (c === jackCard) return 15;
  if (c === lowCard) return 12;
  const v = tv(c);
  if (v > 0) return -v; // keep natural trumps for later tricks
  return pip(c) - (c & 15) * 0.01;
}

// Cost of using a card to take a trick (negative = it banks a point by winning).
function winCost(c: number): number {
  if (c === JOKER) return -20;
  if (c === jackCard) return -10;
  if (c === lowCard) return -8;
  const v = tv(c);
  if (v > 0) return v;
  return -pip(c) + (c & 15) * 0.05;
}

function choose(seat: number): number {
  const o = seat * HAND;
  const n = len[seat];
  const team = seat & 1;

  // ---- leading ----
  if (tLen === 0) {
    // Pull with the boss trump while an opponent still holds trump.
    let myTop = 0, myTopCard = -1;
    for (let i = 0; i < n; i++) {
      const v = tv(hand[o + i]);
      if (v > myTop) { myTop = v; myTopCard = hand[o + i]; }
    }
    if (myTop > 1 || (myTop === 1 && trickIdx > 0)) {
      let otherTop = 0, oppHasTrump = false;
      for (let q = 0; q < P; q++) {
        if (q === seat) continue;
        const m = maxTvOf(q);
        if (m > otherTop) otherTop = m;
        if (m > 0 && (q & 1) !== team) oppHasTrump = true;
      }
      if (myTop > otherTop && oppHasTrump) return myTopCard;
    }
    // Otherwise lead the cheapest off-suit card, or the lowest trump.
    let best = -1, bestCost = 1e9;
    for (let i = 0; i < n; i++) {
      const c = hand[o + i];
      if (!isLegal(seat, c)) continue;
      const v = tv(c);
      const cost = v > 0 ? 200 + (c === JOKER ? 50 : v) + keepCost(c) : keepCost(c);
      if (cost < bestCost) { bestCost = cost; best = c; }
    }
    return best;
  }

  // ---- following ----
  const pos = tLen;
  if ((winSeat & 1) === team) {
    // Partner is winning: load points if the trick is safe, else play cheap.
    if (safeFrom(team, pos, winTv, winRank)) {
      let best = -1, bestV = -1e9;
      for (let i = 0; i < n; i++) {
        const c = hand[o + i];
        if (!isLegal(seat, c)) continue;
        const lv = loadValue(c);
        if (lv > bestV) { bestV = lv; best = c; }
      }
      return best;
    }
  } else {
    // Opponent is winning: take it with the cheapest card that holds up.
    let best = -1, bestCost = 1e9;
    for (let i = 0; i < n; i++) {
      const c = hand[o + i];
      if (!isLegal(seat, c)) continue;
      const v = tv(c);
      const beats = v > winTv || (winTv === 0 && v === 0 && c >> 4 === ledSuit && (c & 15) > winRank);
      if (!beats) continue;
      if (!safeFrom(team, pos, v, v > 0 ? 0 : c & 15)) continue;
      const wc = winCost(c);
      if (wc < bestCost) { bestCost = wc; best = c; }
    }
    if (best >= 0) {
      let value = 0;
      for (let i = 0; i < tLen; i++) {
        const c = tCard[i];
        value += pip(c) + (c === JOKER ? 20 : c === jackCard || c === lowCard ? 10 : 0);
      }
      if (value > 0 || bestCost < 5) return best;
    }
  }
  // Nothing worth doing: shed the card we least mind losing.
  let best = -1, bestCost = 1e9;
  for (let i = 0; i < n; i++) {
    const c = hand[o + i];
    if (!isLegal(seat, c)) continue;
    const kc = keepCost(c);
    if (kc < bestCost) { bestCost = kc; best = c; }
  }
  return best;
}

// Play the hand out from the current trick position; `next` is the seat to act.
function playOut(next: number): void {
  for (;;) {
    while (tLen < P) {
      const c = choose(next);
      playCard(next, c);
      next = (next + 1) % P;
    }
    next = resolveTrick();
    if (trickIdx >= HAND) return;
  }
}

// ---------- search context built from a real game state ----------

export type SearchContext = {
  seat: number;
  players: number;
  trump: number; // suit index
  unseen: number[]; // cards this seat has not seen (others' hands + kitty)
  counts: number[]; // cards held by each seat (public)
  voids: number[]; // per-seat void bitmask: bit s = no natural suit s, TRUMP_VOID = no trumps
  myHand: number[];
  trickIndex: number;
  trick: { seat: number; card: number }[]; // current trick so far
  captured: Int8Array; // team that captured each played trump card
  pips: [number, number];
};

// Everything the seat may know, in integer form. Reads only public state plus
// the seat's own hand (and the other hands' sizes).
export function buildContext(state: GameState, seat: number, trump: Suit): SearchContext {
  const T0 = SUITS.indexOf(trump);
  const low = lowRankFor(state.players);
  const seen = new Uint8Array(65);
  const myHand = state.hands[seat].map(encodeCard);
  for (const c of myHand) seen[c] = 1;

  const voids = new Array(state.players).fill(0);
  const captured = new Int8Array(65).fill(-1);
  const pips: [number, number] = [0, 0];
  const noteVoids = (plays: { seat: number; card: Card }[]) => {
    if (!plays.length) return;
    const { ledSuit: led, trumpLed: tl } = ledInfo(plays[0].card, trump);
    const ledIdx = SUITS.indexOf(led);
    for (let i = 1; i < plays.length; i++) {
      const c = encodeCard(plays[i].card);
      const isT = c === JOKER || c >> 4 === T0;
      if (tl) {
        if (!isT) voids[plays[i].seat] |= TRUMP_VOID;
      } else if (!isT && c >> 4 !== ledIdx) {
        voids[plays[i].seat] |= 1 << ledIdx;
      }
    }
  };
  for (const t of state.tricksWon) {
    const team = t.seat % 2;
    for (const p of t.plays) {
      const c = encodeCard(p.card);
      seen[c] = 1;
      pips[team] += pip(c);
      if (c === JOKER || c >> 4 === T0) captured[c] = team;
    }
    noteVoids(t.plays);
  }
  for (const p of state.currentTrick) seen[encodeCard(p.card)] = 1;
  noteVoids(state.currentTrick);

  const unseen: number[] = [];
  for (let s = 0; s < 4; s++) for (let r = low; r <= 14; r++) if (!seen[s * 16 + r]) unseen.push(s * 16 + r);
  if (!seen[JOKER]) unseen.push(JOKER);

  return {
    seat,
    players: state.players,
    trump: T0,
    unseen,
    counts: state.hands.map((h) => h.length),
    voids,
    myHand,
    trickIndex: state.trickIndex,
    trick: state.currentTrick.map((p) => ({ seat: p.seat, card: encodeCard(p.card) })),
    captured,
    pips,
  };
}

// ---------- world sampling ----------

const order = new Int16Array(64);
const holderRoom = new Int8Array(MAXP + 1); // last slot = kitty

// Deal ctx.unseen into worldHand/inKitty consistent with counts and voids.
// Cards with the fewest eligible holders are placed first; each card goes to an
// eligible holder with probability proportional to the room it has left. After
// a few failed attempts the void constraints are dropped (never for counts).
function sampleWorld(ctx: SearchContext, rng: () => number): void {
  const U = ctx.unseen;
  const nU = U.length;
  const kittySlot = P;
  for (let attempt = 0; attempt < 6; attempt++) {
    const useVoids = attempt < 5;
    // Order: shuffled, then stably sorted by number of eligible holders.
    for (let i = 0; i < nU; i++) order[i] = i;
    for (let i = nU - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = order[i]; order[i] = order[j]; order[j] = t;
    }
    const elig = (c: number, q: number): boolean => {
      if (!useVoids) return true;
      const m = ctx.voids[q];
      if (!m) return true;
      return (c === JOKER || c >> 4 === T) ? !(m & TRUMP_VOID) : !(m & (1 << (c >> 4)));
    };
    const keys: number[] = new Array(nU);
    for (let i = 0; i < nU; i++) {
      const c = U[order[i]];
      let k = 0;
      for (let q = 0; q < P; q++) if (q !== ctx.seat && ctx.counts[q] > 0 && elig(c, q)) k++;
      keys[i] = k;
    }
    const idx = Array.from({ length: nU }, (_, i) => i).sort((a, b) => keys[a] - keys[b] || a - b);

    for (let q = 0; q < P; q++) { holderRoom[q] = q === ctx.seat ? 0 : ctx.counts[q]; worldLen[q] = 0; }
    holderRoom[kittySlot] = nU - ctx.counts.reduce((a, b, q) => a + (q === ctx.seat ? 0 : b), 0);
    inKitty.fill(0);
    let ok = true;
    for (const i of idx) {
      const c = U[order[i]];
      let total = 0;
      for (let q = 0; q <= P; q++) if (holderRoom[q] > 0 && (q === kittySlot || elig(c, q))) total += holderRoom[q];
      if (total === 0) { ok = false; break; }
      let x = rng() * total;
      let pickQ = kittySlot;
      for (let q = 0; q <= P; q++) {
        if (holderRoom[q] > 0 && (q === kittySlot || elig(c, q))) {
          x -= holderRoom[q];
          if (x < 0) { pickQ = q; break; }
        }
      }
      holderRoom[pickQ]--;
      if (pickQ === kittySlot) inKitty[c] = 1;
      else worldHand[pickQ * HAND + worldLen[pickQ]++] = c;
    }
    if (ok) break;
  }
  // The searching seat's own hand.
  const me = ctx.seat;
  worldLen[me] = ctx.myHand.length;
  for (let i = 0; i < ctx.myHand.length; i++) worldHand[me * HAND + i] = ctx.myHand[i];
}

// Reset the rollout scratch to the sampled world at the decision point.
function loadWorld(ctx: SearchContext): void {
  hand.set(worldHand);
  len.set(worldLen);
  cap.set(baseCap);
  pips0 = basePips0;
  pips1 = basePips1;
  trickIdx = startTrick;
  tLen = 0;
  for (const p of ctx.trick) playCard(p.seat, p.card);
}

function initSearch(ctx: SearchContext): void {
  P = ctx.players;
  T = ctx.trump;
  LOW = lowRankFor(P as 4 | 6 | 8);
  jackCard = T * 16 + 11;
  startTrick = ctx.trickIndex;
  baseCap.set(ctx.captured);
  basePips0 = ctx.pips[0];
  basePips1 = ctx.pips[1];
}

// The Low trump in play in the sampled world (lowest natural trump not buried).
function findLowCard(): number {
  for (let r = LOW; r <= 14; r++) if (!inKitty[T * 16 + r]) return T * 16 + r;
  return -1;
}

const ptsOut = new Int32Array(2);

// Average utility of each candidate card for ctx.seat over `worlds` sampled
// worlds. The candidates must be legal for the seat right now.
export function evaluatePlays(
  ctx: SearchContext,
  candidates: number[],
  stakes: HandStakes,
  worlds: number,
  rng: () => number,
): number[] {
  initSearch(ctx);
  const totals = new Array(candidates.length).fill(0);
  const me = ctx.seat;
  for (let w = 0; w < worlds; w++) {
    sampleWorld(ctx, rng);
    lowCard = findLowCard();
    for (let k = 0; k < candidates.length; k++) {
      loadWorld(ctx);
      playCard(me, candidates[k]);
      let next = (me + 1) % P;
      if (tLen === P) {
        next = resolveTrick();
        if (trickIdx < HAND) playOut(next);
      } else {
        playOut(next);
      }
      finalPoints(ptsOut);
      totals[k] += handUtility(stakes, ptsOut[0], ptsOut[1]);
    }
  }
  return totals.map((t) => t / worlds);
}

// Cards in play for a whole hand (used to size the search budget).
export const cardsLeft = (ctx: SearchContext): number => ctx.counts.reduce((a, b) => a + b, 0);

export { TRUMP_VOID };
