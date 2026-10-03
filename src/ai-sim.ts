// ai-sim.ts — fast determinized Monte Carlo search for the High Low Jack bots.
//
// ai.ts asks this module two kinds of question:
//   - card play: how good is each legal card for the seat to act?
//   - bidding: what points would each team take if this seat (or the current
//     high bidder) won the auction?
// Both are answered the same way:
//   1. sample a "world": deal the cards this seat has NOT seen (everything
//      except its own hand and the cards already played) to the other seats and
//      the 5-card dead kitty, respecting the public constraints — each seat's
//      card count, the suit voids it has shown by failing to follow, and (while
//      bidding) its hand signal and whether it bid or passed;
//   2. play the rest of the hand out with a fast double-dummy rollout policy;
//   3. score the hand exactly like engine.scoreHand. Card play converts that to
//      the searching team's chance of winning the game (winProb), so a hand that
//      reaches the target or makes a bid of 6 counts as a win.
// Card candidates share the same sampled worlds (common random numbers), so the
// comparison between them is far less noisy than the absolute values.
//
// Honesty: the only inputs read from GameState are the searching seat's own
// hand, the OTHER seats' hand SIZES, and public information (trump, tricks,
// the current trick, bids, signals). The true hidden cards and the kitty are
// never read; the sampled worlds come only from the set of cards unseen by
// that seat.
//
// Speed: cards are small integers and all rollout state lives in preallocated
// typed arrays, so a rollout costs a few microseconds. Callers size the number
// of worlds from the work per rollout (see the budgets in ai.ts) and pass a PRNG
// seeded from the state, so the same state always yields the same move.

import { isJoker, lowRankFor, SUITS, ledInfo, type Card, type GameState, type Suit } from "./engine.ts";

// ---------- card encoding ----------

// Natural card = suit index * 16 + rank (2..14); the joker is 64.
export const JOKER = 64;
export const encodeCard = (c: Card): number => (isJoker(c) ? JOKER : SUITS.indexOf(c.suit) * 16 + c.rank);

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

// ---------- win probability from the score ----------

// Distribution of one hand's result in bot self-play (4/6/8 players agree to
// within noise): [bidder team's score change, other team's change, 1 if a bid
// of 6 was made, probability]. Rare results are folded into their neighbours.
const HAND_OUTCOMES: [number, number, number, number][] = [
  [6, 0, 0, 0.257], [6, 0, 1, 0.112], [5, 1, 0, 0.115], [5, 0, 0, 0.046], [4, 2, 0, 0.074],
  [4, 0, 0, 0.036], [4, 1, 0, 0.012], [3, 3, 0, 0.007], [3, 1, 0, 0.004], [3, 2, 0, 0.002],
  [-4, 3, 0, 0.060], [-4, 4, 0, 0.036], [-4, 2, 0, 0.022], [-4, 1, 0, 0.017], [-4, 5, 0, 0.011],
  [-4, 0, 0, 0.004], [-5, 2, 0, 0.025], [-5, 3, 0, 0.016], [-5, 0, 0, 0.014], [-5, 4, 0, 0.012],
  [-5, 1, 0, 0.009], [-5, 5, 0, 0.006], [-5, 6, 0, 0.003], [-6, 1, 0, 0.033], [-6, 0, 0, 0.021],
  [-6, 2, 0, 0.017], [-6, 3, 0, 0.007], [-6, 4, 0, 0.005], [-3, 4, 0, 0.005], [-3, 5, 0, 0.004],
  [-3, 3, 0, 0.002], [-3, 2, 0, 0.002], [-4, 6, 0, 0.002],
];

const MAX_NEED = 32; // points still needed, capped (a team at -11 needs 32 to reach 21)
const winTables = new Map<number, Float64Array>();

// P(a team needing `needMe` points beats one needing `needOpp`) at the start of
// a hand, assuming each team wins the auction half the time. Solved once per
// target by value iteration over HAND_OUTCOMES (a few ms, then cached).
export function winProb(needMe: number, needOpp: number, target: number): number {
  let V = winTables.get(target);
  if (!V) {
    V = solveWinTable(target);
    winTables.set(target, V);
  }
  const a = Math.min(MAX_NEED, Math.max(1, needMe));
  const b = Math.min(MAX_NEED, Math.max(1, needOpp));
  return V[a * (MAX_NEED + 1) + b];
}

