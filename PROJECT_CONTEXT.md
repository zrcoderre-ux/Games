# Parlor — Combined Online Card-Game App — Context Handoff

This document is a complete briefing for a new assistant picking up this project. It assumes you have the repo files but none of the prior conversation.

---

## 1. What this is

A multiplayer, browser-based card-game app that currently hosts **four games**:

- **High Low Jack (HLJ)** — a partnership Pitch variant (bid, pick trump, take trump tricks, score High/Low/Jack/Joker/Game). 4/6/8 players, two teams by seat parity.
- **Rummy 500** — draw/meld/lay-off/discard, race to a point target (default 500). 2–8 players.
- **Hearts ("Black Lady")** — avoid hearts and the Q♠; pass 3 each hand (left/right/across/hold); shoot the moon. 3/4/5 players, lowest score wins (default target 100).
- **Pegs & Jokers** — partnership marble race on a pegged board; jokers bump, sevens split, come out on A/K/Joker. 4 or 6 players, partners by seat parity (default 5 marbles).

> **Merge note (current state):** HLJ + Rummy (with the move log, `setConfig`, the morph client, and `preview.html`) were built in one lineage; Hearts + Pegs & Jokers were built in another. They have been merged: the Hearts/PJ modules now carry the same authoritative move log, the client renders all four games through the morph engine with the Log sheet, and `wrangler.jsonc` declares all four Durable Objects (migrations v1–v4). A previously-latent client bug was fixed in the merge: the Pegs & Jokers party id is `pegs-and-jokers` (the kebab-cased binding name), not `pegsandjokers`.

It runs on **Cloudflare Workers + Durable Objects** (one DO instance per room) using the **PartyServer** library (`partyserver`). The Worker also serves a static vanilla-JS client. Players connect over WebSocket; the server is the sole rules authority and sends each client only its own redacted view.

Deployment identity: Cloudflare account user `zrcoderre-ux`, GitHub repo `Games`, deployed Worker name `cardgames`. The owner tests primarily on iPhone (mobile-first matters).

---

## 2. Architecture (the load-bearing design decision)

**A game is a PURE module** implementing a generic interface; a **generic room server hosts any module** and contains zero game rules.

- `src/game.ts` — the generic seam. Defines `Game<State, Move, Config, View>`, the generic `ClientMessage`/`ServerMessage`, `SeatInfo`/`RoomMeta`/`SeatedMove`, and the shared **`LogEntry`/`LogCard`** types. Nothing here knows about trump, melds, teams, etc.
- `src/room-server.ts` — abstract `RoomServer` (extends partyserver `Server`, `static options = { hibernate: true }`). Owns everything game-independent: seats, stable `pid → seat` reconnect, host election, lobby add/remove bot, lobby resize (`setConfig`), hibernation/persistence (persists the whole `room` to `ctx.storage` under key `"room"`), **paced bot play**, and per-seat redaction. Delegates all rules to `this.game`.
- `src/worker.ts` — the single entry point. One ~3-line DO subclass per game + combined `Env` + `routePartykitRequest`. **Adding a game = new pure module + a tiny subclass + a wrangler binding/migration; you never touch `room-server.ts`.**

### Paced bots (important for UX)
Bots play **one move at a time on a timer**, not all at once, so a watching human sees each card. `resolveBotsAndBroadcast()` broadcasts the current state, then `scheduleBotStep()` sets a Durable Object alarm `Date.now() + BOT_STEP_MS`. `onAlarm()` applies exactly one bot move, broadcasts, and reschedules if the next seat is also a bot. `BOT_STEP_MS = 1400` (ms). Bot display names come from a `BOT_NAMES` pool via `pickBotName(taken)` so the table doesn't read "Bot 1 / Bot 2"; bots are intentionally indistinguishable from humans in-game (only the lobby labels them).

---

## 3. Repo layout

All deliverables live under `/mnt/user-data/outputs/` in this environment.

