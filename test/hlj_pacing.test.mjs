// HLJ pacing / trick-gate regression guard.
// Run from the repo root:  node test/hlj_pacing.test.mjs
//
// Verifies the SERVER contract the client refactor depends on:
//   - bots play strictly one card at a time (no batching)
//   - every completed trick is observable as a `trickComplete` view holding the
//     full N-card trick + a trickWinner (never resolved/cleared atomically)
//   - the game never snaps to gameOver: the view immediately before the first
//     gameOver is always a trickComplete gate
//   - the game completes (no stall)
//
// It does NOT exercise the browser client; it asserts the local.js engine+driver.

import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// local.js ships as ESM but the repo has no package.json "type":"module",
// so copy it to a .mjs in tmp and import that.
const tmp = join(tmpdir(), `hlj_local_${Date.now()}.mjs`);
writeFileSync(tmp, readFileSync("public/local.js", "utf8"));

// Compress every timer so a full bot game runs instantly while preserving order.
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
globalThis.setTimeout = (fn) => { Promise.resolve().then(fn); return 0; };

const { createLocalSocket } = await import("file://" + tmp);

const sock = createLocalSocket("high-low-jack");
const views = [];
sock.onmessage = ({ data }) => {
  const m = JSON.parse(data);
  if (m.t === "view" && m.view && m.view.phase) views.push(m.view);
};
await new Promise((r) => (sock.onopen = r));

// All-bot 4-player table.
sock.send(JSON.stringify({ t: "join", name: "Tester" }));
sock.send(JSON.stringify({ t: "sit", seat: 0 }));
for (let s = 1; s < 4; s++) sock.send(JSON.stringify({ t: "addBot", seat: s }));
sock.send(JSON.stringify({ t: "leave" }));
sock.send(JSON.stringify({ t: "addBot", seat: 0 }));
sock.send(JSON.stringify({ t: "start", config: { players: 4, target: 21 } }));

// Drain: poll on the REAL clock until the view stream stops growing.
let last = -1;
for (let stable = 0; stable < 5; ) {
  await new Promise((r) => realSetTimeout(r, 5));
  if (views.length === last) stable++; else { stable = 0; last = views.length; }
}

rmSync(tmp, { force: true });

const seq = views.map((v) => ({ ph: v.phase, n: (v.currentTrick || []).length, w: v.trickWinner }));
let gates = 0, badGate = 0, badJump = 0, multi = 0;
for (let i = 0; i < seq.length; i++) {
  const cur = seq[i], prev = seq[i - 1];
  if (cur.ph === "trickComplete") { gates++; if (cur.n !== 4 || cur.w == null) badGate++; }
  if (prev && prev.ph === "playing" && cur.ph === "playing" && prev.n === 3 && cur.n === 0) badJump++;
  if (prev && prev.ph === "playing" && (cur.ph === "playing" || cur.ph === "trickComplete") && cur.n > prev.n + 1) multi++;
}
const firstOver = seq.findIndex((s) => s.ph === "gameOver");
const beforeOver = firstOver > 0 ? seq[firstOver - 1] : null;

const checks = [
  ["reached gameOver (no stall)", firstOver !== -1],
  ["trick gates observed", gates > 0],
  ["every gate holds a full 4-card trick + winner", badGate === 0],
  ["no atomic 3->0 resolves inside playing", badJump === 0],
  ["bots play one card at a time (no batching)", multi === 0],
  ["first gameOver preceded by a trickComplete gate", beforeOver && beforeOver.ph === "trickComplete"],
];

let ok = true;
for (const [name, pass] of checks) { console.log(`${pass ? "PASS" : "FAIL"}  ${name}`); if (!pass) ok = false; }
console.log(`\n${gates} gates across ${seq.length} views`);
if (!ok) { console.error("\nREGRESSION: backend contract broken."); process.exit(1); }
console.log("\nAll backend-contract checks passed.");
