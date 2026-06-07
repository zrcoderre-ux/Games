// src/local-room.ts
var BOT_STEP_MS_DEFAULT = 1600;
var emptySeats = (n) => Array.from({ length: n }, () => ({ kind: "empty", name: null }));
var BOT_NAMES = [
  "Ada",
  "Bram",
  "Cleo",
  "Dario",
  "Esme",
  "Flora",
  "Gus",
  "Hana",
  "Ivo",
  "Juno",
  "Kit",
  "Lena",
  "Milo",
  "Nadia",
  "Otto",
  "Pia",
  "Remy",
  "Sasha",
  "Tariq",
  "Vera"
];
function pickBotName(taken) {
  const free = BOT_NAMES.filter((n) => !taken.has(n));
  if (free.length) return free[Math.floor(Math.random() * free.length)];
  let i = 1;
  while (taken.has(`Bot ${i}`)) i++;
  return `Bot ${i}`;
}
var LocalRoom = class {
  constructor(game, config, emit) {
    this.game = game;
    this.config = config;
    this.emit = emit;
    this.seats = emptySeats(game.seatCount(config));
  }
  game;
  config;
  emit;
  state = null;
  seats;
  hostSeat = null;
  viewSeat = null;
  // the seat whose view we currently emit
  name = "You";
  botTimer = null;
  // Single entry point, matching the wire protocol the client already speaks
  // (plus the two pass-and-play lobby extras).
  handle(msg) {
    try {
      switch (msg.t) {
        case "join":
          return this.join(msg.name);
        case "sit":
          return this.sit(msg.seat);
        case "leave":
          return this.leave();
        case "addBot":
          return this.addBot(msg.seat);
        case "removeBot":
          return this.removeBot(msg.seat);
        case "addHuman":
          return this.addHuman(msg.seat, msg.name);
        case "clearSeat":
          return this.clearSeat(msg.seat);
        case "setConfig":
          return this.setConfig(msg.config);
        case "start":
          return this.start(msg.config);
        case "move":
          return this.move(msg.move);
        case "aux":
          return this.aux(msg.payload);
        case "newGame":
          return this.newGame();
      }
    } catch (err) {
      this.emit({ t: "error", message: err instanceof Error ? err.message : "Error" });
    }
  }
  close() {
    if (this.botTimer) clearTimeout(this.botTimer);
    this.botTimer = null;
  }
  // ---------- handlers ----------
  join(name) {
    this.name = name || "You";
    if (this.viewSeat === null) {
      this.viewSeat = 0;
      this.seats[0] = { kind: "human", name: this.name };
      this.hostSeat = 0;
    } else {
      this.seats[this.viewSeat] = { kind: "human", name: this.name };
    }
    this.broadcast();
  }
  sit(seat) {
    if (this.state) throw new Error("Game already in progress");
    if (seat < 0 || seat >= this.seats.length) throw new Error("No such seat");
    if (this.seats[seat].kind !== "empty") throw new Error("Seat is taken");
    if (this.viewSeat !== null) this.seats[this.viewSeat] = { kind: "empty", name: null };
    this.seats[seat] = { kind: "human", name: this.name };
    this.viewSeat = seat;
    if (this.hostSeat === null) this.hostSeat = seat;
    this.broadcast();
  }
  leave() {
    this.close();
    this.state = null;
    this.seats = emptySeats(this.game.seatCount(this.config));
    this.viewSeat = null;
    this.hostSeat = null;
    this.broadcast();
  }
  addBot(seat) {
    if (this.state) throw new Error("Add bots from the lobby, before the game starts");
    if (seat < 0 || seat >= this.seats.length) throw new Error("No such seat");
    if (this.seats[seat].kind !== "empty") throw new Error("Seat is occupied");
    const taken = new Set(this.seats.map((s) => s.name).filter((n) => !!n));
    this.seats[seat] = { kind: "bot", name: pickBotName(taken) };
    this.broadcast();
  }
  removeBot(seat) {
    if (this.state) throw new Error("Bots can't be removed once the game has started");
    if (seat < 0 || seat >= this.seats.length) throw new Error("No such seat");
    if (this.seats[seat].kind !== "bot") throw new Error("That seat is not a bot");
    this.seats[seat] = { kind: "empty", name: null };
    this.broadcast();
  }
  // Pass-and-play: seat another local human (each gets their own private hand).
  addHuman(seat, name) {
    if (this.state) throw new Error("Add players from the lobby, before the game starts");
    if (seat < 0 || seat >= this.seats.length) throw new Error("No such seat");
    if (this.seats[seat].kind !== "empty") throw new Error("Seat is occupied");
    this.seats[seat] = { kind: "human", name: name || `Player ${seat + 1}` };
    this.broadcast();
  }
  // Clear any non-host seat back to empty (offline lobby housekeeping).
  clearSeat(seat) {
    if (this.state) throw new Error("Can't change seats once the game has started");
    if (seat < 0 || seat >= this.seats.length) throw new Error("No such seat");
    if (seat === this.hostSeat) throw new Error("Can't clear the host seat");
    this.seats[seat] = { kind: "empty", name: null };
    this.broadcast();
  }
  setConfig(config) {
    if (this.state) throw new Error("Can't resize the table once the game has started");
    const n = this.game.seatCount(config);
    if (!this.game.meta.supportedPlayerCounts.includes(n)) {
      throw new Error(`${this.game.meta.name} doesn't support ${n} players`);
    }
    const seats = emptySeats(n);
    for (let s = 0; s < Math.min(n, this.seats.length); s++) seats[s] = this.seats[s];
    if (this.hostSeat !== null && this.hostSeat >= n) {
      const h = seats.findIndex((x) => x.kind === "human");
      this.hostSeat = h === -1 ? null : h;
    }
    if (this.viewSeat !== null && this.viewSeat >= n) {
      const v = seats.findIndex((x) => x.kind === "human");
      this.viewSeat = v === -1 ? null : v;
    }
    this.config = config;
    this.seats = seats;
    this.broadcast();
  }
  start(config) {
    if (this.state) throw new Error("Game already in progress");
    const n = this.game.seatCount(config);
    const seats = emptySeats(n);
    const taken = /* @__PURE__ */ new Set();
    for (let s = 0; s < n; s++) {
      const e = this.seats[s];
      if (e && (e.kind === "human" || e.kind === "bot") && e.name) taken.add(e.name);
    }
    for (let s = 0; s < n; s++) {
      const e = this.seats[s];
      if (e && (e.kind === "human" || e.kind === "bot")) {
        seats[s] = e;
      } else {
        const name = pickBotName(taken);
        taken.add(name);
        seats[s] = { kind: "bot", name };
      }
    }
    this.config = config;
    this.seats = seats;
    this.state = this.game.createGame(config, (Date.now() ^ Math.random() * 4294967295) >>> 0);
    this.syncViewSeat();
    this.resolveBotsAndBroadcast();
  }
  move(move) {
    if (!this.state) throw new Error("No game in progress");
    const seat = this.game.seatToAct(this.state);
    if (seat === null) throw new Error("Nobody to act");
    if (this.seats[seat].kind !== "human") throw new Error("It is not your turn");
    if (move.seat !== seat) throw new Error("Seat mismatch");
    if (!this.game.isLegal(this.state, move)) throw new Error("Illegal move");
    this.state = this.game.applyMove(this.state, move);
    this.syncViewSeat();
    this.resolveBotsAndBroadcast();
  }
  // The device always shows the hand of whoever is to act, when that seat is a
  // human — this is what makes the turn "pass" to the next person in hot-seat.
  // While a bot is to act, the view stays put so the last human watches it play.
  syncViewSeat() {
    if (!this.state) return;
    const seat = this.game.seatToAct(this.state);
    if (seat !== null && this.seats[seat]?.kind === "human") this.viewSeat = seat;
  }
  aux(payload) {
    if (!this.state) throw new Error("No game in progress");
    if (!this.game.aux) throw new Error("This game has no side actions");
    if (this.viewSeat === null) throw new Error("You are not seated");
    this.state = this.game.aux.apply(this.state, this.viewSeat, payload);
    this.broadcast();
  }
  newGame() {
    if (this.state && !this.game.isOver(this.state)) throw new Error("Game still in progress");
    this.close();
    this.state = null;
    this.seats = this.seats.map((s) => s.kind === "bot" ? { kind: "empty", name: null } : s);
    this.broadcast();
  }
  // ---------- bots + broadcast ----------
  meta() {
    return { seats: this.seats, hostSeat: this.hostSeat, players: this.seats.length, inLobby: this.state === null, botReplacement: false, disconnectedSeats: [] };
  }
  broadcast() {
    const meta = this.meta();
    const view = this.state ? this.game.redact(this.state, this.viewSeat, meta) : this.game.lobbyView(this.config, this.viewSeat, meta);
    this.emit({ t: "view", view });
  }
  resolveBotsAndBroadcast() {
    this.broadcast();
    this.scheduleBotStep();
  }
  scheduleBotStep() {
    if (this.botTimer) {
      clearTimeout(this.botTimer);
      this.botTimer = null;
    }
    const s = this.state;
    if (!s || this.game.isOver(s)) return;
    const seat = this.game.seatToAct(s);
    if (seat !== null && this.seats[seat]?.kind === "bot") {
      const raw = this.game.botStepMs;
      const ms = typeof raw === "function" ? raw(s) : raw ?? BOT_STEP_MS_DEFAULT;
      this.botTimer = setTimeout(() => this.botStep(), ms);
    }
  }
  botStep() {
    this.botTimer = null;
    const s = this.state;
    if (!s || this.game.isOver(s)) return;
    const seat = this.game.seatToAct(s);
    if (seat === null || this.seats[seat]?.kind !== "bot") return;
    let ns = s;
    if (this.game.aux?.botAux) {
      const a = this.game.aux.botAux(ns, seat);
      if (a != null) ns = this.game.aux.apply(ns, seat, a);
    }
    ns = this.game.applyMove(ns, this.game.aiMove(ns, seat));
    this.state = ns;
    this.syncViewSeat();
    this.broadcast();
    this.scheduleBotStep();
  }
};

