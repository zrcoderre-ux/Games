// room-server.ts — the generic multiplayer room. One Durable Object instance
// per room, hosting ANY game module.
//
// Its jobs are all game-independent: keep the authoritative state, map
// connections to seats, validate incoming moves through the module, let bots
// take empty/abandoned seats, persist across hibernation, and push each
// connection ONLY its own redacted view. Every rule is delegated to the module;
// this file contains no game logic at all.

import { Server, type Connection, type ConnectionContext } from "partyserver";
import type {
  Game,
  SeatedMove,
  SeatInfo,
  RoomMeta,
  ClientMessage,
  ServerMessage,
} from "./game.ts";

export type ConnState = { pid: string; name: string; seat: number | null };

type Room<State, Config> = {
  state: State | null; // null while in the lobby
  config: Config; // table size + per-game options
  seats: SeatInfo[];
  pidSeats: Record<string, number>; // stable pid -> seat, for reconnects
  hostSeat: number | null;
};

export abstract class RoomServer<
  State,
  Move extends SeatedMove,
  Config,
  View,
  Env extends Cloudflare.Env = Cloudflare.Env,
> extends Server<Env> {
  static options = { hibernate: true };

  // Subclasses supply the game module and a starting lobby config. These are
  // the ONLY two things a concrete game's Durable Object needs to provide.
  abstract readonly game: Game<State, Move, Config, View>;
  protected abstract defaultConfig(): Config;

  protected room!: Room<State, Config>; // set in onStart()

  // Load persisted room state when the DO wakes (first start or post-hibernation).
  async onStart() {
    const saved = await this.ctx.storage.get<Room<State, Config>>("room");
    this.room = saved ?? this.freshLobby();
  }

  private freshLobby(): Room<State, Config> {
    const config = this.defaultConfig();
    return {
      state: null,
      config,
      seats: emptySeats(this.game.seatCount(config)),
      pidSeats: {},
      hostSeat: null,
    };
  }

  async onConnect(_conn: Connection<ConnState>, _ctx: ConnectionContext) {
    // Identity arrives via an explicit "join"; nothing to assign yet.
  }

  async onMessage(conn: Connection<ConnState>, raw: string | ArrayBuffer) {
    let msg: ClientMessage<Config, Move>;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return this.send(conn, { t: "error", message: "Malformed message" });
    }
    try {
      switch (msg.t) {
        case "join":    return await this.handleJoin(conn, msg.pid, msg.name);
        case "sit":     return await this.handleSit(conn, msg.seat);
        case "leave":   return await this.handleLeave(conn);
        case "addBot":  return await this.handleAddBot(conn, msg.seat);
        case "removeBot": return await this.handleRemoveBot(conn, msg.seat);
        case "setConfig": return await this.handleSetConfig(conn, msg.config);
        case "start":   return await this.handleStart(conn, msg.config);
        case "move":    return await this.handleMove(conn, msg.move);
        case "aux":     return await this.handleAux(conn, msg.payload);
        case "newGame": return await this.handleNewGame(conn);
      }
    } catch (err) {
      this.send(conn, { t: "error", message: err instanceof Error ? err.message : "Error" });
    }
  }

  async onClose(conn: Connection<ConnState>) {
    const seat = conn.state?.seat;
    if (seat === null || seat === undefined || !this.room.seats[seat]) return;
    if (this.inProgress()) {
      // Hand the seat to a bot so play continues; the human reclaims it on
      // reconnect (same pid -> same seat). This is the short-team/disconnect
      // coverage: any abandoned seat is immediately filled.
      this.room.seats[seat] = { kind: "bot", name: this.room.seats[seat].name };
      await this.persist();
      await this.resolveBotsAndBroadcast();
    } else {
      this.room.seats[seat] = { kind: "empty", name: null };
      await this.persist();
      this.broadcastViews();
    }
  }

  // ---------- handlers ----------

  private async handleJoin(conn: Connection<ConnState>, pid: string, name: string) {
    let seat = this.room.pidSeats[pid] ?? null;
    if (seat !== null) {
      this.room.seats[seat] = { kind: "human", name }; // reconnect: reclaim seat
    } else if (!this.room.state) {
      const empty = this.room.seats.findIndex((s) => s.kind === "empty");
      if (empty !== -1) {
        seat = empty;
        this.room.seats[seat] = { kind: "human", name };
        this.room.pidSeats[pid] = seat;
      }
    }
    if (this.room.hostSeat === null && seat !== null) this.room.hostSeat = seat;
    conn.setState({ pid, name, seat });
    await this.persist();
    this.broadcastViews();
  }

  private async handleSit(conn: Connection<ConnState>, seat: number) {
    if (this.room.state) throw new Error("Game already in progress");
    if (seat < 0 || seat >= this.room.seats.length) throw new Error("No such seat");
    if (this.room.seats[seat].kind !== "empty") throw new Error("Seat is taken");
    const st = conn.state!;
    if (st.seat !== null) this.room.seats[st.seat] = { kind: "empty", name: null }; // vacate old seat
    this.room.seats[seat] = { kind: "human", name: st.name };
    this.room.pidSeats[st.pid] = seat;
    if (this.room.hostSeat === null) this.room.hostSeat = seat;
    conn.setState({ ...st, seat });
    await this.persist();
    this.broadcastViews();
  }

  private async handleLeave(conn: Connection<ConnState>) {
    const st = conn.state!;
    if (st.seat === null) return;
    this.room.seats[st.seat] = this.inProgress()
      ? { kind: "bot", name: this.room.seats[st.seat].name }
      : { kind: "empty", name: null };
    delete this.room.pidSeats[st.pid];
    conn.setState({ ...st, seat: null });
    await this.persist();
    await this.resolveBotsAndBroadcast();
  }

  private requireHost(conn: Connection<ConnState>) {
    if (conn.state?.seat == null || conn.state.seat !== this.room.hostSeat) {
      throw new Error("Only the host can do that");
    }
  }

  private async handleAddBot(conn: Connection<ConnState>, seat: number) {
    this.requireHost(conn);
    if (this.room.state) throw new Error("Add bots from the lobby, before the game starts");
    if (seat < 0 || seat >= this.room.seats.length) throw new Error("No such seat");
    if (this.room.seats[seat].kind !== "empty") throw new Error("Seat is occupied");
    const taken = new Set<string>(this.room.seats.map((x) => x.name).filter((n): n is string => !!n));
    this.room.seats[seat] = { kind: "bot", name: pickBotName(taken) };
    await this.persist();
    this.broadcastViews();
  }

  private async handleRemoveBot(conn: Connection<ConnState>, seat: number) {
    this.requireHost(conn);
    if (this.room.state) throw new Error("Bots can't be removed once the game has started");
    if (seat < 0 || seat >= this.room.seats.length) throw new Error("No such seat");
    if (this.room.seats[seat].kind !== "bot") throw new Error("That seat is not a bot");
    this.room.seats[seat] = { kind: "empty", name: null };
    await this.persist();
    this.broadcastViews();
  }

  private async handleSetConfig(conn: Connection<ConnState>, config: Config) {
    this.requireHost(conn);
    if (this.room.state) throw new Error("Can't resize the table once the game has started");
    const n = this.game.seatCount(config);
    if (!this.game.meta.supportedPlayerCounts.includes(n)) {
      throw new Error(`${this.game.meta.name} doesn't support ${n} players`);
    }
    // Resize, keeping whoever already occupies a seat that still exists.
    const seats: SeatInfo[] = emptySeats(n);
    for (let s = 0; s < Math.min(n, this.room.seats.length); s++) seats[s] = this.room.seats[s];
    for (const [pid, s] of Object.entries(this.room.pidSeats)) if (s >= n) delete this.room.pidSeats[pid];
    // If the host's seat fell off the (smaller) table, hand host to the first remaining human.
    if (this.room.hostSeat !== null && this.room.hostSeat >= n) {
      const firstHuman = seats.findIndex((x) => x.kind === "human");
      this.room.hostSeat = firstHuman === -1 ? null : firstHuman;
    }
    this.room.config = config;
    this.room.seats = seats;
    await this.persist();
    this.broadcastViews();
  }

  private async handleStart(conn: Connection<ConnState>, config: Config) {
    if (this.room.state) throw new Error("Game already in progress");
    if (conn.state?.seat == null || conn.state.seat !== this.room.hostSeat) {
      throw new Error("Only the host can start the game");
    }
    const n = this.game.seatCount(config);
    // Resize the table, keeping seated humans where they are; everyone else
    // becomes a bot. This is what fills a short table on deal.
    const seats: SeatInfo[] = emptySeats(n);
    const taken = new Set<string>();
    for (let s = 0; s < n; s++) {
      const e = this.room.seats[s];
      if (e && e.kind === "human" && e.name) taken.add(e.name);
    }
    for (let s = 0; s < n; s++) {
      const e = this.room.seats[s];
      if (e && e.kind === "human") {
        seats[s] = e;
      } else {
        const name = pickBotName(taken);
        taken.add(name);
        seats[s] = { kind: "bot", name };
      }
    }
    // Drop pid->seat entries that fell outside the new table.
    for (const [pid, s] of Object.entries(this.room.pidSeats)) if (s >= n) delete this.room.pidSeats[pid];

    this.room.config = config;
    this.room.seats = seats;
    this.room.state = this.game.createGame(config, (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0);
    await this.persist();
    await this.resolveBotsAndBroadcast(); // bots act if a bot leads off
  }

  private async handleMove(conn: Connection<ConnState>, move: Move) {
    const state = this.room.state;
    if (!state) throw new Error("No game in progress");
    const seat = conn.state?.seat;
    if (seat === null || seat === undefined) throw new Error("You are not seated");
    if (this.game.seatToAct(state) !== seat) throw new Error("It is not your turn");
    if (move.seat !== seat) throw new Error("Seat mismatch");
    if (!this.game.isLegal(state, move)) throw new Error("Illegal move");

    this.room.state = this.game.applyMove(state, move);
    await this.persist();
    await this.resolveBotsAndBroadcast();
  }

  private async handleAux(conn: Connection<ConnState>, payload: unknown) {
    const state = this.room.state;
    if (!state) throw new Error("No game in progress");
    if (!this.game.aux) throw new Error("This game has no side actions");
    const seat = conn.state?.seat;
    if (seat === null || seat === undefined) throw new Error("You are not seated");
    this.room.state = this.game.aux.apply(state, seat, payload);
    await this.persist();
    this.broadcastViews(); // aux actions change no turns and trigger no bots
  }

  private async handleNewGame(conn: Connection<ConnState>) {
    if (this.inProgress()) throw new Error("Game still in progress");
    if (conn.state?.seat !== this.room.hostSeat) throw new Error("Only the host can start a new game");
    this.room.state = null;
    // Return bots to empty seats so humans can re-seat in the lobby.
    this.room.seats = this.room.seats.map((s) => (s.kind === "bot" ? { kind: "empty", name: null } : s));
    await this.persist();
    this.broadcastViews();
  }

  // ---------- bots + broadcast ----------

  private inProgress(): boolean {
    return this.room.state !== null && !this.game.isOver(this.room.state);
  }

  protected isBot(seat: number): boolean {
    return this.room.seats[seat]?.kind === "bot";
  }

  // After any state change: show the current position immediately, then let the
  // bots act ONE move at a time on a timer (see onAlarm) so a human watching
  // sees each card played in order instead of the whole sequence at once.
  private async resolveBotsAndBroadcast() {
    this.broadcastViews();
    await this.scheduleBotStep();
  }

  // Schedule the next bot move a short beat from now, if the seat to act is a bot.
  private async scheduleBotStep() {
    const s = this.room.state;
    if (!s || this.game.isOver(s)) return;
    const seat = this.game.seatToAct(s);
    if (seat !== null && this.isBot(seat)) await this.ctx.storage.setAlarm(Date.now() + BOT_STEP_MS);
  }

  // Fired by the runtime on our scheduled alarm. PartyServer runs initialization
  // (onStart) before this, so this.room is loaded, and it works across
  // hibernation. Plays exactly one bot move, broadcasts, then reschedules if the
  // next seat is also a bot.
  async onAlarm() {
    const s = this.room.state;
    if (!s || this.game.isOver(s)) return;
    const seat = this.game.seatToAct(s);
    if (seat === null || !this.isBot(seat)) return; // a human reclaimed the turn
    let ns: State = s;
    if (this.game.aux?.botAux) {
      const a = this.game.aux.botAux(ns, seat);
      if (a != null) ns = this.game.aux.apply(ns, seat, a);
    }
    ns = this.game.applyMove(ns, this.game.aiMove(ns, seat));
    this.room.state = ns;
    await this.persist();
    this.broadcastViews();
    await this.scheduleBotStep();
  }

  private meta(): RoomMeta {
    return {
      seats: this.room.seats,
      hostSeat: this.room.hostSeat,
      players: this.room.seats.length,
      inLobby: this.room.state === null,
    };
  }

  private broadcastViews() {
    const meta = this.meta();
    for (const c of this.getConnections<ConnState>()) {
      const seat = c.state?.seat ?? null;
      const view = this.room.state
        ? this.game.redact(this.room.state, seat, meta)
        : this.game.lobbyView(this.room.config, seat, meta);
      this.send(c, { t: "view", view });
    }
  }

  private send(conn: Connection<ConnState>, msg: ServerMessage<View>) {
    conn.send(JSON.stringify(msg));
  }

  private async persist() {
    await this.ctx.storage.put("room", this.room);
  }
}

function emptySeats(n: number): SeatInfo[] {
  return Array.from({ length: n }, () => ({ kind: "empty", name: null }));
}

// How long to pause between bot moves, so a watching human sees each one.
const BOT_STEP_MS = 850;

// Fake names for bots, so the table doesn't read "Bot 1 / Bot 2".
const BOT_NAMES = [
  "Ada", "Bram", "Cleo", "Dario", "Esme", "Flora", "Gus", "Hana", "Ivo", "Juno",
  "Kit", "Lena", "Milo", "Nadia", "Otto", "Pia", "Quentin", "Remy", "Sasha", "Tariq",
  "Uma", "Vera", "Wes", "Xander", "Yusuf", "Zola", "Indra", "Theo", "Mira", "Cyrus",
  "Noor", "Dax", "Liv", "Hugo", "Saoirse", "Bo",
];

// Pick a fake name not already used at the table; fall back to a numbered one.
function pickBotName(taken: Set<string>): string {
  const free = BOT_NAMES.filter((n) => !taken.has(n));
  if (free.length) return free[Math.floor(Math.random() * free.length)];
  let i = 1;
  while (taken.has(`Bot ${i}`)) i++;
  return `Bot ${i}`;
}
