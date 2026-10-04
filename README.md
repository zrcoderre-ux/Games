# card-games

A combined online card-game app on Cloudflare Workers + Durable Objects (one
Durable Object instance per room) via [PartyServer]. Four games today — **High
Low Jack** (a Pitch variant), **Rummy 500**, **Hearts**, and **Pegs & Jokers** — share one room engine.

## Architecture

A game is a **pure module** (no runtime imports) implementing the `Game<State,
Move, Config, View>` contract in `src/game.ts`: deal, turn order, move legality,
state transition, per-seat redaction, and a bot AI. The generic
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
  worker.ts         Worker entry: one DO subclass per game + routing
  room-server.ts    Generic RoomServer base (room machinery)
  local-room.ts     The same room run in the browser for offline / pass-and-play
  client-local.ts   Offline bundle entry -> public/local.js (`npm run build`; never edit local.js)
  game.ts           Game<> interface + room types + wire protocol
  hlj-module.ts     High Low Jack as a pure module (adapter over engine/ai/protocol)
  rummy-module.ts   Rummy 500 as a pure module (jokers wild; bot AI included)
  hearts-module.ts  Hearts as a pure module
  pj-module.ts      Pegs and Jokers as a pure module (board + cards)
  engine.ts         HLJ rules engine
  ai.ts, ai-sim.ts  HLJ bot: Monte Carlo bidding and card play
  protocol.ts       HLJ redact() + PlayerView
  *.smoke.ts        Rummy / Hearts / Pegs & Jokers full-game smoke tests (run with `node`)
  *.battle.ts       Paired-seed bot-vs-bot battle harnesses (HLJ, Rummy)
test/
  *.test.ts         node:test suites (HLJ signals and bidding, fixed-bug regressions)
  hlj_pacing.test.mjs  HLJ trick-gate pacing contract, driven through the offline bundle
```

Routing is by party name: `/parties/high-low-jack/<room>`, `/parties/rummy500/<room>`,
`/parties/hearts/<room>`, and `/parties/pegs-and-jokers/<room>`.

## Develop

```sh
npm install
npm run typecheck      # tsc --noEmit (Worker code; Node-only scripts are excluded)
npm test               # node:test suites + pacing test + Rummy/Hearts/P&J smoke tests
npm run build          # rebuild public/local.js from src/client-local.ts (commit the result)
npm run dev            # wrangler dev
npm run deploy         # wrangler deploy
npm run cf-typegen     # regenerate worker-configuration.d.ts after binding changes
```

Requires Node 22+ (the tests and scripts rely on built-in TypeScript type-stripping).
CI (`.github/workflows/check-local-bundle.yml`) fails a stale `public/local.js`, then
runs the type-check and `npm test`.

Bot battle harnesses (paired seeds, so card luck cancels; see each file's header):

```sh
node src/ai.battle.ts --a ./src/hlj-module.ts --b <baseline>/hlj-module.ts --players 4,6,8 --seeds 500
node src/ai.battle.ts --roundrobin --players 4 --seeds 300      # HLJ personalities vs each other
node src/rummy.battle.ts --a ./src/rummy-module.ts --b <baseline>/rummy-module.ts --players 4 --seeds 300
```

[PartyServer]: https://github.com/cloudflare/partyserver
