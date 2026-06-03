// local-room.ts — the same multiplayer room as room-server.ts, but running
// in-process in the browser so a game can be played with no network at all.
//
// It hosts ANY pure game module (the identical ones the worker uses), keeps the
// authoritative state, validates moves, lets bots take their turns on a timer,
// and emits a redacted view for the seat currently being viewed. There is no
// persistence, no sockets, and no Cloudflare runtime — just the rules.
//
// SEAT MODEL: the local device owns one or more "human (local)" seats plus any
// number of bots. `viewSeat` is whose hand is shown right now. Offline-vs-bots
// uses a single human seat; pass-and-play (hot-seat) will reuse this class with
// several human seats and switch `viewSeat` as the turn moves between people.

import type { Game, SeatInfo, RoomMeta, ClientMessage, ServerMessage } from "./game.ts";

// The local protocol is the wire protocol plus two lobby-only extras used by
// pass-and-play: seat a named human, or clear a seat back to empty.
type LocalMessage<Config, Move> =
  | ClientMessage<Config, Move>
  | { t: "addHuman"; seat: number; name: string }
  | { t: "clearSeat"; seat: number };

// How long bots pause between moves so a human watching sees each one land.
const BOT_STEP_MS = 1600;

const emptySeats = (n: number): SeatInfo[] => Array.from({ length: n }, () => ({ kind: "empty", name: null }));

const BOT_NAMES = [
  "Ada", "Bram", "Cleo", "Dario", "Esme", "Flora", "Gus", "Hana", "Ivo", "Juno",
  "Kit", "Lena", "Milo", "Nadia", "Otto", "Pia", "Remy", "Sasha", "Tariq", "Vera",
];
function pickBotName(taken: Set<string>): string {
  const free = BOT_NAMES.filter((n) => !taken.has(n));
  if (free.length) return free[Math.floor(Math.random() * free.length)];
  let i = 1;
  while (taken.has(`Bot ${i}`)) i++;
  return `Bot ${i}`;
}

