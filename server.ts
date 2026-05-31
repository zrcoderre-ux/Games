// The multiplayer server: one Durable Object instance per room.
//
// It is deliberately a thin shell over the pure pieces we already tested. Its
// only jobs are: keep the authoritative GameState, map connections to seats,
// run validated moves through applyMove, let bots take empty seats, persist
// across hibernation, and push each connection ONLY its own redacted view.

import { Server, routePartykitRequest, type Connection, type ConnectionContext } from "partyserver";
import {
  createGame,
  applyMove,
  legalMoves,
  setSignal,
  type GameState,
  type Move,
  type PlayerCount,
  type HandSignal,
} from "./engine.ts";
import {
  redact,
  advanceBots,
  type ClientMessage,
  type ServerMessage,
  type SeatInfo,
} from "./protocol.ts";

export interface Env {
  GameServer: DurableObjectNamespace<GameServer>;
}

type ConnState = { pid: string; name: string; seat: number | null };

type Room = {
  game: GameState | null; // null while in the lobby
  players: PlayerCount; // table size (chosen at start)
  target: number;
  seats: SeatInfo[]; // length === players
  pidSeats: Record<string, number>; // stable pid -> seat, for reconnects
  hostSeat: number | null;
};

const moveEq = (a: Move, b: Move): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

export class GameServer extends Server<Env> {
  static options = { hibernate: true };

  room: Room = { game: null, players: 4, target: 21, seats: emptySeats(4), pidSeats: {}, hostSeat: null };

  // Load persisted room state when the DO wakes (first start or post-hibernation).
  async onStart() {
    const saved = await this.ctx.storage.get<Room>("room");
    if (saved) this.room = saved;
  }

  async onConnect(_conn: Connection<ConnState>, _ctx: ConnectionContext) {
    // We wait for an explicit "join" message to learn the player's identity, so
    // there's nothing to assign yet. The client sends "join" immediately.
  }

  async onMessage(conn: Connection<ConnState>, raw: string | ArrayBuffer) {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return this.send(conn, { t: "error", message: "Malformed message" });
    }

