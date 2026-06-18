// tutorial.js — guided practice-hand overlay for Bonhomme.
//
// A purely client-side teaching layer. It watches the same redacted `view`
// frames the client already renders (server OR offline LocalRoom) and shows a
// scripted sequence of pop-ups that point at real controls and explain the
// rules + app functions as a normal practice hand unfolds. It changes NO game
// rules and touches NO engine code: the practice hand is just an ordinary
// offline game vs bots, narrated.
//
// Integration (see HANDOFF.md): app.js sets Tutorial.active via the lobby
// "Practice hand" checkbox, calls Tutorial.start(party) when an offline game
// with that flag begins, Tutorial.onView(view) once per frame AFTER render(),
// and Tutorial.stop() when leaving.
//
// A "script" is an ordered list of steps. Each step:
//   id      unique string (shown once per practice hand)
//   when    (view, ctx) => bool   — fire this step when true
//   title   heading text
//   body    HTML string (explanation: rules AND/OR app function)
//   anchor  optional CSS selector to spotlight + point at (degrades to centered)
//   place   optional "above" | "below" | "center" (default: auto)
//   gate    "tap" (default) advance on the Next button;
//           "action" advance automatically when done() becomes true
//   done    (view, ctx) => bool   — required for gate:"action"
//   cta     optional Next-button label (tap gates)
//
// ctx carries small derived facts across frames (e.g. trick counts) so steps
// can detect transitions.

