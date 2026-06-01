# card-games

A combined online card-game app on Cloudflare Workers + Durable Objects (one
Durable Object instance per room) via [PartyServer]. Two games today — **High
Low Jack** (a Pitch variant) and **Rummy 500** — share one room engine.

## Architecture

A game is a **pure module** (no runtime imports) implementing the `Game<State,
Move, Config, View>` contract in `src/game.ts`: deal, turn order, move legality,
state transition, per-seat redaction, and a heuristic AI. The generic
`RoomServer` base in `src/room-server.ts` hosts any such module — it owns seats,
reconnects (stable `pid` → seat), host election, lobby bot add/remove, bot fill,
hibernation/persistence, and per-seat broadcast — and delegates every rule to
the module. `src/worker.ts` is the single Worker entry: one thin Durable Object
subclass per game plus shared routing.

Adding a game = one new pure module + a ~4-line `RoomServer` subclass in
`worker.ts` + one binding and one migration in `wrangler.jsonc`. `game.ts` and
`room-server.ts` do not change.

```
src/
  worker.ts         Worker entry: DO subclasses (HighLowJackServer, Rummy500Server) + routing
  room-server.ts    Generic RoomServer base (room machinery)
  game.ts           Game<> interface + room types + wire protocol
  hlj-module.ts     High Low Jack as a pure module (adapter over engine/ai/protocol)
  rummy-module.ts   Rummy 500 as a pure module
  engine.ts         HLJ rules engine
  ai.ts             HLJ heuristic AI
  protocol.ts       HLJ redact() + PlayerView
  signals.test          HLJ tests
  lead-and-signals.test HLJ tests
  rummy.smoke.ts    Rummy bot-vs-bot smoke test (run with `node`)
```

Routing is by party name: `/parties/highlowjack/<room>` and
`/parties/rummy500/<room>`.

## Develop

```sh
npm install
npm run typecheck      # tsc --noEmit
npm run test:rummy     # node src/rummy.smoke.ts
npm run dev            # wrangler dev
npm run deploy         # wrangler deploy
npm run cf-typegen     # regenerate worker-configuration.d.ts after binding changes
```

Requires Node 22+ (the smoke test relies on built-in TypeScript type-stripping).

[PartyServer]: https://github.com/cloudflare/partyserver