export class LocalRoom<State, Move extends { seat: number }, Config, View> {
  private state: State | null = null;
  private seats: SeatInfo[];
  private hostSeat: number | null = null;
  private viewSeat: number | null = null; // the seat whose view we currently emit
  private name = "You";
  private botTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private game: Game<State, Move, Config, View>,
    private config: Config,
    private emit: (msg: ServerMessage<View>) => void,
  ) {
    this.seats = emptySeats(game.seatCount(config));
  }

  // Single entry point, matching the wire protocol the client already speaks
  // (plus the two pass-and-play lobby extras).
  handle(msg: LocalMessage<Config, Move>): void {
    try {
      switch (msg.t) {
        case "join": return this.join(msg.name);
        case "sit": return this.sit(msg.seat);
        case "leave": return this.leave();
        case "addBot": return this.addBot(msg.seat);
        case "removeBot": return this.removeBot(msg.seat);
        case "addHuman": return this.addHuman(msg.seat, msg.name);
        case "clearSeat": return this.clearSeat(msg.seat);
        case "setConfig": return this.setConfig(msg.config);
        case "start": return this.start(msg.config);
        case "move": return this.move(msg.move);
        case "aux": return this.aux(msg.payload);
        case "newGame": return this.newGame();
      }
    } catch (err) {
      this.emit({ t: "error", message: err instanceof Error ? err.message : "Error" });
    }
  }

  close(): void {
    if (this.botTimer) clearTimeout(this.botTimer);
    this.botTimer = null;
  }

  // ---------- handlers ----------

  private join(name: string): void {
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

  private sit(seat: number): void {
    if (this.state) throw new Error("Game already in progress");
    if (seat < 0 || seat >= this.seats.length) throw new Error("No such seat");
    if (this.seats[seat].kind !== "empty") throw new Error("Seat is taken");
    if (this.viewSeat !== null) this.seats[this.viewSeat] = { kind: "empty", name: null };
    this.seats[seat] = { kind: "human", name: this.name };
    this.viewSeat = seat;
    if (this.hostSeat === null) this.hostSeat = seat;
    this.broadcast();
  }

  private leave(): void {
    // Offline: leaving just resets the table to a fresh lobby.
    this.close();
    this.state = null;
    this.seats = emptySeats(this.game.seatCount(this.config));
    this.viewSeat = null;
    this.hostSeat = null;
    this.broadcast();
  }

  private addBot(seat: number): void {
    if (this.state) throw new Error("Add bots from the lobby, before the game starts");
    if (seat < 0 || seat >= this.seats.length) throw new Error("No such seat");
    if (this.seats[seat].kind !== "empty") throw new Error("Seat is occupied");
    const taken = new Set(this.seats.map((s) => s.name).filter((n): n is string => !!n));
    this.seats[seat] = { kind: "bot", name: pickBotName(taken) };
    this.broadcast();
  }

  private removeBot(seat: number): void {
    if (this.state) throw new Error("Bots can't be removed once the game has started");
    if (seat < 0 || seat >= this.seats.length) throw new Error("No such seat");
    if (this.seats[seat].kind !== "bot") throw new Error("That seat is not a bot");
    this.seats[seat] = { kind: "empty", name: null };
    this.broadcast();
  }

  // Pass-and-play: seat another local human (each gets their own private hand).
  private addHuman(seat: number, name: string): void {
    if (this.state) throw new Error("Add players from the lobby, before the game starts");
    if (seat < 0 || seat >= this.seats.length) throw new Error("No such seat");
    if (this.seats[seat].kind !== "empty") throw new Error("Seat is occupied");
    this.seats[seat] = { kind: "human", name: name || `Player ${seat + 1}` };
    this.broadcast();
  }

  // Clear any non-host seat back to empty (offline lobby housekeeping).
  private clearSeat(seat: number): void {
    if (this.state) throw new Error("Can't change seats once the game has started");
    if (seat < 0 || seat >= this.seats.length) throw new Error("No such seat");
    if (seat === this.hostSeat) throw new Error("Can't clear the host seat");
    this.seats[seat] = { kind: "empty", name: null };
    this.broadcast();
  }

  private setConfig(config: Config): void {
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

  private start(config: Config): void {
    if (this.state) throw new Error("Game already in progress");
    const n = this.game.seatCount(config);
    const seats = emptySeats(n);
    const taken = new Set<string>();
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
    this.state = this.game.createGame(config, (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0);
    this.syncViewSeat();
    this.resolveBotsAndBroadcast();
  }

  private move(move: Move): void {
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
  private syncViewSeat(): void {
    if (!this.state) return;
    const seat = this.game.seatToAct(this.state);
    if (seat !== null && this.seats[seat]?.kind === "human") this.viewSeat = seat;
  }

  private aux(payload: unknown): void {
    if (!this.state) throw new Error("No game in progress");
    if (!this.game.aux) throw new Error("This game has no side actions");
    if (this.viewSeat === null) throw new Error("You are not seated");
    this.state = this.game.aux.apply(this.state, this.viewSeat, payload);
    this.broadcast(); // aux changes no turns and triggers no bots
  }

  private newGame(): void {
    if (this.state && !this.game.isOver(this.state)) throw new Error("Game still in progress");
    this.close();
    this.state = null;
    this.seats = this.seats.map((s) => (s.kind === "bot" ? { kind: "empty", name: null } : s));
    this.broadcast();
  }

  // ---------- bots + broadcast ----------

  private meta(): RoomMeta {
    return { seats: this.seats, hostSeat: this.hostSeat, players: this.seats.length, inLobby: this.state === null };
  }

  private broadcast(): void {
    const meta = this.meta();
    const view = this.state
      ? this.game.redact(this.state, this.viewSeat, meta)
      : this.game.lobbyView(this.config, this.viewSeat, meta);
    this.emit({ t: "view", view });
  }

  private resolveBotsAndBroadcast(): void {
    this.broadcast();
    this.scheduleBotStep();
  }

  private scheduleBotStep(): void {
    if (this.botTimer) { clearTimeout(this.botTimer); this.botTimer = null; }
    const s = this.state;
    if (!s || this.game.isOver(s)) return;
    const seat = this.game.seatToAct(s);
    if (seat !== null && this.seats[seat]?.kind === "bot") {
      this.botTimer = setTimeout(() => this.botStep(), BOT_STEP_MS);
    }
  }

  private botStep(): void {
    this.botTimer = null;
    const s = this.state;
    if (!s || this.game.isOver(s)) return;
    const seat = this.game.seatToAct(s);
    if (seat === null || this.seats[seat]?.kind !== "bot") return;
    let ns: State = s;
    if (this.game.aux?.botAux) {
      const a = this.game.aux.botAux(ns, seat);
      if (a != null) ns = this.game.aux.apply(ns, seat, a);
    }
    ns = this.game.applyMove(ns, this.game.aiMove(ns, seat));
    this.state = ns;
    this.syncViewSeat(); // a bot may have handed the turn to a human
    this.broadcast();
    this.scheduleBotStep();
  }
}
