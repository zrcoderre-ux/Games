// client-local.ts — browser bundle entry for offline play.
//
// esbuild bundles this (and the pure game modules it pulls in) into
// public/local.js. It exposes createLocalSocket(party): a WebSocket-shaped
// object the client can use in place of a real socket, so app.js talks to an
// in-browser LocalRoom exactly the way it talks to the server. No build-time
// magic leaks into the client — same rules, same protocol, no network.

import { LocalRoom } from "./local-room.ts";
import type { Game, ClientMessage, ServerMessage } from "./game.ts";

import { hljModule } from "./hlj-module.ts";
import { rummy500Module } from "./rummy-module.ts";
import { heartsModule } from "./hearts-module.ts";
import { pegsAndJokersModule } from "./pj-module.ts";

// Keyed by the party id app.js uses (its GAMES keys), each with the same lobby
// default the worker's Durable Object subclass uses.
const REGISTRY: Record<string, { game: Game<any, any, any, any>; config: any }> = {
  rummy500: { game: rummy500Module, config: { players: 4, target: 500 } },
  "high-low-jack": { game: hljModule, config: { players: 6, target: 21 } },
  hearts: { game: heartsModule, config: { players: 4, target: 100 } },
  "pegs-and-jokers": { game: pegsAndJokersModule, config: { players: 4, marbles: 5 } },
};

// A minimal WebSocket look-alike (the subset app.js uses): readyState,
// onopen/onmessage/onclose, send(), close(). Messages flow synchronously
// through the LocalRoom; views come back via onmessage as JSON, just like the
// server's frames.
class LocalSocket {
  readyState = 0; // CONNECTING; becomes 1 (OPEN) after onopen
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private room: LocalRoom<any, any, any, any>;

  constructor(game: Game<any, any, any, any>, config: any) {
    this.room = new LocalRoom(game, config, (msg: ServerMessage<any>) => {
      this.onmessage?.({ data: JSON.stringify(msg) });
    });
    // Open on the next microtask so callers can attach handlers first.
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }

  send(data: string): void {
    let msg: ClientMessage<any, any>;
    try { msg = JSON.parse(data); } catch { return; }
    this.room.handle(msg);
  }

  close(): void {
    this.readyState = 3; // CLOSED
    this.room.close();
    this.onclose?.();
  }
}

export function createLocalSocket(party: string): LocalSocket {
  const entry = REGISTRY[party];
  if (!entry) throw new Error(`No offline game registered for "${party}"`);
  return new LocalSocket(entry.game, entry.config);
}