// Solve the standard target up front so no bot move pays the one-time cost.
winProb(1, 1, 21);

function solveWinTable(target: number): Float64Array {
  const W = MAX_NEED + 1;
  const n = HAND_OUTCOMES.length;
  const dBid = new Int8Array(n), dOther = new Int8Array(n), six = new Uint8Array(n), p = new Float64Array(n);
  const total = HAND_OUTCOMES.reduce((sum, o) => sum + o[3], 0);
  HAND_OUTCOMES.forEach((o, i) => {
    dBid[i] = o[0];
    dOther[i] = o[1];
    six[i] = o[2];
    p[i] = (0.5 * o[3]) / total;
  });
  const V = new Float64Array(W * W).fill(0.5);
  const cap = (x: number) => (x > MAX_NEED ? MAX_NEED : x);
  for (let sweep = 0; sweep < 100; sweep++) {
    let change = 0;
    for (let a = 1; a <= MAX_NEED; a++) {
      for (let b = 1; b <= MAX_NEED; b++) {
        let v = 0;
        for (let i = 0; i < n; i++) {
          // We bid: a made 6 wins outright unless we were in the hole.
          const ma = a - dBid[i], mb = b - dOther[i];
          v += p[i] * (six[i] && a <= target ? 1 : ma <= 0 ? 1 : mb <= 0 ? 0 : V[cap(ma) * W + cap(mb)]);
          // They bid.
          const ta = a - dOther[i], tb = b - dBid[i];
          v += p[i] * (six[i] && b <= target ? 0 : tb <= 0 ? 0 : ta <= 0 ? 1 : V[cap(ta) * W + cap(tb)]);
        }
        const d = v - V[a * W + b];
        if (d > change) change = d;
        else if (-d > change) change = -d;
        V[a * W + b] = v;
      }
    }
    if (change < 1e-4) break;
  }
  return V;
}

// ---------- utility of a finished hand ----------

// What the searching team gets out of a hand: its win probability (in percent)
// after the hand is scored — 100 if the hand wins the game, 0 if it loses it.
export type HandStakes = {
  myTeam: number;
  bidderTeam: number;
  bid: number;
  scores: [number, number];
  target: number;
};

export function handUtility(st: HandStakes, pts0: number, pts1: number): number {
  const bt = st.bidderTeam;
  const pts = bt === 0 ? pts0 : pts1;
  const other = bt === 0 ? pts1 : pts0;
  const made = pts >= st.bid;
  const nBid = st.scores[bt] + (made ? pts : -st.bid);
  const nOther = st.scores[1 - bt] + other;
  let bidderWins: boolean;
  if (st.bid === 6 && made && st.scores[bt] >= 0) bidderWins = true; // bid-6 auto-win
  else if (nBid >= st.target) bidderWins = true; // bidder wins simultaneous crossings
  else if (nOther >= st.target) bidderWins = false;
  else {
    const v = winProb(st.target - nBid, st.target - nOther, st.target);
    return 100 * (st.myTeam === bt ? v : 1 - v);
  }
  return st.myTeam === bt === bidderWins ? 100 : 0;
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
  evidence: HandEvidence[] | null; // what the auction says about each hand (bidding only)
};

// Public auction evidence about one seat's hand: its signal (0 weak, 1 medium,
// 2 strong, -1 none) and its action (1 voluntary bid, -1 voluntary pass, 0 none).
export type HandEvidence = { signal: number; action: number };

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
    evidence: state.phase === "bidding" ? auctionEvidence(state) : null,
  };
}

function auctionEvidence(state: GameState): HandEvidence[] {
  const ev: HandEvidence[] = state.signals.map((sig) => ({
    signal: sig === "strong" ? 2 : sig === "medium" ? 1 : sig === "weak" ? 0 : -1,
    action: 0,
  }));
  for (const b of state.bidHistory) {
    // Implicit passes (skipped by a 6-bid) say nothing; the dealer never acts
    // before the current decision, so a forced dealer bid can't appear here.
    if (b.type === "bid") ev[b.seat].action = 1;
    else if (!b.implicit) ev[b.seat].action = -1;
  }
  return ev;
}

