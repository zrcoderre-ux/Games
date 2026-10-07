// worker.ts — the single worker entry. It holds every game's Durable Object
// subclass, the combined Env, and the shared routing. Each subclass is just the
// generic RoomServer parameterized with a pure game module plus a lobby default
// — that is the entire cost of adding a game here.

import { routePartykitRequest } from "partyserver";
import { RoomServer } from "./room-server.ts";

import { hljModule, type HLJConfig, type HljState } from "./hlj-module.ts";
import type { Move } from "./engine.ts";
import type { PlayerView } from "./protocol.ts";

import { rummy500Module, type RummyConfig, type RummyState, type RummyMove, type RummyView } from "./rummy-module.ts";
import { heartsModule, type HeartsConfig, type HeartsState, type HeartsMove, type HeartsView } from "./hearts-module.ts";
import { pegsAndJokersModule, type PJConfig, type PJState, type PJMove, type PJView } from "./pj-module.ts";
import { GameLogServer } from "./gamelog-server.ts";

export { GameLogServer };

export interface Env {
  HighLowJack: DurableObjectNamespace<HighLowJackServer>;
  Rummy500: DurableObjectNamespace<Rummy500Server>;
  Hearts: DurableObjectNamespace<HeartsServer>;
  PegsAndJokers: DurableObjectNamespace<PegsAndJokersServer>;
  GameLog: DurableObjectNamespace<GameLogServer>;
}

export class HighLowJackServer extends RoomServer<HljState, Move, HLJConfig, PlayerView, Env> {
  readonly game = hljModule;
  protected defaultConfig(): HLJConfig {
    return { players: 6, target: 21 };
  }
}

export class Rummy500Server extends RoomServer<RummyState, RummyMove, RummyConfig, RummyView, Env> {
  readonly game = rummy500Module;
  protected defaultConfig(): RummyConfig {
    return { players: 4, target: 500 };
  }
}

export class HeartsServer extends RoomServer<HeartsState, HeartsMove, HeartsConfig, HeartsView, Env> {
  readonly game = heartsModule;
  protected defaultConfig(): HeartsConfig {
    return { players: 4, target: 100 };
  }
}

export class PegsAndJokersServer extends RoomServer<PJState, PJMove, PJConfig, PJView, Env> {
  readonly game = pegsAndJokersModule;
  protected defaultConfig(): PJConfig {
    return { players: 4, marbles: 5 };
  }
}

// Game ids a finished-hand record may carry (each module's loggableHand uses its meta.id).
const LOG_GAMES = new Set([hljModule, rummy500Module, heartsModule, pegsAndJokersModule].map((m) => m.meta.id));
const OFFLINE_RECORD_MAX_BYTES = 128 * 1024; // HLJ records (with the hand's log) run to ~50 KB

// Read a request body as text, giving up (null) once it passes maxBytes.
async function readCapped(request: Request, maxBytes: number): Promise<string | null> {
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
  return new TextDecoder().decode(bytes);
}

// Client-side offline games POST completed hands here. Public, so accept only
// a size-capped JSON object for a known game, marked offline.
async function appendOffline(request: Request, env: Env): Promise<Response> {
  const body = await readCapped(request, OFFLINE_RECORD_MAX_BYTES);
  if (body === null) return new Response("Too large", { status: 413 });
  let rec: unknown;
  try { rec = JSON.parse(body); } catch { return new Response("Bad record", { status: 400 }); }
  if (typeof rec !== "object" || rec === null || Array.isArray(rec)) return new Response("Bad record", { status: 400 });
  const { game, offline } = rec as { game?: unknown; offline?: unknown };
  if (typeof game !== "string" || !LOG_GAMES.has(game) || offline !== true) return new Response("Bad record", { status: 400 });
  await env.GameLog.get(env.GameLog.idFromName("singleton")).append(body);
  return new Response("ok");
}

// routePartykitRequest dispatches by the party name in the URL to the matching
// binding (/parties/high-low-jack/<room>, /parties/rummy500/<room>,
// /parties/hearts/<room>, /parties/pegs-and-jokers/<room>), so this stays identical as you add games.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/gamelog/append-offline") {
      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
      return appendOffline(request, env);
    }
    // The feed itself is read-only from outside: rooms append over the binding.
    if (url.pathname === "/gamelog" || url.pathname.startsWith("/gamelog/")) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
      }
      const stub = env.GameLog.get(env.GameLog.idFromName("singleton"));
      return stub.fetch(request);
    }
    // GameLog is a binding too, so routePartykitRequest would expose it as
    // /parties/game-log/<name>; only the game rooms are public.
    const [prefix, party] = url.pathname.split("/").filter(Boolean);
    if (prefix === "parties" && party === "game-log") return new Response("Not Found", { status: 404 });
    return (await routePartykitRequest(request, env)) || new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
