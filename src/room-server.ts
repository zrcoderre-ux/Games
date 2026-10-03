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
import type { GameLogServer } from "./gamelog-server.ts";

export type ConnState = { pid: string; name: string; seat: number | null };

type LogEnv = { GameLog?: DurableObjectNamespace<GameLogServer> };

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

  // The bot move or gate auto-advance the single alarm is timing, keyed by the
  // transition it became pending after (and who/what it is for), so unrelated
  // events (a reconnect, a side action, a replacement coming due) neither push
  // it back nor make it fire early. In memory only: undefined means this
  // instance just woke from hibernation, and then whatever the alarm was timing
  // is treated as due.
  private stepTimer?: { key: string; at: number } | null;
  private transitions = 0; // bumped on every deal and applied move

  // Load persisted room state when the DO wakes (first start or post-hibernation).
  async onStart() {
    const saved = await this.ctx.storage.get<Room<State, Config>>("room");
    this.room = saved ?? this.freshLobby();
    // Backward compat: rooms saved before bot-replacement fields were added.
    if (!this.room.pendingBotSeats) this.room.pendingBotSeats = {};
    if (!this.room.disconnectedSeats) this.room.disconnectedSeats = {};
    if (this.room.botReplacement === undefined) this.room.botReplacement = false;
    // A game saved by an older deploy: let the module bring it up to date and
    // check it can still be served. If not, start the room over rather than
    // leave it throwing on every view, move and alarm with no way to reset.
    if (this.room.state != null) {
      try {
        if (this.game.migrate) this.room.state = this.game.migrate(this.room.state);
        this.game.seatToAct(this.room.state!);
        this.game.redact(this.room.state!, null, this.meta());
      } catch (err) {
        console.error("[room] saved game can't be loaded; resetting to a lobby:", err);
        this.room = this.freshLobby();
        await this.persist();
      }
    }
    // A running game with no human seat left (frozen by an older deploy) can
    // never resume or be reset by anyone: reopen it as a lobby.
    if (this.inProgress() && !this.room.seats.some((s) => s.kind === "human")) {
      this.resetToLobby();
      await this.persist();
    }
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

  // Rooms speak WebSocket only; a plain HTTP request has nothing to see here.
  async onRequest(_req: Request): Promise<Response> {
    return new Response("Not found", { status: 404 });
  }

  async onMessage(conn: Connection<ConnState>, raw: string | ArrayBuffer) {
    let msg: ClientMessage<Config, Move>;
    try {
      const size = typeof raw === "string" ? raw.length : raw.byteLength;
      if (size > MAX_FRAME) throw new Error("too large");
      const parsed: unknown = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
      if (!isObject(parsed) || typeof parsed.t !== "string") throw new Error("not a message");
      msg = parsed as ClientMessage<Config, Move>;
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
    if (seat === null || seat === undefined || this.room.seats[seat]?.kind !== "human") return;
    // A late close from a superseded socket (a reload, a network switch, a
    // second tab): the player still has an open connection on this seat, so
    // nothing was abandoned.
    if (this.liveSeats(conn).has(seat)) return;
    if (this.inProgress()) {
      const otherHumans = this.room.seats.filter((s, i) => i !== seat && s.kind === "human").length;
      if (otherHumans > 0) {
        // Mark as disconnected so the host can see and act.
        this.room.disconnectedSeats[seat] = true;
        if (this.room.botReplacement) {
          // Auto-replace after 60 s; human can still reconnect and reclaim before then.
          this.room.pendingBotSeats[seat] = Date.now() + BOT_REPLACE_DELAY_MS;
        }
        this.ensureHost(conn);
        const log = this.resolveOrphanGate(conn);
        await this.persist();
        await this.resolveBotsAndBroadcast();
        this.sendLog(log);
      }
      // else: sole human — game pauses until they reconnect; no bot takeover.
    } else {
      this.room.seats[seat] = { kind: "empty", name: null };
      this.dropPidsAt(seat); // the seat is free now: coming back is a fresh join
      this.ensureHost(conn);
      await this.persist();
      this.broadcastViews();
    }
  }

  // ---------- handlers ----------

  private async handleJoin(conn: Connection<ConnState>, rawPid: unknown, rawName: unknown) {
    // pids key a plain object, so refuse anything Object.prototype answers to.
    if (typeof rawPid !== "string" || !PID_RE.test(rawPid) || rawPid in Object.prototype) throw new Error("Bad player id");
    const pid = rawPid;
    const name = typeof rawName === "string" ? rawName.trim().slice(0, MAX_NAME) : "";
    if (conn.state && conn.state.pid !== pid) throw new Error("Already joined");
    let seat = Object.hasOwn(this.room.pidSeats, pid) ? this.room.pidSeats[pid] : null;
    // Reclaim only a seat that is still this player's: a stale mapping must
    // never hand a seat someone else now holds to a second player.
    if (seat !== null && (!this.room.seats[seat] || this.liveConns(conn).some((c) => c.state?.seat === seat && c.state.pid !== pid))) {
      delete this.room.pidSeats[pid];
      seat = null;
    }
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
        this.assignSeat(pid, seat);
      }
    }
    conn.setState({ pid, name, seat });
    this.ensureHost();
    await this.persist();
    this.broadcastViews();
  }

  private async handleSit(conn: Connection<ConnState>, rawSeat: unknown) {
    if (this.room.state) throw new Error("Game already in progress");
    const st = conn.state;
    if (!st) throw new Error("Join the room first");
    const seat = this.seatArg(rawSeat);
    if (this.room.seats[seat].kind !== "empty") throw new Error("Seat is taken");
    const old = st.seat;
    if (old !== null) this.room.seats[old] = { kind: "empty", name: null }; // vacate old seat
    this.room.seats[seat] = { kind: "human", name: st.name };
    this.assignSeat(st.pid, seat);
    if (old !== null && old === this.room.hostSeat) this.room.hostSeat = seat; // the host moves with them
    conn.setState({ ...st, seat });
    for (const c of this.liveConns(conn)) if (c.state?.pid === st.pid) c.setState({ ...c.state, seat }); // their other tabs follow
    this.ensureHost();
    await this.persist();
    this.broadcastViews();
  }

  private async handleLeave(conn: Connection<ConnState>) {
    const st = conn.state;
    if (!st || st.seat === null) return;
    const seat = st.seat;
    if (this.inProgress()) {
      const otherHumans = this.room.seats.filter((s, i) => i !== seat && s.kind === "human").length;
      if (otherHumans === 0) {
        // The last human is leaving: start over as an open lobby rather than
        // leave a running game nobody could ever join, finish or reset.
        this.resetToLobby();
        await this.persist();
        this.broadcastViews();
        return;
      }
      this.room.seats[seat] = { kind: "bot", name: this.room.seats[seat].name };
    } else {
      this.room.seats[seat] = { kind: "empty", name: null };
    }
    delete this.room.pendingBotSeats[seat];
    delete this.room.disconnectedSeats[seat];
    this.dropPidsAt(seat);
    // They left from every tab: none of their sockets may keep driving the seat.
    for (const c of this.getConnections<ConnState>()) if (c.state?.seat === seat) c.setState({ ...c.state, seat: null });
    conn.setState({ ...st, seat: null });
    this.ensureHost();
    const log = this.resolveOrphanGate();
    await this.persist();
    await this.resolveBotsAndBroadcast();
    this.sendLog(log);
  }

  private requireHost(conn: Connection<ConnState>, message = "Only the host can do that") {
    if (conn.state?.seat == null || conn.state.seat !== this.room.hostSeat) {
      throw new Error(message);
    }
  }

  // A seat index from a client message: an integer naming a seat at this table.
  private seatArg(seat: unknown): number {
    if (typeof seat !== "number" || !Number.isInteger(seat) || seat < 0 || seat >= this.room.seats.length) {
      throw new Error("No such seat");
    }
    return seat;
  }

  private async handleAddBot(conn: Connection<ConnState>, rawSeat: unknown) {
    this.requireHost(conn);
    if (this.room.state) throw new Error("Add bots from the lobby, before the game starts");
    const seat = this.seatArg(rawSeat);
    if (this.room.seats[seat].kind !== "empty") throw new Error("Seat is occupied");
    const taken = new Set<string>(this.room.seats.map((x) => x.name).filter((n): n is string => !!n));
    this.room.seats[seat] = { kind: "bot", name: pickBotName(taken) };
    await this.persist();
    this.broadcastViews();
  }

  private async handleRemoveBot(conn: Connection<ConnState>, rawSeat: unknown) {
    this.requireHost(conn);
    if (this.room.state) throw new Error("Bots can't be removed once the game has started");
    const seat = this.seatArg(rawSeat);
    if (this.room.seats[seat].kind !== "bot") throw new Error("That seat is not a bot");
    this.room.seats[seat] = { kind: "empty", name: null };
    await this.persist();
    this.broadcastViews();
  }

  // The lobby config is the current one with the client's fields merged over
  // it, accepted only if the table size is supported and the module can deal
  // it (a dry-run createGame throws with the module's own message). Nothing is
  // mutated here, so a rejected config leaves the room as it was.
  private mergedConfig(patch: unknown): Config {
    const next: Record<string, unknown> = { ...(this.room.config as object) };
    if (isObject(patch)) {
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

  // Resize the lobby to n seats without losing anyone: seats below n keep their
  // occupant, and each human beyond the new size moves to the first empty seat
  // (or displaces a bot). `moved` maps a displaced human's old seat to the new
  // one, or null when the table is full of humans (they become a spectator).
  // Bots that were in seats beyond the new size are simply dropped.
  private resizedSeats(n: number): { seats: SeatInfo[]; moved: Map<number, number | null> } {
    const old = this.room.seats;
    const seats: SeatInfo[] = emptySeats(n);
    for (let s = 0; s < Math.min(n, old.length); s++) seats[s] = old[s];
    const moved = new Map<number, number | null>();
    for (let s = n; s < old.length; s++) {
      if (old[s].kind !== "human") continue;
      let free = seats.findIndex((x) => x.kind === "empty");
      if (free === -1) free = seats.findIndex((x) => x.kind === "bot");
      if (free !== -1) seats[free] = old[s];
      moved.set(s, free === -1 ? null : free);
    }
    return { seats, moved };
  }

  // Commit a resize from resizedSeats. Pid mappings, the host, and every live
  // connection's seat follow the humans that moved, so nobody is left driving
  // (or watching the hand of) an index that is no longer theirs.
  private commitSeats(seats: SeatInfo[], moved: Map<number, number | null>) {
    const n = seats.length;
    const where = (s: number): number | null => (s < n ? s : (moved.get(s) ?? null));
    const pidSeats: Record<string, number> = {};
    for (const [pid, s] of Object.entries(this.room.pidSeats)) {
      const ns = s < n ? (this.room.seats[s]?.kind === "human" ? s : null) : where(s);
      if (ns !== null) pidSeats[pid] = ns;
    }
    for (const c of this.getConnections<ConnState>()) {
      const st = c.state;
      if (!st || st.seat === null) continue;
      const ns = where(st.seat);
      if (ns !== st.seat) c.setState({ ...st, seat: ns });
    }
    if (this.room.hostSeat !== null) this.room.hostSeat = where(this.room.hostSeat);
    this.room.seats = seats;
    this.room.pidSeats = pidSeats;
    this.ensureHost();
  }

  private async handleSetConfig(conn: Connection<ConnState>, patch: unknown) {
    this.requireHost(conn);
    if (this.room.state) throw new Error("Can't resize the table once the game has started");
    const config = this.mergedConfig(patch);
    const { seats, moved } = this.resizedSeats(this.game.seatCount(config));
    this.room.config = config;
    this.commitSeats(seats, moved);
    await this.persist();
    this.broadcastViews();
  }

  private async handleStart(conn: Connection<ConnState>, patch: unknown) {
    if (this.room.state) throw new Error("Game already in progress");
    this.requireHost(conn, "Only the host can start the game");
    const config = this.mergedConfig(patch);
    // Resize the table, keeping seated humans and lobby bots; every empty seat
    // becomes a bot. This is what fills a short table on deal.
    const { seats, moved } = this.resizedSeats(this.game.seatCount(config));
    const taken = new Set<string>(seats.map((x) => x.name).filter((n): n is string => !!n));
    for (let s = 0; s < seats.length; s++) {
      if (seats[s].kind !== "empty") continue;
      const name = pickBotName(taken);
      taken.add(name);
      seats[s] = { kind: "bot", name };
    }
    // Deal first: nothing is committed unless the module accepts the config.
    const state = this.reseeded(this.game.createGame(config, randomSeed()));
    this.transitions++;
    this.room.config = config;
    this.commitSeats(seats, moved);
    this.room.state = state;
    this.room.pendingBotSeats = {};
    this.room.disconnectedSeats = {};
    await this.persist();
    await this.resolveBotsAndBroadcast(); // bots act if a bot leads off
  }

  private async handleMove(conn: Connection<ConnState>, move: Move) {
    const state = this.room.state;
    if (!state) throw new Error("No game in progress");
    const seat = this.actingSeat(conn);
    if (typeof move !== "object" || move === null) throw new Error("Illegal move");
    if (this.game.seatToAct(state) !== seat) throw new Error("It is not your turn");
    if (move.seat !== seat) throw new Error("Seat mismatch");
    if (!this.game.isLegal(state, move)) throw new Error("Illegal move");

    const afterMove = this.transition(state, move);
    this.room.state = this.game.openHumanGate?.(afterMove, move) ?? afterMove;
    const log = this.handRecord(state, this.room.state);
    await this.persist();
    await this.resolveBotsAndBroadcast();
    this.sendLog(log);
  }

  // A seated human taps a pacing gate (e.g. a completed trick) to skip its wait.
  // Silently ignored when there is nothing to advance (a double tap, or a tap
  // racing the auto-advance) or the gate belongs to another seat (advanceSeat).
  // The auto-advance alarm covers the case where nobody taps.
  private async handleAdvance(conn: Connection<ConnState>) {
    const state = this.room.state;
    const seat = conn.state?.seat;
    if (!state || seat == null || this.room.seats[seat]?.kind !== "human" || this.game.isOver(state)) return;
    const pace = this.game.pacing ? this.game.pacing(state) : null;
    if (!pace || !pace.move) return;
    if (pace.advanceSeat != null && pace.advanceSeat !== seat) return;
    this.room.state = this.transition(state, pace.move);
    const log = this.handRecord(state, this.room.state);
    await this.persist();
    await this.resolveBotsAndBroadcast();
    this.sendLog(log);
  }

  private async handleAux(conn: Connection<ConnState>, payload: unknown) {
    const state = this.room.state;
    if (!state) throw new Error("No game in progress");
    if (!this.game.aux) throw new Error("This game has no side actions");
    const seat = this.actingSeat(conn);
    this.room.state = this.game.aux.apply(state, seat, payload);
    await this.persist();
    // An aux action can clear a gate (e.g. HLJ's confidence pick clears
    // pendingSignal), which changes who is to act. Re-arm the bot alarm rather
    // than only broadcasting, or play freezes until the safety-net alarm fires.
    await this.resolveBotsAndBroadcast();
  }

  // The seat a connection may act for: it must be seated, and the seat must
  // still be a human's (not handed to a bot while this socket lingered).
  private actingSeat(conn: Connection<ConnState>): number {
    const seat = conn.state?.seat;
    if (seat === null || seat === undefined) throw new Error("You are not seated");
    if (this.room.seats[seat]?.kind !== "human") throw new Error("You are no longer seated");
    return seat;
  }

  private async handleNewGame(conn: Connection<ConnState>) {
    if (this.inProgress()) throw new Error("Game still in progress");
    this.requireHost(conn, "Only the host can start a new game");
    this.room.state = null;
    this.room.pendingBotSeats = {};
    this.room.disconnectedSeats = {};
    // Return bots to empty seats so humans can re-seat in the lobby, and free
    // the seats of humans who are no longer connected (a lobby only holds
    // present players). A freed seat's pid mapping goes too, so whoever takes
    // it next can't be displaced by the old owner coming back.
    const live = this.liveSeats();
    this.room.seats = this.room.seats.map((s, i) => {
      if (s.kind === "empty" || (s.kind === "human" && live.has(i))) return s;
      this.dropPidsAt(i);
      return { kind: "empty", name: null };
    });
    this.ensureHost();
    await this.persist();
    this.broadcastViews();
  }

  private async handleSetBotReplacement(conn: Connection<ConnState>, enabled: unknown) {
    this.requireHost(conn);
    if (typeof enabled !== "boolean") throw new Error("Bad request");
    this.room.botReplacement = enabled;
    if (!enabled) {
      // Cancel any scheduled replacements.
      this.room.pendingBotSeats = {};
    }
    await this.persist();
    this.broadcastViews();
  }

  private async handleReplaceSeat(conn: Connection<ConnState>, rawSeat: unknown) {
    this.requireHost(conn, "Only the host can replace a seat");
    if (!this.inProgress()) throw new Error("No game in progress");
    const seat = this.seatArg(rawSeat);
    if (!Object.hasOwn(this.room.disconnectedSeats, seat) || this.room.seats[seat].kind !== "human") {
      throw new Error("That player is not disconnected");
    }
    this.botTakesSeat(seat);
    this.ensureHost();
    const log = this.resolveOrphanGate();
    await this.persist();
    await this.resolveBotsAndBroadcast();
    this.sendLog(log);
  }

  // ---------- seats + host ----------

  // Open connections, optionally ignoring one (a socket that is closing).
  private liveConns(except?: Connection<ConnState>): Connection<ConnState>[] {
    return [...this.getConnections<ConnState>()].filter((c) => !except || c.id !== except.id);
  }

  // Seats held by an open connection.
  private liveSeats(except?: Connection<ConnState>): Set<number> {
    const seats = new Set<number>();
    for (const c of this.liveConns(except)) if (c.state?.seat != null) seats.add(c.state.seat);
    return seats;
  }

  // Give `seat` to `pid`, dropping any other (stale) claim on it, so a seat
  // never belongs to two players.
  private assignSeat(pid: string, seat: number) {
    this.dropPidsAt(seat);
    this.room.pidSeats[pid] = seat;
  }

  private dropPidsAt(seat: number) {
    for (const [pid, s] of Object.entries(this.room.pidSeats)) if (s === seat) delete this.room.pidSeats[pid];
  }

  // The host is a seated human with an open connection. Whenever the host seat
  // is vacated, handed to a bot, or its human disconnects, hosting passes to
  // the lowest seat whose human is connected (or to nobody, until someone sits).
  private ensureHost(except?: Connection<ConnState>) {
    const live = this.liveSeats(except);
    const ok = (s: number) => live.has(s) && this.room.seats[s]?.kind === "human";
    const h = this.room.hostSeat;
    if (h !== null && ok(h)) return;
    const next = this.room.seats.findIndex((_, s) => ok(s));
    this.room.hostSeat = next === -1 ? null : next;
  }

  // Hand a seat to a bot, keeping the player's name (and their pid mapping, so
  // they can still come back and reclaim it). A socket still bound to the seat
  // stops driving it and gets a spectator view.
  private botTakesSeat(seat: number) {
    this.room.seats[seat] = { kind: "bot", name: this.room.seats[seat].name };
    delete this.room.pendingBotSeats[seat];
    delete this.room.disconnectedSeats[seat];
    for (const c of this.getConnections<ConnState>()) if (c.state?.seat === seat) c.setState({ ...c.state, seat: null });
  }

  // No human is left at a running table: back to an open lobby (same size and
  // options), with every connection a spectator until they sit.
  private resetToLobby() {
    this.room.state = null;
    this.room.seats = emptySeats(this.room.seats.length);
    this.room.pidSeats = {};
    this.room.hostSeat = null;
    this.room.pendingBotSeats = {};
    this.room.disconnectedSeats = {};
    for (const c of this.getConnections<ConnState>()) if (c.state?.seat != null) c.setState({ ...c.state, seat: null });
  }

  // A gate only one seat may advance (pacing's advanceSeat) must not wait on a
  // seat no connected human holds any more (they left, were replaced, or
  // dropped): apply it now. Returns the finished-hand record, if any.
  private resolveOrphanGate(except?: Connection<ConnState>): object | null {
    const s = this.room.state;
    if (!s || !this.game.pacing || this.game.isOver(s) || this.game.seatToAct(s) !== null) return null;
    const pace = this.game.pacing(s);
    if (!pace || !pace.move || pace.advanceSeat == null) return null;
    const owner = pace.advanceSeat;
    if (this.room.seats[owner]?.kind === "human" && !this.room.disconnectedSeats[owner] && this.liveSeats(except).has(owner)) return null;
    this.room.state = this.transition(s, pace.move);
    return this.handRecord(s, this.room.state);
  }

  // ---------- bots + broadcast ----------

  private inProgress(): boolean {
    return this.room.state !== null && !this.game.isOver(this.room.state);
  }

  protected isBot(seat: number): boolean {
    return this.room.seats[seat]?.kind === "bot";
  }

  // Fresh shuffle entropy for the module, when it takes any.
  private reseeded(state: State): State {
    return this.game.reseed ? this.game.reseed(state, freshEntropy()) : state;
  }

  // Every transition (human, bot, or pacing advance) goes through here, so the
  // next deal can't be predicted from anything a client has seen.
  private transition(state: State, move: Move): State {
    this.transitions++;
    return this.game.applyMove(this.reseeded(state), move);
  }

  // After any state change: broadcast the new view, then let bots/timers act.
  private async resolveBotsAndBroadcast() {
    this.broadcastViews();
    await this.scheduleNextAlarm();
  }

  // The driver's next timed step for state s, if any: a bot's move, or the
  // auto-advance of a pacing gate.
  private nextStep(s: State): { key: string; ms: number; apply: () => State } | null {
    if (this.game.isOver(s)) return null;
    const seat = this.game.seatToAct(s);
    if (seat !== null) {
      if (!this.isBot(seat)) return null; // a human is to act → wait for their move
      const raw = this.game.botStepMs;
      const ms = typeof raw === "function" ? raw(s) : (raw ?? BOT_STEP_MS);
      return { key: `${this.transitions}:bot:${seat}`, ms, apply: () => this.botMove(s, seat) };
    }
    // No seat to act and not over → a pacing gate (e.g. trickComplete). Schedule
    // the auto-advance; a human stack-tap can advance sooner via handleAdvance.
    const pace = this.game.pacing ? this.game.pacing(s) : null;
    if (!pace || !pace.move) return null;
    const hasHuman = this.room.seats.some((x) => x?.kind === "human");
    if (pace.kind !== "auto" && hasHuman) return null; // "wait" with a human present → wait for the tap
    const move = pace.move;
    return { key: `${this.transitions}:gate`, ms: pace.ms, apply: () => this.transition(s, move) };
  }

  private botMove(s: State, seat: number): State {
    let ns: State = s;
    if (this.game.aux?.botAux) {
      const a = this.game.aux.botAux(ns, seat);
      if (a != null) ns = this.game.aux.apply(ns, seat, a);
    }
    return this.transition(ns, this.game.aiMove(ns, seat));
  }

  // nextStep plus when it is due: from when it first became pending (see
  // stepTimer), or now if `dueNow`.
  private timedStep(dueNow = false): { at: number; apply: () => State } | null {
    const s = this.room.state;
    const step = s ? this.nextStep(s) : null;
    if (!step) {
      this.stepTimer = null;
      return null;
    }
    const t = this.stepTimer;
    const at = t && t.key === step.key ? t.at : Date.now() + (dueNow ? 0 : step.ms);
    this.stepTimer = { key: step.key, at };
    return { at, apply: step.apply };
  }

  // Single alarm slot covers both pending bot-replacements and bot move steps.
  private async scheduleNextAlarm() {
    let next: number | null = null;
    for (const t of Object.values(this.room.pendingBotSeats)) {
      next = next === null ? t : Math.min(next, t);
    }
    const step = this.timedStep();
    if (step) next = next === null ? step.at : Math.min(next, step.at);
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }

  // Fired by the runtime on our scheduled alarm. Handles two cases in order:
  //   1. Any pending bot replacements whose delay has expired.
  //   2. A single bot move (or gate auto-advance), if its own time has come.
  async onAlarm() {
    const now = Date.now();
    const woke = this.stepTimer === undefined;

    // 1. Flush expired bot-replacement timers.
    let replacedAny = false;
    for (const [seatStr, t] of Object.entries(this.room.pendingBotSeats)) {
      if (now >= t) {
        const seat = +seatStr;
        if (this.room.seats[seat]?.kind === "human") {
          this.botTakesSeat(seat);
          replacedAny = true;
        }
        delete this.room.pendingBotSeats[seat];
        delete this.room.disconnectedSeats[seat];
      }
    }
    let gateLog: object | null = null;
    if (replacedAny) {
      if (this.room.state && !this.room.seats.some((s) => s.kind === "human")) {
        // The last human was replaced: don't let bots play on to an empty room.
        this.resetToLobby();
        await this.persist();
        this.broadcastViews();
        return;
      }
      this.ensureHost();
      gateLog = this.resolveOrphanGate();
    }

    // 2. Bot move step / pacing gate auto-advance.
    const prev = this.room.state;
    const step = this.timedStep(woke);
    if (prev && step && Date.now() >= step.at - ALARM_SLACK_MS) {
      const next = step.apply();
      this.room.state = next;
      const log = this.handRecord(prev, next);
      await this.persist();
      this.broadcastViews();
      await this.scheduleNextAlarm();
      this.sendLog(gateLog);
      this.sendLog(log);
      return;
    }

    if (replacedAny) {
      await this.persist();
      await this.resolveBotsAndBroadcast();
      this.sendLog(gateLog);
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

  // The game-log record for a transition that finished a hand, else null.
  // Built at once (it snapshots who sat where) but sent with sendLog only
  // after everyone has the new view.
  private handRecord(prev: State, next: State): object | null {
    try {
      const rec = this.game.loggableHand?.(prev, next);
      if (!rec) return null;
      return { ...(rec as object), ts: new Date().toISOString(), seatKinds: this.room.seats.map((s) => s.kind) };
    } catch (err) {
      console.error("[gamelog] building the record failed:", err);
      return null;
    }
  }

  // Fire-and-forget append to the shared GameLog: never awaited and never
  // throws, so a slow or failing log can't delay or abort a hand.
  private sendLog(rec: object | null) {
    if (!rec || !this.env.GameLog) return;
    try {
      const stub = this.env.GameLog.get(this.env.GameLog.idFromName("singleton"));
      const done = Promise.resolve(stub.append(JSON.stringify(rec))).catch((err) => {
        console.error("[gamelog] append failed:", err);
      });
      this.ctx.waitUntil?.(done);
    } catch (err) {
      console.error("[gamelog] append failed:", err);
    }
  }
}

function emptySeats(n: number): SeatInfo[] {
  return Array.from({ length: n }, () => ({ kind: "empty", name: null }));
}

// How long to pause between bot moves, so a watching human sees each one.
// A relaxed pace lets each draw, meld, and discard register before the next.
const BOT_STEP_MS = 2400;
const BOT_REPLACE_DELAY_MS = 60_000; // 1 minute grace period before auto bot-replacement
const ALARM_SLACK_MS = 50; // an alarm this close to a step's due time runs it

// Client input limits. No legitimate message comes near MAX_FRAME; names match
// the client's input (maxlength 24); pids are crypto.randomUUID() or p_<base36><ms>.
const MAX_FRAME = 16_384;
const MAX_NAME = 24;
const PID_RE = /^[\w-]{1,64}$/;
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Deal seeds and shuffle entropy come from the platform CSPRNG.
function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}
function freshEntropy(): number[] {
  return Array.from(crypto.getRandomValues(new Uint32Array(4)));
}

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