```
wrangler.jsonc          name "cardgames", main "src/worker.ts",
                        compat 2026-05-01 + nodejs_compat,
                        assets:{ directory:"./public", run_worker_first:["/parties/*"] },
                        2 DO bindings + migrations v1, v2
package.json, tsconfig.json, .gitignore, README.md
src/
  worker.ts             DO subclasses (HighLowJack, Rummy500, Hearts, PegsAndJokers) + Env + fetch
  room-server.ts        generic RoomServer (hosting, reconnect, bots, persistence)
  game.ts               generic Game interface + wire protocol + LogEntry/LogCard
  hlj-module.ts         HLJ as a Game module (adapter over engine/ai/protocol) + move log
  rummy-module.ts       Rummy 500 as a pure Game module + move log
  hearts-module.ts      Hearts as a pure Game module + move log
  pj-module.ts          Pegs & Jokers as a pure Game module (board + cards) + move log
  engine.ts             HLJ pure rules engine
  ai.ts, ai-sim.ts      HLJ bot (Monte Carlo bidding + card play) + handConfidence
  protocol.ts           HLJ redact() + PlayerView (+ legacy advanceBots/stepBot, superseded)
  local-room.ts         the room run in-browser (offline / pass-and-play), bundled via
  client-local.ts         `npm run build` into public/local.js (generated — never hand-edit)
  rummy.smoke.ts        Rummy full-game fuzz/smoke (2–8p, requireDiscard on/off, mixed bot levels)
  hearts.smoke.ts       Hearts full-game smoke (3/4/5p; scoring + conservation invariants)
  pj.smoke.ts           Pegs & Jokers full-game smoke (4p/6p; invariants every move)
  ai.battle.ts          HLJ paired-seed bot battle harness (A vs B, or --roundrobin)
  rummy.battle.ts       Rummy paired-seed bot battle harness (baseline moves illegal under the new rules are substituted and counted; --strict)
  hearts.battle.ts      Hearts paired-seed bot battle harness (--mode solo|duo, --workers, --timing)
test/
  signals.test.ts, lead-and-signals.test.ts   HLJ node:test suites
  regressions.test.ts   fixed-bug regressions (LocalRoom config merge, HLJ signal gate, Rummy/Hearts rules, reseed)
  hlj_pacing.test.mjs   HLJ trick-gate pacing contract through the offline bundle
public/                 static client served by the Worker
  index.html            shell: fonts (Fraunces + Hanken Grotesk), #toast, #app, module script
  styles.css            full cozy-parlor theme + table/log/team styles
  app.js                vanilla ES-module client (render + networking)
preview.html            standalone visual preview (NOT shipped) — see §6
```

---

## 4. Critical invariants (do not break)

- **Party ids are kebab-cased binding names.** PartyServer derives the URL party id from the DO *binding* name. Bindings are `HighLowJack`, `Rummy500`, `Hearts`, `PegsAndJokers`, so the client MUST connect with party ids **`high-low-jack`**, **`rummy500`**, **`hearts`**, **`pegs-and-jokers`** (NOT `highlowjack` / `pegsandjokers`). The client's `GAMES` object keys are exactly these strings. A mismatch here caused a "Connecting… forever" bug historically — and the Pegs & Jokers key was wrong (`pegsandjokers`) before the merge fixed it.
- **Client WebSocket URL:** `${wss|ws}//${location.host}/parties/${party}/${encodeURIComponent(room)}`.
- **Client identity:** persists `cg_pid` and `cg_name` in `localStorage`; sends `{t:"join", pid, name}` on open. Same pid reclaims the same seat on reconnect.
- **Workers Builds gotcha (historical):** the project files must be at the **repo root** and on the deployed **branch** (`main`); otherwise the build can't find the static dir. The owner has deployed successfully.
- **Redaction is the anti-cheat boundary.** A view must never leak other hands, the stock contents/order, or the HLJ kitty. `protocol.redact` (HLJ) and `redact` in `rummy-module.ts` whitelist fields explicitly — never spread raw state into a view.
- **The move log is public and safe** (only ever describes public events), so it is sent unredacted to everyone.