// ---------- world sampling ----------

const order = new Int16Array(64);
const sorted = new Int16Array(64);
const keyOf = new Int8Array(64);
const voidBit = new Int8Array(65); // which void bit rules a card out (trump / its suit)
const holderRoom = new Int8Array(MAXP + 1); // last slot = kitty
let anyVoids = false;

const eligible = (ctx: SearchContext, c: number, q: number): boolean => (ctx.voids[q] & voidBit[c]) === 0;

// Deal ctx.unseen into worldHand/inKitty consistent with counts and voids.
// Cards with the fewest eligible holders are placed first; each card goes to an
// eligible holder with probability proportional to the room it has left. After
// a few failed attempts the void constraints are dropped (never the counts).
function dealWorld(ctx: SearchContext, rng: () => number): void {
  const U = ctx.unseen;
  const nU = U.length;
  const kittySlot = P;
  const me = ctx.seat;
  for (let attempt = 0; attempt < 6; attempt++) {
    const useVoids = anyVoids && attempt < 5;
    for (let i = 0; i < nU; i++) order[i] = i;
    for (let i = nU - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = order[i]; order[i] = order[j]; order[j] = t;
    }
    if (useVoids) {
      // Stable counting sort of the shuffled cards by number of eligible seats.
      for (let i = 0; i < nU; i++) {
        const c = U[order[i]];
        let k = 0;
        for (let q = 0; q < P; q++) if (q !== me && ctx.counts[q] > 0 && eligible(ctx, c, q)) k++;
        keyOf[i] = k;
      }
      let n = 0;
      for (let k = 0; k <= P; k++) for (let i = 0; i < nU; i++) if (keyOf[i] === k) sorted[n++] = order[i];
    } else {
      sorted.set(order.subarray(0, nU));
    }

    let others = 0;
    for (let q = 0; q < P; q++) {
      holderRoom[q] = q === me ? 0 : ctx.counts[q];
      others += holderRoom[q];
      worldLen[q] = 0;
    }
    holderRoom[kittySlot] = nU - others;
    inKitty.fill(0);
    let ok = true;
    for (let i = 0; i < nU; i++) {
      const c = U[sorted[i]];
      let total = holderRoom[kittySlot];
      for (let q = 0; q < P; q++) if (holderRoom[q] > 0 && (!useVoids || eligible(ctx, c, q))) total += holderRoom[q];
      if (total === 0) { ok = false; break; }
      let x = rng() * total;
      let pickQ = kittySlot;
      for (let q = 0; q < P; q++) {
        if (holderRoom[q] > 0 && (!useVoids || eligible(ctx, c, q))) {
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
  worldLen[me] = ctx.myHand.length;
  for (let i = 0; i < ctx.myHand.length; i++) worldHand[me * HAND + i] = ctx.myHand[i];
}

// How a seat's auction behaviour constrains its hand during bidding. A bot's
// signal is an exact function of its hand (signalLevel of its best suitScore);
// a hand that would have signalled differently is still allowed SIGNAL_MISMATCH
// of the time (humans signal by feel). Voluntary bids and passes are soft
// evidence about the same strength: self-play bidders sit above ~2.4, passers below.
const SIGNAL_MISMATCH = 0.15;
const BID_STRENGTH = 2.4;
const BID_STRENGTH_SPREAD = 0.35;
const EVIDENCE_TRIES = 20;
const pool = new Int8Array(64);

function evidenceLikelihood(ev: HandEvidence, cards: Int8Array, n: number): number {
  let best = 0;
  for (let s = 0; s < 4; s++) best = Math.max(best, suitScore(cards, n, s, LOW));
  let l = 1;
  if (ev.signal >= 0 && signalLevel(best) !== ev.signal) l *= SIGNAL_MISMATCH;
  if (ev.action !== 0) l /= 1 + Math.exp((ev.action * (BID_STRENGTH - best)) / BID_STRENGTH_SPREAD);
  return l;
}

// Bidding-time deal: every hand is still full, so each seat with auction
// evidence draws its six cards from the pool, redrawing until the hand
// plausibly explains that evidence (accepted with probability = likelihood);
// the remaining seats and the kitty split what is left uniformly.
function dealFromEvidence(ctx: SearchContext, rng: () => number): void {
  const ev = ctx.evidence!;
  let nPool = ctx.unseen.length;
  for (let i = 0; i < nPool; i++) pool[i] = ctx.unseen[i];
  const deal = (q: number) => {
    // Move 6 random pool cards to the pool's tail and copy them into q's hand.
    const o = q * HAND;
    for (let k = 0; k < HAND; k++) {
      const j = Math.floor(rng() * (nPool - k));
      const t = pool[j]; pool[j] = pool[nPool - 1 - k]; pool[nPool - 1 - k] = t;
      worldHand[o + k] = pool[nPool - 1 - k];
    }
    worldLen[q] = HAND;
  };
  const hasEvidence = (q: number) => ev[q].signal >= 0 || ev[q].action !== 0;
  for (let q = 0; q < P; q++) {
    if (q === ctx.seat || !hasEvidence(q)) continue;
    for (let t = 0; t < EVIDENCE_TRIES; t++) {
      deal(q);
      if (rng() < evidenceLikelihood(ev[q], worldHand.subarray(q * HAND, q * HAND + HAND), HAND)) break;
    }
    nPool -= HAND;
  }
  for (let q = 0; q < P; q++) {
    if (q === ctx.seat || hasEvidence(q)) continue;
    deal(q);
    nPool -= HAND;
  }
  inKitty.fill(0);
  for (let i = 0; i < nPool; i++) inKitty[pool[i]] = 1;
  worldLen[ctx.seat] = ctx.myHand.length;
  for (let i = 0; i < ctx.myHand.length; i++) worldHand[ctx.seat * HAND + i] = ctx.myHand[i];
}

function sampleWorld(ctx: SearchContext, rng: () => number): void {
  if (ctx.evidence) dealFromEvidence(ctx, rng);
  else dealWorld(ctx, rng);
  lowCard = findLowCard();
}

// ---------- hand strength (shared with ai.ts) ----------

// Estimate of how many of the 6 points `cards[0..n)` can take with `suit` as
// trump — the classic heuristic behind bot bidding signals. `low` is the
// lowest rank in the deck.
export function suitScore(cards: ArrayLike<number>, n: number, suit: number, low: number): number {
  let trumps = 0, tens = 0, highCount = 0;
  let hasA = false, hasK = false, hasQ = false, hasJ = false, hasJoker = false, hasLow = false;
  for (let i = 0; i < n; i++) {
    const c = cards[i];
    if (c === JOKER) { trumps++; hasJoker = true; continue; }
    const r = c & 15;
    if (r === 10) tens++;
    if (c >> 4 !== suit) continue;
    trumps++;
    if (r >= 12) highCount++;
    if (r === 14) hasA = true;
    else if (r === 13) hasK = true;
    else if (r === 12) hasQ = true;
    else if (r === 11) hasJ = true;
    if (r === low) hasLow = true;
  }
  let score = 0;
  // High: you own the High point if you hold the top trump in play.
  score += hasA ? 1.0 : hasK ? 0.4 : hasQ ? 0.15 : 0;
  // Jack — keepable with higher trumps (or the joker) to protect it.
  if (hasJ) score += Math.min(0.9, 0.25 + 0.2 * ((hasA ? 1 : 0) + (hasK ? 1 : 0) + (hasQ ? 1 : 0) + (hasJoker ? 1 : 0)));
  // Joker (2 pts): kept with trump control (Ace+joker synergy), else captured by strong trumps.
  if (hasJoker) score += Math.min(2.2, 0.3 + 0.25 * (trumps - 1) + (hasA ? 1.15 : 0));
  else score += Math.min(0.8, 0.15 * highCount);
  // Low (captured rule): the Ace or King forces it out.
  score += Math.min(0.7, 0.12 * trumps + (hasLow ? 0.15 : 0) + (hasA ? 0.65 : hasK ? 0.25 : 0));
  // Game: tens are gold; the Ace guarantees a pip trick.
  score += Math.min(1.0, 0.1 * trumps + 0.15 * tens + (hasA ? 0.5 : 0));
  // Sheer bulk of trumps is control.
  score += 0.1 * Math.max(0, trumps - 3);
  return score;
}

// The hand-confidence signal a bot sends for a hand whose best suitScore is
// `best`: 2 strong, 1 medium, 0 weak.
export const signalLevel = (best: number): number => (best >= 3.0 ? 2 : best >= 1.5 ? 1 : 0);

function initSearch(ctx: SearchContext): void {
  P = ctx.players;
  T = ctx.trump;
  LOW = lowRankFor(P as 4 | 6 | 8);
  jackCard = T * 16 + 11;
  startTrick = ctx.trickIndex;
  baseCap.set(ctx.captured);
  basePips0 = ctx.pips[0];
  basePips1 = ctx.pips[1];
  for (let c = 0; c < 64; c++) voidBit[c] = c >> 4 === T ? TRUMP_VOID : 1 << (c >> 4);
  voidBit[JOKER] = TRUMP_VOID;
  anyVoids = ctx.voids.some((m) => m !== 0);
}

// The Low trump in play in the sampled world (lowest natural trump not buried).
function findLowCard(): number {
  for (let r = LOW; r <= 14; r++) if (!inKitty[T * 16 + r]) return T * 16 + r;
  return -1;
}

const ptsOut = new Int32Array(2);

// Play `card` for `seat` in the current sampled world, then roll the hand out;
// leaves the raw points in ptsOut.
function rollout(ctx: SearchContext, seat: number, card: number): void {
  hand.set(worldHand);
  len.set(worldLen);
  cap.set(baseCap);
  pips0 = basePips0;
  pips1 = basePips1;
  trickIdx = startTrick;
  tLen = 0;
  for (const p of ctx.trick) playCard(p.seat, p.card);
  playCard(seat, card);
  let next = (seat + 1) % P;
  if (tLen === P) next = resolveTrick();
  if (trickIdx < HAND) playOut(next);
  finalPoints(ptsOut);
}

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
  for (let w = 0; w < worlds; w++) {
    sampleWorld(ctx, rng);
    for (let k = 0; k < candidates.length; k++) {
      rollout(ctx, ctx.seat, candidates[k]);
      totals[k] += handUtility(stakes, ptsOut[0], ptsOut[1]);
    }
  }
  return totals.map((t) => t / worlds);
}

// Distribution of raw points when ctx.seat plays `card` now: hist[a * 7 + b]
// counts worlds where team 0 took a points and team 1 took b.
export function pointHistogram(ctx: SearchContext, card: number, worlds: number, rng: () => number): Float64Array {
  initSearch(ctx);
  const hist = new Float64Array(49);
  for (let w = 0; w < worlds; w++) {
    sampleWorld(ctx, rng);
    rollout(ctx, ctx.seat, card);
    hist[ptsOut[0] * 7 + ptsOut[1]]++;
  }
  return hist;
}

// The same distribution if another seat, `bidder`, wins the auction instead:
// in each sampled world it names its best suit (by suitScore, among suits it
// holds a natural card in) by leading that suit's top card. Bidding only.
export function otherBidderHistogram(ctx: SearchContext, bidder: number, worlds: number, rng: () => number): Float64Array {
  initSearch(ctx);
  const hist = new Float64Array(49);
  const o = bidder * HAND;
  for (let w = 0; w < worlds; w++) {
    sampleWorld(ctx, rng);
    let suit = -1, bestScore = -1;
    for (let s = 0; s < 4; s++) {
      let natural = false;
      for (let i = 0; i < worldLen[bidder]; i++) if (worldHand[o + i] >> 4 === s && worldHand[o + i] !== JOKER) natural = true;
      if (!natural) continue;
      const score = suitScore(worldHand.subarray(o, o + worldLen[bidder]), worldLen[bidder], s, LOW);
      if (score > bestScore) { bestScore = score; suit = s; }
    }
    let lead = -1;
    for (let i = 0; i < worldLen[bidder]; i++) {
      const c = worldHand[o + i];
      if (c !== JOKER && c >> 4 === suit && c > lead) lead = c;
    }
    T = suit;
    jackCard = suit * 16 + 11;
    lowCard = findLowCard();
    rollout(ctx, bidder, lead);
    hist[ptsOut[0] * 7 + ptsOut[1]]++;
  }
  return hist;
}

// Cards in play for a whole hand (used to size the search budget).
export const cardsLeft = (ctx: SearchContext): number => ctx.counts.reduce((a, b) => a + b, 0);
