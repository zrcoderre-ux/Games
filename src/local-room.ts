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

// Default delay between bot moves; individual games may override via botStepMs.
const BOT_STEP_MS_DEFAULT = 1600;

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

// Deal seeds and shuffle entropy come from the platform CSPRNG.
const randomSeed = (): number => crypto.getRandomValues(new Uint32Array(1))[0];
const freshEntropy = (): number[] => Array.from(crypto.getRandomValues(new Uint32Array(4)));
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export class LocalRoom<State, Move extends { seat: number }, Config, View> {
  private state: State | null = null;
  private seats: SeatInfo[];
  private hostSeat: number | null = null;
  private viewSeat: number | null = null; // the seat whose view we currently emit
  private name = "You";
  private botTimer: ReturnType<typeof setTimeout> | null = null;
  // Plain fields rather than constructor parameter properties, so Node's
  // type stripping can load this file directly (the tests do).
  private game: Game<State, Move, Config, View>;
  private config: Config;
  private emit: (msg: ServerMessage<View>) => void;

  constructor(game: Game<State, Move, Config, View>, config: Config, emit: (msg: ServerMessage<View>) => void) {
    this.game = game;
    this.config = config;
    this.emit = emit;
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
        case "advance": return this.advance();
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

  // The client's fields merged over the current config, accepted only if the
  // table size is supported and the module can deal it (a dry-run createGame
  // throws with the module's own message). Mutates nothing.
  private mergedConfig(patch: unknown): Config {
    const next: Record<string, unknown> = { ...(this.config as object) };
    if (patch && typeof patch === "object" && !Array.isArray(patch)) {
      for (const [k, v] of Object.entries(patch)) if (!UNSAFE_KEYS.has(k)) next[k] = v;
    }
    const config = next as Config;
    const n = this.game.seatCount(config);
    if (!this.game.meta.supportedPlayerCounts.includes(n)) {
      throw new Error(`${this.game.meta.name} doesn't support ${n} players`);
    }
    this.game.createGame(config, 1);
    return config;
  }

  // Seats for an n-seat table without losing anyone, like the server: seats
  // below n keep their occupant, and each human beyond the new size moves to
  // the first empty seat (or displaces a bot). Throws if they can't all fit.
  // `moved` maps each moved human's old seat to the new one.
  private resizedSeats(n: number): { seats: SeatInfo[]; moved: Map<number, number> } {
    const seats = emptySeats(n);
    for (let s = 0; s < Math.min(n, this.seats.length); s++) seats[s] = this.seats[s];
    const moved = new Map<number, number>();
    for (let s = n; s < this.seats.length; s++) {
      if (this.seats[s].kind !== "human") continue;
      let free = seats.findIndex((x) => x.kind === "empty");
      if (free === -1) free = seats.findIndex((x) => x.kind === "bot");
      if (free === -1) throw new Error(`Not enough seats for everyone at ${n} players`);
      seats[free] = this.seats[s];
      moved.set(s, free);
    }
    return { seats, moved };
  }

  // Commit a resize; the host and the viewed seat follow their human.
  private commitSeats(seats: SeatInfo[], moved: Map<number, number>): void {
    const where = (s: number | null): number | null => (s === null || s < seats.length ? s : (moved.get(s) ?? null));
    this.hostSeat = where(this.hostSeat);
    this.viewSeat = where(this.viewSeat);
    this.seats = seats;
  }

  private setConfig(patch: Partial<Config>): void {
    if (this.state) throw new Error("Can't resize the table once the game has started");
    const config = this.mergedConfig(patch);
    const { seats, moved } = this.resizedSeats(this.game.seatCount(config));
    this.config = config;
    this.commitSeats(seats, moved);
    this.broadcast();
  }

  private start(patch?: Partial<Config>): void {
    if (this.state) throw new Error("Game already in progress");
    const config = this.mergedConfig(patch);
    const n = this.game.seatCount(config);
    const { seats, moved } = this.resizedSeats(n);
    const taken = new Set<string>(seats.map((s) => s.name).filter((x): x is string => !!x));
    for (let s = 0; s < n; s++) {
      if (seats[s].kind !== "empty") continue;
      const name = pickBotName(taken);
      taken.add(name);
      seats[s] = { kind: "bot", name };
    }
    // dealerSeat: negative values are relative to seatN (e.g. -2 → n-2, the right-wall
    // teammate for any even player count). seed is used as-is when provided.
    const rawDealer = (config as any).dealerSeat;
    const seed = rawDealer !== undefined
      ? ((rawDealer < 0 ? n + rawDealer : rawDealer) % n)  // n already declared above
      : (config as any).seed !== undefined
        ? (config as any).seed
        : randomSeed();
    let state = this.game.createGame(config, seed);
    // ensureAce: re-deal (preserving dealer) until seat 0 holds at least one ace.
    if ((config as any).ensureAce) {
      let s = seed;
      for (let i = 0; i < 200; i++) {
        const hands = (state as any).hands as Array<Array<Record<string, unknown>>>;
        if (hands?.[0]?.some(c => !("joker" in c) && c["rank"] === 14)) break;
        s += n;
        state = this.game.createGame(config, s);
      }
    }
    // Dealt without error: only now commit the table.
    this.config = config;
    this.commitSeats(seats, moved);
    this.state = this.reseeded(state);
    this.syncViewSeat();
    this.resolveBotsAndBroadcast();
  }

  // Fresh shuffle entropy for the module, when it takes any.
  private reseeded(state: State): State {
    return this.game.reseed ? this.game.reseed(state, freshEntropy()) : state;
  }

  // Every transition (human, bot, or pacing advance) goes through here.
  private transition(state: State, move: Move): State {
    return this.game.applyMove(this.reseeded(state), move);
  }

  private move(move: Move): void {
    if (!this.state) throw new Error("No game in progress");
    const seat = this.game.seatToAct(this.state);
    if (seat === null) throw new Error("Nobody to act");
    if (this.seats[seat].kind !== "human") throw new Error("It is not your turn");
    if (move.seat !== seat) throw new Error("Seat mismatch");
    if (!this.game.isLegal(this.state, move)) throw new Error("Illegal move");
    const prev = this.state;
    const afterMove = this.transition(this.state, move);
    this.state = this.game.openHumanGate?.(afterMove, move) ?? afterMove;
    this.logHandIfComplete(prev, this.state);
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
    // An aux action can clear a gate (e.g. HLJ's confidence pick clears
    // pendingSignal), which changes who is to act. Resume the bot loop rather
    // than only broadcasting, or play freezes on the next seat.
    this.syncViewSeat();
    this.resolveBotsAndBroadcast();
  }

  private newGame(): void {
    if (this.state && !this.game.isOver(this.state)) throw new Error("Game still in progress");
    this.close();
    this.state = null;
    this.seats = this.seats.map((s) => (s.kind === "bot" ? { kind: "empty", name: null } : s));
    this.broadcast();
  }

  // ---------- bots + broadcast ----------

  private logHandIfComplete(prev: State, next: State): void {
    const rec = this.game.loggableHand?.(prev, next);
    if (!rec) return;
    const enriched = {
      ...(rec as object),
      ts: new Date().toISOString(),
      seatKinds: this.seats.map((s) => s.kind),
      offline: true,
    };
    fetch("/gamelog/append-offline", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(enriched),
    }).catch(() => { /* fire-and-forget; silently ignore offline or failed requests */ });
  }

  private meta(): RoomMeta {
    return { seats: this.seats, hostSeat: this.hostSeat, players: this.seats.length, inLobby: this.state === null, botReplacement: false, disconnectedSeats: [] };
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

  // A human stack-tap during a pacing gate (e.g. Pitch's trickComplete): apply the
  // gate's advance move immediately instead of waiting for the auto-advance timer.
  // A stale tap, or one on a gate owned by another seat (advanceSeat), is ignored.
  private advance(): void {
    if (!this.state || this.game.isOver(this.state)) return;
    const pace = this.game.pacing ? this.game.pacing(this.state) : null;
    if (!pace || !pace.move) return;
    if (pace.advanceSeat != null && pace.advanceSeat !== this.viewSeat) return;
    const prev = this.state;
    this.state = this.transition(this.state, pace.move);
    this.logHandIfComplete(prev, this.state);
    this.syncViewSeat();
    this.resolveBotsAndBroadcast();
  }

  // The driver-owned auto-advance for a pacing gate, fired by the single timer.
  private autoAdvance(move: Move): void {
    this.botTimer = null;
    const s = this.state;
    if (!s || this.game.isOver(s)) return;
    if (this.game.seatToAct(s) !== null) return; // no longer in a gate
    this.state = this.transition(s, move);
    this.logHandIfComplete(s, this.state);
    this.syncViewSeat();
    this.broadcast();
    this.scheduleBotStep();
  }

  private scheduleBotStep(): void {
    if (this.botTimer) { clearTimeout(this.botTimer); this.botTimer = null; }
    const s = this.state;
    if (!s || this.game.isOver(s)) return;
    const seat = this.game.seatToAct(s);
    if (seat !== null) {
      if (this.seats[seat]?.kind === "bot") {
        const raw = this.game.botStepMs;
        const ms = typeof raw === "function" ? raw(s) : (raw ?? BOT_STEP_MS_DEFAULT);
        this.botTimer = setTimeout(() => this.botStep(), ms);
      }
      return; // a human is to act → wait for their move
    }
    // No seat to act and not over → a pacing gate (e.g. trickComplete). The driver
    // owns the single auto-advance timer; a human stack-tap can advance() sooner.
    const pace = this.game.pacing ? this.game.pacing(s) : null;
    if (!pace || !pace.move) return;
    const hasHuman = this.seats.some((x) => x?.kind === "human");
    if (pace.kind === "auto" || !hasHuman) {
      const move = pace.move;
      this.botTimer = setTimeout(() => this.autoAdvance(move), pace.ms);
    }
    // pace.kind === "wait" with a human present → no timer; wait for the tap.
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
    const prevNs = ns;
    ns = this.transition(ns, this.game.aiMove(ns, seat));
    this.state = ns;
    this.logHandIfComplete(prevNs, ns);
    this.syncViewSeat(); // a bot may have handed the turn to a human
    this.broadcast();
    this.scheduleBotStep();
  }
}