---

## 5. The two game modules

Both are pure (no runtime imports beyond types/helpers), deterministic via a seeded PRNG threaded through state (live rooms also fold fresh CSPRNG entropy into each deal via the optional `reseed`), and reused on the client for offline play.

- **HLJ (`hlj-module.ts`)** is a thin adapter over `engine.ts`/`ai.ts`/`protocol.ts`. Its state type is `HljState = GameState & { log: LogEntry[]; logSeq: number; botSeed?: number }` (exported; used by the Worker subclass). Config `{ players: 4|6|8, target, bestOf? }`. Teams are `seat % 2` (Team A = even seats, Team B = odd), so partners always sit **across** the table — the "teammates don't sit adjacent" convention holds by construction.
- **Rummy (`rummy-module.ts`)** is fully self-contained Rummy 500: 2–8 players, one deck for 2–4 / two decks for 5–8, every card has a unique `id`; each deck carries 2 wild jokers. `RummyState` carries `log`/`logSeq`. A turn = draw → any melds/lay-offs → discard; a card drawn from the discard (`mustMeldCardId`) must be used before discarding.

---

## 6. UI — "Warm cozy parlor" (the chosen aesthetic)

Walnut wood frame around green baize, brass/gold accents, cream cards with depth. Brand: the **BONHOMME!** wordmark (Bevan, purple with a gold stroke) and the purple jester hat (`joker-hat.png`, cropped to its artwork in CSS via `--hat-size`/`--hat-pos`). Type: Bevan (brand + card faces), Fraunces (headings, numbers), Hanken Grotesk (UI). Mobile-first. All colors, radii and fonts are tokens at the top of `styles.css` (§1); the stylesheet is organised in numbered sections listed in its header comment.

Layout is a **real table**: opponents are "pods" around the felt (a stack of team-colored card backs — or an avatar in Hearts — over a name plate; the plate turns gold on their turn; dealer / bid chips sit on the stack's inner corner, an HLJ confidence signal on its outer corner; a dropped player's plate shows an "away" chip and the host gets a Replace button); your fanned hand rides over the bottom of the felt; the center shows the trick (HLJ/Hearts), stock + discard + melds (Rummy) or the board (P&J).

### Two table layouts (CSS-driven, mirrored in JS by `isRails()`)
- **Stacked** (portrait): top bar (Leave · game/room · HLJ scores · Log) → felt (flex: 1) → dock (hand, player bar, actions + hint). The hand overlaps the felt by `--hand-overlap`; everything on the felt lives in `.felt-stage`, which stops `--stage-bottom` above the felt's bottom edge so nothing sits under the hand.
- **Rails** (any landscape: phones, iPad, desktop): `.table` becomes a CSS grid and the top bar / dock wrappers are `display: contents`, so each control lands in a named grid area — left rail: Leave, settings, you, Team A score; right rail: Log, Invite, actions, Team B score. The felt spans the full height; the hand peeks over its bottom edge (`--hand-sink`, 0 on tall screens).
- JS layout math (pod insets, trick oval, bid-token positions, hand card width in `handMetrics()`/`fanHand()`) branches on `isRails()`; keep it in step with the CSS breakpoints. The app re-renders on resize/orientation change.

