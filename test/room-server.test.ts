// RoomServer seat, host and alarm regressions: reconnects keep their seat and
// the host role, seats nobody is connected to (a restart drops sockets with no
// close) can be replaced or are freed, and step timing survives hibernation.
// partyserver needs the Workers runtime, so it is swapped for a stand-in with
// just what RoomServer uses; Durable Object storage and sockets are faked.
// Run with `npm test` (or `node --test test/room-server.test.ts`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

const stub = "export class Server { constructor(ctx, env) { this.ctx = ctx; this.env = env; } getConnections() { return this.ctx.conns.filter((c) => c.open); } }";
const hooks = `export async function resolve(spec, context, next) {
  return spec === "partyserver" ? { url: ${JSON.stringify("data:text/javascript," + encodeURIComponent(stub))}, shortCircuit: true } : next(spec, context);
}`;
register("data:text/javascript," + encodeURIComponent(hooks));
const { RoomServer } = await import("../src/room-server.ts");
const { hljModule } = await import("../src/hlj-module.ts");
const { heartsModule } = await import("../src/hearts-module.ts");
const { rummy500Module } = await import("../src/rummy-module.ts");

// A controllable clock: alarms are fired by moving it to the alarm's time.
let now = Date.now();
Date.now = () => now;

const GAMES: Record<string, [any, any]> = {
  hlj: [hljModule, { players: 4, target: 21 }],
  hearts: [heartsModule, { players: 4, target: 100 }],
  rummy: [rummy500Module, { players: 4, target: 500 }],
};

class Conn {
  static n = 0;
  id = `c${++Conn.n}`;
  open = true;
  state: any = null;
  frames: any[] = [];
  setState(s: any) { this.state = structuredClone(s); return this.state; }
  send(m: string) { this.frames.push(JSON.parse(m)); }
  view() { return this.frames.filter((f) => f.t === "view").at(-1)?.view; }
  errors() { return this.frames.filter((f) => f.t === "error").map((f) => f.message); }
}

class Ctx {
  store = new Map<string, unknown>();
  alarm: number | null = null;
  conns: Conn[] = [];
  storage = {
    get: async (k: string) => structuredClone(this.store.get(k)),
    put: async (k: string, v: unknown) => { this.store.set(k, structuredClone(v)); },
    setAlarm: async (t: number) => { this.alarm = t; },
    deleteAlarm: async () => { this.alarm = null; },
  };
  waitUntil() {}
}

// A room instance on `ctx`'s storage and sockets: a fresh one stands in for a
// wake from hibernation.
async function open(kind: string, ctx = new Ctx()): Promise<any> {
  const [mod, config] = GAMES[kind];
  class Room extends (RoomServer as any) {
    game = mod;
    defaultConfig() { return structuredClone(config); }
  }
  const room: any = new (Room as any)(ctx, {});
  await room.onStart();
  return room;
}
// A restart or deploy: every socket dies with no close, and a new instance
// loads the saved room.
function restart(kind: string, room: any) {
  for (const c of room.ctx.conns) c.open = false;
  return open(kind, room.ctx);
}
async function join(room: any, pid: string, name = pid): Promise<Conn> {
  const c = new Conn();
  room.ctx.conns.push(c);
  await room.onMessage(c, JSON.stringify({ t: "join", pid, name }));
  return c;
}
const send = (room: any, c: Conn, m: object) => room.onMessage(c, JSON.stringify(m));
async function drop(room: any, c: Conn) {
  c.open = false;
  await room.onClose(c);
}
async function fireAt(room: any, t: number) {
  now = t;
  await room.onAlarm();
}

// ---------- reconnects keep the seat and the host role ----------

test("a lobby reload gets the picked seat and the host role back", async () => {
  const room = await open("hlj");
  const alice = await join(room, "A", "Alice");
  const bob = await join(room, "B", "Bob");
  await send(room, alice, { t: "sit", seat: 3 });
  assert.equal(alice.view().you, 3);
  await drop(room, alice); // the old socket's close beats the new page's join
  assert.equal(room.room.hostSeat, 1, "Bob hosts while Alice is away");
  const alice2 = await join(room, "A", "Alice");
  assert.equal(alice2.state.seat, 3);
  assert.equal(room.room.hostSeat, 3);
  assert.equal(bob.view().hostSeat, 3);
  assert.deepEqual(room.room.seats.map((s: any) => s.kind), ["empty", "human", "empty", "human"]);
});

