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
    this.room.seats[seat] = { kind: "bot", name: botName(seat) };
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

  private async handleStart(conn: Connection<ConnState>, config: Config) {
    if (this.room.state) throw new Error("Game already in progress");
    if (conn.state?.seat == null || conn.state.seat !== this.room.hostSeat) {
      throw new Error("Only the host can start the game");
    }
    const n = this.game.seatCount(config);
    // Resize the table, keeping seated humans where they are; everyone else
    // becomes a bot. This is what fills a short table on deal.
    const seats: SeatInfo[] = emptySeats(n);
    for (let s = 0; s < n; s++) {
      const existing = this.room.seats[s];
      seats[s] = existing && existing.kind === "human" ? existing : { kind: "bot", name: botName(s) };
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

  // Resolve every bot move that follows the current position, then broadcast.
  // (For paced one-at-a-time bot play, drive a single iteration of this loop
  // from an alarm instead.)
  private async resolveBotsAndBroadcast() {
    let s = this.room.state;
    if (s) {
      let guard = 0;
      while (!this.game.isOver(s)) {
        const seat = this.game.seatToAct(s);
        if (seat === null || !this.isBot(seat)) break;
        if (this.game.aux?.botAux) {
          const a = this.game.aux.botAux(s, seat);
          if (a != null) s = this.game.aux.apply(s, seat, a);
        }
        s = this.game.applyMove(s, this.game.aiMove(s, seat));
        if (++guard > 10000) throw new Error("Bot loop failed to make progress");
      }
      this.room.state = s;
      await this.persist();
    }
    this.broadcastViews();
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

function botName(seat: number): string {
  return `Bot ${seat + 1}`;
}
