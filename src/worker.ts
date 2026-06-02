// worker.ts — the single worker entry. It holds every game's Durable Object
// subclass, the combined Env, and the shared routing. Each subclass is just the
// generic RoomServer parameterized with a pure game module plus a lobby default
// — that is the entire cost of adding a game here.

import { routePartykitRequest } from "partyserver";
import { RoomServer } from "./room-server.ts";

import { hljModule, type HLJConfig } from "./hlj-module.ts";
import type { GameState, Move } from "./engine.ts";
import type { PlayerView } from "./protocol.ts";

import { rummy500Module, type RummyConfig, type RummyState, type RummyMove, type RummyView } from "./rummy-module.ts";
import { heartsModule, type HeartsConfig, type HeartsState, type HeartsMove, type HeartsView } from "./hearts-module.ts";

export interface Env {
  HighLowJack: DurableObjectNamespace<HighLowJackServer>;
  Rummy500: DurableObjectNamespace<Rummy500Server>;
  Hearts: DurableObjectNamespace<HeartsServer>;
}

export class HighLowJackServer extends RoomServer<GameState, Move, HLJConfig, PlayerView, Env> {
  readonly game = hljModule;
  protected defaultConfig(): HLJConfig {
    return { players: 4, target: 21 };
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

// routePartykitRequest dispatches by the party name in the URL to the matching
// binding (/parties/highlowjack/<room>, /parties/rummy500/<room>,
// /parties/hearts/<room>), so this stays identical as you add games.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (await routePartykitRequest(request, env)) || new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