test("a freed lobby seat is never reclaimed from someone who has taken it", async () => {
  const room = await open("hearts");
  const alice = await join(room, "A", "Alice");
  const bob = await join(room, "B", "Bob");
  await drop(room, bob);
  const carol = await join(room, "C", "Carol");
  assert.equal(carol.state.seat, 1, "Carol takes Bob's free seat");
  const bob2 = await join(room, "B", "Bob");
  assert.equal(bob2.state.seat, 2);
  assert.equal(carol.state.seat, 1);
  // A bot added to a seat held for a player who dropped is not given back either.
  await drop(room, bob2);
  await send(room, alice, { t: "addBot", seat: 2 });
  const bob3 = await join(room, "B", "Bob");
  assert.equal(bob3.state.seat, 3);
  assert.equal(room.room.seats[2].kind, "bot");
});

test("a host who drops mid-game gets the role back on returning", async () => {
  const room = await open("hearts");
  const alice = await join(room, "A", "Alice");
  await join(room, "B", "Bob");
  await send(room, alice, { t: "start", config: {} });
  await drop(room, alice);
  assert.equal(room.room.hostSeat, 1);
  assert.deepEqual(room.meta().disconnectedSeats, [0]);
  const alice2 = await join(room, "A", "Alice");
  assert.equal(alice2.state.seat, 0);
  assert.equal(room.room.hostSeat, 0);
  assert.deepEqual(room.meta().disconnectedSeats, []);
});

test("after a finished game everyone reconnects to their own seat and the host can deal again", async () => {
  const room = await open("hearts");
  const alice = await join(room, "A", "Alice");
  const bob = await join(room, "B", "Bob");
  await send(room, alice, { t: "start", config: {} });
  room.room.state = { ...room.room.state, phase: "gameOver" };
  await drop(room, alice);
  await drop(room, bob);
  assert.deepEqual(room.room.seats.map((s: any) => s.name).slice(0, 2), ["Alice", "Bob"], "a close keeps finished seats");
  const bob2 = await join(room, "B", "Bob"); // Bob's phone wakes first
  const alice2 = await join(room, "A", "Alice");
  assert.equal(bob2.state.seat, 1);
  assert.equal(alice2.state.seat, 0);
  assert.equal(room.room.hostSeat, 0);
  await send(room, alice2, { t: "newGame" });
  assert.deepEqual(alice2.errors(), []);
  assert.equal(room.room.state, null);
  assert.deepEqual(room.room.seats.map((s: any) => s.kind), ["human", "human", "empty", "empty"]);
});

// ---------- seats nobody is connected to ----------

test("after a restart mid-game, a player who doesn't come back can be replaced", async () => {
  let room = await open("rummy");
  const alice = await join(room, "A", "Alice");
  await join(room, "B", "Bob");
  await send(room, alice, { t: "setBotReplacement", enabled: true });
  await send(room, alice, { t: "start", config: {} });
  room = await restart("rummy", room);
  assert.deepEqual(room.meta().disconnectedSeats, [], "nothing is flagged before anyone is back");
  const alice2 = await join(room, "A", "Alice");
  assert.equal(room.room.hostSeat, 0);
  assert.deepEqual(room.meta().disconnectedSeats, [1]);
  assert.equal(room.room.pendingBotSeats[1], now + 60_000, "the replacement timer runs");
  await send(room, alice2, { t: "replaceSeat", seat: 1 });
  assert.deepEqual(alice2.errors(), []);
  assert.equal(room.room.seats[1].kind, "bot");
  await send(room, alice2, { t: "replaceSeat", seat: 0 });
  assert.deepEqual(alice2.errors(), ["That player is not disconnected"]);
});