// src/engine.ts
var SUITS = ["C", "D", "H", "S"];
var isJoker = (c) => "joker" in c;
function sameCard(a, b) {
  if (isJoker(a) || isJoker(b)) return isJoker(a) && isJoker(b);
  return a.rank === b.rank && a.suit === b.suit;
}
var SUPPORTED_PLAYERS = [4, 6, 8];
function lowRankFor(players) {
  const ranksKept = (players * 6 + 4) / 4;
  return 15 - ranksKept;
}
function buildDeck(players) {
  const low = lowRankFor(players);
  const deck = [];
  for (const suit of SUITS) {
    for (let rank = low; rank <= 14; rank++) deck.push({ rank, suit });
  }
  deck.push({ joker: true });
  return deck;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = a + 1831565813 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function shuffle(items, seed) {
  const rng = mulberry32(seed);
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  const nextSeed = Math.floor(rng() * 4294967295) >>> 0;
  return { shuffled: a, nextSeed };
}
function trumpValue(c, trump) {
  if (isJoker(c)) return 0;
  if (c.suit === trump) return c.rank;
  return null;
}
function isTrump(c, trump) {
  return trumpValue(c, trump) !== null;
}
function gameValue(c) {
  if (isJoker(c)) return 0;
  if (c.rank === 10) return 10;
  if (c.rank === 14) return 4;
  if (c.rank === 13) return 3;
  if (c.rank === 12) return 2;
  if (c.rank === 11) return 1;
  return 0;
}
function ledInfo(leadCard, trump) {
  if (isJoker(leadCard)) return { ledSuit: trump, trumpLed: true };
  return { ledSuit: leadCard.suit, trumpLed: leadCard.suit === trump };
}
function trickWinner(plays, trump) {
  const { ledSuit } = ledInfo(plays[0].card, trump);
  const trumps = plays.filter((p) => isTrump(p.card, trump));
  if (trumps.length) {
    return trumps.reduce(
      (best, p) => trumpValue(p.card, trump) > trumpValue(best.card, trump) ? p : best
    ).seat;
  }
  const followers = plays.filter((p) => !isJoker(p.card) && p.card.suit === ledSuit);
  return followers.reduce(
    (best, p) => p.card.rank > best.card.rank ? p : best
  ).seat;
}
var teamOf = (seat) => seat % 2;
function emptyProfile() {
  return {
    handsPlayed: 0,
    signalRecord: {
      weak: { bid: 0, made: 0 },
      medium: { bid: 0, made: 0 },
      strong: { bid: 0, made: 0 }
    },
    bidsWon: 0,
    bidsMade: 0,
    totalTeamPoints: 0
  };
}
function createGame(players, seed, target = 21, winsNeeded = 1) {
  if (!SUPPORTED_PLAYERS.includes(players)) {
    throw new Error(`Unsupported player count: ${players}`);
  }
  const base = {
    players,
    target,
    seed,
    phase: "bidding",
    dealerSeat: seed % players,
    scores: [0, 0],
    winner: null,
    gamesWon: [0, 0],
    winsNeeded,
    hands: [],
    kitty: [],
    trump: null,
    trumpRevealed: false,
    bidTurn: 0,
    bidsActed: 0,
    highBid: null,
    winningBid: null,
    signals: [],
    turn: 0,
    leaderSeat: 0,
    trickIndex: 0,
    currentTrick: [],
    tricksWon: [],
    lastHand: null,
    dealtHands: null,
    bidHistory: [],
    profiles: Array.from({ length: players }, emptyProfile)
  };
  return deal(base);
}
function deal(state) {
  const deck = buildDeck(state.players);
  const { shuffled, nextSeed } = shuffle(deck, state.seed);
  const hands = Array.from({ length: state.players }, () => []);
  let i = 0;
  for (let c = 0; c < 6; c++) {
    for (let seat = 0; seat < state.players; seat++) hands[seat].push(shuffled[i++]);
  }
  const kitty = shuffled.slice(i, i + 5);
  const firstBidder = (state.dealerSeat + 1) % state.players;
  return {
    ...state,
    seed: nextSeed,
    phase: "bidding",
    hands,
    dealtHands: hands.map((h) => [...h]),
    kitty,
    trump: null,
    trumpRevealed: false,
    bidTurn: firstBidder,
    bidsActed: 0,
    highBid: null,
    winningBid: null,
    signals: Array(state.players).fill(null),
    bidHistory: [],
    turn: firstBidder,
    leaderSeat: firstBidder,
    trickIndex: 0,
    currentTrick: [],
    tricksWon: []
  };
}
function setSignal(state, seat, level) {
  if (state.phase !== "bidding") throw new Error("Signals can only be set during bidding");
  if (seat < 0 || seat >= state.players) throw new Error("No such seat");
  const signals = state.signals.slice();
  signals[seat] = level;
  return { ...state, signals };
}
function legalMoves(state) {
  if (state.phase === "gameOver") return [];
  if (state.phase === "bidding") {
    const seat2 = state.bidTurn;
    const isDealer = seat2 === state.dealerSeat;
    const high = state.highBid?.amount ?? null;
    const moves = [];
    const min = high === null ? 2 : isDealer ? high : high + 1;
    for (let amt = min; amt <= 6; amt++) moves.push({ type: "bid", seat: seat2, amount: amt });
    const dealerStuck = isDealer && high === null;
    if (!dealerStuck) moves.push({ type: "pass", seat: seat2 });
    return moves;
  }
  const seat = state.turn;
  const hand = state.hands[seat];
  if (state.trump === null) {
    const declares = SUITS.map((suit) => ({ type: "selectTrump", seat, suit }));
    const leads = hand.filter((c) => !isJoker(c)).map((card) => ({ type: "play", seat, card }));
    return [...declares, ...leads];
  }
  const trump = state.trump;
  const leading = state.currentTrick.length === 0;
  let playable;
  if (leading) {
    playable = hand.slice();
    if (state.trickIndex === 0) playable = playable.filter((c) => !isJoker(c));
  } else {
    const { ledSuit, trumpLed } = ledInfo(state.currentTrick[0].card, trump);
    if (trumpLed) {
      const trumps = hand.filter((c) => isTrump(c, trump));
      playable = trumps.length ? trumps : hand.slice();
    } else {
      const ofLed = hand.filter((c) => !isJoker(c) && c.suit === ledSuit && c.suit !== trump);
      if (ofLed.length) {
        const trumps = hand.filter((c) => isTrump(c, trump));
        playable = [...ofLed, ...trumps];
      } else {
        playable = hand.slice();
      }
    }
  }
  return playable.map((card) => ({ type: "play", seat, card }));
}
function moveEq(a, b) {
  if (a.type !== b.type || a.seat !== b.seat) return false;
  if (a.type === "bid" && b.type === "bid") return a.amount === b.amount;
  if (a.type === "selectTrump" && b.type === "selectTrump") return a.suit === b.suit;
  if (a.type === "play" && b.type === "play") return sameCard(a.card, b.card);
  return true;
}
function applyMove(state, move) {
  const legal = legalMoves(state);
  if (!legal.some((m) => moveEq(m, move))) {
    throw new Error(`Illegal move: ${JSON.stringify(move)} in phase ${state.phase}`);
  }
  if (state.phase === "bidding") return applyBid(state, move);
  if (state.phase === "playing") {
    if (move.type === "selectTrump") return { ...state, trump: move.suit, trumpRevealed: true };
    return applyPlay(state, move);
  }
  throw new Error("game over");
}
function applyBid(state, move) {
  let highBid = state.highBid;
  if (move.type === "bid") highBid = { seat: move.seat, amount: move.amount };
  const bidsActed = state.bidsActed + 1;
  const done = bidsActed === state.players;
  const entry = move.type === "bid" ? { seat: move.seat, type: "bid", amount: move.amount } : { seat: move.seat, type: "pass" };
  const bidHistory = [...state.bidHistory ?? [], entry];
  if (!done) {
    const nextTurn = (state.bidTurn + 1) % state.players;
    const jumpToDealer = move.type === "bid" && move.amount === 6 && state.bidTurn !== state.dealerSeat;
    if (jumpToDealer) {
      const skips = [];
      for (let seat = nextTurn; seat !== state.dealerSeat; seat = (seat + 1) % state.players) {
        skips.push({ seat, type: "pass" });
      }
      return {
        ...state,
        highBid,
        bidsActed: bidsActed + skips.length,
        bidHistory: [...bidHistory, ...skips],
        bidTurn: state.dealerSeat
      };
    }
    return {
      ...state,
      highBid,
      bidsActed,
      bidHistory,
      bidTurn: nextTurn
    };
  }
  return {
    ...state,
    highBid,
    bidsActed,
    bidHistory,
    winningBid: highBid,
    phase: "playing",
    trump: null,
    turn: highBid.seat,
    leaderSeat: highBid.seat,
    trickIndex: 0,
    currentTrick: []
  };
}
function applyPlay(state, move) {
  if (move.type !== "play") throw new Error("expected play");
  const seat = move.seat;
  if (state.trump === null) {
    if (isJoker(move.card)) throw new Error("Cannot lead the joker on the first trick");
    state = { ...state, trump: move.card.suit, trumpRevealed: true };
  } else if (!state.trumpRevealed) {
    state = { ...state, trumpRevealed: true };
  }
  const hands = state.hands.map(
    (h, s) => s === seat ? h.filter((c) => !sameCard(c, move.card)) : h
  );
  const currentTrick = [...state.currentTrick, { seat, card: move.card }];
  if (currentTrick.length < state.players) {
    return { ...state, hands, currentTrick, turn: (seat + 1) % state.players };
  }
  const trump = state.trump;
  const winnerSeat = trickWinner(currentTrick, trump);
  const tricksWon = [...state.tricksWon, { seat: winnerSeat, cards: currentTrick.map((p) => p.card) }];
  const trickIndex = state.trickIndex + 1;
  if (trickIndex < 6) {
    return {
      ...state,
      hands,
      currentTrick: [],
      tricksWon,
      trickIndex,
      leaderSeat: winnerSeat,
      turn: winnerSeat
    };
  }
  return scoreHand({ ...state, hands, currentTrick: [], tricksWon, trickIndex });
}
function scoreHand(state) {
  const trump = state.trump;
  const bidderSeat = state.winningBid.seat;
  const bidderTeam = teamOf(bidderSeat);
  const bid = state.winningBid.amount;
  const kittyHasTrump = (c) => state.kitty.some((k) => sameCard(k, c));
  const low = lowRankFor(state.players);
  const naturalTrumpRanksInPlay = [];
  for (let r = low; r <= 14; r++) {
    const card = { rank: r, suit: trump };
    if (!kittyHasTrump(card)) naturalTrumpRanksInPlay.push(r);
  }
  const highRank = Math.max(...naturalTrumpRanksInPlay);
  const lowRank = Math.min(...naturalTrumpRanksInPlay);
  const jackInPlay = naturalTrumpRanksInPlay.includes(11);
  const jokerInPlay = !state.kitty.some((k) => isJoker(k));
  const capturingTeam = (target) => {
    for (const t of state.tricksWon) {
      if (t.cards.some((c) => sameCard(c, target))) return teamOf(t.seat);
    }
    return null;
  };
  const highTeam = capturingTeam({ rank: highRank, suit: trump });
  const lowTeam = capturingTeam({ rank: lowRank, suit: trump });
  const jackTeam = jackInPlay ? capturingTeam({ rank: 11, suit: trump }) : null;
  const bonhommeTeam = jokerInPlay ? capturingTeam({ joker: true }) : null;
  const gameCount = [0, 0];
  for (const t of state.tricksWon) {
    const team = teamOf(t.seat);
    for (const c of t.cards) gameCount[team] += gameValue(c);
  }
  const gameTeam = gameCount[0] === gameCount[1] ? null : gameCount[0] > gameCount[1] ? 0 : 1;
  const pointsByTeam = [0, 0];
  const add = (team, n) => {
    if (team !== null) pointsByTeam[team] += n;
  };
  add(highTeam, 1);
  add(lowTeam, 1);
  add(jackTeam, 1);
  add(bonhommeTeam, 2);
  add(gameTeam, 1);
  const made = pointsByTeam[bidderTeam] >= bid;
  const other = 1 - bidderTeam;
  const preScore = state.scores[bidderTeam];
  const deltaByTeam = [0, 0];
  deltaByTeam[bidderTeam] = made ? pointsByTeam[bidderTeam] : -bid;
  deltaByTeam[other] = pointsByTeam[other];
  const scores = [
    state.scores[0] + deltaByTeam[0],
    state.scores[1] + deltaByTeam[1]
  ];
  const result = {
    bidderSeat,
    bidderTeam,
    bid,
    pointsByTeam,
    made,
    deltaByTeam,
    detail: { high: highTeam, low: lowTeam, jack: jackTeam, bonhomme: bonhommeTeam, game: gameTeam, gameCount },
    dealtHands: state.dealtHands ?? []
  };
  const autoWin = bid === 6 && made && preScore >= 0;
  let winner = null;
  if (autoWin) {
    winner = bidderTeam;
  } else {
    const bidderOut = scores[bidderTeam] >= state.target;
    const otherOut = scores[other] >= state.target;
    if (bidderOut && otherOut) winner = bidderTeam;
    else if (bidderOut) winner = bidderTeam;
    else if (otherOut) winner = other;
  }
  const profiles = state.profiles.map((prof, seat) => {
    const p = {
      ...prof,
      signalRecord: {
        weak: { ...prof.signalRecord.weak },
        medium: { ...prof.signalRecord.medium },
        strong: { ...prof.signalRecord.strong }
      },
      handsPlayed: prof.handsPlayed + 1,
      totalTeamPoints: prof.totalTeamPoints + pointsByTeam[teamOf(seat)]
    };
    const sig = state.signals[seat];
    const level = sig ?? "medium";
    if (seat === bidderSeat) {
      p.bidsWon++;
      if (made) p.bidsMade++;
      p.signalRecord[level].bid++;
      if (made) p.signalRecord[level].made++;
    }
    return p;
  });
  if (winner !== null) {
    const gamesWon = [state.gamesWon[0], state.gamesWon[1]];
    gamesWon[winner]++;
    const seriesWinner = gamesWon[winner] >= state.winsNeeded ? winner : null;
    if (seriesWinner !== null) {
      return { ...state, scores, gamesWon, phase: "gameOver", winner: seriesWinner, lastHand: result, profiles };
    }
    const next2 = {
      ...state,
      scores: [0, 0],
      gamesWon,
      winner: null,
      lastHand: result,
      profiles,
      dealerSeat: (state.dealerSeat + 1) % state.players
    };
    return deal(next2);
  }
  const next = {
    ...state,
    scores,
    lastHand: result,
    profiles,
    dealerSeat: (state.dealerSeat + 1) % state.players
  };
  return deal(next);
}

// src/ai.ts
var PERSONALITIES = {
  conservative: {
    name: "Conservative",
    bidSafety: 1.25,
    stretchProb: 0.15,
    trumpPullFrac: 0.5,
    lowKeepBonus: 40,
    endgameCutoff: 3,
    loadSignalThreshold: 2,
    tenProtectMargin: 5
  },
  balanced: {
    name: "Balanced",
    bidSafety: 0.75,
    stretchProb: 0.35,
    trumpPullFrac: 0.35,
    lowKeepBonus: 25,
    endgameCutoff: 2,
    loadSignalThreshold: 1,
    tenProtectMargin: 10
  },
  aggressive: {
    name: "Aggressive",
    bidSafety: 0.25,
    stretchProb: 0.6,
    trumpPullFrac: 0.2,
    lowKeepBonus: 10,
    endgameCutoff: 1,
    loadSignalThreshold: 0,
    tenProtectMargin: 20
  }
};
var clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
function suitValue(hand, suit, players) {
  const trumps = hand.filter((c) => isTrump(c, suit));
  const n = trumps.length;
  const has = (rank) => trumps.some((c) => !isJoker(c) && c.rank === rank);
  const hasJoker = trumps.some(isJoker);
  const highCount = trumps.filter((c) => !isJoker(c) && c.rank >= 12).length;
  const lowest = lowRankFor(players);
  const tens = hand.filter((c) => !isJoker(c) && c.rank === 10).length;
  let score = 0;
  if (has(14)) score += 1;
  else if (has(13)) score += 0.4;
  else if (has(12)) score += 0.15;
  if (has(11)) {
    const protectors = [14, 13, 12].filter(has).length + (hasJoker ? 1 : 0);
    score += Math.min(0.9, 0.25 + 0.2 * protectors);
  }
  if (hasJoker) score += Math.min(2.2, 0.3 + 0.25 * (n - 1) + (has(14) ? 1.15 : 0));
  else score += Math.min(0.8, 0.15 * highCount);
  score += Math.min(0.7, 0.12 * n + (has(lowest) ? 0.15 : 0) + (has(14) ? 0.65 : has(13) ? 0.25 : 0));
  score += Math.min(1, 0.1 * n + 0.15 * tens + (has(14) ? 0.5 : 0));
  score += 0.1 * Math.max(0, n - 3);
  return score;
}
function bestSuit(hand, players) {
  let best = { suit: SUITS[0], score: -Infinity };
  for (const suit of SUITS) {
    const score = suitValue(hand, suit, players);
    if (score > best.score) best = { suit, score };
  }
  return best;
}
function bossTrumpValue(state, trump) {
  const low = lowRankFor(state.players);
  const all = [{ joker: true }];
  for (let r = low; r <= 14; r++) all.push({ rank: r, suit: trump });
  const seen = [];
  for (const t of state.tricksWon) for (const c of t.cards) if (isTrump(c, trump)) seen.push(c);
  for (const p of state.currentTrick) if (isTrump(p.card, trump)) seen.push(p.card);
  const seenVals = new Set(seen.map((c) => trumpValue(c, trump)));
  const unseen = all.map((c) => trumpValue(c, trump)).filter((v) => !seenVals.has(v));
  return unseen.length ? Math.max(...unseen) : -1;
}
function unseenTrumpCount(state, trump, myCards) {
  const low = lowRankFor(state.players);
  const totalTrumps = 1 + (14 - low + 1);
  const seenInTricks = state.tricksWon.flatMap((t) => t.cards).filter((c) => isTrump(c, trump)).length + state.currentTrick.filter((p) => isTrump(p.card, trump)).length;
  const myTrumps = myCards.filter((c) => isTrump(c, trump)).length;
  return totalTrumps - seenInTricks - myTrumps;
}
function tricksRemaining(state) {
  const handSize3 = state.hands[0].length + state.tricksWon.length + (state.currentTrick.length > 0 ? 1 : 0);
  return handSize3 - state.tricksWon.length;
}
function gamePipTotals(state) {
  const totals = [0, 0];
  for (const t of state.tricksWon) {
    const team = teamOf(t.seat);
    for (const c of t.cards) totals[team] += gameValue(c);
  }
  return totals;
}
function keepValue(c, trump, low, p, myTeamAhead) {
  if (isJoker(c)) return 100;
  if (c.suit === trump) {
    if (c.rank === 11) return 90;
    if (c.rank === 14) return 85;
    if (c.rank === low) return 40 + c.rank + p.lowKeepBonus;
    return 40 + c.rank;
  }
  if (c.rank === 10) return myTeamAhead ? 30 + p.tenProtectMargin : 30;
  if (c.rank === 14) return 25;
  return c.rank;
}
function loadValue(c, trump) {
  if (isJoker(c)) return 60;
  if (!isJoker(c) && c.suit === trump && c.rank === 11) return 30;
  return gameValue(c);
}
var winCost = (c, trump) => isTrump(c, trump) ? trumpValue(c, trump) : c.rank;
function pick(items, score, mode) {
  return items.reduce(
    (best, t) => mode === "max" ? score(t) > score(best) ? t : best : score(t) < score(best) ? t : best
  );
}
function bestDiscard(cards, trump, low, p, myTeamAhead) {
  const offSuit = cards.filter((c) => !isTrump(c, trump) && !isJoker(c));
  if (!offSuit.length) return pick(cards, (c) => keepValue(c, trump, low, p, myTeamAhead), "min");
  const suitCounts = {};
  for (const c of offSuit) suitCounts[c.suit] = (suitCounts[c.suit] ?? 0) + 1;
  const sorted = offSuit.slice().sort((a, b) => {
    const byLen = suitCounts[a.suit] - suitCounts[b.suit];
    if (byLen !== 0) return byLen;
    return keepValue(a, trump, low, p, myTeamAhead) - keepValue(b, trump, low, p, myTeamAhead);
  });
  return sorted[0];
}
function mulberry322(seed) {
  let a = seed >>> 0;
  return () => {
    a = a + 1831565813 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function stateRng(state, seat) {
  let h = (state.seed ^ Math.imul(seat + 1, 2654435761) ^ Math.imul(state.bidsActed + 1, 2246822519)) >>> 0;
  for (const c of state.hands[seat]) h = Math.imul(h, 31) + (isJoker(c) ? 53 : c.rank * 4 + SUITS.indexOf(c.suit)) >>> 0;
  return mulberry322(h);
}
var confFromScore = (score) => score >= 3 ? 2 : score >= 1.5 ? 1 : 0;
var signalToNum = (sig) => sig === "strong" ? 2 : sig === "weak" ? 0 : 1;
function signalReliability(prof, level) {
  const rec = prof.signalRecord[level];
  return rec.bid >= 3 ? rec.made / rec.bid : null;
}
function calibratedSignal(sig, prof) {
  const raw = signalToNum(sig);
  const level = sig ?? "medium";
  const rel = signalReliability(prof, level);
  if (rel === null) return raw;
  const expected = level === "strong" ? 0.7 : level === "medium" ? 0.5 : 0.2;
  const delta = rel - expected;
  return clamp(raw + delta * 2, 0, 2);
}
function aggressionIndex(prof) {
  return prof.handsPlayed >= 3 ? prof.bidsWon / prof.handsPlayed : 0.5;
}
var competeProb = (myConf, theirConf, stretchProb) => {
  const gap = myConf - theirConf;
  return gap <= 0 ? stretchProb * 0.6 : gap === 1 ? stretchProb + 0.1 : stretchProb + 0.3;
};
function opponentThreatLevel(state, opponentSeat, bidAmount) {
  const team = teamOf(opponentSeat);
  const after = state.scores[team] + bidAmount;
  if (after >= state.target) return 2;
  if (after >= state.target - 2) return 1;
  return 0;
}
function estimateSixBidProb(hand, players) {
  const { suit } = bestSuit(hand, players);
  const trumps = hand.filter((c) => isTrump(c, suit));
  const has = (r) => trumps.some((c) => !isJoker(c) && c.rank === r);
  const hasJoker = trumps.some(isJoker);
  const n = trumps.length;
  if (!has(14)) return 0;
  const remaining = players * 6 + 5 - 6;
  const pJokerLive = hasJoker ? 1 : (remaining - 5) / remaining;
  let sweepProb = 0.99;
  if (!hasJoker) sweepProb -= 0.01;
  if (!has(11)) sweepProb -= 0.2;
  if (!has(13) && !has(12)) sweepProb -= 0.08;
  sweepProb += 5e-3 * Math.max(0, n - 4);
  sweepProb = clamp(sweepProb, 0, 0.99);
  return pJokerLive * sweepProb;
}
function decideBid(state, seat, rng, p) {
  const hand = state.hands[seat];
  const best = bestSuit(hand, state.players);
  const myTeam = teamOf(seat);
  const oppTeam = 1 - myTeam;
  const oppGap = state.target - state.scores[oppTeam];
  const desperationBonus = oppGap <= 6 ? (6 - oppGap) * 0.18 : 0;
  const effectiveSafety = Math.max(0, p.bidSafety - desperationBonus);
  const willing = clamp(Math.round(best.score - effectiveSafety), 0, 6);
  const myConf = confFromScore(best.score);
  const isDealer = seat === state.dealerSeat;
  const high = state.highBid;
  const highAmt = high?.amount ?? null;
  if (isDealer && highAmt === null) return { type: "bid", seat, amount: 2 };
  const needed = highAmt === null ? 2 : isDealer ? highAmt : highAmt + 1;
  if (needed > 6) return { type: "pass", seat };
  if (willing >= needed) return { type: "bid", seat, amount: needed };
  if (high !== null) {
    const sameTeam = teamOf(high.seat) === teamOf(seat);
    const holderProf = state.profiles[high.seat];
    const theirConf = calibratedSignal(state.signals[high.seat], holderProf);
    if (!sameTeam) {
      const threat = opponentThreatLevel(state, high.seat, high.amount);
      if (threat === 2 && needed <= 6) return { type: "bid", seat, amount: needed };
      if (threat === 1 && needed <= willing + 2) {
        const blockProb = clamp(0.5 + theirConf * 0.2 - (2 - myConf) * 0.1, 0.2, 0.95);
        if (rng() < blockProb) return { type: "bid", seat, amount: needed };
      }
      if (needed <= willing + 1 && myConf >= theirConf) {
        const aggBonus = Math.max(0, aggressionIndex(holderProf) - 0.4) * 0.3;
        if (rng() < competeProb(myConf, theirConf, p.stretchProb + aggBonus))
          return { type: "bid", seat, amount: needed };
      }
    } else if (sameTeam && myConf === 2 && theirConf <= 0.5) {
      if (rng() < p.stretchProb * 0.5) return { type: "bid", seat, amount: needed };
    }
  }
  if (needed === 6) {
    const sixProb = estimateSixBidProb(hand, state.players);
    const myScore = state.scores[myTeam];
    const myGap = state.target - myScore;
    const safeFromHoleBonus = myScore >= 1 ? Math.min(0.1, myScore * 8e-3) : 0;
    const autoWinBonus = myScore >= 0 ? 0.07 : 0;
    const despSixBonus = oppGap <= 4 ? 0.12 : oppGap <= 6 ? 0.06 : 0;
    const rawNearWinPenalty = myGap <= 6 ? (6 - myGap) * 0.1 : 0;
    const nearWinPenalty = rawNearWinPenalty * Math.max(0, 1 - despSixBonus * 5);
    const sixThresh = clamp(
      0.65 + p.bidSafety * 0.2 - safeFromHoleBonus - autoWinBonus - despSixBonus + nearWinPenalty,
      0.48,
      0.97
    );
    if (sixProb >= sixThresh) return { type: "bid", seat, amount: 6 };
  }
  return { type: "pass", seat };
}
function decidePlay(state, seat, p) {
  const trump = state.trump;
  const players = state.players;
  const low = lowRankFor(players);
  const cards = legalMoves(state).filter((m) => m.type === "play").map((m) => m.card);
  const boss = bossTrumpValue(state, trump);
  const asMove = (card) => ({ type: "play", seat, card });
  const pips = gamePipTotals(state);
  const myTeam = teamOf(seat);
  const myTeamAhead = pips[myTeam] - pips[1 - myTeam] >= p.tenProtectMargin;
  const kv = (c) => keepValue(c, trump, low, p, myTeamAhead);
  const remaining = tricksRemaining(state);
  const unseenTrumps = unseenTrumpCount(state, trump, cards);
  const myTrumps = cards.filter((c) => isTrump(c, trump));
  const isLast = state.currentTrick.length === players - 1;
  if (state.currentTrick.length === 0) {
    const shouldPullTrumps = myTrumps.length > 0 && unseenTrumps > 0 && unseenTrumps / (remaining * (players - 1)) >= p.trumpPullFrac;
    if (myTrumps.length) {
      const top = pick(myTrumps, (c) => trumpValue(c, trump), "max");
      const topVal = trumpValue(top, trump);
      const conserve = remaining <= p.endgameCutoff;
      if (topVal === boss && !conserve) return asMove(top);
      if (shouldPullTrumps) {
        const nonBoss = myTrumps.filter((c) => trumpValue(c, trump) !== boss);
        if (nonBoss.length) {
          const hasProtection = myTrumps.some((c) => !isJoker(c) && c.rank > 11);
          const jack = myTrumps.find((c) => !isJoker(c) && c.rank === 11);
          const safe = nonBoss.filter((c) => !(c === jack && !hasProtection));
          if (safe.length) return asMove(pick(safe, (c) => trumpValue(c, trump), "max"));
        }
      }
      const myLow = myTrumps.find((c) => !isJoker(c) && c.rank === low);
      if (!myLow && shouldPullTrumps && myTrumps.length >= 2) {
        const byVal = myTrumps.slice().sort((a, b) => trumpValue(a, trump) - trumpValue(b, trump));
        return asMove(byVal[1]);
      }
    }
    const sideAces = cards.filter((c) => !isTrump(c, trump) && !isJoker(c) && c.rank === 14);
    if (sideAces.length) return asMove(sideAces[0]);
    return asMove(bestDiscard(cards, trump, low, p, myTeamAhead));
  }
  const winnerSeat = trickWinner(state.currentTrick, trump);
  const winnerCard = state.currentTrick.find((p2) => p2.seat === winnerSeat).card;
  const partnerWinning = teamOf(winnerSeat) === teamOf(seat);
  const trickHasValue = state.currentTrick.some((p2) => isTrump(p2.card, trump) || gameValue(p2.card) >= 4);
  const wouldWin = (c) => trickWinner([...state.currentTrick, { seat, card: c }], trump) === seat;
  const winners = cards.filter(wouldWin);
  if (partnerWinning) {
    const partnerSeat = seat % 2 === 0 ? 1 : 0;
    const partnerCalibrated = calibratedSignal(state.signals[partnerSeat], state.profiles[partnerSeat]);
    const winVal = trumpValue(winnerCard, trump);
    const partnerStrong = winVal !== null ? winVal === boss || winVal >= 12 || partnerCalibrated >= p.loadSignalThreshold : partnerCalibrated >= p.loadSignalThreshold;
    const safe = cards.filter((c) => !wouldWin(c));
    const pool = safe.length ? safe : cards;
    if (partnerStrong || isLast) {
      return asMove(pick(pool, (c) => loadValue(c, trump), "max"));
    }
    return asMove(bestDiscard(pool, trump, low, p, myTeamAhead));
  }
  if (winners.length && trickHasValue) {
    const opponentConf = state.signals.map((s, i) => teamOf(i) !== myTeam ? calibratedSignal(s, state.profiles[i]) : -1).reduce((a, b) => Math.max(a, b), -1);
    if (opponentConf >= 2 && winners.every((c) => !isTrump(c, trump))) {
      return asMove(bestDiscard(cards, trump, low, p, myTeamAhead));
    }
    return asMove(pick(winners, (c) => winCost(c, trump), "min"));
  }
  return asMove(bestDiscard(cards, trump, low, p, myTeamAhead));
}
function aiMove(state, seat, rng = stateRng(state, seat), personality = PERSONALITIES.balanced) {
  if (state.phase === "gameOver") throw new Error("game is over");
  const turnSeat = state.phase === "bidding" ? state.bidTurn : state.turn;
  if (turnSeat !== seat) throw new Error(`not seat ${seat}'s turn (it is seat ${turnSeat}'s)`);
  if (state.phase === "bidding") return decideBid(state, seat, rng, personality);
  if (state.trump === null)
    return { type: "selectTrump", seat, suit: bestSuit(state.hands[seat], state.players).suit };
  return decidePlay(state, seat, personality);
}
function handConfidence(hand, players) {
  const score = bestSuit(hand, players).score;
  if (score >= 3) return "strong";
  if (score >= 1.5) return "medium";
  return "weak";
}

// src/protocol.ts
function redact(state, seat, meta) {
  const phase = meta.phase ?? state.phase;
  const playing = phase === "bidding" || phase === "playing";
  const toAct = !playing ? null : state.phase === "bidding" ? state.bidTurn : state.turn;
  const yourTurn = seat !== null && toAct === seat;
  const tricks = state.tricksWon;
  const lastTrick = tricks.length ? { winner: tricks[tricks.length - 1].seat, cards: tricks[tricks.length - 1].cards } : null;
  return {
    you: seat,
    players: state.players,
    phase,
    target: state.target,
    seats: meta.seats,
    hostSeat: meta.hostSeat,
    scores: state.scores,
    winner: state.winner,
    gamesWon: state.gamesWon,
    winsNeeded: state.winsNeeded,
    dealerSeat: state.dealerSeat,
    trump: state.trump,
    trumpRevealed: state.trumpRevealed,
    toAct,
    yourTurn,
    legalMoves: yourTurn ? legalMoves(state) : [],
    yourHand: seat !== null && state.hands[seat] ? state.hands[seat] : [],
    handCounts: state.hands.map((h) => h.length),
    highBid: state.highBid,
    bidHistory: state.bidHistory ?? [],
    signals: state.signals,
    currentTrick: state.currentTrick,
    lastTrick,
    lastHand: state.lastHand,
    lastKitty: state.lastHand ? state.kitty : null,
    lastDealtHands: state.lastHand ? state.lastHand.dealtHands : null,
    log: state.log ?? []
  };
}

// src/hlj-module.ts
var moveEq2 = (a, b) => JSON.stringify(a) === JSON.stringify(b);
var LOG_CAP = 120;
var teamName = (seat) => seat % 2 === 0 ? "Team A" : "Team B";
var teamLetter = (t) => t === 0 ? "A" : "B";
function attach(next, prevLog, prevSeq, parts) {
  let seq = prevSeq;
  const added = parts.map((p) => ({ id: ++seq, ...p }));
  const log = [...prevLog, ...added].slice(-LOG_CAP);
  return { ...next, log, logSeq: seq };
}
function hljEntries(prev, next, move) {
  const out = [];
  if (move.type === "bid") out.push({ seat: move.seat, msg: `bid ${move.amount}` });
  else if (move.type === "pass") out.push({ seat: move.seat, msg: "passed" });
  else if (move.type === "selectTrump") out.push({ seat: move.seat, msg: "called trump", suit: move.suit });
  else if (move.type === "play") out.push({ seat: move.seat, msg: "played", cards: [move.card] });
  if (next.winningBid && (!prev.winningBid || prev.winningBid.seat !== next.winningBid.seat || prev.winningBid.amount !== next.winningBid.amount)) {
    out.push({ seat: next.winningBid.seat, msg: `wins the bid at ${next.winningBid.amount}` });
  }
  if (prev.trump === null && next.trump !== null && move.type === "play") {
    out.push({ seat: null, msg: "trump is", suit: next.trump });
  }
  if (next.tricksWon.length > prev.tricksWon.length) {
    const t = next.tricksWon[next.tricksWon.length - 1];
    out.push({ seat: t.seat, msg: "takes the trick" });
  }
  if (next.lastHand && next.lastHand !== prev.lastHand) {
    const r = next.lastHand;
    out.push({ seat: null, msg: `${teamName(r.bidderSeat)} bid ${r.bid} \u2014 ${r.made ? "made it" : "set back"}` });
    const d = r.detail;
    const honors = [`High\u2192${teamLetter(d.high ?? 0)}`, `Low\u2192${teamLetter(d.low ?? 0)}`];
    if (d.jack !== null) honors.push(`Jack\u2192${teamLetter(d.jack)}`);
    if (d.bonhomme !== null) honors.push(`Joker\u2192${teamLetter(d.bonhomme)}`);
    if (d.game !== null) honors.push(`Game\u2192${teamLetter(d.game)}`);
    out.push({ seat: null, msg: honors.join("    ") });
    out.push({ seat: null, msg: `Score \u2014 A ${next.scores[0]}, B ${next.scores[1]}` });
    if (next.phase === "gameOver" && next.winner !== null) {
      out.push({ seat: null, msg: `${teamName(next.winner)} wins the game!` });
    } else if (next.dealerSeat !== prev.dealerSeat) {
      out.push({ seat: next.dealerSeat, msg: "deals the next hand" });
    }
  }
  return out;
}
var PERSONALITY_TABLE = [
  PERSONALITIES.aggressive,
  PERSONALITIES.balanced,
  PERSONALITIES.aggressive,
  PERSONALITIES.balanced,
  PERSONALITIES.conservative
];
function botPersonality(state, seat) {
  const h = (state.seed >>> 0 ^ Math.imul(seat + 1, 2654435769)) >>> 0;
  return PERSONALITY_TABLE[h % PERSONALITY_TABLE.length];
}
var hljModule = {
  meta: { id: "high-low-jack", name: "High Low Jack", supportedPlayerCounts: [4, 6, 8] },
  seatCount: (config) => config.players,
  // Scale bot delay so total wait per trick stays roughly constant regardless of player count.
  // Base 1600ms for 4p: 6p → ~1067ms, 8p → 800ms.
  botStepMs: (s) => Math.round(1600 * 4 / s.players),
  createGame: (config, seed) => {
    const winsNeeded = config.bestOf ? Math.ceil(config.bestOf / 2) : 1;
    const g = createGame(config.players, seed, config.target, winsNeeded);
    return attach(g, [], 0, [{ seat: g.dealerSeat, msg: "deals the first hand" }]);
  },
  // Pitch's turn order: bidder during bidding, otherwise the player to act.
  seatToAct: (s) => s.phase === "gameOver" ? null : s.phase === "bidding" ? s.bidTurn : s.turn,
  // Pitch's move set is tiny, so enumerate-and-compare is a fine authorizer.
  isLegal: (s, move) => legalMoves(s).some((m) => moveEq2(m, move)),
  legalMoves: (s) => legalMoves(s),
  applyMove: (s, move) => {
    const next = applyMove(s, move);
    return attach(next, s.log, s.logSeq, hljEntries(s, next, move));
  },
  isOver: (s) => s.phase === "gameOver",
  redact: (s, seat, meta) => redact(s, seat, { seats: meta.seats, hostSeat: meta.hostSeat, botReplacement: meta.botReplacement, disconnectedSeats: meta.disconnectedSeats }),
  lobbyView: (config, seat, meta) => {
    const winsNeeded = config.bestOf ? Math.ceil(config.bestOf / 2) : 1;
    const g = createGame(config.players, 1, config.target, winsNeeded);
    const blanked = { ...g, hands: g.hands.map(() => []), kitty: [], phase: "bidding" };
    return redact(blanked, seat, { seats: meta.seats, hostSeat: meta.hostSeat, botReplacement: meta.botReplacement, disconnectedSeats: meta.disconnectedSeats, phase: "lobby" });
  },
  aiMove: (s, seat) => aiMove(s, seat, void 0, botPersonality(s, seat)),
  // Hand signals: a non-turn side action that must preserve the log untouched.
  aux: {
    apply: (s, seat, payload) => {
      const next = setSignal(s, seat, payload);
      return { ...next, log: s.log, logSeq: s.logSeq };
    },
    botAux: (s, seat) => s.phase === "bidding" && s.signals[seat] == null ? handConfidence(s.hands[seat], s.players) : null
  }
};

// src/rummy-module.ts
var cardValue = (c) => c.joker ? 15 : c.rank === 14 ? 15 : c.rank >= 10 ? 10 : c.rank;
function buildDeck2(decks = 1) {
  const deck = [];
  let id = 0;
  for (let d = 0; d < decks; d++) {
    for (const suit of SUITS) for (let rank = 2; rank <= 14; rank++) deck.push({ id: id++, rank, suit });
    for (let j = 0; j < 2; j++) deck.push({ id: id++, rank: 0, suit: "S", joker: true });
  }
  return deck;
}
var decksFor = (players) => players <= 4 ? 1 : 2;
function mulberry323(seed) {
  let a = seed >>> 0;
  return () => {
    a = a + 1831565813 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function shuffle2(items, seed) {
  const rng = mulberry323(seed);
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  const nextSeed = Math.floor(rng() * 4294967295) >>> 0;
  return { shuffled: a, nextSeed };
}
function isRun(cards) {
  if (cards.length < 3) return false;
  const naturals = cards.filter((c) => !c.joker);
  const jokers = cards.length - naturals.length;
  if (naturals.length === 0) return false;
  const suit = naturals[0].suit;
  if (!naturals.every((c) => c.suit === suit)) return false;
  for (const aceRank of [1, 14]) {
    const ranks = naturals.map((c) => c.rank === 14 ? aceRank : c.rank).sort((a, b) => a - b);
    if (new Set(ranks).size !== ranks.length) continue;
    const low = ranks[0], high = ranks[ranks.length - 1];
    if (low < 1 || high > 14) continue;
    const gaps = high - low + 1 - ranks.length;
    if (gaps < 0 || gaps > jokers) continue;
    const extra = jokers - gaps;
    if (high - low + 1 + extra > 14) continue;
    if (low - 1 + (14 - high) < extra) continue;
    return true;
  }
  return false;
}
function isSet(cards) {
  if (cards.length < 3) return false;
  const naturals = cards.filter((c) => !c.joker);
  if (naturals.length === 0) return false;
  if (!naturals.every((c) => c.rank === naturals[0].rank)) return false;
  const suits = naturals.map((c) => c.suit);
  if (new Set(suits).size !== suits.length) return false;
  if (cards.length > 4) return false;
  return true;
}
function orderRunCards(cards) {
  const naturals = cards.filter((c) => !c.joker);
  const jokers = cards.filter((c) => c.joker);
  for (const aceRank of [1, 14]) {
    const eff = naturals.map((c) => ({ c, r: c.rank === 14 ? aceRank : c.rank })).sort((a, b) => a.r - b.r);
    const ranks = eff.map((x) => x.r);
    if (new Set(ranks).size !== ranks.length) continue;
    const low = ranks[0], high = ranks[ranks.length - 1];
    const gaps = high - low + 1 - ranks.length;
    if (gaps < 0 || gaps > jokers.length) continue;
    const extra = jokers.length - gaps;
    const after = Math.min(extra, 14 - high);
    const before = extra - after;
    if (before > low - 1) continue;
    const byRank = new Map(eff.map((x) => [x.r, x.c]));
    const jk = [...jokers];
    const out = [];
    for (let r = low - before; r <= high + after; r++) out.push(byRank.get(r) ?? jk.shift());
    if (out.length === cards.length && jk.length === 0) return out;
  }
  return cards;
}
var validMeld = (cards) => isSet(cards) || isRun(cards);
function canRunWith(pool, target) {
  if (target.joker) return false;
  const inSuit = pool.filter((c) => c.suit === target.suit && !c.joker);
  const jokers = pool.filter((c) => c.joker).length;
  for (const aceRank of [1, 14]) {
    const ranks = new Set(inSuit.map((c) => c.rank === 14 ? aceRank : c.rank));
    const tr = target.rank === 14 ? aceRank : target.rank;
    ranks.add(tr);
    for (let start = tr - 2; start <= tr; start++) {
      let ok = true, need = 0;
      for (let k = 0; k < 3; k++) {
        const r = start + k;
        if (r < 1 || r > 14) {
          ok = false;
          break;
        }
        if (!ranks.has(r)) need++;
      }
      if (ok && need <= jokers) return true;
    }
  }
  return false;
}
function canFormMeldWith(pool, target) {
  if (target.joker) return false;
  const otherSuits = new Set(pool.filter((c) => !c.joker && c.rank === target.rank && c.suit !== target.suit).map((c) => c.suit));
  const jokers = pool.filter((c) => c.joker).length;
  if (1 + otherSuits.size + jokers >= 3) return true;
  return canRunWith(pool, target);
}
function canLayoff(state, target) {
  return state.melds.some(
    (m) => m.kind === "set" ? isSet([...m.cards, target]) : isRun([...m.cards, target])
  );
}
var handSize = (players) => players === 2 ? 13 : 7;
function dealRound(prev) {
  const { shuffled, nextSeed } = shuffle2(buildDeck2(decksFor(prev.players)), prev.seed);
  const hands = Array.from({ length: prev.players }, () => []);
  const hs = handSize(prev.players);
  let i = 0;
  for (let k = 0; k < hs; k++) for (let s = 0; s < prev.players; s++) hands[s].push(shuffled[i++]);
  const discard = [shuffled[i++]];
  const stock = shuffled.slice(i);
  return {
    ...prev,
    seed: nextSeed,
    phase: "playing",
    turn: (prev.dealerSeat + 1) % prev.players,
    turnPhase: "draw",
    hands,
    stock,
    discard,
    melds: [],
    cardOwner: {},
    mustMeldCardId: null,
    winner: null,
    nextMeldId: 0
  };
}
function createGame2(config, seed) {
  if (config.players < 2 || config.players > 8) throw new Error(`Unsupported player count: ${config.players}`);
  if (config.target <= 0) throw new Error("Target must be positive");
  const botDifficulty = Array.from({ length: config.players }, (_, i) => config.botDifficulty?.[i] ?? 2);
  const base = {
    players: config.players,
    target: config.target,
    seed,
    phase: "playing",
    dealerSeat: 0,
    turn: 0,
    turnPhase: "draw",
    hands: [],
    stock: [],
    discard: [],
    melds: [],
    cardOwner: {},
    mustMeldCardId: null,
    scores: Array(config.players).fill(0),
    winner: null,
    lastRound: null,
    botDifficulty,
    nextMeldId: 0,
    log: [],
    logSeq: 0
  };
  const dealt = dealRound(base);
  return attachRummy(dealt, [], 0, [{ seat: dealt.dealerSeat, msg: "deals the first hand" }]);
}
var LOG_CAP2 = 120;
function attachRummy(next, prevLog, prevSeq, parts) {
  let seq = prevSeq;
  const added = parts.map((p) => ({ id: ++seq, ...p }));
  return { ...next, log: [...prevLog, ...added].slice(-LOG_CAP2), logSeq: seq };
}
var findCard = (list, id) => list.find((c) => c.id === id);
function rummyEntries(prev, next, move) {
  const out = [];
  const seat = move.seat;
  const hand = prev.hands[seat] ?? [];
  if (move.type === "drawStock") {
    out.push({ seat, msg: "drew from the stock" });
  } else if (move.type === "drawDiscard") {
    const idx = prev.discard.findIndex((c) => c.id === move.cardId);
    const taken = idx >= 0 ? prev.discard.slice(idx) : [];
    const target = idx >= 0 ? prev.discard[idx] : void 0;
    const extra = Math.max(0, taken.length - 1);
    out.push({
      seat,
      msg: "took",
      cards: target ? [target] : [],
      tail: extra ? `+${extra} more from the discard` : "from the discard",
      extraCards: extra ? taken.slice(1) : void 0
    });
  } else if (move.type === "meld") {
    out.push({ seat, msg: "melded", cards: move.cards.map((id) => findCard(hand, id)).filter(Boolean) });
  } else if (move.type === "layoff") {
    out.push({ seat, msg: "laid off", cards: move.cards.map((id) => findCard(hand, id)).filter(Boolean) });
  } else if (move.type === "discard") {
    const c = findCard(hand, move.cardId);
    out.push({ seat, msg: "discarded", cards: c ? [c] : [] });
  }
  if (next.lastRound && next.lastRound !== prev.lastRound) {
    const lr = next.lastRound;
    if (lr.outSeat != null) out.push({ seat: lr.outSeat, msg: `goes out (+${lr.delta[lr.outSeat]} this round)` });
    else out.push({ seat: null, msg: "Stock exhausted \u2014 round scored" });
    if (next.phase === "gameOver" && next.winner !== null) out.push({ seat: next.winner, msg: "wins the game!" });
    else if (next.dealerSeat !== prev.dealerSeat) out.push({ seat: next.dealerSeat, msg: "deals a new round" });
  }
  return out;
}
function meldedValue(state, seat) {
  let v = 0;
  for (const m of state.melds) for (const c of m.cards) if (state.cardOwner[c.id] === seat) v += cardValue(c);
  return v;
}
var heldValue = (state, seat) => state.hands[seat].reduce((a, c) => a + cardValue(c), 0);
function endRound(state, outSeat) {
  const meldedPts = state.scores.map((_, s) => meldedValue(state, s));
  const heldPts = state.scores.map((_, s) => heldValue(state, s));
  const delta = state.scores.map((_, s) => meldedPts[s] - heldPts[s]);
  const heldCards = state.hands.map((h) => [...h]);
  const scores = state.scores.map((v, s) => v + delta[s]);
  const lastRound = { delta, outSeat, meldedPts, heldPts, heldCards };
  const max = Math.max(...scores);
  if (max >= state.target) {
    return { ...state, scores, phase: "gameOver", winner: scores.indexOf(max), lastRound };
  }
  return dealRound({ ...state, scores, lastRound, dealerSeat: (state.dealerSeat + 1) % state.players });
}
var seatToAct = (s) => s.phase === "gameOver" ? null : s.turn;
var isOver = (s) => s.phase === "gameOver";
function isLegal(state, move) {
  if (state.phase !== "playing" || move.seat !== state.turn) return false;
  const hand = state.hands[move.seat];
  switch (move.type) {
    case "drawStock":
      return state.turnPhase === "draw" && state.stock.length > 0;
    case "drawDiscard": {
      if (state.turnPhase !== "draw") return false;
      const idx = state.discard.findIndex((c) => c.id === move.cardId);
      if (idx < 0) return false;
      if (idx === state.discard.length - 1) return true;
      const taken = state.discard.slice(idx);
      const target = state.discard[idx];
      return canFormMeldWith([...hand, ...taken], target) || canLayoff(state, target);
    }
    case "meld": {
      if (state.turnPhase !== "play" || !move.cards || move.cards.length < 3) return false;
      if (new Set(move.cards).size !== move.cards.length) return false;
      const objs = move.cards.map((id) => hand.find((c) => c.id === id));
      if (objs.some((o) => !o)) return false;
      if (!validMeld(objs)) return false;
      if (state.mustMeldCardId != null && !move.cards.includes(state.mustMeldCardId)) {
        const mustCard = hand.find((c) => c.id === state.mustMeldCardId);
        if (mustCard) {
          const remainHand = hand.filter((c) => !move.cards.includes(c.id));
          const newMeldCards = objs;
          const newMeldKind = isSet(newMeldCards) ? "set" : "run";
          const allMelds = [...state.melds, { id: -1, kind: newMeldKind, cards: newMeldCards }];
          const canStillPlay = canFormMeldWith(remainHand, mustCard) || allMelds.some((m) => m.kind === "set" ? isSet([...m.cards, mustCard]) : isRun([...m.cards, mustCard]));
          if (!canStillPlay) return false;
        }
      }
      return true;
    }
    case "layoff": {
      if (state.turnPhase !== "play" || !move.cards || move.cards.length < 1) return false;
      if (new Set(move.cards).size !== move.cards.length) return false;
      const m = state.melds.find((x) => x.id === move.meldId);
      if (!m) return false;
      const objs = move.cards.map((id) => hand.find((c) => c.id === id));
      if (objs.some((o) => !o)) return false;
      const combined = [...m.cards, ...objs];
      if (!(m.kind === "set" ? isSet(combined) : isRun(combined))) return false;
      if (state.mustMeldCardId != null && !move.cards.includes(state.mustMeldCardId)) {
        const mustCard = hand.find((c) => c.id === state.mustMeldCardId);
        if (mustCard) {
          const remainHand = hand.filter((c) => !move.cards.includes(c.id));
          const updatedMeldCards = m.kind === "run" ? orderRunCards(combined) : combined;
          const updatedMelds = state.melds.map((x) => x.id === move.meldId ? { ...x, cards: updatedMeldCards } : x);
          const canStillPlay = canFormMeldWith(remainHand, mustCard) || updatedMelds.some((mx) => mx.kind === "set" ? isSet([...mx.cards, mustCard]) : isRun([...mx.cards, mustCard]));
          if (!canStillPlay) return false;
        }
      }
      return true;
    }
    case "discard":
      return state.turnPhase === "play" && state.mustMeldCardId == null && hand.some((c) => c.id === move.cardId);
  }
  return false;
}
function applyMoveCore(state, move) {
  if (state.phase !== "playing") throw new Error("Game is over");
  if (seatToAct(state) !== move.seat) throw new Error("Not this seat's turn");
  if (!isLegal(state, move)) throw new Error(`Illegal move: ${JSON.stringify(move)}`);
  const seat = move.seat;
  const handsWith = (h) => state.hands.map((x, s) => s === seat ? h : x);
  const clears = (ids) => state.mustMeldCardId != null && ids.includes(state.mustMeldCardId) ? null : state.mustMeldCardId;
  switch (move.type) {
    case "drawStock": {
      const stock = state.stock.slice(0, -1);
      const drawn = state.stock[state.stock.length - 1];
      return { ...state, stock, hands: handsWith([...state.hands[seat], drawn]), turnPhase: "play" };
    }
    case "drawDiscard": {
      const idx = state.discard.findIndex((c) => c.id === move.cardId);
      const taken = state.discard.slice(idx);
      return {
        ...state,
        discard: state.discard.slice(0, idx),
        hands: handsWith([...state.hands[seat], ...taken]),
        turnPhase: "play",
        // Taking just the top card carries no obligation; sweeping deeper means
        // the bottom card must be melded/laid off before discarding.
        mustMeldCardId: taken.length > 1 ? move.cardId : null
      };
    }
    case "meld": {
      const objs = move.cards.map((id) => state.hands[seat].find((c) => c.id === id));
      const newHand = state.hands[seat].filter((c) => !move.cards.includes(c.id));
      const kind = isSet(objs) ? "set" : "run";
      const meld = { id: state.nextMeldId, kind, cards: kind === "run" ? orderRunCards(objs) : objs };
      const cardOwner = { ...state.cardOwner };
      for (const id of move.cards) cardOwner[id] = seat;
      const ns = {
        ...state,
        hands: handsWith(newHand),
        melds: [...state.melds, meld],
        cardOwner,
        nextMeldId: state.nextMeldId + 1,
        mustMeldCardId: clears(move.cards)
      };
      return newHand.length === 0 ? endRound(ns, seat) : ns;
    }
    case "layoff": {
      const objs = move.cards.map((id) => state.hands[seat].find((c) => c.id === id));
      const newHand = state.hands[seat].filter((c) => !move.cards.includes(c.id));
      const melds = state.melds.map(
        (m) => m.id === move.meldId ? { ...m, cards: m.kind === "run" ? orderRunCards([...m.cards, ...objs]) : [...m.cards, ...objs] } : m
      );
      const cardOwner = { ...state.cardOwner };
      for (const id of move.cards) cardOwner[id] = seat;
      const ns = { ...state, hands: handsWith(newHand), melds, cardOwner, mustMeldCardId: clears(move.cards) };
      return newHand.length === 0 ? endRound(ns, seat) : ns;
    }
    case "discard": {
      const card = state.hands[seat].find((c) => c.id === move.cardId);
      const newHand = state.hands[seat].filter((c) => c.id !== move.cardId);
      const discard = [...state.discard, card];
      if (newHand.length === 0) return endRound({ ...state, hands: handsWith(newHand), discard }, seat);
      const ns = {
        ...state,
        hands: handsWith(newHand),
        discard,
        turn: (seat + 1) % state.players,
        turnPhase: "draw",
        mustMeldCardId: null
      };
      return ns.stock.length === 0 ? endRound(ns, null) : ns;
    }
  }
}
function applyMoveWithLog(state, move) {
  const next = applyMoveCore(state, move);
  return attachRummy(next, state.log, state.logSeq, rummyEntries(state, next, move));
}
function legalMoves2(state) {
  if (state.phase === "gameOver") return [];
  const seat = state.turn;
  const hand = state.hands[seat];
  const moves = [];
  if (state.turnPhase === "draw") {
    if (state.stock.length > 0) moves.push({ type: "drawStock", seat });
    const top = state.discard[state.discard.length - 1];
    if (top) moves.push({ type: "drawDiscard", seat, cardId: top.id });
    for (let i = 0; i < state.discard.length - 1; i++) {
      const target = state.discard[i];
      const taken = state.discard.slice(i);
      if (canFormMeldWith([...hand, ...taken], target) || canLayoff(state, target))
        moves.push({ type: "drawDiscard", seat, cardId: target.id });
    }
    return moves;
  }
  const set = findSet(hand);
  if (set) moves.push({ type: "meld", seat, cards: set.map((c) => c.id) });
  const run = findRun(hand);
  if (run) moves.push({ type: "meld", seat, cards: run.map((c) => c.id) });
  for (const m of state.melds)
    for (const c of hand) {
      const combined = [...m.cards, c];
      if (m.kind === "set" ? isSet(combined) : isRun(combined))
        moves.push({ type: "layoff", seat, meldId: m.id, cards: [c.id] });
    }
  if (state.mustMeldCardId == null) for (const c of hand) moves.push({ type: "discard", seat, cardId: c.id });
  return moves;
}
function redact2(state, seat, meta) {
  const toAct = state.phase === "gameOver" ? null : state.turn;
  const yours = seat !== null && toAct === seat;
  return {
    you: seat,
    players: state.players,
    phase: state.phase,
    target: state.target,
    seats: meta.seats,
    hostSeat: meta.hostSeat,
    botReplacement: meta.botReplacement,
    disconnectedSeats: meta.disconnectedSeats,
    scores: state.scores,
    winner: state.winner,
    dealerSeat: state.dealerSeat,
    toAct,
    turnPhase: state.turnPhase,
    yourTurn: yours,
    legalMoves: yours ? legalMoves2(state) : [],
    yourHand: seat !== null && state.hands[seat] ? state.hands[seat] : [],
    handCounts: state.hands.map((h) => h.length),
    stockCount: state.stock.length,
    discard: state.discard,
    melds: state.melds.map((m) => ({ id: m.id, kind: m.kind, owner: state.cardOwner[m.cards[0].id] ?? -1, cards: m.cards })),
    mustMeldCardId: yours ? state.mustMeldCardId : null,
    lastRound: state.lastRound,
    botDifficulty: state.botDifficulty,
    log: state.log
  };
}
function lobbyView(config, seat, meta) {
  const players = config.players;
  return {
    you: seat,
    players,
    phase: "lobby",
    target: config.target,
    seats: meta.seats,
    hostSeat: meta.hostSeat,
    botReplacement: meta.botReplacement,
    disconnectedSeats: meta.disconnectedSeats,
    scores: Array(players).fill(0),
    winner: null,
    dealerSeat: 0,
    toAct: null,
    turnPhase: "draw",
    yourTurn: false,
    legalMoves: [],
    yourHand: [],
    handCounts: Array(players).fill(0),
    stockCount: 0,
    discard: [],
    melds: [],
    mustMeldCardId: null,
    lastRound: null,
    botDifficulty: Array.from({ length: players }, (_, i) => config.botDifficulty?.[i] ?? 2),
    log: []
  };
}
var PERSONALITIES2 = [
  // 0 · Balanced — reliable execution, moderate risk tolerance
  { pickupThreshold: 6, earlyDiscount: 0.68, endgameHandSize: 3, dangerWeight: 1.8, misplayRate: 0.03 },
  // 1 · Aggressive — highest pile appetite, sharpest execution, rarely misplays
  { pickupThreshold: 3, earlyDiscount: 0.76, endgameHandSize: 2, dangerWeight: 0.8, misplayRate: 0.01 },
  // 2 · Conservative — very selective pickups, strongest danger avoidance, patient
  { pickupThreshold: 9, earlyDiscount: 0.65, endgameHandSize: 5, dangerWeight: 3.5, misplayRate: 0.02 },
  // 3 · Opportunist — erratic: swings between brilliance and blunder
  { pickupThreshold: 5, earlyDiscount: 0.6, endgameHandSize: 4, dangerWeight: 1.2, misplayRate: 0.05 }
];
var DIFFICULTY_TO_PERSONALITY = [2, 0, 1, 3];
function getPersonality(seat, state) {
  const difficulty = state.botDifficulty?.[seat] ?? 2;
  return PERSONALITIES2[DIFFICULTY_TO_PERSONALITY[difficulty]];
}
function roundProgress(state) {
  const deckSize = 54 * decksFor(state.players);
  const hs = handSize(state.players);
  const initialStock = Math.max(1, deckSize - state.players * hs - 1);
  return Math.min(1, Math.max(0, 1 - state.stock.length / initialStock));
}
function aiRng(state, seat) {
  const seed = (state.seed >>> 0 ^ seat * 2654435769 ^ state.logSeq * 1367130551) >>> 0;
  return mulberry323(seed);
}
function buildOpponentModel(state, seat) {
  const model = /* @__PURE__ */ new Map();
  for (let i = 0; i < state.players; i++) if (i !== seat) model.set(i, []);
  const fullDeck = buildDeck2(decksFor(state.players));
  const visibleIds = new Set(visibleCards(state, seat).map((c) => c.id));
  const unknownPool = fullDeck.filter((c) => !visibleIds.has(c.id));
  if (state.stock.length === 0 && unknownPool.length > 0) {
    const opponentSeats = Array.from({ length: state.players }, (_, i) => i).filter((i) => i !== seat);
    const totalOppCards = opponentSeats.reduce((s, i) => s + state.hands[i].length, 0);
    for (const opp of opponentSeats) {
      const fraction = totalOppCards > 0 ? state.hands[opp].length / totalOppCards : 0;
      model.set(opp, unknownPool.map((card) => ({ card, confidence: fraction })));
    }
    return model;
  }
  const totalEntries = state.log.length;
  for (const entry of state.log) {
    const opp = entry.seat;
    if (opp === null || opp === seat) continue;
    if (!model.has(opp)) continue;
    if (entry.msg !== "took" || !entry.cards || entry.cards.length === 0) continue;
    const lc3 = entry.cards[0];
    if ("joker" in lc3) continue;
    const { rank, suit } = lc3;
    const turnsAgo = totalEntries - entry.id;
    const recency = Math.max(0.1, 1 - turnsAgo / 30);
    const suspected = model.get(opp);
    for (const uc of unknownPool) {
      if (uc.joker) continue;
      let conf = 0;
      if (uc.rank === rank && uc.suit !== suit) conf = Math.max(conf, 0.45 * recency);
      const ucR = uc.rank === 14 ? 1 : uc.rank;
      const tR = rank === 14 ? 1 : rank;
      if (uc.suit === suit && Math.abs(ucR - tR) <= 2 && uc.rank !== rank) conf = Math.max(conf, 0.3 * recency);
      if (conf > 0) suspected.push({ card: uc, confidence: conf });
    }
  }
  for (const [opp, list] of model) {
    const best = /* @__PURE__ */ new Map();
    for (const s of list) {
      const prev = best.get(s.card.id);
      if (!prev || s.confidence > prev.confidence) best.set(s.card.id, s);
    }
    model.set(opp, [...best.values()]);
  }
  return model;
}
function opponentDangerWithModel(state, card, seat, model) {
  if (card.joker) return 0;
  let danger2 = 0;
  for (const m of state.melds) {
    const combined = [...m.cards, card];
    if (m.kind === "set" ? isSet(combined) : isRun(combined)) {
      danger2 += 4;
      break;
    }
  }
  const sameRankOnTable = state.melds.flatMap((m) => m.cards).filter((c) => !c.joker && c.rank === card.rank).length;
  if (sameRankOnTable >= 1) danger2 += 2;
  danger2 += Math.floor(cardValue(card) / 5);
  for (const suspected of model.values()) {
    let modelDanger = 0;
    for (const { card: sc, confidence } of suspected) {
      if (sc.joker) continue;
      if (sc.rank === card.rank) modelDanger = Math.max(modelDanger, confidence * 4);
      if (sc.suit === card.suit && Math.abs(sc.rank - card.rank) <= 2) modelDanger = Math.max(modelDanger, confidence * 3);
    }
    danger2 += modelDanger;
  }
  return Math.min(danger2, 10);
}
var naturalsOf = (hand) => hand.filter((c) => !c.joker);
var jokersOf = (hand) => hand.filter((c) => c.joker);
function uniqueBySuit(cards) {
  const seen = /* @__PURE__ */ new Map();
  for (const c of cards) if (!seen.has(c.suit)) seen.set(c.suit, c);
  return [...seen.values()];
}
function findSet(hand) {
  const jokers = jokersOf(hand);
  const byRank = /* @__PURE__ */ new Map();
  for (const c of naturalsOf(hand)) byRank.set(c.rank, [...byRank.get(c.rank) ?? [], c]);
  let bestG = null;
  for (const g of byRank.values()) {
    const unique = uniqueBySuit(g);
    if (unique.length >= 3) return unique.slice(0, 4);
    if (!bestG || unique.length > bestG.length) bestG = unique;
  }
  if (bestG && bestG.length >= 1 && bestG.length + jokers.length >= 3)
    return [...bestG, ...jokers.slice(0, 3 - bestG.length)];
  return null;
}
function findSetContaining(hand, c) {
  if (c.joker) return null;
  const seen = /* @__PURE__ */ new Map([[c.suit, c]]);
  for (const x of hand) if (!x.joker && x.rank === c.rank && !seen.has(x.suit)) seen.set(x.suit, x);
  const g = [...seen.values()];
  if (g.length >= 3) return g.slice(0, 4);
  const jokers = jokersOf(hand);
  if (g.length >= 1 && g.length + jokers.length >= 3) return [...g, ...jokers.slice(0, 3 - g.length)];
  return null;
}
function bestRunInSuit(naturals, jokers) {
  let best = null;
  let bestScore = -Infinity;
  for (const aceRank of [1, 14]) {
    const byRank = /* @__PURE__ */ new Map();
    for (const c of naturals) {
      const r = c.rank === 14 ? aceRank : c.rank;
      if (!byRank.has(r)) byRank.set(r, c);
    }
    if (!byRank.size) continue;
    for (let lo = 1; lo <= 12; lo++) {
      for (let hi = lo + 2; hi <= 14; hi++) {
        const span = hi - lo + 1;
        let nat = 0;
        for (let r = lo; r <= hi; r++) if (byRank.has(r)) nat++;
        const missing = span - nat;
        if (nat < 1 || missing > jokers.length) continue;
        const score = nat * 100 - missing;
        if (score <= bestScore) continue;
        const jk = [...jokers];
        const cards = [];
        for (let r = lo; r <= hi; r++) cards.push(byRank.has(r) ? byRank.get(r) : jk.shift());
        best = cards;
        bestScore = score;
      }
    }
  }
  return best;
}
function findRun(hand) {
  const jokers = jokersOf(hand);
  for (const s of SUITS) {
    const r = bestRunInSuit(hand.filter((c) => c.suit === s && !c.joker), jokers);
    if (r) return r;
  }
  return null;
}
function findRunContaining(hand, c) {
  if (c.joker) return null;
  const inSuit = hand.filter((x) => x.suit === c.suit && !x.joker);
  const jokers = jokersOf(hand);
  for (const aceRank of [1, 14]) {
    const byRank = /* @__PURE__ */ new Map();
    for (const x of inSuit) {
      const r = x.rank === 14 ? aceRank : x.rank;
      if (!byRank.has(r)) byRank.set(r, x);
    }
    const cr = c.rank === 14 ? aceRank : c.rank;
    byRank.set(cr, c);
    for (let lo = Math.max(1, cr - 2); lo <= cr; lo++) {
      for (let hi = cr; hi <= Math.min(14, cr + 2); hi++) {
        if (hi - lo + 1 < 3) continue;
        let nat = 0;
        for (let r = lo; r <= hi; r++) if (byRank.has(r)) nat++;
        const missing = hi - lo + 1 - nat;
        if (nat < 1 || missing > jokers.length) continue;
        const jk = [...jokers];
        const cards = [];
        for (let r = lo; r <= hi; r++) cards.push(byRank.has(r) ? byRank.get(r) : jk.shift());
        if (cards.includes(c)) return cards;
      }
    }
  }
  return null;
}
function layoffOnto(state, m, c, seat) {
  const combined = [...m.cards, c];
  const ok = m.kind === "set" ? isSet(combined) : isRun(combined);
  return ok ? { type: "layoff", seat, meldId: m.id, cards: [c.id] } : null;
}
function handPoints(hand) {
  return hand.reduce((s, c) => s + cardValue(c), 0);
}
function simulatePlayPoints(hand, melds) {
  let h = [...hand];
  for (let pass = 0; pass < 12; pass++) {
    const before = h.length;
    const set = findSet(h);
    if (set) {
      h = h.filter((c) => !set.includes(c));
      continue;
    }
    const run = findRun(h);
    if (run) {
      h = h.filter((c) => !run.includes(c));
      continue;
    }
    let laid = false;
    for (const m of melds) {
      for (const c of h) {
        const combined = [...m.cards, c];
        if (m.kind === "set" ? isSet(combined) : isRun(combined)) {
          h = h.filter((x) => x !== c);
          laid = true;
          break;
        }
      }
      if (laid) break;
    }
    if (!laid && h.length === before) break;
  }
  return handPoints(h);
}
function visibleCards(state, seat) {
  return [
    ...state.hands[seat],
    ...state.discard,
    ...state.melds.flatMap((m) => m.cards)
  ];
}
function unknownCount(state, seat) {
  return state.stock.length + state.hands.reduce((s, h, i) => i !== seat ? s + h.length : s, 0);
}
function probDraw(state, seat, rank, suit) {
  const totalDecks = decksFor(state.players);
  const seen = visibleCards(state, seat);
  const visibleCopies = seen.filter((c) => !c.joker && c.rank === rank && c.suit === suit).length;
  const remaining = Math.max(0, totalDecks - visibleCopies);
  if (remaining === 0) return 0;
  const unk = unknownCount(state, seat);
  return unk > 0 ? Math.min(1, remaining / unk) : 0;
}
function probEventually(pPerDraw, draws) {
  if (pPerDraw <= 0 || draws <= 0) return 0;
  return Math.min(1, 1 - Math.pow(1 - pPerDraw, draws));
}
function expectedFutureDraws(state, seat) {
  return Math.max(0, state.stock.length / state.players);
}
function cardMeldEV(state, seat, card) {
  if (card.joker) return cardValue(card);
  const hand = state.hands[seat];
  const draws = expectedFutureDraws(state, seat);
  const val = cardValue(card);
  const sameRankInHand = hand.filter((c) => !c.joker && c.rank === card.rank && c.id !== card.id);
  const jokersInHand = jokersOf(hand).length;
  let pSet = 0;
  if (sameRankInHand.length + jokersInHand >= 2) {
    pSet = 1;
  } else if (sameRankInHand.length === 1) {
    const usedSuits = /* @__PURE__ */ new Set([card.suit, sameRankInHand[0].suit]);
    let pOneMore = 0;
    for (const s of SUITS) if (!usedSuits.has(s)) pOneMore += probDraw(state, seat, card.rank, s);
    pSet = probEventually(pOneMore, draws);
  } else if (jokersInHand >= 1) {
    let pOneMore = 0;
    const usedSuits = /* @__PURE__ */ new Set([card.suit]);
    for (const s of SUITS) if (!usedSuits.has(s)) pOneMore += probDraw(state, seat, card.rank, s);
    pSet = probEventually(pOneMore, draws) * 0.7;
  }
  let pRun = 0;
  for (const aceRank of [1, 14]) {
    const cr = card.rank === 14 ? aceRank : card.rank;
    if (cr < 1 || cr > 14) continue;
    const byRank = /* @__PURE__ */ new Map();
    for (const c of hand) {
      if (c.joker || c.suit !== card.suit) continue;
      const r = c.rank === 14 ? aceRank : c.rank;
      byRank.set(r, true);
    }
    byRank.set(cr, true);
    for (let lo = Math.max(1, cr - 4); lo <= cr; lo++) {
      for (let hi = cr; hi <= Math.min(14, lo + 6); hi++) {
        if (hi - lo + 1 < 3) continue;
        const needed = [];
        for (let r = lo; r <= hi; r++) if (!byRank.has(r)) needed.push(r);
        const canFillWithJokers = needed.length <= jokersInHand;
        if (canFillWithJokers) {
          pRun = Math.max(pRun, 0.95);
          continue;
        }
        const stillNeed = needed.length - jokersInHand;
        if (stillNeed > 2) continue;
        let pAll = 1;
        for (const r of needed.slice(jokersInHand)) {
          pAll *= probEventually(probDraw(state, seat, r, card.suit), draws / Math.max(1, stillNeed));
        }
        pRun = Math.max(pRun, pAll * (hi - lo + 1 >= 4 ? 1 : 0.8));
      }
    }
  }
  const pMeld = Math.min(1, Math.max(pSet, pRun));
  return val * pMeld - val * (1 - pMeld);
}
function meldPotential(hand) {
  let score = 0;
  for (const c of hand) {
    if (c.joker) {
      score += 20;
      continue;
    }
    const sameRank = hand.filter((x) => !x.joker && x.rank === c.rank && x.id !== c.id).length;
    const inSuitAdj = hand.filter(
      (x) => !x.joker && x.suit === c.suit && x.id !== c.id && Math.abs(x.rank - c.rank) <= 2
    ).length;
    score += sameRank * 3 + inSuitAdj * 2;
  }
  return score;
}
function minOpponentHandSize(state, seat) {
  let min = Infinity;
  for (let i = 0; i < state.players; i++) {
    if (i !== seat) min = Math.min(min, state.hands[i].length);
  }
  return min === Infinity ? 99 : min;
}
function evaluateDeepPickup(state, seat, targetCardId, personality) {
  const discardPile = state.discard;
  const targetIdx = discardPile.findIndex((c) => c.id === targetCardId);
  if (targetIdx < 0) return { gain: -Infinity, cards: [] };
  const taken = discardPile.slice(targetIdx);
  const combined = [...state.hands[seat], ...taken];
  const leftoverPts = simulatePlayPoints(combined, state.melds);
  const handPts = handPoints(state.hands[seat]);
  const takenPts = taken.reduce((s, c) => s + cardValue(c), 0);
  const extraHeldPts = Math.max(0, leftoverPts - handPts);
  const progress2 = roundProgress(state);
  const discount = personality.earlyDiscount * (1 - progress2);
  const effectiveHeldPenalty = extraHeldPts * (1 - discount);
  const grossGain = takenPts - extraHeldPts;
  return { gain: grossGain - effectiveHeldPenalty, cards: taken };
}
function maybeMisplay(ranked, rng, misplayRate) {
  if (ranked.length <= 1 || rng() >= misplayRate) return ranked[0];
  const worstZone = ranked.slice(Math.max(1, Math.floor(ranked.length / 3)));
  return worstZone[Math.floor(rng() * worstZone.length)];
}
function speculativeTopValue(hand, top, state, personality) {
  if (top.joker) return 40;
  const progress2 = roundProgress(state);
  const futureDiscount = personality.earlyDiscount * (1 - progress2);
  const hypotheticalState = { ...state, hands: state.hands.map((h, i) => i === state.turn ? [...h, top] : h) };
  const mev = cardMeldEV(hypotheticalState, state.turn, top);
  return mev * (0.5 + futureDiscount * 0.5);
}
function allMeldsInHand(hand) {
  const melds = [];
  let remaining = [...hand];
  for (let pass = 0; pass < 20; pass++) {
    const run = findRun(remaining);
    const set = findSet(remaining);
    const runPts = run ? run.reduce((s, c) => s + cardValue(c), 0) : -1;
    const setPts = set ? set.reduce((s, c) => s + cardValue(c), 0) : -1;
    const pick2 = runPts >= setPts ? run : set;
    if (!pick2) break;
    melds.push(pick2);
    remaining = remaining.filter((c) => !pick2.includes(c));
  }
  return melds;
}
function evaluateGoOutSurprise(state, seat, personality, rng) {
  if (state.mustMeldCardId != null) return null;
  const hand = state.hands[seat];
  const meldGroups = allMeldsInHand(hand);
  if (meldGroups.length === 0) return null;
  const meldedIds = new Set(meldGroups.flatMap((g) => g.map((c) => c.id)));
  let remaining = hand.filter((c) => !meldedIds.has(c.id));
  for (const tm of state.melds) {
    for (const c of [...remaining]) {
      const combined = [...tm.cards, c];
      if (tm.kind === "set" ? isSet(combined) : isRun(combined)) {
        remaining = remaining.filter((x) => x !== c);
      }
    }
  }
  if (remaining.length === 0) return null;
  if (remaining.length > 3) return null;
  const remainingEV = remaining.reduce((s, c) => s + cardMeldEV(state, seat, c), 0);
  if (remainingEV <= 0) return null;
  const opponentHeld = state.hands.reduce(
    (s, h, i) => i !== seat ? s + h.reduce((hs, c) => hs + cardValue(c), 0) : s,
    0
  );
  const immediateScore = meldGroups.flat().reduce((s, c) => s + cardValue(c), 0);
  if (opponentHeld < immediateScore * 0.6) return null;
  if (minOpponentHandSize(state, seat) <= 3) return null;
  const gamblerFactor = (personality.earlyDiscount - 0.6) / 0.16;
  const gamblerProb = Math.max(0, Math.min(1, gamblerFactor));
  if (rng() > gamblerProb) return null;
  return meldedIds;
}
function aiMove2(state, seat) {
  const hand = state.hands[seat];
  const personality = getPersonality(seat, state);
  const opponentLow = minOpponentHandSize(state, seat) <= personality.endgameHandSize;
  const rng = aiRng(state, seat);
  const model = buildOpponentModel(state, seat);
  if (state.turnPhase === "draw") {
    const discard = state.discard;
    const top = discard[discard.length - 1];
    if (top && (canFormMeldWith([...hand, top], top) || canLayoff(state, top))) {
      if (rng() < personality.misplayRate && state.stock.length > 0)
        return { type: "drawStock", seat };
      return { type: "drawDiscard", seat, cardId: top.id };
    }
    if (!opponentLow && top) {
      const specScore = speculativeTopValue(hand, top, state, personality);
      if (specScore > 0) {
        if (rng() >= personality.misplayRate) return { type: "drawDiscard", seat, cardId: top.id };
      }
    }
    const deepAllowed = !opponentLow || personality.pickupThreshold <= 5;
    if (deepAllowed && discard.length >= 2) {
      let bestGain = personality.pickupThreshold;
      let bestTarget = null;
      for (let i = 0; i < discard.length - 1; i++) {
        const candidate = discard[i];
        const combined = [...hand, ...discard.slice(i)];
        if (!canFormMeldWith(combined, candidate) && !canLayoff(state, candidate)) continue;
        const { gain: gain2 } = evaluateDeepPickup(state, seat, candidate.id, personality);
        if (gain2 > bestGain) {
          bestGain = gain2;
          bestTarget = candidate;
        }
      }
      if (bestTarget) {
        if (rng() >= personality.misplayRate) return { type: "drawDiscard", seat, cardId: bestTarget.id };
      }
    }
    if (state.stock.length > 0) return { type: "drawStock", seat };
    if (top) return { type: "drawDiscard", seat, cardId: top.id };
    return { type: "drawStock", seat };
  }
  if (state.mustMeldCardId != null) {
    const mc = hand.find((c) => c.id === state.mustMeldCardId);
    if (mc) {
      const s2 = findSetContaining(hand, mc);
      if (s2) return { type: "meld", seat, cards: s2.map((c) => c.id) };
      const r2 = findRunContaining(hand, mc);
      if (r2) return { type: "meld", seat, cards: r2.map((c) => c.id) };
      for (const m of state.melds) {
        const lo = layoffOnto(state, m, mc, seat);
        if (lo) return lo;
      }
    }
  }
  const withheldIds = !opponentLow ? evaluateGoOutSurprise(state, seat, personality, rng) : null;
  if (withheldIds === null) {
    const allMelds = allMeldsInHand(hand);
    if (allMelds.length > 0) return { type: "meld", seat, cards: allMelds[0].map((c) => c.id) };
    const layoffCandidates = [];
    for (const m of state.melds) {
      for (const c of hand) {
        const lo = layoffOnto(state, m, c, seat);
        if (lo) layoffCandidates.push({ move: lo, value: cardValue(c) });
      }
    }
    if (layoffCandidates.length > 0) {
      layoffCandidates.sort((a, b) => {
        if (opponentLow) return b.value - a.value;
        const aCard = hand.find((c) => c.id === a.move.cards[0]);
        const bCard = hand.find((c) => c.id === b.move.cards[0]);
        const aPot = meldPotential([aCard, ...hand.filter((c) => c !== aCard)]);
        const bPot = meldPotential([bCard, ...hand.filter((c) => c !== bCard)]);
        return aPot - bPot;
      });
      return layoffCandidates[0].move;
    }
  }
  const discardPool = withheldIds ? hand.filter((c) => !withheldIds.has(c.id)) : hand;
  const discardSource = discardPool.length > 0 ? discardPool : hand;
  const discardRanked = discardSource.map((c) => {
    if (c.joker) return { card: c, score: -200 };
    const mev = cardMeldEV(state, seat, c);
    const danger2 = opponentDangerWithModel(state, c, seat, model);
    let score = -mev;
    score += danger2 * (opponentLow ? personality.dangerWeight * 0.5 : personality.dangerWeight);
    if (opponentLow) score += Math.max(0, -mev) * 0.5;
    return { card: c, score };
  }).sort((a, b) => b.score - a.score);
  const chosen = maybeMisplay(discardRanked, rng, personality.misplayRate);
  return { type: "discard", seat, cardId: chosen.card.id };
}
var rummy500Module = {
  meta: { id: "rummy-500", name: "Rummy 500", supportedPlayerCounts: [2, 3, 4, 5, 6, 7, 8] },
  botStepMs: 900,
  seatCount: (config) => config.players,
  createGame: createGame2,
  seatToAct,
  isLegal,
  legalMoves: legalMoves2,
  applyMove: applyMoveWithLog,
  isOver,
  redact: redact2,
  lobbyView,
  aiMove: aiMove2
  // no `aux`: Rummy has no non-turn side actions
};

// src/hearts-module.ts
var QUEEN = 12;
var isQueenOfSpades = (c) => c.suit === "S" && c.rank === QUEEN;
var isHeart = (c) => c.suit === "H";
var isPoint = (c) => isHeart(c) || isQueenOfSpades(c);
var cardPoints = (c) => isQueenOfSpades(c) ? 13 : isHeart(c) ? 1 : 0;
function removedFor(players) {
  if (players === 3) return [{ rank: 2, suit: "D" }];
  if (players === 5) return [{ rank: 2, suit: "D" }, { rank: 2, suit: "C" }];
  return [];
}
function buildDeck3(players) {
  const removed = removedFor(players);
  const isRemoved = (rank, suit) => removed.some((r) => r.rank === rank && r.suit === suit);
  const deck = [];
  let id = 0;
  for (const suit of SUITS)
    for (let rank = 2; rank <= 14; rank++) {
      if (isRemoved(rank, suit)) continue;
      deck.push({ id: id++, rank, suit });
    }
  return deck;
}
var handSize2 = (players) => buildDeck3(players).length / players;
var LOG_CAP3 = 120;
var lc = (c) => ({ rank: c.rank, suit: c.suit });
function passDirLabel(offset, players) {
  if (offset === 0) return "hold \u2014 no pass";
  if (offset === 1) return "passing left";
  if (offset === players - 1) return "passing right";
  return "passing across";
}
function attach2(next, prev, parts) {
  if (parts.length === 0) return { ...next, log: prev.log, logSeq: prev.logSeq };
  let seq = prev.logSeq;
  const added = parts.map((p) => ({ id: ++seq, ...p }));
  const log = [...prev.log, ...added].slice(-LOG_CAP3);
  return { ...next, log, logSeq: seq };
}
function mulberry324(seed) {
  let a = seed >>> 0;
  return () => {
    a = a + 1831565813 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function shuffle3(items, seed) {
  const rng = mulberry324(seed);
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  const nextSeed = Math.floor(rng() * 4294967295) >>> 0;
  return { shuffled: a, nextSeed };
}
function passOffsetFor(handNo, players) {
  const m = handNo % players;
  return m === players - 1 ? 0 : m + 1;
}
function lowestClubSeat(hands) {
  let bestSeat = 0;
  let bestRank = Infinity;
  for (let s = 0; s < hands.length; s++)
    for (const c of hands[s]) if (c.suit === "C" && c.rank < bestRank) {
      bestRank = c.rank;
      bestSeat = s;
    }
  return bestSeat;
}
function dealHand(prev) {
  const { shuffled, nextSeed } = shuffle3(buildDeck3(prev.players), prev.seed);
  const hands = Array.from({ length: prev.players }, () => []);
  const hs = handSize2(prev.players);
  let i = 0;
  for (let k = 0; k < hs; k++) for (let s = 0; s < prev.players; s++) hands[s].push(shuffled[i++]);
  const passOffset = passOffsetFor(prev.handNo, prev.players);
  const base = {
    ...prev,
    seed: nextSeed,
    hands,
    passOffset,
    selected: Array.from({ length: prev.players }, () => null),
    currentTrick: [],
    lastTrick: null,
    heartsBroken: false,
    trickNo: 0,
    points: Array(prev.players).fill(0),
    winner: null,
    leader: 0,
    // real leader set when play begins (after any pass)
    phase: "passing"
  };
  if (passOffset === 0) return { ...base, phase: "playing", leader: lowestClubSeat(hands) };
  return base;
}
function createGame3(config, seed) {
  if (![3, 4, 5].includes(config.players)) throw new Error(`Unsupported player count: ${config.players}`);
  if (config.target <= 0) throw new Error("Target must be positive");
  const base = {
    players: config.players,
    target: config.target,
    seed,
    phase: "passing",
    handNo: 0,
    passOffset: 0,
    hands: [],
    selected: [],
    leader: 0,
    currentTrick: [],
    lastTrick: null,
    heartsBroken: false,
    trickNo: 0,
    points: Array(config.players).fill(0),
    scores: Array(config.players).fill(0),
    winner: null,
    lastHand: null,
    log: [],
    logSeq: 0
  };
  const dealt = dealHand(base);
  return attach2(dealt, dealt, [{ seat: null, msg: `first hand \u2014 ${passDirLabel(dealt.passOffset, dealt.players)}` }]);
}
function legalPlays(state, seat) {
  const hand = state.hands[seat];
  const firstTrick = state.trickNo === 0;
  const leading = state.currentTrick.length === 0;
  if (leading) {
    if (firstTrick) {
      const clubs = hand.filter((c) => c.suit === "C");
      const lead = clubs.reduce((lo, c) => c.rank < lo.rank ? c : lo, clubs[0]);
      return lead ? [lead] : hand.slice();
    }
    if (!state.heartsBroken) {
      const nonHearts = hand.filter((c) => !isHeart(c));
      if (nonHearts.length) return nonHearts;
    }
    return hand.slice();
  }
  const ledSuit = state.currentTrick[0].card.suit;
  const inSuit = hand.filter((c) => c.suit === ledSuit);
  let candidates = inSuit.length ? inSuit : hand.slice();
  if (firstTrick) {
    const nonPoints = candidates.filter((c) => !isPoint(c));
    if (nonPoints.length) candidates = nonPoints;
  }
  return candidates;
}
var seatToAct2 = (s) => {
  if (s.phase === "gameOver") return null;
  if (s.phase === "passing") {
    const idx = s.selected.findIndex((sel) => sel === null);
    return idx === -1 ? null : idx;
  }
  return (s.leader + s.currentTrick.length) % s.players;
};
var isOver2 = (s) => s.phase === "gameOver";
function isLegal2(state, move) {
  if (state.phase === "gameOver") return false;
  if (seatToAct2(state) !== move.seat) return false;
  if (move.type === "pass") {
    if (state.phase !== "passing" || state.passOffset === 0) return false;
    if (state.selected[move.seat] !== null) return false;
    const ids = move.cards;
    if (!ids || ids.length !== 3 || new Set(ids).size !== 3) return false;
    const hand = state.hands[move.seat];
    return ids.every((id) => hand.some((c) => c.id === id));
  }
  if (state.phase !== "playing") return false;
  const card = state.hands[move.seat].find((c) => c.id === move.card);
  if (!card) return false;
  return legalPlays(state, move.seat).some((c) => c.id === move.card);
}
function trickWinner2(cards) {
  const ledSuit = cards[0].card.suit;
  let best = cards[0];
  for (const p of cards) if (p.card.suit === ledSuit && p.card.rank > best.card.rank) best = p;
  return best.seat;
}
function endHand(state) {
  const points = state.points;
  const moon = points.findIndex((p) => p === 26);
  const delta = moon >= 0 ? points.map((_, s) => s === moon ? 0 : 26) : points.slice();
  const scores = state.scores.map((v, s) => v + delta[s]);
  const lastHand = { delta, shooter: moon >= 0 ? moon : null };
  if (Math.max(...scores) >= state.target) {
    const min = Math.min(...scores);
    return { ...state, scores, phase: "gameOver", winner: scores.indexOf(min), lastHand };
  }
  return dealHand({ ...state, scores, lastHand, handNo: state.handNo + 1 });
}
function applyMove2(state, move) {
  if (state.phase === "gameOver") throw new Error("Game is over");
  if (seatToAct2(state) !== move.seat) throw new Error("Not this seat's turn");
  if (!isLegal2(state, move)) throw new Error(`Illegal move: ${JSON.stringify(move)}`);
  const ent = [];
  if (move.type === "pass") {
    const selected = state.selected.map((sel, s) => s === move.seat ? move.cards.slice() : sel);
    const everyone = selected.every((sel) => sel !== null);
    ent.push({ seat: move.seat, msg: "passed 3 cards" });
    if (!everyone) return attach2({ ...state, selected }, state, ent);
    const offset = state.passOffset;
    const N = state.players;
    const given = selected.map((ids, s) => ids.map((id) => state.hands[s].find((c) => c.id === id)));
    const hands2 = state.hands.map((h, s) => h.filter((c) => !selected[s].includes(c.id)));
    for (let s = 0; s < N; s++) {
      const giver = (s - offset + N) % N;
      hands2[s].push(...given[giver]);
    }
    const leader = lowestClubSeat(hands2);
    ent.push({ seat: null, msg: `cards exchanged \u2014 ${passDirLabel(offset, N)}` });
    ent.push({ seat: leader, msg: "leads with the lowest club" });
    return attach2(
      { ...state, hands: hands2, selected: Array.from({ length: N }, () => null), phase: "playing", leader },
      state,
      ent
    );
  }
  const seat = move.seat;
  const card = state.hands[seat].find((c) => c.id === move.card);
  const hands = state.hands.map((h, s) => s === seat ? h.filter((c) => c.id !== move.card) : h);
  const currentTrick = [...state.currentTrick, { seat, card }];
  const heartsBroken = state.heartsBroken || isHeart(card);
  ent.push({ seat, msg: "played", cards: [lc(card)] });
  if (!state.heartsBroken && isHeart(card)) ent.push({ seat: null, msg: "hearts are broken" });
  if (currentTrick.length < state.players) {
    return attach2({ ...state, hands, currentTrick, heartsBroken }, state, ent);
  }
  const winner = trickWinner2(currentTrick);
  const won = currentTrick.reduce((a, p) => a + cardPoints(p.card), 0);
  const points = state.points.map((v, s) => s === winner ? v + won : v);
  const trickNo = state.trickNo + 1;
  ent.push({ seat: winner, msg: "takes the trick", tail: won > 0 ? `+${won}` : void 0 });
  const ns = {
    ...state,
    hands,
    heartsBroken,
    currentTrick: [],
    lastTrick: { cards: currentTrick, winner },
    leader: winner,
    trickNo,
    points
  };
  if (trickNo !== handSize2(state.players)) return attach2(ns, state, ent);
  const scored = endHand(ns);
  const moon = ns.points.findIndex((p) => p === 26);
  if (moon >= 0) {
    ent.push({ seat: moon, msg: "shoots the moon! \u2014 everyone else +26" });
  } else {
    const delta = scored.lastHand ? scored.lastHand.delta : ns.points;
    for (let s = 0; s < ns.players; s++) if (delta[s] > 0) ent.push({ seat: s, msg: `+${delta[s]} this hand` });
  }
  ent.push({ seat: null, msg: `scores: ${scored.scores.join(" / ")}` });
  if (scored.phase === "gameOver" && scored.winner !== null) {
    ent.push({ seat: scored.winner, msg: "wins the game \u2014 lowest score!" });
  } else {
    ent.push({ seat: null, msg: `next hand \u2014 ${passDirLabel(scored.passOffset, scored.players)}` });
  }
  return attach2(scored, state, ent);
}
function legalMoves3(state) {
  if (state.phase !== "playing") return [];
  const seat = seatToAct2(state);
  if (seat === null) return [];
  return legalPlays(state, seat).map((c) => ({ type: "play", seat, card: c.id }));
}
function redact3(state, seat, meta) {
  const toAct = seatToAct2(state);
  const yours = seat !== null && toAct === seat;
  return {
    you: seat,
    players: state.players,
    phase: state.phase,
    target: state.target,
    seats: meta.seats,
    hostSeat: meta.hostSeat,
    botReplacement: meta.botReplacement,
    disconnectedSeats: meta.disconnectedSeats,
    scores: state.scores,
    winner: state.winner,
    handNo: state.handNo,
    passOffset: state.passOffset,
    toAct,
    yourTurn: yours,
    legalMoves: yours && state.phase === "playing" ? legalMoves3(state) : [],
    yourHand: seat !== null && state.hands[seat] ? state.hands[seat] : [],
    handCounts: state.hands.map((h) => h.length),
    youPassed: seat !== null && state.selected[seat] != null,
    leader: state.leader,
    currentTrick: state.currentTrick,
    lastTrick: state.lastTrick,
    heartsBroken: state.heartsBroken,
    trickNo: state.trickNo,
    points: state.points,
    lastHand: state.lastHand,
    log: state.log
  };
}
function lobbyView2(config, seat, meta) {
  return {
    you: seat,
    players: config.players,
    phase: "lobby",
    target: config.target,
    seats: meta.seats,
    hostSeat: meta.hostSeat,
    scores: Array(config.players).fill(0),
    winner: null,
    handNo: 0,
    passOffset: 0,
    toAct: null,
    yourTurn: false,
    legalMoves: [],
    yourHand: [],
    handCounts: Array(config.players).fill(0),
    youPassed: false,
    leader: 0,
    currentTrick: [],
    lastTrick: null,
    heartsBroken: false,
    trickNo: 0,
    points: Array(config.players).fill(0),
    lastHand: null,
    log: []
  };
}
function danger(c) {
  if (isQueenOfSpades(c)) return 1e3;
  if (c.suit === "S" && c.rank >= 13) return 500 + c.rank;
  if (isHeart(c)) return 100 + c.rank;
  return c.rank;
}
function aiPass(state, seat) {
  const hand = state.hands[seat];
  const cards = [...hand].sort((a, b) => danger(b) - danger(a)).slice(0, 3);
  return { type: "pass", seat, cards: cards.map((c) => c.id) };
}
function aiPlay(state, seat) {
  const legal = legalPlays(state, seat);
  const play = (c) => ({ type: "play", seat, card: c.id });
  const lowestBy = (cards, key) => cards.reduce((lo, c) => key(c) < key(lo) ? c : lo, cards[0]);
  const highestBy = (cards, key) => cards.reduce((hi, c) => key(c) > key(hi) ? c : hi, cards[0]);
  if (state.currentTrick.length === 0) {
    const nonHearts = legal.filter((c) => !isHeart(c));
    const pool = nonHearts.length ? nonHearts : legal;
    return play(lowestBy(pool, (c) => c.rank));
  }
  const ledSuit = state.currentTrick[0].card.suit;
  const inSuit = legal.filter((c) => c.suit === ledSuit);
  if (inSuit.length) {
    const curWin = state.currentTrick.filter((p) => p.card.suit === ledSuit).reduce((hi, p) => p.card.rank > hi.card.rank ? p : hi, state.currentTrick[0]);
    const losing = inSuit.filter((c) => c.rank < curWin.card.rank);
    if (losing.length) return play(highestBy(losing, (c) => c.rank));
    return play(lowestBy(inSuit, (c) => c.rank));
  }
  return play(highestBy(legal, danger));
}
function aiMove3(state, seat) {
  if (state.phase === "gameOver") throw new Error("game is over");
  if (seatToAct2(state) !== seat) throw new Error(`not seat ${seat}'s turn`);
  return state.phase === "passing" ? aiPass(state, seat) : aiPlay(state, seat);
}
var heartsModule = {
  meta: { id: "hearts", name: "Hearts", supportedPlayerCounts: [3, 4, 5] },
  botStepMs: 400,
  seatCount: (config) => config.players,
  createGame: createGame3,
  seatToAct: seatToAct2,
  isLegal: isLegal2,
  legalMoves: legalMoves3,
  applyMove: applyMove2,
  isOver: isOver2,
  redact: redact3,
  lobbyView: lobbyView2,
  aiMove: aiMove3
  // no `aux`: Hearts has no non-turn side actions
};

// src/pj-module.ts
var HPS = 12;
var HAND = 5;
var SUPPORTED = [4, 6];
var ringSize = (players) => players * HPS;
var teamOf2 = (p) => p % 2;
var teammatesOf = (p, players) => {
  const out = [];
  for (let q = 0; q < players; q++) if (q !== p && teamOf2(q) === teamOf2(p)) out.push(q);
  return out;
};
var castleEntry = (p) => p * HPS + (HPS >> 1);
var exitHole = (p, players) => (castleEntry(p) + 1) % ringSize(players);
var isJokerCard = (c) => "joker" in c;
var stepsOf = (c) => isJokerCard(c) ? 0 : c.rank === 14 ? 1 : c.rank;
var isComeOutCard = (c) => isJokerCard(c) || !isJokerCard(c) && (c.rank === 14 || c.rank === 13);
function buildDeck4() {
  const deck = [];
  let id = 0;
  for (let d = 0; d < 2; d++) for (const suit of SUITS) for (let rank = 2; rank <= 14; rank++) deck.push({ id: id++, rank, suit });
  for (let j = 0; j < 4; j++) deck.push({ id: id++, joker: true });
  return deck;
}
function mulberry325(seed) {
  let a = seed >>> 0;
  return () => {
    a = a + 1831565813 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function shuffle4(items, seed) {
  const rng = mulberry325(seed);
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return { shuffled: a, nextSeed: Math.floor(rng() * 4294967295) >>> 0 };
}
function progress(owner, loc, players) {
  if (loc.z === "start") return -1;
  const R = ringSize(players);
  if (loc.z === "ring") return (loc.r - exitHole(owner, players) + R) % R;
  return R + loc.i;
}
function locAtProgress(owner, prog, players) {
  const R = ringSize(players);
  return prog < R ? { z: "ring", r: (exitHole(owner, players) + prog) % R } : { z: "castle", i: prog - R };
}
function boardLayout(players, marbles) {
  const W = 100;
  const ti = 8;
  const H = players === 6 ? 2 * W - 2 * ti : 100;
  const cx = W / 2, cy = H / 2;
  const half = (H - 2 * ti) / 2;
  const runs = players === 4 ? [
    (t) => ({ x: ti + t * (W - 2 * ti), y: ti }),
    // top  L->R
    (t) => ({ x: W - ti, y: ti + t * (H - 2 * ti) }),
    // right T->B
    (t) => ({ x: W - ti - t * (W - 2 * ti), y: H - ti }),
    // bottom R->L
    (t) => ({ x: ti, y: H - ti - t * (H - 2 * ti) })
    // left  B->T
  ] : [
    (t) => ({ x: ti + t * (W - 2 * ti), y: ti }),
    // S0 top
    (t) => ({ x: W - ti, y: ti + t * half }),
    // S1 right-upper
    (t) => ({ x: W - ti, y: ti + half + t * half }),
    // S2 right-lower
    (t) => ({ x: W - ti - t * (W - 2 * ti), y: H - ti }),
    // S3 bottom
    (t) => ({ x: ti, y: H - ti - t * half }),
    // S4 left-lower
    (t) => ({ x: ti, y: H - ti - half - t * half })
    // S5 left-upper
  ];
  const ring = [];
  for (let p = 0; p < players; p++) for (let j = 0; j < HPS; j++) ring.push(runs[p]((j + 0.5) / HPS));
  const castles = [];
  const starts = [];
  const seams = [];
  const railSpacing = (W - 2 * ti) / HPS;
  const S2 = 1 / Math.SQRT2;
  const corners4 = [
    { x: W - ti, y: ti, dx: -S2, dy: S2 },
    // top-right → SW
    { x: W - ti, y: H - ti, dx: -S2, dy: -S2 },
    // bottom-right → NW
    { x: ti, y: H - ti, dx: S2, dy: -S2 },
    // bottom-left → NE
    { x: ti, y: ti, dx: S2, dy: S2 }
    // top-left → SE
  ];
  const cstep4 = 4.8;
  const castleGap4 = 6.5;
  for (let p = 0; p < players; p++) {
    const cm = ring[castleEntry(p)];
    const dx = cx - cm.x, dy = cy - cm.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const ax = -uy, ay = ux;
    const reach = len * 0.6;
    const cstep = reach / (marbles + 0.5);
    const cas = [];
    if (players === 4) {
      const c = corners4[p];
      for (let j = 0; j < marbles; j++) cas.push({ x: c.x + c.dx * (castleGap4 + cstep4 * (j + 1)), y: c.y + c.dy * (castleGap4 + cstep4 * (j + 1)) });
    } else {
      for (let j = 0; j < marbles; j++) cas.push({ x: cm.x + ux * cstep * (j + 1), y: cm.y + uy * cstep * (j + 1) });
    }
    castles.push(cas);
    const ex = ring[exitHole(p, players)];
    const rowSp = 4.5, colSp = 3.6;
    const row0n = Math.ceil(marbles / 2), row1n = Math.floor(marbles / 2);
    const st = [];
    for (let row = 0; row < 2; row++) {
      const n = row === 0 ? row0n : row1n;
      const inset = 9.5 + row * rowSp;
      for (let col = 0; col < n; col++) {
        const along = colSp * (col - (n - 1) / 2);
        st.push({ x: ex.x + ux * inset + ax * along, y: ex.y + uy * inset + ay * along });
      }
    }
    starts.push(st);
    seams.push(runs[p](0));
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
    castleArmStarts: players === 4 ? corners4.map((c) => ({ x: c.x, y: c.y })) : Array.from({ length: players }, (_, p) => ring[castleEntry(p)]),
    seams
  };
}
function ringOccupant(state, r) {
  for (let p = 0; p < state.players; p++)
    for (let i = 0; i < state.marbles; i++) {
      const l = state.pos[p][i];
      if (l.z === "ring" && l.r === r) return { owner: p, idx: i };
    }
  return null;
}
function castleOccupied(state, owner, i) {
  return state.pos[owner].some((l) => l.z === "castle" && l.i === i);
}
function firstEmptyStart(state, owner) {
  const used = new Set(state.pos[owner].filter((l) => l.z === "start").map((l) => l.i));
  for (let i = 0; i < state.marbles; i++) if (!used.has(i)) return i;
  return 0;
}
var allHome = (state, owner) => state.pos[owner].every((l) => l.z === "castle");
function movableOwners(state, seat) {
  if (!allHome(state, seat)) return [seat];
  const helping = teammatesOf(seat, state.players).filter((q) => !allHome(state, q));
  return helping.length ? helping : [seat];
}
function ordinaryEffect(state, ref, steps) {
  const loc = state.pos[ref.owner][ref.idx];
  if (loc.z === "start") return null;
  const prog = progress(ref.owner, loc, state.players);
  const np = prog + steps;
  if (steps <= 0 || np > ringSize(state.players) + state.marbles - 1) return null;
  const to = locAtProgress(ref.owner, np, state.players);
  if (to.z === "ring") {
    const occ = ringOccupant(state, to.r);
    if (occ && teamOf2(occ.owner) === teamOf2(ref.owner)) return null;
    return { from: loc, to, bump: occ && teamOf2(occ.owner) !== teamOf2(ref.owner) ? occ : null };
  }
  if (castleOccupied(state, ref.owner, to.i)) return null;
  return { from: loc, to, bump: null };
}
function comeOutEffect(state, ref) {
  const loc = state.pos[ref.owner][ref.idx];
  if (loc.z !== "start") return null;
  const r = exitHole(ref.owner, state.players);
  const occ = ringOccupant(state, r);
  if (occ && teamOf2(occ.owner) === teamOf2(ref.owner)) return null;
  return { from: loc, to: { z: "ring", r }, bump: occ ?? null };
}
function jokerEffect(state, ref, target) {
  const loc = state.pos[ref.owner][ref.idx];
  if (loc.z === "castle") return null;
  const occ = ringOccupant(state, target);
  if (!occ || teamOf2(occ.owner) === teamOf2(ref.owner)) return null;
  return { from: loc, to: { z: "ring", r: target }, bump: occ };
}
function legalBoardMoves(state) {
  const seat = state.turn;
  const owners = movableOwners(state, seat);
  const out = [];
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
    if (isComeOutCard(card)) {
      for (const owner of owners)
        for (let idx = 0; idx < state.marbles; idx++)
          if (comeOutEffect(state, { owner, idx })) out.push({ type: "comeOut", seat, cardId, marble: { owner, idx } });
    }
    for (const owner of owners)
      for (let idx = 0; idx < state.marbles; idx++)
        if (ordinaryEffect(state, { owner, idx }, steps)) out.push({ type: "move", seat, cardId, marble: { owner, idx }, steps });
    if (!isJokerCard(card) && card.rank === 7) {
      const refs = [];
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
function legalMoves4(state) {
  if (state.phase !== "playing") return [];
  const board = legalBoardMoves(state);
  if (board.length) return board;
  return state.hands[state.turn].map((c) => ({ type: "forfeit", seat: state.turn, cardId: c.id }));
}
var moveEq3 = (a, b) => JSON.stringify(a) === JSON.stringify(b);
var seatToAct3 = (s) => s.phase === "gameOver" ? null : s.turn;
var isOver3 = (s) => s.phase === "gameOver";
function isLegal3(state, move) {
  return state.phase === "playing" && move.seat === state.turn && legalMoves4(state).some((m) => moveEq3(m, move));
}
var LOG_CAP4 = 120;
var teamLetter2 = (t) => t === 0 ? "A" : "B";
var lc2 = (c) => isJokerCard(c) ? { joker: true } : { rank: c.rank, suit: c.suit };
function describePlay(move) {
  switch (move.type) {
    case "forfeit":
      return { msg: "forfeits \u2014 no legal play" };
    case "comeOut":
      return { msg: "brings a marble out" };
    case "joker":
      return { msg: "plays a joker" };
    case "split7":
      return { msg: "splits the seven" };
    case "move":
      return { msg: "plays", tail: `${move.steps} step${Math.abs(move.steps) === 1 ? "" : "s"}` };
  }
}
function attach3(next, prev, parts) {
  if (parts.length === 0) return { ...next, log: prev.log, logSeq: prev.logSeq };
  let seq = prev.logSeq;
  const added = parts.map((p) => ({ id: ++seq, ...p }));
  const log = [...prev.log, ...added].slice(-LOG_CAP4);
  return { ...next, log, logSeq: seq };
}
function applyEffect(state, ref, eff) {
  const pos = state.pos.map((row) => row.slice());
  pos[ref.owner][ref.idx] = eff.to;
  if (eff.bump) pos[eff.bump.owner][eff.bump.idx] = { z: "start", i: firstEmptyStart(state, eff.bump.owner) };
  return { ...state, pos };
}
function drawUp(state) {
  let { stock, discard, seed } = state;
  const hands = state.hands.map((h) => h.slice());
  const seat = state.turn;
  while (hands[seat].length < HAND) {
    if (stock.length === 0) {
      if (discard.length === 0) break;
      const sh = shuffle4(discard, seed);
      stock = sh.shuffled;
      seed = sh.nextSeed;
      discard = [];
    }
    hands[seat].push(stock[stock.length - 1]);
    stock = stock.slice(0, -1);
  }
  return { ...state, hands, stock, discard, seed };
}
function finishTurn(state, cardId, bump) {
  const seat = state.turn;
  const card = state.hands[seat].find((c) => c.id === cardId);
  const hands = state.hands.map((h, s) => s === seat ? h.filter((c) => c.id !== cardId) : h);
  let ns = { ...state, hands, discard: [...state.discard, card], lastBump: bump };
  const myTeam = teamOf2(seat);
  const teamHome = (t) => {
    for (let p = 0; p < ns.players; p++) if (teamOf2(p) === t && !allHome(ns, p)) return false;
    return true;
  };
  if (teamHome(myTeam)) return { ...ns, phase: "gameOver", winner: myTeam };
  ns = drawUp(ns);
  return { ...ns, turn: (seat + 1) % ns.players };
}
function applyMove3(state, move) {
  if (state.phase !== "playing") throw new Error("Game is over");
  if (seatToAct3(state) !== move.seat) throw new Error("Not this seat's turn");
  if (!isLegal3(state, move)) throw new Error(`Illegal move: ${JSON.stringify(move)}`);
  const seat = move.seat;
  const card = state.hands[seat].find((c) => c.id === move.cardId);
  const homeBefore = state.pos[seat].filter((l) => l.z === "castle").length;
  let ns = state;
  let bump = null;
  const note = (owner, eff) => {
    if (eff.bump) bump = { by: teamOf2(owner), victim: teamOf2(eff.bump.owner) };
  };
  if (move.type === "move") {
    const eff = ordinaryEffect(ns, move.marble, move.steps);
    note(move.marble.owner, eff);
    ns = applyEffect(ns, move.marble, eff);
  } else if (move.type === "comeOut") {
    const eff = comeOutEffect(ns, move.marble);
    note(move.marble.owner, eff);
    ns = applyEffect(ns, move.marble, eff);
  } else if (move.type === "joker") {
    const eff = jokerEffect(ns, move.marble, move.target);
    note(move.marble.owner, eff);
    ns = applyEffect(ns, move.marble, eff);
  } else if (move.type === "split7") {
    const e1 = ordinaryEffect(ns, move.a.marble, move.a.steps);
    note(move.a.marble.owner, e1);
    ns = applyEffect(ns, move.a.marble, e1);
    const e2 = ordinaryEffect(ns, move.b.marble, move.b.steps);
    note(move.b.marble.owner, e2);
    ns = applyEffect(ns, move.b.marble, e2);
  }
  const done = finishTurn(ns, move.cardId, bump);
  const d = describePlay(move);
  const ent = [{ seat, msg: d.msg, cards: [lc2(card)], tail: d.tail }];
  const homeAfter = done.pos[seat].filter((l) => l.z === "castle").length;
  if (homeAfter > homeBefore) {
    ent.push({ seat, msg: `marble${homeAfter - homeBefore > 1 ? "s" : ""} home (${homeAfter}/${done.marbles})` });
  }
  if (bump) {
    const b = bump;
    ent.push({ seat: null, msg: `Team ${teamLetter2(b.by)} sends a Team ${teamLetter2(b.victim)} marble back to start` });
  }
  if (done.phase === "gameOver" && done.winner !== null) {
    ent.push({ seat: null, msg: `Team ${teamLetter2(done.winner)} brings every marble home \u2014 wins the game!` });
  }
  return attach3(done, state, ent);
}
function createGame4(config, seed) {
  if (!SUPPORTED.includes(config.players)) throw new Error(`Pegs and Jokers supports ${SUPPORTED.join("/")} players (got ${config.players})`);
  const marbles = config.marbles;
  if (marbles < 2 || marbles > 5) throw new Error(`Unsupported marble count: ${marbles}`);
  const players = config.players;
  const { shuffled, nextSeed } = shuffle4(buildDeck4(), seed);
  const hands = Array.from({ length: players }, () => []);
  let i = 0;
  for (let k = 0; k < HAND; k++) for (let s = 0; s < players; s++) hands[s].push(shuffled[i++]);
  const stock = shuffled.slice(i);
  const pos = Array.from({ length: players }, () => Array.from({ length: marbles }, (_, idx) => ({ z: "start", i: idx })));
  const base = { players, marbles, seed: nextSeed, phase: "playing", turn: 0, pos, hands, stock, discard: [], winner: null, lastBump: null, log: [], logSeq: 0 };
  return attach3(base, base, [{ seat: null, msg: "new game \u2014 come out with an Ace, King, or Joker" }]);
}
function pegs(state) {
  const out = [];
  for (let p = 0; p < state.players; p++) for (let idx = 0; idx < state.marbles; idx++) out.push({ owner: p, idx, team: teamOf2(p), loc: state.pos[p][idx] });
  return out;
}
function redact4(state, seat, meta) {
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
    yourTeam: seat !== null ? teamOf2(seat) : null,
    playingFor: yours ? movableOwners(state, seat) : [],
    board: boardLayout(state.players, state.marbles),
    pegs: pegs(state),
    yourHand: seat !== null && state.hands[seat] ? state.hands[seat] : [],
    handCounts: state.hands.map((h) => h.length),
    stockCount: state.stock.length,
    discardCount: state.discard.length,
    legalMoves: yours ? legalMoves4(state) : [],
    homeCounts: state.pos.map((row) => row.filter((l) => l.z === "castle").length),
    winner: state.winner,
    lastBump: state.lastBump,
    log: state.log
  };
}
function lobbyView3(config, seat, meta) {
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
    yourTeam: seat !== null ? teamOf2(seat) : null,
    playingFor: [],
    board: boardLayout(config.players, config.marbles),
    pegs: Array.from(
      { length: config.players },
      (_, p) => Array.from({ length: config.marbles }, (_2, idx) => ({ owner: p, idx, team: teamOf2(p), loc: { z: "start", i: idx } }))
    ).flat(),
    yourHand: [],
    handCounts: Array(config.players).fill(0),
    stockCount: 0,
    discardCount: 0,
    legalMoves: [],
    homeCounts: Array(config.players).fill(0),
    winner: null,
    lastBump: null,
    log: []
  };
}
var HOME_BONUS = 40;
var COMEOUT_BONUS = 12;
var BUMP_WEIGHT = 0.5;
function progAfter(owner, loc, players) {
  if (loc.z === "start") return 0;
  if (loc.z === "ring") return 1 + progress(owner, loc, players);
  return 1 + ringSize(players) + loc.i + HOME_BONUS;
}
function gain(owner, from, to, players) {
  return progAfter(owner, to, players) - progAfter(owner, from, players);
}
function moveScore(state, m) {
  const P = state.players;
  if (m.type === "forfeit") return -1e3;
  if (m.type === "comeOut") {
    const e2 = comeOutEffect(state, m.marble);
    return COMEOUT_BONUS + gain(m.marble.owner, e2.from, e2.to, P) + (e2.bump ? BUMP_WEIGHT * progAfter(e2.bump.owner, e2.from, P) : 0);
  }
  if (m.type === "joker") {
    const e2 = jokerEffect(state, m.marble, m.target);
    return gain(m.marble.owner, e2.from, e2.to, P) + BUMP_WEIGHT * (1 + progAfter(e2.bump.owner, { z: "ring", r: m.target }, P));
  }
  if (m.type === "split7") {
    const e1 = ordinaryEffect(state, m.a.marble, m.a.steps);
    const s1 = gain(m.a.marble.owner, e1.from, e1.to, P) + (e1.bump ? BUMP_WEIGHT * progAfter(e1.bump.owner, e1.from, P) : 0);
    const mid = applyEffect(state, m.a.marble, e1);
    const e2 = ordinaryEffect(mid, m.b.marble, m.b.steps);
    return s1 + gain(m.b.marble.owner, e2.from, e2.to, P) + (e2.bump ? BUMP_WEIGHT * progAfter(e2.bump.owner, e2.from, P) : 0);
  }
  const e = ordinaryEffect(state, m.marble, m.steps);
  return gain(m.marble.owner, e.from, e.to, P) + (e.bump ? BUMP_WEIGHT * progAfter(e.bump.owner, e.from, P) : 0);
}
function aiMove4(state, seat) {
  if (state.phase === "gameOver") throw new Error("game is over");
  if (state.turn !== seat) throw new Error(`not seat ${seat}'s turn`);
  const moves = legalMoves4(state);
  let best = moves[0];
  let bestScore = -Infinity;
  for (const m of moves) {
    const sc = moveScore(state, m);
    if (sc > bestScore) {
      bestScore = sc;
      best = m;
    }
  }
  return best;
}
var pegsAndJokersModule = {
  meta: { id: "pegs-and-jokers", name: "Pegs and Jokers", supportedPlayerCounts: SUPPORTED },
  seatCount: (config) => config.players,
  createGame: createGame4,
  seatToAct: seatToAct3,
  isLegal: isLegal3,
  legalMoves: legalMoves4,
  applyMove: applyMove3,
  isOver: isOver3,
  redact: redact4,
  lobbyView: lobbyView3,
  aiMove: aiMove4
};

// src/client-local.ts
var REGISTRY = {
  rummy500: { game: rummy500Module, config: { players: 4, target: 500 } },
  "high-low-jack": { game: hljModule, config: { players: 6, target: 21 } },
  hearts: { game: heartsModule, config: { players: 4, target: 100 } },
  "pegs-and-jokers": { game: pegsAndJokersModule, config: { players: 4, marbles: 5 } }
};
var LocalSocket = class {
  readyState = 0;
  // CONNECTING; becomes 1 (OPEN) after onopen
  onopen = null;
  onmessage = null;
  onclose = null;
  onerror = null;
  room;
  constructor(game, config) {
    this.room = new LocalRoom(game, config, (msg) => {
      this.onmessage?.({ data: JSON.stringify(msg) });
    });
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }
  send(data) {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    this.room.handle(msg);
  }
  close() {
    this.readyState = 3;
    this.room.close();
    this.onclose?.();
  }
};
function createLocalSocket(party) {
  const entry = REGISTRY[party];
  if (!entry) throw new Error(`No offline game registered for "${party}"`);
  return new LocalSocket(entry.game, entry.config);
}
export {
  createLocalSocket
};
