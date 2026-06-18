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
    // HLJ
    c.youBid = Array.isArray(v.bidHistory) && v.you != null
      ? v.bidHistory.some((b) => b.seat === v.you) : c.youBid;
    if (v.trump) c.trumpSeen = true;
    if (v.phase === "playing") c.playStarted = true;
    // Rummy 500: remember once meld/layoff intro has been shown so we skip it next round
    if (T.party === "rummy500" && Array.isArray(v.melds) && v.melds.length > 0) c.meldShown = true;
    // Hearts: track one-shot steps
    if (T.party === "hearts") {
      if (!c.firstPlayDone && v.phase === "playing" && !v.yourTurn && v.trickNo > 0) c.firstPlayDone = true;
      if (v.heartsBroken) c.heartsShown = true;
      if (v.phase === "trickComplete") c.trickShown = true;
      if (v.trickNo >= 6) c.moonShown = true;
    }
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
        id: "dealer-privilege",
        when: (v) => v.phase === "bidding",
        skipWhen: (v) => v.phase !== "bidding",
        anchor: ".hlj-bid-overlay",
        place: "above",
        title: "Dealer's privilege",
        body: "The <b>dealer gets one special power</b>: they can <b>take</b> the highest bid without going higher. If everyone else passed at 2, the dealer can claim the bid for 2 rather than having to bid 3. And if <b>everyone passes</b>, the dealer <b>must</b> take it for 2 — someone always has to play the hand. This makes the dealer seat valuable — they always get the last word.",
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
    rummy500: [
      {
        id: "welcome",
        when: (v) => v.phase === "playing",
        title: "Welcome to Rummy 500",
        body: "Everyone plays for themselves — no teams. Each round you draw, meld cards onto the table, and discard. Cards you meld score <b>for you</b>; cards left in your hand score <b>against you</b>. First to <b>500 points</b> wins.",
        gate: "tap", cta: "Show me",
      },
      {
        id: "your-hand",
        when: () => true,
        anchor: ".fan-inner",
        place: "above",
        title: "Your hand",
        body: "These are your cards — only you can see them. Card values: <b>A = 15 pts, face cards = 10 pts, 2–9 = pip value</b>. Jokers are wild and worth 15 pts. Your goal is to get high-value cards onto the table before the round ends.",
        gate: "tap",
      },
      {
        id: "the-piles",
        when: () => true,
        anchor: ".piles",
        title: "Stock & discard",
        body: "The <b>face-down stack</b> is the stock — draw blindly from here. The <b>face-up pile</b> is the discard — you can see every card in it and pick any of them up. Smart discard reads are the heart of Rummy.",
        gate: "tap",
      },
      {
        id: "draw",
        when: (v) => v.phase === "playing" && v.yourTurn && v.turnPhase === "draw",
        skipWhen: (v) => v.phase !== "playing" || (v.yourTurn && v.turnPhase !== "draw"),
        anchor: ".piles",
        title: "Draw a card",
        body: "Every turn starts with a draw. <b>Tap the stock</b> to draw blind, or <b>tap the discard pile</b> to browse and pick a card. If you grab a card that isn't on top, you take every card above it too — and you must immediately meld or lay off the target card.",
        hint: "Draw from the stock or tap the discard pile.",
        gate: "action",
        done: (v) => !(v.yourTurn && v.turnPhase === "draw"),
      },
      {
        id: "meld-intro",
        when: (v) => v.phase === "playing" && v.yourTurn && v.turnPhase === "play",
        skipWhen: (v, c) => c.meldShown || (v.phase === "playing" && v.yourTurn && v.turnPhase === "draw"),
        anchor: ".fan-inner",
        place: "above",
        title: "Melding",
        body: "Now select cards and play them to the table. A valid <b>meld</b> is either a <b>set</b> (3–4 cards of the same rank, different suits) or a <b>run</b> (3+ consecutive ranks in the same suit). Tap cards to select them, then tap <b>Play meld</b>. Jokers are wild.",
        gate: "tap",
      },
      {
        id: "layoff-intro",
        when: (v, c) => v.phase === "playing" && v.yourTurn && v.turnPhase === "play" && !c.meldShown,
        skipWhen: (v, c) => c.meldShown || v.phase !== "playing",
        anchor: ".rummy-melds-scroll",
        title: "Laying off",
        body: "You can also <b>lay off</b> — add cards to a meld already on the table (yours or anyone else's). Tap a card, then tap the meld you want to extend. You score the points for whatever you lay off, even on someone else's meld.",
        gate: "tap",
      },
      {
        id: "discard",
        when: (v) => v.phase === "playing" && v.yourTurn && v.turnPhase === "play",
        skipWhen: (v) => v.phase !== "playing" || !v.yourTurn || v.turnPhase !== "play",
        anchor: ".fan-inner",
        place: "above",
        title: "Discard to end your turn",
        body: "When you're done melding, select one card and tap <b>Discard</b>. That card goes face-up on the discard pile and your turn ends. Choose wisely — opponents can pick it up.",
        hint: "Select a card and tap Discard.",
        gate: "action",
        done: (v) => !(v.yourTurn && v.turnPhase === "play"),
      },
      {
        id: "scoring",
        when: (v) => !!(v.lastRound),
        anchor: ".selfbar",
        place: "above",
        title: "How scoring works",
        body: "When the round ends, each player's score is <b>melded points minus held points</b>. Cards still in your hand count against you — a hand full of face cards hurts. Negative rounds are possible if you're caught holding big cards.",
        gate: "tap",
      },
      {
        id: "going-out",
        when: (v) => !!(v.lastRound),
        title: "Going out",
        body: "A round ends when someone <b>goes out</b> (empties their hand) or the <b>stock runs dry</b>. Going out first is powerful — you decide when the round ends, often leaving opponents stuck with unmelded cards. No rush though: staying in to meld more can outscore a fast out.",
        gate: "tap",
      },
      {
        id: "log-melds",
        when: (v) => !!(v.lastRound),
        anchor: "[data-action='toggle-log']",
        title: "Log & Melds tab",
        body: "Tap <b>Log</b> any time during a round. Switch to the <b>Melds</b> tab to see everything on the table at once — who owns each meld, what's in it, and where you can lay off.",
        gate: "tap",
      },
      {
        id: "wrap",
        when: (v) => !!(v.lastRound) || v.phase === "gameOver",
        title: "You've got it",
        body: "That's Rummy 500. Draw smart, meld early, lay off where you can, and don't get caught holding. The game keeps going from here — this guide steps out now. Good luck!",
        gate: "tap", cta: "Finish",
      },
    ],
    hearts: [
      {
        id: "welcome",
        when: (v) => v.phase === "passing" || v.phase === "playing",
        title: "Welcome to Hearts",
        body: "Hearts is a trick-avoidance game — <b>lowest score wins</b>. Each heart is worth 1 point, and the <b>Queen of Spades is worth 13</b>. You want to capture as few of these as possible. First player to reach the target score ends the game; whoever has the fewest points wins.",
        gate: "tap", cta: "Show me",
      },
      {
        id: "your-hand",
        when: () => true,
        anchor: ".fan-inner",
        place: "above",
        title: "Your hand",
        body: "These are your cards for this hand. You'll play one card per trick. <b>High cards are dangerous</b> — they win tricks that might carry hearts or the Queen of Spades. Low cards are generally safer.",
        gate: "tap",
      },
      {
        id: "passing",
        when: (v) => v.phase === "passing" && v.passOffset !== 0 && !v.youPassed,
        skipWhen: (v) => v.phase !== "passing" || v.passOffset === 0,
        anchor: ".fan-inner",
        place: "above",
        title: "Passing cards",
        body: "Before play begins, pass <b>3 cards</b> to your neighbor. The direction rotates each hand — left, across, right, then a <b>hold hand</b> with no pass. Tap 3 cards to select them, then tap <b>Pass</b>. Dump your highest hearts or the Ace/King of Spades — anything that might land you points.",
        hint: "Select 3 cards and tap Pass.",
        gate: "action",
        done: (v) => v.youPassed || v.phase !== "passing",
      },
      {
        id: "hold-hand",
        when: (v) => v.phase === "playing" && v.passOffset === 0 && v.trickNo === 0,
        skipWhen: (v) => v.phase !== "playing" || v.passOffset !== 0,
        title: "Hold hand — no pass",
        body: "Every fourth hand is a <b>hold hand</b>: no passing. You play exactly what you were dealt. Hold hands reward players who've built safe hands — and punish those who rely on passing away danger.",
        gate: "tap",
      },
      {
        id: "first-trick",
        when: (v) => v.phase === "playing" && v.trickNo === 0,
        skipWhen: (v) => v.phase !== "playing" || v.trickNo !== 0,
        anchor: ".fan-inner",
        place: "above",
        title: "The first trick",
        body: "The player holding the <b>lowest club</b> leads it. Everyone must follow suit if they can — the highest card of the led suit wins the trick. <b>No point cards</b> (hearts or Queen of Spades) may be played on the first trick unless you have no clubs at all.",
        gate: "tap",
      },
      {
        id: "play-card",
        when: (v) => v.phase === "playing" && v.yourTurn,
        skipWhen: (v, c) => v.phase !== "playing" || c.firstPlayDone,
        anchor: ".fan-inner",
        place: "above",
        title: "Play a card",
        body: "Tap a card to play it. You <b>must follow the led suit</b> if you can. If you can't follow, you may throw any card — that's your chance to dump a heart or the Queen of Spades on someone else's trick.",
        hint: "Tap a card to play it.",
        gate: "action",
        done: (v) => !v.yourTurn,
      },
      {
        id: "bleeding-hearts",
        when: (v) => v.phase === "playing" && !v.heartsBroken,
        skipWhen: (v, c) => v.phase !== "playing" || v.heartsBroken || c.heartsShown,
        anchor: ".trump-watermark",
        title: "Hearts aren't broken yet",
        body: "You <b>cannot lead hearts</b> until a heart has been played to a trick — that's called breaking hearts. Once broken, hearts are fair game to lead. Until then, if you can only lead hearts, you may lead one anyway.",
        gate: "tap",
      },
      {
        id: "trick-complete",
        when: (v) => v.phase === "trickComplete",
        skipWhen: (v, c) => v.phase !== "trickComplete" || c.trickShown,
        anchor: ".trick-gate",
        title: "Trick won",
        body: "The cards stay on screen so everyone can see who took what. Tap the trick (or wait) to sweep it and continue. Points in the pile go to the winner — watch for red cards and the Queen of Spades.",
        gate: "tap",
      },
      {
        id: "shoot-the-moon",
        when: (v) => v.phase === "playing" && v.trickNo >= 3,
        skipWhen: (v, c) => c.moonShown || v.phase !== "playing",
        title: "Shooting the moon",
        body: "Here's the wild card: if one player captures <b>all 26 points</b> in a hand — every heart and the Queen of Spades — that's <b>shooting the moon</b>. They score 0 and <b>everyone else gets 26</b>. It's a high-risk comeback move; watch out for opponents loading up on hearts.",
        gate: "tap",
      },
      {
        id: "scoring",
        when: (v) => !!(v.lastHand),
        title: "End of hand",
        body: "After all 13 tricks the hand is scored. Check the <b>scorecard</b>: each player's hearts and Q♠ are totalled. If someone shot the moon, everyone else takes 26. The running totals update and a new hand deals. Game ends when anyone reaches the target — lowest total wins.",
        gate: "tap",
      },
      {
        id: "wrap",
        when: (v) => !!(v.lastHand) || v.phase === "gameOver",
        title: "You've got it",
        body: "That's Hearts. Pass away your danger cards, follow suit, dump points when you can't, and keep an eye out for a moon shot. The game keeps going from here — this guide steps out now. Good luck!",
        gate: "tap", cta: "Finish",
      },
    ],
    // pegs-and-jokers script follows the same shape.
  };

  window.Tutorial = Tutorial;
})();