    try {
      switch (msg.t) {
        case "join":
          return await this.handleJoin(conn, msg.pid, msg.name);
        case "sit":
          return await this.handleSit(conn, msg.seat);
        case "leave":
          return await this.handleLeave(conn);
        case "start":
          return await this.handleStart(conn, msg.players, msg.target ?? 21);
        case "move":
          return await this.handleMove(conn, msg.move);
        case "signal":
          return await this.handleSignal(conn, msg.level);
        case "newGame":
          return await this.handleNewGame(conn);
      }
    } catch (err) {
      this.send(conn, { t: "error", message: err instanceof Error ? err.message : "Error" });
    }
  }

  async onClose(conn: Connection<ConnState>) {
    const seat = conn.state?.seat;
    if (seat === null || seat === undefined) return;
    // If a game is in progress, hand the seat to a bot so play continues; the
    // human can reclaim it on reconnect (same pid -> same seat).
    if (this.room.game && this.room.seats[seat]) {
      this.room.seats[seat] = { kind: "bot", name: this.room.seats[seat].name };
      await this.persist();
      await this.resolveBotsAndBroadcast();
    } else if (this.room.seats[seat]) {
      this.room.seats[seat] = { kind: "empty", name: null };
      await this.persist();
      this.broadcastViews();
    }
  }

  // ---------- handlers ----------

  private async handleJoin(conn: Connection<ConnState>, pid: string, name: string) {
    let seat = this.room.pidSeats[pid] ?? null;

    if (seat !== null) {
      // Reconnect: reclaim the seat and switch it back to human.
      this.room.seats[seat] = { kind: "human", name };
    } else if (!this.room.game) {
      // New player in the lobby: take the lowest empty seat if there is one.
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
    if (this.room.game) throw new Error("Game already in progress");
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
    this.room.seats[st.seat] = this.room.game
      ? { kind: "bot", name: st.seat === null ? null : this.room.seats[st.seat].name }
      : { kind: "empty", name: null };
    delete this.room.pidSeats[st.pid];
    conn.setState({ ...st, seat: null });
    await this.persist();
    await this.resolveBotsAndBroadcast();
  }

  private async handleStart(conn: Connection<ConnState>, players: PlayerCount, target: number) {
    if (this.room.game) throw new Error("Game already in progress");
    if (conn.state?.seat === null || conn.state?.seat !== this.room.hostSeat) {
      throw new Error("Only the host can start the game");
    }
    // Resize the table, keeping seated humans where they are; everyone else is a bot.
    const seats: SeatInfo[] = emptySeats(players);
    for (let s = 0; s < players; s++) {
      const existing = this.room.seats[s];
      seats[s] = existing && existing.kind === "human" ? existing : { kind: "bot", name: botName(s) };
    }
    // Drop pid->seat entries that fell outside the new table.
    for (const [pid, s] of Object.entries(this.room.pidSeats)) if (s >= players) delete this.room.pidSeats[pid];

    this.room.players = players;
    this.room.target = target;
    this.room.seats = seats;
    this.room.game = createGame(players, (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0, target);

    await this.persist();
    await this.resolveBotsAndBroadcast(); // bots act if seat 1 (etc.) leads off
  }

  private async handleMove(conn: Connection<ConnState>, move: Move) {
    const game = this.room.game;
    if (!game) throw new Error("No game in progress");
    const seat = conn.state?.seat;
    if (seat === null || seat === undefined) throw new Error("You are not seated");

    const toAct = game.phase === "bidding" ? game.bidTurn : game.turn;
    if (toAct !== seat) throw new Error("It is not your turn");
    if (move.seat !== seat) throw new Error("Seat mismatch");
    if (!legalMoves(game).some((m) => moveEq(m, move))) throw new Error("Illegal move");

    this.room.game = applyMove(game, move);
    await this.persist();
    await this.resolveBotsAndBroadcast();
  }

  private async handleSignal(conn: Connection<ConnState>, level: HandSignal) {
    const game = this.room.game;
    if (!game) throw new Error("No game in progress");
    const seat = conn.state?.seat;
    if (seat === null || seat === undefined) throw new Error("You are not seated");
    // setSignal enforces that signalling is only allowed during the bidding phase.
    this.room.game = setSignal(game, seat, level);
    await this.persist();
    this.broadcastViews(); // signalling changes no turns and triggers no bots
  }

  private async handleNewGame(conn: Connection<ConnState>) {
    if (this.room.game && this.room.game.phase !== "gameOver") throw new Error("Game still in progress");
    if (conn.state?.seat !== this.room.hostSeat) throw new Error("Only the host can start a new game");
    this.room.game = null;
    // Return bots to empty seats so humans can re-seat in the lobby.
    this.room.seats = this.room.seats.map((s) => (s.kind === "bot" ? { kind: "empty", name: null } : s));
    await this.persist();
    this.broadcastViews();
  }

  // ---------- bots + broadcast ----------

  // Resolve every bot move that follows the current position, then broadcast.
  // NOTE: this resolves all bot moves at once. For paced, one-card-at-a-time bot
  // play, replace this with an alarm loop calling stepBot() on a timer.
  private async resolveBotsAndBroadcast() {
    if (this.room.game) {
      const isBot = (s: number) => this.room.seats[s]?.kind === "bot";
      const { state } = advanceBots(this.room.game, isBot);
      this.room.game = state;
      await this.persist();
    }
    this.broadcastViews();
  }

  private broadcastViews() {
    const phase = this.room.game ? undefined : ("lobby" as const);
    const meta = { seats: this.room.seats, hostSeat: this.room.hostSeat, phase };
    // A lobby placeholder game (not dealt) just to carry seat/score scaffolding.
    const base = this.room.game ?? lobbyState(this.room.players, this.room.target);
    for (const c of this.getConnections<ConnState>()) {
      const seat = c.state?.seat ?? null;
      this.send(c, { t: "view", view: redact(base, seat, meta) });
    }
  }

  private send(conn: Connection<ConnState>, msg: ServerMessage) {
    conn.send(JSON.stringify(msg));
  }

  private async persist() {
    await this.ctx.storage.put("room", this.room);
  }
}

// ---------- helpers ----------

function emptySeats(n: number): SeatInfo[] {
  return Array.from({ length: n }, () => ({ kind: "empty", name: null }));
}
function botName(seat: number): string {
  return `Bot ${seat + 1}`;
}
// A minimal undealt state so the lobby view has seats/scores to render.
function lobbyState(players: PlayerCount, target: number): GameState {
  const g = createGame(players, 1, target);
  return { ...g, hands: g.hands.map(() => []), kitty: [], phase: "bidding" };
}

// ---------- worker entrypoint ----------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (await routePartykitRequest(request, env)) || new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
