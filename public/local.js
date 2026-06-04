"use strict";
(() => {
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
        this.botTimer = setTimeout(() => this.botStep(), this.game.botStepMs ?? BOT_STEP_MS_DEFAULT);
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
})();