Selected cards (Rummy meld/lay-off/discard, Hearts pass) lift **in place** via the CSS `translate` property (composes with each card's inline fan rotation) — there is no separate "selected row", so the dock height never jumps. Newly drawn/received cards get a temporary `.fresh` highlight. Leaving mid-game asks for confirmation. Hints are hidden on short / landscape screens except rule reasons (`.hint.key`: a forced Rummy card, Must discard). Spectators see the table from seat 0's chair (seat 0's pod takes the bottom slot). Results pages (hand/round/game over) keep Leave and the move log reachable.

### Rendering uses in-place DOM morphing (don't regress this)
`app.js` renders whole screens as HTML strings, but instead of `innerHTML =` it routes through a tiny **morph** engine: `app.__set = html` (a defined setter) → `patch(html)` → `morphList(app, template.content)` walks and patches nodes in place. This was added deliberately to **kill flashing** (the whole DOM was being recreated on every server update, replaying entrance animations) and to let CSS transitions actually tween (card positions glide; turn glow fades between pods). When editing render code, keep assigning through `app.__set` so morphing is preserved. Animation timings were also slowed (card transform ~0.34s, trick entrance ~0.5s, deal stagger ~0.55s) and bot pacing raised to 1400ms.

### Team clarity (HLJ)
Team A = red (`--teamA`), Team B = blue (`--teamB`): opponent card backs and name-plate dots are team-colored, your avatar shows your team letter, and the A/B score pills (top bar / rail corners) outline your team.

### `preview.html`
A standalone, directly-openable file (real `styles.css` inlined; real `app.js` render functions embedded with `init()` stripped and networking stubbed) with a bottom toolbar to flip between Start / Lobby / HLJ bid / HLJ play / HLJ last trick / Rummy / Game over, plus the in-app "Log" button. It's a visual sanity tool for the owner — it is **not** part of the deployed app, and it must be regenerated whenever `app.js`/`styles.css` or the mock view shapes change (it embeds copies). **It predates the current design** (it embeds the old two-game client) and needs regenerating before it's useful again.

---

## 7. The move log (authoritative, server-owned)

The headline of the most recent work: a rock-solid, server-authoritative move log (an earlier client-side reconstruction from view-diffs was replaced).

- Shared type in `game.ts`: `LogEntry = { id: number; seat: number|null; msg: string; cards?: LogCard[]; suit?: string; tail?: string }`. `seat` is the actor (client resolves the name; `null` = table/system event). No names are stored, so renames don't corrupt history.
- Each module **appends entries inside its `applyMove`**, computed by diffing the before/after state. Because every `engine.ts` transition is a `{ ...state }` spread, the `log`/`logSeq` fields ride through trick resolution, hand scoring, and new deals untouched — `engine.ts` was NOT modified. HLJ wraps `engineApplyMove` and re-attaches the log; Rummy renamed its internal transition to `applyMoveCore` and exposes `applyMoveWithLog`. HLJ caps stored entries at `LOG_CAP = 600`, the other modules at 120.
- `redact` ships `log` in the view (`PlayerView.log` for HLJ, `RummyView.log` for Rummy). Because the log lives in game state, it **persists across hibernation** and is identical for every client, including reconnects. Bot and human moves are logged identically (both flow through `applyMove`).
- HLJ captures: deals, bids/passes, bid winner, trump (called or set by the lead), every play, each trick winner, and the full hand breakdown (made/set, High/Low/Jack/Joker/Game by team, running score, next dealer or game winner). Rummy captures: draws (stock vs. a named card taken from the discard, "+N more" when scooping a run), melds/lay-offs with actual cards, discards, "goes out (+N this round)", "wins the game!".
- Client: `view.log` drives a slide-up "Log" sheet (newest first); `logEntryHTML()` renders `name + msg + suit + cards + tail`. The HLJ **last-trick** panel reads the already-authoritative `view.lastTrick` (`{ winner, cards }`).

---

## 8. How to verify changes (no browser available)

The container has Node 22, `tsc`, `wrangler`, `tsx`, and `jsdom`; npm and GitHub are reachable. Set up a scratch project to type-check and dry-run:

1. **Type-check:** copy `src/` + `wrangler.jsonc` into a project with deps (`partyserver`, `typescript`, `@cloudflare/workers-types`, `wrangler`) and run `npx tsc --noEmit`. Must be clean.
2. **Dry-run deploy:** `npx wrangler deploy --dry-run` — must register both Durable Objects (`HighLowJack` / `Rummy500`).
3. **Tests:** `npm test` (Node 22 runs `.ts` directly) runs the node:test suites in `test/`, the HLJ pacing test against a fresh bundle of `src/client-local.ts`, and the Rummy/Hearts/Pegs & Jokers smoke tests (many complete bot games, asserting card conservation and that every AI move is legal). `npm run typecheck` covers the Worker code; Node-only scripts are excluded in `tsconfig.json`. CI runs the bundle staleness check, the type-check and `npm test`.
4. **Bot strength:** `node src/ai.battle.ts --a ./src/hlj-module.ts --b <baseline>/hlj-module.ts --players 4,6,8 --seeds 500`, `node src/rummy.battle.ts --a ./src/rummy-module.ts --b <baseline>/rummy-module.ts --players 4 --seeds 300` and `node src/hearts.battle.ts --a ./src/hearts-module.ts --b <baseline>/hearts-module.ts --players 4 --seeds 200` play paired seeds (each deal from both sides) and print win rates (Hearts also points per hand) with 95% CIs; `node src/hearts.battle.ts --timing --players 4 --seeds 50` measures Hearts bot latency.
5. **Headless render of the client:** install `jsdom`, stub globals, strip the trailing `init();` from `app.js`, and drive `render()` against mock views. Gotchas: in Node 22 `navigator` is a read-only global (set `window`/`document`/`location`/`history`/`WebSocket`/`crypto`/`localStorage` individually, skip `navigator`); `WebSocket` and `localStorage` need trivial stubs. This catches runtime errors in render code without a browser. (Don't try Puppeteer — the Chromium download host is outside the network allowlist.)

---

## 9. Deployment notes (tell the owner after edits)

- **Server logic changed** (anything under `src/`): the Worker must be redeployed — push to `main` (Workers Builds) or `npx wrangler deploy`.
- **Client changed** (`public/app.js` / `public/styles.css` / `public/index.html`): these are **assets**; republish and **hard-refresh on the phone** (asset caching).
- The log lives in game state, so a deploy mid-hand won't back-fill history for moves already made in that in-flight hand; it populates from the next move (and from the first deal of any new game). Nothing breaks.

---

## 10. Known gaps / sensible next steps (deferred)

- Auto-open or flash the Log sheet when a hand/round is scored, so the breakdown is hard to miss.
- Per-card seat attribution in the HLJ last-trick panel — needs a small `engine.ts` change to store each trick's `plays` (seat+card); currently `tricksWon` keeps only the winner seat + cards, so the panel shows cards + "won by X" without per-card names. (The full move log already gives per-seat attribution.)
- Prune now-unused exports in `protocol.ts` (`advanceBots`, `stepBot`, the legacy `ClientMessage`) — superseded by the generic server, but `redact`/`PlayerView` are still used by `hlj-module.ts`.
- Bots only advance when an alarm is scheduled; with no humans connected nothing drives them (acceptable).

---

## 11. Environment constraints for the working assistant

- Read-only mounts: `/mnt/user-data/uploads`, `/mnt/skills/*`, `/mnt/transcripts`. Write deliverables to `/mnt/user-data/outputs/`.
- `create_file` fails if the path already exists — overwrite via `bash` heredoc (`cat > file <<'EOF' … EOF`) or use `str_replace`.
- Network allowlist permits npm/PyPI/GitHub/crates; it does **not** include general web or Google storage (so headless Chromium downloads fail — use `jsdom`).
- The owner is on mobile; keep the UI mobile-first and test against narrow widths.
- Before creating/editing files or writing code, consult the relevant `/mnt/skills/public/*/SKILL.md` (e.g. `frontend-design` for any UI work).
