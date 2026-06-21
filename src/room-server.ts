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

type LogEnv = { GameLog?: DurableObjectNamespace };

type Room<State, Config> = {
  state: State | null; // null while in the lobby
  config: Config; // table size + per-game options
  seats: SeatInfo[];
  pidSeats: Record<string, number>; // stable pid -> seat, for reconnects
  hostSeat: number | null;
  botReplacement: boolean;                // auto-replace disconnected humans after 60 s
  pendingBotSeats: Record<number, number>; // seat → epoch-ms when bot takes over
  disconnectedSeats: Record<number, true>; // seats with a closed WebSocket
};

export abstract class RoomServer<
  State,
  Move extends SeatedMove,
  Config,
  View,
  Env extends Cloudflare.Env & LogEnv = Cloudflare.Env & LogEnv,
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
    // Backward compat: rooms saved before bot-replacement fields were added.
    if (!this.room.pendingBotSeats) this.room.pendingBotSeats = {};
    if (!this.room.disconnectedSeats) this.room.disconnectedSeats = {};
    if (this.room.botReplacement === undefined) this.room.botReplacement = false;
  }

  private freshLobby(): Room<State, Config> {
    const config = this.defaultConfig();
    return {
      state: null,
      config,
      seats: emptySeats(this.game.seatCount(config)),
      pidSeats: {},
      hostSeat: null,
      botReplacement: false,
      pendingBotSeats: {},
      disconnectedSeats: {},
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
        case "move":              return await this.handleMove(conn, msg.move);
        case "advance":           return await this.handleAdvance(conn);
        case "aux":               return await this.handleAux(conn, msg.payload);
        case "newGame":           return await this.handleNewGame(conn);
        case "setBotReplacement": return await this.handleSetBotReplacement(conn, msg.enabled);
        case "replaceSeat":       return await this.handleReplaceSeat(conn, msg.seat);
      }
    } catch (err) {
      this.send(conn, { t: "error", message: err instanceof Error ? err.message : "Error" });
    }
  }

  async onClose(conn: Connection<ConnState>) {
    const seat = conn.state?.seat;
    if (seat === null || seat === undefined || !this.room.seats[seat]) return;
    if (this.inProgress()) {
      const otherHumans = this.room.seats.filter((s, i) => i !== seat && s.kind === "human").length;
      if (otherHumans > 0) {
        // Mark as disconnected so the host can see and act.
        this.room.disconnectedSeats[seat] = true;
        if (this.room.botReplacement) {
          // Auto-replace after 60 s; human can still reconnect and reclaim before then.
          this.room.pendingBotSeats[seat] = Date.now() + BOT_REPLACE_DELAY_MS;
          await this.scheduleNextAlarm();
        }
        await this.persist();
        this.broadcastViews();
      }
      // else: sole human — game pauses until they reconnect; no bot takeover.
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
      // Cancel any scheduled or pending bot replacement for this seat.
      delete this.room.pendingBotSeats[seat];
      delete this.room.disconnectedSeats[seat];
    } else if (!this.room.state || this.game.isOver(this.room.state)) {
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
    if (this.inProgress()) {
      const otherHumans = this.room.seats.filter((s, i) => i !== st.seat && s.kind === "human").length;
      this.room.seats[st.seat] = otherHumans > 0
        ? { kind: "bot", name: this.room.seats[st.seat].name }
        : { kind: "empty", name: null }; // sole human leaving: free the seat
    } else {
      this.room.seats[st.seat] = { kind: "empty", name: null };
    }
    delete this.room.pendingBotSeats[st.seat];
    delete this.room.disconnectedSeats[st.seat];
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
    // Resize: preserve all human players. First fill humans into the new seat array
    // in their current order, then pack any that fell outside n into the first empty slots.
    const seats: SeatInfo[] = emptySeats(n);
    const overflow: Array<[string, SeatInfo]> = []; // [pid, info] for displaced humans
    for (let s = 0; s < this.room.seats.length; s++) {
      const info = this.room.seats[s];
      if (info.kind !== "human") continue;
      if (s < n) {
        seats[s] = info;
      } else {
        const pid = Object.entries(this.room.pidSeats).find(([, seat]) => seat === s)?.[0];
        if (pid) overflow.push([pid, info]);
      }
    }
    for (const [pid, info] of overflow) {
      const free = seats.findIndex((x) => x.kind === "empty");
      if (free !== -1) {
        seats[free] = info;
        this.room.pidSeats[pid] = free;
      } else {
        delete this.room.pidSeats[pid]; // table truly full — no room for this human
      }
    }
    // Bots that were in seats beyond the new size are simply dropped (they're expendable).
    for (const [pid, s] of Object.entries(this.room.pidSeats)) if (s >= n) delete this.room.pidSeats[pid];
    // Update host if their seat moved.
    if (this.room.hostSeat !== null) {
      const hostPid = Object.entries(this.room.pidSeats).find(([, s]) => s === this.room.hostSeat)?.[0];
      if (!hostPid) {
        const firstHuman = seats.findIndex((x) => x.kind === "human");
        this.room.hostSeat = firstHuman === -1 ? null : firstHuman;
      }
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

    const afterMove = this.game.applyMove(state, move);
    this.room.state = this.game.openHumanGate?.(afterMove, move) ?? afterMove;
    await this.persist();
    await this.logHandIfComplete(state, this.room.state);
    await this.resolveBotsAndBroadcast();
  }

  // A seated human taps a pacing gate (e.g. a completed trick) to skip its wait.
  // No-op-safe: throws only if there's no gate to advance. The auto-advance alarm
  // covers the case where nobody taps.
  private async handleAdvance(conn: Connection<ConnState>) {
    const state = this.room.state;
    if (!state) throw new Error("No game in progress");
    const seat = conn.state?.seat;
    if (seat === null || seat === undefined) throw new Error("You are not seated");
    const pace = this.game.pacing ? this.game.pacing(state) : null;
    if (!pace || !pace.move) throw new Error("Nothing to advance");
    this.room.state = this.game.applyMove(state, pace.move);
    await this.persist();
    await this.logHandIfComplete(state, this.room.state);
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
    // An aux action can clear a gate (e.g. HLJ's confidence pick clears
    // pendingSignal), which changes who is to act. Re-arm the bot alarm rather
    // than only broadcasting, or play freezes until the safety-net alarm fires.
    await this.resolveBotsAndBroadcast();
  }

  private async handleNewGame(conn: Connection<ConnState>) {
    if (this.inProgress()) throw new Error("Game still in progress");
    if (conn.state?.seat !== this.room.hostSeat) throw new Error("Only the host can start a new game");
    this.room.state = null;
    this.room.pendingBotSeats = {};
    this.room.disconnectedSeats = {};
    // Return bots to empty seats so humans can re-seat in the lobby.
    this.room.seats = this.room.seats.map((s) => (s.kind === "bot" ? { kind: "empty", name: null } : s));
    await this.persist();
    this.broadcastViews();
  }

  private async handleSetBotReplacement(conn: Connection<ConnState>, enabled: boolean) {
    this.requireHost(conn);
    this.room.botReplacement = enabled;
    if (!enabled) {
      // Cancel any scheduled replacements.
      this.room.pendingBotSeats = {};
    }
    await this.persist();
    this.broadcastViews();
  }

  private async handleReplaceSeat(conn: Connection<ConnState>, seat: number) {
    if (conn.state?.seat !== this.room.hostSeat) throw new Error("Only the host can replace a seat");
    if (!this.inProgress()) throw new Error("No game in progress");
    if (!this.room.disconnectedSeats[seat]) throw new Error("That player is not disconnected");
    this.room.seats[seat] = { kind: "bot", name: this.room.seats[seat].name };
    delete this.room.pendingBotSeats[seat];
    delete this.room.disconnectedSeats[seat];
    await this.persist();
    await this.resolveBotsAndBroadcast();
  }

  // ---------- bots + broadcast ----------

  private inProgress(): boolean {
    return this.room.state !== null && !this.game.isOver(this.room.state);
  }

  protected isBot(seat: number): boolean {
    return this.room.seats[seat]?.kind === "bot";
  }

  // After any state change: broadcast the new view, then let bots/timers act.
  private async resolveBotsAndBroadcast() {
    this.broadcastViews();
    await this.scheduleNextAlarm();
  }

  // Single alarm slot covers both pending bot-replacements and bot move steps.
  private async scheduleNextAlarm() {
    let next: number | null = null;
    for (const t of Object.values(this.room.pendingBotSeats)) {
      next = next === null ? t : Math.min(next, t);
    }
    const s = this.room.state;
    if (s && !this.game.isOver(s)) {
      const seat = this.game.seatToAct(s);
      if (seat !== null && this.isBot(seat)) {
        const raw = this.game.botStepMs;
        const stepMs = typeof raw === "function" ? raw(s) : (raw ?? BOT_STEP_MS);
        const botTime = Date.now() + stepMs;
        next = next === null ? botTime : Math.min(next, botTime);
      } else if (seat === null) {
        // No seat to act and not over → a pacing gate (e.g. trickComplete). Schedule
        // the auto-advance; a human stack-tap can advance sooner via handleAdvance.
        const pace = this.game.pacing ? this.game.pacing(s) : null;
        if (pace && pace.move) {
          const hasHuman = this.room.seats.some((x) => x?.kind === "human");
          if (pace.kind === "auto" || !hasHuman) {
            const gateTime = Date.now() + pace.ms;
            next = next === null ? gateTime : Math.min(next, gateTime);
          }
        }
      }
    }
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }

  // Fired by the runtime on our scheduled alarm. Handles two cases in order:
  //   1. Any pending bot replacements whose delay has expired.
  //   2. A single bot move for the seat currently to act.
  async onAlarm() {
    const now = Date.now();

    // 1. Flush expired bot-replacement timers.
    let replacedAny = false;
    for (const [seatStr, t] of Object.entries(this.room.pendingBotSeats)) {
      if (now >= t) {
        const seat = +seatStr;
        if (this.room.seats[seat]?.kind === "human") {
          this.room.seats[seat] = { kind: "bot", name: this.room.seats[seat].name };
          replacedAny = true;
        }
        delete this.room.pendingBotSeats[seat];
        delete this.room.disconnectedSeats[seat];
      }
    }

    // 2. Bot move step.
    const s = this.room.state;
    if (s && !this.game.isOver(s)) {
      const seat = this.game.seatToAct(s);
      if (seat !== null && this.isBot(seat)) {
        let ns: State = s;
        if (this.game.aux?.botAux) {
          const a = this.game.aux.botAux(ns, seat);
          if (a != null) ns = this.game.aux.apply(ns, seat, a);
        }
        const prevNs = ns;
        ns = this.game.applyMove(ns, this.game.aiMove(ns, seat));
        this.room.state = ns;
        await this.persist();
        await this.logHandIfComplete(prevNs, ns);
        this.broadcastViews();
        await this.scheduleNextAlarm();
        return;
      }
      // 2b. Pacing gate auto-advance (no seat to act, game not over).
      if (seat === null && this.game.pacing) {
        const pace = this.game.pacing(s);
        if (pace && pace.move) {
          const hasHuman = this.room.seats.some((x) => x?.kind === "human");
          if (pace.kind === "auto" || !hasHuman) {
            this.room.state = this.game.applyMove(s, pace.move);
            await this.persist();
            await this.logHandIfComplete(s, this.room.state);
            this.broadcastViews();
            await this.scheduleNextAlarm();
            return;
          }
        }
      }
    }

    if (replacedAny) {
      await this.persist();
      await this.resolveBotsAndBroadcast();
    } else {
      await this.scheduleNextAlarm();
    }
  }

  private meta(): RoomMeta {
    return {
      seats: this.room.seats,
      hostSeat: this.room.hostSeat,
      players: this.room.seats.length,
      inLobby: this.room.state === null,
      botReplacement: this.room.botReplacement,
      disconnectedSeats: Object.keys(this.room.disconnectedSeats).map(Number),
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

  private async logHandIfComplete(prev: State, next: State) {
    const rec = this.game.loggableHand?.(prev, next);
    console.log("[gamelog] check: rec=", !!rec, "GameLog=", !!this.env.GameLog, "game=", this.game.meta?.id ?? "?");
    if (!rec || !this.env.GameLog) return;
    const enriched = {
      ...(rec as object),
      ts: new Date().toISOString(),
      seatKinds: this.room.seats.map((s) => s.kind), // "human" | "bot" | "empty", no names
    };
    try {
      const stub = this.env.GameLog.get(this.env.GameLog.idFromName("singleton"));
      await stub.fetch("https://gamelog/append", { method: "POST", body: JSON.stringify(enriched) });
    } catch (err) { console.error("[gamelog] append failed:", err); }
  }
}

function emptySeats(n: number): SeatInfo[] {
  return Array.from({ length: n }, () => ({ kind: "empty", name: null }));
}

// How long to pause between bot moves, so a watching human sees each one.
// A relaxed pace lets each draw, meld, and discard register before the next.
const BOT_STEP_MS = 2400;
const BOT_REPLACE_DELAY_MS = 60_000; // 1 minute grace period before auto bot-replacement

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