test("after a restart in the lobby, a player who doesn't come back is not dealt in", async () => {
  let room = await open("hearts");
  await join(room, "A", "Alice");
  await join(room, "B", "Bob");
  room = await restart("hearts", room);
  const alice = await join(room, "A", "Alice");
  await send(room, alice, { t: "start", config: {} });
  assert.deepEqual(alice.errors(), []);
  assert.deepEqual(room.room.seats.map((s: any) => s.kind), ["human", "bot", "bot", "bot"]);
  const bob = await join(room, "B", "Bob");
  assert.equal(bob.state.seat, null, "Bob watches the game he missed");
});

test("the last connected player leaving resets the room even if a disconnected seat remains", async () => {
  const room = await open("hearts");
  const alice = await join(room, "A", "Alice");
  const bob = await join(room, "B", "Bob");
  await send(room, alice, { t: "start", config: {} });
  await drop(room, bob);
  await send(room, alice, { t: "leave" });
  assert.equal(room.room.state, null);
  assert.ok(room.room.seats.every((s: any) => s.kind === "empty"));
  const carol = await join(room, "C", "Carol");
  assert.equal(carol.state.seat, 0);
  assert.equal(room.room.hostSeat, 0);
});

// ---------- step timing across hibernation ----------

// HLJ 4p with Alice at seat 0 and Bob at seat 1, bot replacement on, on a
// fixed deal where Bob bids first; his bid of 2 opens the 30 s signal gate.
async function hljGate() {
  const room = await open("hlj");
  const alice = await join(room, "A", "Alice");
  const bob = await join(room, "B", "Bob");
  await send(room, alice, { t: "setBotReplacement", enabled: true });
  await send(room, alice, { t: "start", config: {} });
  room.room.state = hljModule.createGame({ players: 4, target: 21 }, 4); // dealer 0, seat 1 opens
  assert.equal(hljModule.seatToAct(room.room.state), 1);
  return { room, alice, bob };
}

test("the HLJ signal gate keeps its full 30 s when a replacement comes due during it, across hibernation", async () => {
  let { room, alice, bob } = await hljGate();
  const t0 = now;
  await drop(room, alice); // her replacement is due at t0 + 60 s
  now = t0 + 40_000;
  await send(room, bob, { t: "move", move: { type: "bid", seat: 1, amount: 2 } });
  assert.equal(room.room.state.pendingSignal, true);
  assert.equal(room.ctx.alarm, t0 + 60_000);
  room = await open("hlj", room.ctx); // idle: evicted, then the alarm wakes a new instance
  await fireAt(room, t0 + 60_000);
  assert.equal(room.room.seats[0].kind, "bot");
  assert.equal(room.room.state.pendingSignal, true, "the gate is still open");
  assert.equal(room.ctx.alarm, t0 + 70_000);
  room = await open("hlj", room.ctx);
  await fireAt(room, t0 + 70_000);
  assert.equal(room.room.state.pendingSignal, false);
});

test("a close after a wake does not push the gate back, and a stale alarm does not end it early", async () => {
  let { room, alice, bob } = await hljGate();
  await send(room, bob, { t: "move", move: { type: "bid", seat: 1, amount: 2 } });
  const opened = now;
  assert.equal(room.ctx.alarm, opened + 30_000);
  now += 20_000;
  room = await open("hlj", room.ctx);
  await drop(room, alice);
  assert.equal(room.ctx.alarm, opened + 30_000, "still due 30 s after it opened");
  room = await open("hlj", room.ctx);
  await fireAt(room, opened + 25_000); // an alarm left over from something else
  assert.equal(room.room.state.pendingSignal, true);
  assert.equal(room.ctx.alarm, opened + 30_000);
});

test("the alarm is cleared when nothing is left to time", async () => {
  const { room, alice } = await hljGate();
  await drop(room, alice);
  assert.equal(room.ctx.alarm, now + 60_000, "armed for her replacement");
  await join(room, "A", "Alice"); // back in time: Bob is still to bid, nothing to time
  assert.equal(room.ctx.alarm, null);
});