(function () {
  "use strict";

  // ---------- styles (injected once, self-contained) ----------
  const CSS = `
  .tut-ring{position:fixed;z-index:9000;border:2px solid #e6cf78;border-radius:12px;
    box-shadow:0 0 0 9999px rgba(6,18,12,.0),0 0 18px 3px rgba(230,207,120,.65),inset 0 0 12px rgba(230,207,120,.35);
    pointer-events:none;transition:all .22s cubic-bezier(.4,1.2,.5,1);animation:tutPulse 1.8s ease-in-out infinite}
  @keyframes tutPulse{0%,100%{box-shadow:0 0 16px 2px rgba(230,207,120,.5),inset 0 0 10px rgba(230,207,120,.3)}
    50%{box-shadow:0 0 24px 5px rgba(230,207,120,.8),inset 0 0 14px rgba(230,207,120,.45)}}
  .tut-card{position:fixed;z-index:9001;max-width:310px;width:calc(100vw - 32px);
    background:linear-gradient(158deg,#2c5a40,#1c4031);color:#eef3e6;
    border:1px solid rgba(230,207,120,.5);border-radius:16px;padding:16px 18px 14px;
    box-shadow:0 18px 44px -10px rgba(0,0,0,.8),inset 0 1px 0 rgba(255,255,255,.08),0 0 0 4px rgba(80,49,26,.4);
    font-family:"Hanken Grotesk",system-ui,sans-serif;animation:tutIn .26s ease both}
  @keyframes tutIn{from{opacity:0;transform:translateY(6px) scale(.98)}to{opacity:1;transform:none}}
  .tut-card h4{margin:0 0 6px;font-family:"Fraunces",Georgia,serif;font-weight:700;font-size:17px;
    color:#f0dd9a;letter-spacing:.01em}
  .tut-card p{margin:0;font-size:14px;line-height:1.5;color:rgba(238,243,230,.92)}
  .tut-card b{color:#f0dd9a;font-weight:600}
  .tut-foot{display:flex;align-items:center;justify-content:space-between;margin-top:13px;gap:10px}
  .tut-progress{font:600 11px/1 ui-monospace,monospace;letter-spacing:.06em;color:rgba(230,207,120,.7)}
  .tut-next{appearance:none;border:none;cursor:pointer;font-family:inherit;font-weight:700;font-size:14px;
    color:#241704;padding:9px 18px;border-radius:9px;
    background:linear-gradient(180deg,#ecd680,#d4b85a 55%,#b1973e);box-shadow:0 4px 10px rgba(0,0,0,.4)}
  .tut-next:active{transform:translateY(1px)}
  .tut-hint{margin-top:11px;font-size:12.5px;font-style:italic;color:rgba(230,207,120,.85);
    display:flex;align-items:center;gap:7px}
  .tut-hint::before{content:"";width:8px;height:8px;border-radius:50%;background:#e6cf78;
    box-shadow:0 0 8px #e6cf78;animation:tutPulse 1.4s ease-in-out infinite}
  .tut-skip{position:fixed;z-index:9001;top:max(10px,env(safe-area-inset-top));right:12px;
    appearance:none;border:1px solid rgba(230,207,120,.35);background:rgba(6,18,12,.6);color:rgba(238,243,230,.8);
    font:600 11px/1 ui-monospace,monospace;letter-spacing:.04em;padding:6px 10px;border-radius:999px;
    cursor:pointer;backdrop-filter:blur(4px)}
  `;
  function injectCSS() {
    if (document.getElementById("tut-style")) return;
    const s = document.createElement("style");
    s.id = "tut-style";
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  // ---------- engine state ----------
  const T = {
    active: false,      // set by the lobby checkbox; persists into the game
    running: false,     // a practice hand is in progress
    party: null,
    script: [],
    idx: 0,             // index of the next step not yet completed
    shown: false,       // current step's pop-up is on screen
    ctx: {},            // derived facts carried across frames
    root: null,         // overlay DOM container
    lastView: null,
  };

  function el(cls, tag) {
    const e = document.createElement(tag || "div");
    if (cls) e.className = cls;
    return e;
  }

  function ensureRoot() {
    if (T.root) return T.root;
    const r = el("tut-root");
    r.style.position = "fixed";
    r.style.inset = "0";
    r.style.zIndex = "9000";
    r.style.pointerEvents = "none"; // never block the game; children opt back in
    document.body.appendChild(r);
    const skip = el("tut-skip");
    skip.textContent = "Skip tutorial";
    skip.style.pointerEvents = "auto";
    skip.onclick = () => Tutorial.stop();
    r.appendChild(skip);
    T.root = r;
    return r;
  }

  function clearPopup() {
    if (!T.root) return;
    [...T.root.querySelectorAll(".tut-ring,.tut-card")].forEach((n) => n.remove());
  }

  // Compute card + ring geometry for a given anchor element (or null for centered).
  function geometry(anchorEl, card) {
    if (anchorEl) {
      const a = anchorEl.getBoundingClientRect();
      const pad = 6;
      const ch = card.offsetHeight || 150;
      const cw = card.offsetWidth || 300;
      const below = a.bottom + 12;
      const wantAbove = card._step?.place === "above" ||
        (below + ch > window.innerHeight - 12 && a.top - 12 - ch > 12);
      let top = wantAbove ? a.top - 12 - ch : below;
      top = Math.max(12, Math.min(top, window.innerHeight - ch - 12));
      let left = a.left + a.width / 2 - cw / 2;
      left = Math.max(12, Math.min(left, window.innerWidth - cw - 12));
      return {
        card: { top, left },
        ring: { left: a.left - pad, top: a.top - pad, width: a.width + pad * 2, height: a.height + pad * 2 },
      };
    } else {
      const cw = card.offsetWidth || 300;
      const ch = card.offsetHeight || 150;
      return { card: { top: Math.max(12, (window.innerHeight - ch) / 2), left: Math.max(12, (window.innerWidth - cw) / 2) } };
    }
  }

  // Build or update the spotlight ring + card. Pass repin=true to move existing
  // elements without tearing them down (avoids the tutIn animation flashing).
  function place(step, repin) {
    const r = ensureRoot();
    const anchorEl = step.anchor ? document.querySelector(step.anchor) : null;

    let card = repin ? T.root.querySelector(".tut-card") : null;
    let ring = repin ? T.root.querySelector(".tut-ring") : null;

    if (!card) {
      if (!repin) clearPopup();
      card = el("tut-card");
      card.style.pointerEvents = "auto";
      const total = T.script.length;
      card.innerHTML =
        `<h4>${step.title}</h4><p>${step.body}</p>` +
        (step.gate === "action"
          ? `<div class="tut-hint">${step.hint || "Your move — do it on the table to continue."}</div>`
          : `<div class="tut-foot"><span class="tut-progress">${T.idx + 1} / ${total}</span>` +
            `<button class="tut-next">${step.cta || (T.idx + 1 >= total ? "Finish" : "Next")}</button></div>`);
      card._step = step;
      r.appendChild(card);
      if (step.gate !== "action") {
        card.querySelector(".tut-next").onclick = () => advance();
      }
    }

    if (anchorEl && !ring) {
      ring = el("tut-ring");
      r.appendChild(ring);
    } else if (!anchorEl && ring) {
      ring.remove();
      ring = null;
    }

    // Position: update in-place (no style.animation reset needed).
    const geo = geometry(anchorEl, card);
    card.style.left = geo.card.left + "px";
    card.style.top = geo.card.top + "px";
    if (ring && geo.ring) {
      ring.style.left = geo.ring.left + "px";
      ring.style.top = geo.ring.top + "px";
      ring.style.width = geo.ring.width + "px";
      ring.style.height = geo.ring.height + "px";
    }
  }

  function advance() {
    T.idx += 1;
    T.shown = false;
    clearPopup();
    if (T.idx >= T.script.length) return Tutorial.stop();
    // Re-evaluate immediately against the current view so a chain of tap steps
    // can show back-to-back without waiting for the next frame.
    if (T.lastView) evaluate(T.lastView);
  }

  function evaluate(view) {
    if (!T.running || T.idx >= T.script.length) return;
    const step = T.script[T.idx];

    // Action-gated step already on screen: advance when its action is done.
    if (T.shown && step.gate === "action") {
      try {
        if (step.done && step.done(view, T.ctx)) return advance();
      } catch (_) {}
      // Repin the ring to the (possibly re-rendered) anchor without rebuilding.
      place(step, true);
      return;
    }

    // Tap-gated step already on screen: just repin without flashing.
    if (T.shown) {
      place(step, true);
      return;
    }

    // Not shown yet: skip stale steps (their phase passed), else fire on trigger.
    let skip = false;
    try { skip = step.skipWhen ? step.skipWhen(view, T.ctx) : false; } catch (_) {}
    if (skip) return advance();
    let fire = false;
    try { fire = step.when ? step.when(view, T.ctx) : true; } catch (_) { fire = false; }
    if (fire) {
      T.shown = true;
      place(step);
    }
  }

  // ---------- public API ----------
  const Tutorial = {
    get active() { return T.active; },
    set active(v) { T.active = !!v; },

    start(party) {
      injectCSS();
      T.party = party;
      T.script = (SCRIPTS[party] || []).slice();
      T.idx = 0;
      T.shown = false;
      T.ctx = {};
      T.lastView = null;
      T.running = T.script.length > 0;
      if (T.running) ensureRoot();
    },

    onView(view) {
      if (!T.running || !view) return;
      T.lastView = view;
      // Update carried context BEFORE evaluating (so transition detectors work).
      updateCtx(view);
      evaluate(view);
    },

    stop() {
      T.running = false;
      T.active = false;
      if (T.root) { T.root.remove(); T.root = null; }
    },

    // Re-pin on resize/scroll so the ring stays on its control.
    reflow() { if (T.running && T.shown) place(T.script[T.idx], true); },
  };

  function updateCtx(v) {
    const c = T.ctx;
    c.youBid = Array.isArray(v.bidHistory) && v.you != null
      ? v.bidHistory.some((b) => b.seat === v.you) : c.youBid;
    if (v.trump) c.trumpSeen = true;
    if (v.phase === "playing") c.playStarted = true;
  }

  window.addEventListener("resize", () => Tutorial.reflow());
  window.addEventListener("scroll", () => Tutorial.reflow(), true);

  // =====================================================================
  // SCRIPTS — per-game step sequences. High Low Jack first.
  // Field names follow the redacted PlayerView (see src/protocol.ts). If a
  // field name differs in the live view, adjust the predicates here only;
  // the engine above is game-agnostic.
  // =====================================================================
  const youTurnBidding = (v) => v.phase === "bidding" && v.yourTurn;
  const SCRIPTS = {
    "high-low-jack": [
      {
        id: "welcome",
        when: (v) => v.phase === "bidding",
        title: "Welcome to High Low Jack",
        body: "You and the player across from you are <b>partners</b> (Team A). The other seats are Team B. Each hand, one team bids for the right to name <b>trump</b>, then both teams fight for points. First team to the target score wins. Let's play one practice hand.",
        gate: "tap", cta: "Show me",
      },
      {
        id: "your-hand",
        when: () => true,
        anchor: ".fan-inner",
        place: "above",
        title: "Your hand",
        body: "These are your six cards. Cards rank <b>A K Q J 10 … 2</b>. You'll play exactly one card per trick. Strong cards in one suit are what you bid on.",
        gate: "tap",
      },
      {
        id: "log",
        when: () => true,
        anchor: "[data-action='toggle-log']",
        title: "The log",
        body: "Tap <b>Log</b> any time to review every bid, every card played, the trump called, and the hands that were dealt. Great for learning what happened.",
        gate: "tap",
      },
      {
        id: "bidding-rules",
        when: youTurnBidding,
        skipWhen: (v) => v.phase !== "bidding",
        anchor: ".hlj-bid-overlay",
        place: "above",
        title: "Bidding",
        body: "A bid is a promise: how many of the hand's points your team will capture (2–6). The <b>highest bidder names trump</b> and must take at least that many points — fall short and you're <b>set back</b> (the bid is subtracted from your score instead). Bidding <b>6 is an automatic win</b> — unless your team is in the hole (negative score) going into that hand.",
        gate: "tap",
      },
      {
        id: "place-bid",
        when: youTurnBidding,
        skipWhen: (v, c) => v.phase !== "bidding" || c.youBid === true,
        anchor: ".hlj-bid-overlay",
        place: "above",
        title: "Your bid",
        body: "Tap a number to bid, or <b>Pass</b>. Rule of thumb: bid if you hold high trump (Ace/King) or lots of one suit; otherwise pass and let the other team risk it.",
        hint: "Tap a bid or Pass to continue.",
        gate: "action",
        done: (v, c) => c.youBid === true || v.phase !== "bidding",
      },
      {
        id: "signals",
        when: (v) => v.pendingSignal === true,
        skipWhen: (v) => v.phase !== "bidding" && v.pendingSignal !== true,
        anchor: ".selfbar",
        place: "above",
        title: "Hand signals",
        body: "Because a teammate still has to bid, you may flash a <b>confidence signal</b> — a legal way to hint how strong your hand is. Pick <b>High</b>, <b>Medium</b>, or <b>Low</b>; your partner sees the badge and bids smarter. Opponents see it too, so it's a real tell.",
        hint: "Pick a signal to continue.",
        gate: "action",
        done: (v) => v.pendingSignal !== true,
      },
      {
        id: "read-signal",
        when: (v) => !v.pendingSignal && Array.isArray(v.signals) && v.signals.some((s) => s != null),
        skipWhen: (v) => (v.phase === "playing" || v.phase === "gameOver" || v.phase === "trickComplete")
          && !(Array.isArray(v.signals) && v.signals.some((s) => s != null)),
        anchor: ".pod .signal-img, .signal-img",
        title: "Reading a signal",
        body: "That badge is a teammate's (or opponent's) confidence signal. A <b>High</b> badge from your partner means lean in; a <b>Low</b> one means don't overbid expecting help.",
        gate: "tap",
      },
      {
        id: "trump",
        when: (v) => !!v.trump,
        anchor: ".trump-watermark",
        title: "Trump",
        body: "Trump is set — shown here. <b>Any trump beats any non-trump.</b> The bid winner leads the first trick. Watch which trumps are still out; they decide most tricks.",
        gate: "tap",
      },
      {
        id: "play-card",
        when: (v) => v.phase === "playing" && v.yourTurn,
        anchor: ".fan-inner",
        place: "above",
        title: "Playing a trick",
        body: "Tap a card to play it. You must <b>follow the led suit</b> if you can; if you can't, you may play anything — including trump. Highest trump wins the trick; with no trump, the highest card of the led suit wins.",
        hint: "Tap a card to play it.",
        gate: "action",
        done: (v) => !v.yourTurn, // your turn flips off the instant you play
      },
      {
        id: "trick-won",
        when: (v) => v.phase === "trickComplete",
        anchor: ".trick-gate, .trick",
        title: "Winning tricks",
        body: "The cards in the middle are a <b>trick</b>. Whoever won it gathers the cards and leads the next one. Tap the pile to move on whenever you've seen enough.",
        gate: "tap",
      },
      {
        id: "honors",
        when: (v) => v.phase === "playing",
        title: "Where points come from",
        body: "Each hand has up to <b>six</b> points to win: <b>High</b> (highest trump played), <b>Low</b> (lowest trump played), <b>Jack</b> (the jack of trump), <b>Bonhomme</b> (the Joker) — worth <b>2 points</b>, not 1 — and <b>Game</b> (most card value: A=4, K=3, Q=2, J=1, 10=10). Capture them in your tricks.",
        gate: "tap",
      },
      {
        id: "scored",
        when: (v) => !!v.lastHand || v.phase === "gameOver",
        title: "Scoring the hand",
        body: "The hand is scored: each captured honor counts (Bonhomme counts for 2). If the bidding team made its bid, those points count; if not, the bid is subtracted (<b>set back</b>). The game is played to <b>21 points</b> — first team there wins.",
        gate: "tap",
      },
      {
        id: "wrap",
        when: (v) => !!v.lastHand || v.phase === "gameOver",
        title: "You've got it",
        body: "That's one hand of High Low Jack. Bid on strength, signal your partner, capture the honors, and race to the target. The game keeps going from here — this guide steps out now. Good luck!",
        gate: "tap", cta: "Finish",
      },
    ],
    // rummy500 / hearts / pegs-and-jokers scripts follow the same shape.
  };

  window.Tutorial = Tutorial;
})();
