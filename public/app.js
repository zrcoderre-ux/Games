// Parlor — card games client. Vanilla ES module, native WebSocket, no build step.
// The server is the rules authority: we turn `view.legalMoves` into controls, and
// for Rummy melds we let the player select cards and submit — the server validates.
// This file's RENDER layer draws a cozy parlor table; all networking/protocol is unchanged.

const SUIT = { S: "\u2660", H: "\u2665", D: "\u2666", C: "\u2663" };
const RED = new Set(["H", "D"]);
const GAMES = {
  rummy500: {
    label: "Rummy 500",
    players: [2, 3, 4, 5, 6, 7, 8],
    target: 500,
    suit: "\u2665",
    blurb: "Draw, build runs & sets, race to 500.",
    range: "2\u20138 players",
  },
  "high-low-jack": {
    label: "High Low Jack",
    players: [4, 6, 8],
    target: 21,
    suit: "\u2660",
    blurb: "Bid, take trump tricks, chase the Jack.",
    range: "4 / 6 / 8 players",
  },
  hearts: {
    label: "Hearts",
    players: [3, 4, 5],
    target: 100,
    suit: "\u2665",
    blurb: "Dodge hearts & the Black Lady; lowest score wins.",
    range: "3 / 4 / 5 players",
  },
  "pegs-and-jokers": {
    label: "Pegs & Jokers",
    players: [4, 6],
    marbles: [3, 4, 5],
    suit: "\u2660",
    blurb: "Race your marbles home; jokers bump, sevens split.",
    range: "4 or 6 players \u00b7 partners",
  },
};

const app = document.getElementById("app");
const toastEl = document.getElementById("toast");

const S = {
  pid: null,
  name: "",
  party: null,
  pickGame: "high-low-jack", // start-screen selection
  room: null,
  ws: null,
  offline: false, // playing locally vs bots (no server)
  hotseat: false, // 2+ local humans sharing the device (pass-and-play)
  revealedSeat: null, // which human seat's hand is currently unlocked on screen
  awaitingPass: false, // showing the privacy hand-off screen
  passTo: null, // seat we're passing the device to
  passReady: false, // hand-off delay elapsed; reveal button enabled
  connected: false,
  intentionalClose: false,
  view: null,
  rummySel: new Set(), // selected card ids
  rummyLayoff: null, // selected meld id for layoff
  rummyMeldOpen: null, // meld id whose popup is open
  rummyRoundAcked: null, // JSON key of the lastRound already dismissed
  rummyRoundTimer: null, // auto-dismiss setTimeout handle
  rummyRoundVisible: false, // true once the pause after going-out has elapsed
  hljHandAcked: null, // JSON key of the lastHand already dismissed
  hljHandTimer: null, // auto-dismiss setTimeout handle
  hljHandVisible: false, // delayed until trick hold animation completes
  hljShowDealtHands: false,
  hljBidHold: null,   // frozen bid overlay shown briefly after bidding ends
  hljBidHoldTimer: null,
  hljHandTrickCount: 0, // tricks resolved in current hand; 0 at hand start so stale lastTrick isn't shown
  hljTrickHold: null, // {trick, winSeat} held briefly after last card played
  hljTrickHoldTimer: null,
  hljTrickWinReady: false, // delayed win-card highlight within the hold
  hljTrickWinTimer: null,
  hljLastTrickOpen: false, // client-only: whether last trick is expanded as a hand fan
  hljDripTrick: null,    // array of plays being dripped in one-at-a-time after hold expires
  hljDripPending: [],    // queued plays not yet shown
  hljDripTimer: null,
  rummyOrder: [], // display order of your hand (card ids) for sort + drag/drop
  rummySort: "suit", // last sort mode used; next click alternates
  theme: "midnight", // "midnight" | "velvet" | "baize" | "parchment"

  discardOpen: false, // discard-pile popup open?
  dragId: null, // card id being dragged within the hand
  dropBeforeId: null, // drop target (insert before this card id; null = end)
  heartsPass: new Set(), // selected card ids to pass (Hearts)
  hotseats: {}, // seat → name for pass-and-play reservations (pre-start, client-only)
  pjCard: null, // selected card id (Pegs & Jokers)
  pjMoves: [], // candidate moves currently shown as buttons (Pegs & Jokers)
  lbySettingsOpen: false,
  showLog: false,
  logTab: "log", // "log" | "melds"
  logExpandedId: null, // id of log entry whose extraCards are expanded
};

// Pegs & Jokers peg colors, one per seat. Even seats are team A, odd are team B.
const PJ_PEG = ["#b8413a", "#d79a3c", "#2f9069", "#3f6bb0", "#8a52a0", "#3aa0a8"];
const shade = (hex, p) => {
  const n = parseInt(hex.slice(1), 16), c = (v) => Math.max(0, Math.min(255, v));
  return `#${((c((n >> 16) + p) << 16) | (c(((n >> 8) & 255) + p) << 8) | c((n & 255) + p)).toString(16).padStart(6, "0")}`;
};

// ---------- in-place DOM morphing ----------
// We re-render whole screens as HTML strings, but patch them into the live DOM
// node-by-node instead of replacing innerHTML. Unchanged nodes are kept, so there
// is no flash on every server update, entrance animations don't replay, and CSS
// transitions (card position, turn glow) actually tween between states.
function morphNode(a, b) {
  if (a.nodeType !== b.nodeType || a.nodeName !== b.nodeName) {
    a.replaceWith(b.cloneNode(true));
    return;
  }
  if (a.nodeType === 3 || a.nodeType === 8) {
    if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue;
    return;
  }
  for (let i = a.attributes.length - 1; i >= 0; i--) {
    const n = a.attributes[i].name;
    if (!b.hasAttribute(n)) a.removeAttribute(n);
  }
  for (const at of b.attributes) {
    if (a.getAttribute(at.name) !== at.value) a.setAttribute(at.name, at.value);
  }
  // keep form fields usable: sync value/checked unless the user is editing it now
  if ((a.nodeName === "INPUT" || a.nodeName === "TEXTAREA" || a.nodeName === "SELECT") && a !== document.activeElement) {
    const bv = b.getAttribute("value");
    if (bv != null && a.value !== bv) a.value = bv;
  }
  morphList(a, b);
}
function morphList(parent, source) {
  let a = parent.firstChild;
  let b = source.firstChild;
  while (b) {
    const bnext = b.nextSibling;
    if (!a) { parent.appendChild(b.cloneNode(true)); b = bnext; continue; }
    const anext = a.nextSibling;
    morphNode(a, b);
    a = anext; b = bnext;
  }
  while (a) { const n = a.nextSibling; parent.removeChild(a); a = n; }
}
function patch(html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  morphList(app, tpl.content);
}
Object.defineProperty(app, "__set", { configurable: true, set(html) { patch(html); } });

// ---------- theme ----------
const THEMES = [
  { id: "midnight", label: "Midnight" },
  { id: "velvet",   label: "Velvet"   },
  { id: "baize",    label: "Baize"    },
  { id: "parchment",label: "Parchment"},
];
function applyTheme(id) {
  document.documentElement.setAttribute("data-theme", id);
  const meta = document.querySelector('meta[name="theme-color"]');
  const colors = { midnight: "#060910", velvet: "#0d0610", baize: "#060c08", parchment: "#1e1408" };
  if (meta) meta.content = colors[id] || colors.midnight;
}
function themePickerHTML() {
  const swatches = THEMES.map(t =>
    `<button class="theme-swatch${S.theme === t.id ? " active" : ""}" data-action="set-theme" data-t="${t.id}" title="${t.label}"></button>`
  ).join("");
  const cur = THEMES.find(t => t.id === S.theme);
  return `<div class="theme-picker">${swatches}<span class="theme-label">${cur ? cur.label : ""}</span></div>`;
}

// ---------- utilities ----------
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const rankLabel = (r) => (r === 14 ? "A" : r === 13 ? "K" : r === 12 ? "Q" : r === 11 ? "J" : String(r));
const cardKey = (c) => (c.joker ? "joker" : `${c.rank}${c.suit}`);

// elegant card face: corner pips (rank + suit) + center pip, court face for J/Q/K
function cardHTML(c, o = {}) {
  const st = o.style ? ` style="${o.style}"` : "";
  const cls = ["card"];
  if (o.mini) cls.push("mini");
  if (o.lg) cls.push("lg");
  if (o.back) {
    cls.push("back");
    return `<div class="${cls.join(" ")}"${st}></div>`;
  }
  if (o.playable) cls.push("playable");
  if (o.sel) cls.push("sel");
  if (o.must) cls.push("must");
  if (o.dim) cls.push("dim");
  const a = [];
  if (o.action) a.push(`data-action="${o.action}"`);
  if (o.key) a.push(`data-key="${o.key}"`);
  if (o.id !== undefined) a.push(`data-cardid="${o.id}"`);
  if (o.draggable) a.push(`draggable="true"`);
  if (o.win) cls.push("win");
  if (c.joker) {
    cls.push("joker");
    if (o.jokerAs) cls.push("joker-wild");
    const badge = o.jokerAs
      ? `<span class="joker-as-badge ${RED.has(o.jokerAs.suit) ? "red" : ""}">${rankLabel(o.jokerAs.rank)}${SUIT[o.jokerAs.suit]}</span>`
      : "";
    const action = o.jokerAs && !o.inMeld ? ` data-action="reveal-joker"` : (a.length ? ` ${a.join(" ")}` : "");
    return `<div class="${cls.join(" ")}"${st}${action}><img class="joker-img" src="/joker-card.png" alt="Joker">${badge}</div>`;
  }
  if (RED.has(c.suit)) cls.push("red");
  const r = rankLabel(c.rank);
  const s = SUIT[c.suit];
  const corner = `<b>${r}</b><i>${s}</i>`;
  if (o.mini) {
    return `<div class="${cls.join(" ")}"${st} ${a.join(" ")}><span class="corner tl">${corner}</span><span class="pip">${s}</span></div>`;
  }
  return `<div class="${cls.join(" ")}"${st} ${a.join(" ")}><span class="corner tl">${corner}</span><span class="pip">${s}</span><span class="corner br">${corner}</span></div>`;
}

function seatName(v, i) {
  const s = v.seats[i];
  if (!s || s.kind === "empty") return `Seat ${i + 1}`;
  return s.name || (s.kind === "bot" ? `Bot ${i + 1}` : `Seat ${i + 1}`);
}

// ---------- avatars ----------
const AV = [
  ["#e7c485", "#c08a3e"], ["#e0a44e", "#b5662f"], ["#cfa86a", "#9c7232"], ["#d98f6a", "#a85138"],
  ["#bcae74", "#86763c"], ["#d6a3a0", "#a86560"], ["#a9b58f", "#6f7c4f"], ["#cda05a", "#8d6531"],
];
function avHash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }
function initials(name) {
  const w = String(name).trim().split(/\s+/).filter(Boolean);
  if (w.length >= 2) return (w[0][0] + w[1][0]).toUpperCase();
  const x = w[0] || "?";
  return (x.length > 1 ? x[0] + x[1] : x[0]).toUpperCase().slice(0, 2);
}
function avatarHTML(name, o = {}) {
  const [a, b] = AV[avHash(name) % AV.length];
  return `<div class="avatar${o.big ? " big" : ""}" style="--av-1:${a};--av-2:${b}">${esc(initials(name))}${o.host ? `<span class="crown">\u265B</span>` : ""}</div>`;
}

// opponent pod
function podHTML(v, i, o = {}) {
  const name = seatName(v, i);
  const backs = 4;
  const cardCount = o.cardCount != null ? o.cardCount : null;
  const mbArr = Array.from({ length: backs }, (_, idx) =>
    idx === backs - 1 && cardCount != null
      ? `<span class="mb mb-last"><span class="mb-count">${cardCount}</span></span>`
      : `<span class="mb"></span>`
  );
  const mb = mbArr.join("");
  const isDisconnected = v.disconnectedSeats && v.disconnectedSeats.includes(i);
  const isHost = v.you === v.hostSeat && v.you !== null;
  const replaceBtn = isDisconnected && isHost && !S.offline
    ? `<button class="btn sm danger" data-action="replace-seat" data-seat="${i}">Replace</button>`
    : "";
  const disconnectedBadge = isDisconnected ? `<span class="chip" style="background:var(--danger,#c0392b);color:#fff;font-size:10px">away</span>` : "";
  return `<div class="pod ${o.active ? "active" : ""} ${o.partner ? "partner" : ""} ${o.team ? "t" + o.team : ""} ${isDisconnected ? "disconnected" : ""} ${o.extraClass || ""}">
    <div class="ministack">
      ${mb}
      <span class="back-name">${esc(name)}${disconnectedBadge}</span>
    </div>
    ${o.highBid != null ? `<div class="pod-dealer-badge bid">${o.highBid}</div>` : o.dealer ? `<div class="pod-dealer-badge">D</div>` : ""}
    ${o.pts != null || o.count != null ? `<div class="pod-info">
      ${o.pts != null ? `<span class="pts">${o.pts}</span>` : ""}
      ${o.count != null ? `<span class="count">${o.count}</span>` : ""}
    </div>` : ""}
    ${o.note ? `<div class="note">${esc(o.note)}</div>` : ""}
    ${replaceBtn}
  </div>`;
}

// fanned hand with per-card rotation + arc, overlap scaled to fit
function fanHand(cards, optFn) {
  const n = cards.length;
  if (!n) return "";
  const cardW = 64;
  const avail = Math.min(360, (window.innerWidth || 360) - 30);
  const step = n > 1 ? Math.min(44, Math.max(20, (avail - cardW) / (n - 1))) : 0;
  const overlap = step - cardW; // negative => overlap
  const spread = Math.min(3, 24 / n);
  const arc = n > 2 ? Math.min(13, n * 1.4) : 0;
  const mid = (n - 1) / 2 || 1;
  return cards
    .map((c, i) => {
      const off = i - (n - 1) / 2;
      const rot = off * spread;
      const lift = -arc * (1 - (off / mid) ** 2);
      const o = optFn(c, i) || {};
      o.style = `${i ? `margin-left:${overlap.toFixed(1)}px;` : ""}transform:rotate(${rot.toFixed(2)}deg) translateY(${lift.toFixed(1)}px);z-index:${i + 1};`;
      return cardHTML(c, o);
    })
    .join("");
}

let toastTimer = null;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 3200);
}

// ---------- move log (authoritative: rendered from view.log) ----------
function cardText(c) {
  if (!c) return "";
  if (c.joker) return `<span class="lc red">\u2605</span>`;
  return `<span class="lc ${RED.has(c.suit) ? "red" : ""}">${rankLabel(c.rank)}${SUIT[c.suit]}</span>`;
}
function logEntryHTML(v, e) {
  const who = e.seat != null ? `<b>${esc(seatName(v, e.seat))}</b> ` : "";
  const body = e.seat == null ? `<i>${esc(e.msg)}</i>` : esc(e.msg);
  const suit = e.suit ? ` <span class="lc ${RED.has(e.suit) ? "red" : ""}">${SUIT[e.suit]}</span>` : "";
  // "was dealt" and "kitty" entries use mini card images instead of text glyphs
  if ((e.msg === "was dealt" || e.msg === "kitty") && e.cards?.length) {
    const miniCards = e.cards.map(c => cardHTML(c, { mini: true })).join("");
    return `<div class="hlj-dealt-row">${who}${body}<div class="hlj-dealt-cards">${miniCards}</div></div>`;
  }
  const cards = (e.cards || []).map((c) => cardText(c)).join(" ");
  let tail = "";
  if (e.tail && e.extraCards && e.extraCards.length) {
    const expanded = S.logExpandedId === e.id;
    tail = ` <button class="log-expand-btn${expanded ? " active" : ""}" data-action="expand-log" data-entryid="${e.id}">${esc(e.tail)}</button>`;
    if (expanded) {
      const miniCards = [e.cards?.[0], ...e.extraCards].filter(Boolean).map((c) => cardHTML(c, { mini: true })).join("");
      tail += `<div class="log-extra-cards">${miniCards}</div>`;
    }
  } else if (e.tail) {
    tail = ` ${esc(e.tail)}`;
  }
  return `${who}${body}${suit}${cards ? " " + cards : ""}${tail}`;
}

// ---------- networking ----------
function send(m) {
  if (S.ws && S.ws.readyState === WebSocket.OPEN) S.ws.send(JSON.stringify(m));
}

// Shared frame handler for both the real socket and the offline LocalRoom.
function onFrame(e) {
  let msg;
  try { msg = JSON.parse(e.data); } catch { return; }
  if (msg.t === "view") {
    const prev = S.view;
    S.view = msg.view;
    // HLJ: if drip mode is active, queue any newly arrived trick cards.
    // If the user just played their own card, flush everything immediately so it
    // never disappears from hand without appearing in the trick.
    if (S.hljDripTrick !== null && S.party === "high-low-jack" && msg.view?.phase === "playing") {
      const shown = S.hljDripTrick.length + S.hljDripPending.length;
      const incoming = msg.view.currentTrick ?? [];
      if (incoming.length > shown) {
        const newCards = incoming.slice(shown);
        const userSeat = msg.view.you;
        if (userSeat != null && newCards.some(c => c.seat === userSeat)) {
          // User's card arrived — flush all pending + new cards at once
          if (S.hljDripTimer) { clearTimeout(S.hljDripTimer); S.hljDripTimer = null; }
          S.hljDripTrick = [...S.hljDripTrick, ...S.hljDripPending, ...newCards];
          S.hljDripPending = [];
          // Don't set to null yet — let the next render pick it up, then clear
          setTimeout(() => { S.hljDripTrick = null; }, 0);
        } else {
          S.hljDripPending.push(...newCards);
        }
      }
    }
    // HLJ: freeze bid overlay briefly when bidding ends so the dealer's chip is visible
    if (S.party === "high-low-jack" && prev?.phase === "bidding" && msg.view?.phase === "playing") {
      S.hljHandTrickCount = 0; // new hand — suppress stale lastTrick from previous hand
      if (S.hljBidHoldTimer) clearTimeout(S.hljBidHoldTimer);
      // Use the NEW view's bidHistory — the dealer's final action may only exist there
      // (server batches the dealer-bot move in the same frame as the phase transition)
      S.hljBidHold = { bidHistory: msg.view.bidHistory, highBid: msg.view.highBid, dealerSeat: prev.dealerSeat, you: prev.you, seats: prev.seats };
      S.hljBidHoldTimer = setTimeout(() => {
        S.hljBidHold = null;
        S.hljBidHoldTimer = null;
        render();
      }, 900);
    }
    // HLJ: when the trick just resolved (currentTrick went from non-empty → empty OR
    // directly to the next trick when the bot both wins and leads immediately).
    // msg.view.lastTrick is now always set even on end-of-hand (server preserves it
    // via lastHand.lastTrick when tricksWon resets on new deal).
    const prevTrickLen = prev?.currentTrick?.length ?? 0;
    const newTrickLen = msg.view?.currentTrick?.length ?? 0;
    const n = msg.view?.seats?.length ?? 4;
    // A trick just resolved when: the previous trick was full (or nearly full) AND
    // the new view shows 0 cards in the trick (human won/led) OR 1 card (bot won and led).
    // Also fires for end-of-hand where msg.view.lastTrick comes from lastHand.lastTrick.
    const trickJustResolved = S.party === "high-low-jack"
        && prevTrickLen > 0
        && prev?.phase === "playing"
        && msg.view?.lastTrick
        && (newTrickLen === 0
            // Bot won and immediately led — detect by trick having been "full" before
            || (newTrickLen > 0 && prevTrickLen >= n - 1
                && JSON.stringify(msg.view.lastTrick) !== JSON.stringify(prev?.lastTrick)));
    if (trickJustResolved) {
      // Cancel any in-progress drip — trick just ended.
      if (S.hljDripTimer) { clearTimeout(S.hljDripTimer); S.hljDripTimer = null; }
      S.hljDripTrick = null;
      S.hljDripPending = [];
      S.hljHandTrickCount++;
      if (S.hljTrickHoldTimer) clearTimeout(S.hljTrickHoldTimer);
      const lt = msg.view.lastTrick;
      const n = prev.seats.length; // use prev seats (new hand may differ in phase)
      // Build trick plays from lastTrick.cards in play order using prev.currentTrick seats
      const trick = lt.cards.map((card, i) => {
        // prev.currentTrick has n-1 cards; the last card's seat comes from prev.toAct
        const seat = i < prev.currentTrick.length
          ? prev.currentTrick[i].seat
          : (prev.toAct ?? i);
        return { card, seat, name: prev.seats[seat]?.name ?? `Player ${seat + 1}` };
      });
      S.hljLastTrickOpen = false;
      if (S.hljTrickWinTimer) { clearTimeout(S.hljTrickWinTimer); S.hljTrickWinTimer = null; }
      S.hljTrickWinReady = false;
      S.hljTrickHold = { trick, winSeat: lt.winner, n, you: prev.you, names: prev.seats.map((s,i) => s.name ?? `Player ${i+1}`), collecting: false };
      const PHANTOM = 1200;
      // After phantom pause, switch to collecting (fan animation)
      S.hljTrickWinTimer = setTimeout(() => {
        if (S.hljTrickHold) { S.hljTrickHold = { ...S.hljTrickHold, collecting: true }; render(); }
        S.hljTrickWinTimer = null;
      }, PHANTOM);
      S.hljHandVisible = false;
      S.hljTrickHoldTimer = setTimeout(() => {
        S.hljTrickHold = null;
        S.hljTrickHoldTimer = null;
        S.hljHandVisible = true;
        const snapshot = [...(S.view?.currentTrick ?? [])];
        if (snapshot.length > 1) {
          // Cards accumulated while hold was active — drip them in one by one.
          S.hljDripTrick = snapshot.slice(0, 1);
          S.hljDripPending = snapshot.slice(1);
          render();
          startTrickDrip();
        } else {
          S.hljDripTrick = null;
          render();
        }
      }, PHANTOM + 2400);
    }
    // HLJ: if a new hand result arrived but trickJustResolved didn't fire (server batched the
    // last bot trick), hljHandVisible may already be true — enforce a short hold so the modal
    // doesn't flash in immediately.
    if (S.party === "high-low-jack" && !trickJustResolved) {
      const prevHandKey = prev?.lastHand ? JSON.stringify(prev.lastHand) : null;
      const newHandKey  = msg.view?.lastHand ? JSON.stringify(msg.view.lastHand) : null;
      if (newHandKey && newHandKey !== prevHandKey && newHandKey !== S.hljHandAcked) {
        S.hljHandVisible = false;
        if (S.hljTrickHoldTimer) { clearTimeout(S.hljTrickHoldTimer); S.hljTrickHoldTimer = null; }
        S.hljTrickHoldTimer = setTimeout(() => {
          S.hljHandVisible = true;
          S.hljTrickHoldTimer = null;
          render();
        }, 1200);
      }
    }
    // If the round result changed (new round ended), reset the ack so the popup shows again.
    const prevKey = prev?.lastRound ? JSON.stringify(prev.scores) : null;
    const newKey  = msg.view?.lastRound ? JSON.stringify(msg.view.scores) : null;
    if (newKey && newKey !== prevKey && newKey !== S.rummyRoundAcked) {
      if (S.rummyRoundTimer) { clearTimeout(S.rummyRoundTimer); S.rummyRoundTimer = null; }
      S.rummyRoundVisible = false;
    }
    // Auto-sort rummy hand on draw: whenever the hand gains card(s), re-apply the current sort.
    const v = msg.view;
    if (S.party === "rummy500" && v && v.yourHand && v.you != null) {
      const prevHand = prev?.yourHand ?? [];
      if (v.yourHand.length > prevHand.length) {
        const rank = (c) => (c.joker ? 100 : c.rank);
        const suitOrder = { S: 0, H: 1, C: 2, D: 3 };
        const by = S.rummySort === "suit"
          ? (a, b) => (a.joker - b.joker) || (suitOrder[a.suit] - suitOrder[b.suit]) || (rank(a) - rank(b))
          : (a, b) => (rank(a) - rank(b)) || (suitOrder[a.suit] - suitOrder[b.suit]);
        S.rummyOrder = [...v.yourHand].sort(by).map((c) => c.id);
      }
    }
    maybePromptPass();
    render();
    maybeAutoPlay(msg.view);
  }
  else if (msg.t === "error") { toast(msg.message); }
}

// Drip accumulated trick cards in one at a time after the trick hold expires.
function startTrickDrip() {
  if (S.hljDripTimer) clearTimeout(S.hljDripTimer);
  S.hljDripTimer = setTimeout(() => {
    S.hljDripTimer = null;
    if (!S.hljDripPending.length) {
      S.hljDripTrick = null;
      render();
      maybeAutoPlay(S.view);
      return;
    }
    S.hljDripTrick = [...S.hljDripTrick, S.hljDripPending.shift()];
    render();
    if (S.hljDripPending.length > 0) {
      startTrickDrip();
    } else {
      S.hljDripTrick = null;
      render();
      maybeAutoPlay(S.view);
    }
  }, 800);
}

// Auto-play: when it's your turn in HLJ playing phase and only one card is legal,
// play it automatically after a short delay so the game flows without tap-spam.
let _autoPlayTimer = null;
function maybeAutoPlay(v) {
  if (_autoPlayTimer) { clearTimeout(_autoPlayTimer); _autoPlayTimer = null; }
  if (!v || !v.yourTurn) return;
  if (S.hljDripTrick !== null) return; // block during drip — re-triggered when drip finishes
  const legal = v.legalMoves || [];
  if (legal.length !== 1) return;
  const move = legal[0];
  // Only auto-play card-play moves (not bidding choices, select-trump, etc.)
  if (move.type !== "play") return;
  const delay = S.party === "high-low-jack" ? 1200 : 900;
  _autoPlayTimer = setTimeout(() => {
    _autoPlayTimer = null;
    if (S.view === v) send({ t: "move", move });
  }, delay);
}

// Pass-and-play privacy gate: when the active hand belongs to a different local
// human than the one currently looking, hide everything behind a hand-off
// screen until they confirm they're ready. The view frame already holds the
// next player's cards, but the interstitial renders none of them.
function maybePromptPass() {
  const v = S.view;
  S.hotseat = S.offline && !!v && v.seats && v.seats.filter((s) => s.kind === "human").length >= 2;
  if (!S.hotseat || S.awaitingPass) return;
  if (!v || v.phase === "lobby" || v.phase === "gameOver") return;
  if (v.you != null && v.yourTurn && v.you !== S.revealedSeat) {
    S.passTo = v.you;
    S.awaitingPass = true;
    S.passReady = false;
    // A short beat so the device can actually change hands before it unlocks.
    setTimeout(() => { S.passReady = true; if (S.awaitingPass) render(); }, 1400);
  }
}

function joinOnOpen() {
  S.connected = true;
  send({ t: "join", pid: S.pid, name: S.name });
}

function connect() {
  S.intentionalClose = false;
  if (S.offline) return connectLocal();

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${location.host}/parties/${S.party}/${encodeURIComponent(S.room)}`;
  const ws = new WebSocket(url);
  S.ws = ws;
  let opened = false;

  // If we can't reach the server, fall back to local play vs bots.
  const fallback = (why) => {
    if (opened || S.intentionalClose || S.offline) return;
    clearTimeout(fbTimer);
    try { ws.close(); } catch {}
    toast(why || "No connection — playing offline vs bots.");
    connectLocal();
  };
  const fbTimer = setTimeout(() => fallback(), 3500);

  ws.onopen = () => { opened = true; clearTimeout(fbTimer); joinOnOpen(); };
  ws.onmessage = onFrame;
  ws.onclose = () => {
    // Don't clobber S.connected if we've already switched to a local socket.
    if (!S.offline) S.connected = false;
    if (S.intentionalClose || S.offline) return;
    if (!opened) return fallback();
    render();
    setTimeout(() => { if (!S.connected && !S.intentionalClose) connect(); }, 1500);
  };
  ws.onerror = () => { if (!opened) fallback(); };
  render();
}

let localMod = null;
// serverSeats: if provided, replicate this seat layout and auto-start (Pass & Play / bot-only handoff).
// startConfig: { target?, marbles?, botDifficulty? } mirroring the server lobby settings.
async function connectLocal(serverSeats = null, startConfig = null) {
  S.offline = true;
  try {
    if (!localMod) localMod = await import("/local.js");
  } catch (err) {
    return toast("Couldn't load offline mode.");
  }
  const sock = localMod.createLocalSocket(S.party);
  S.ws = sock;
  sock.onopen = () => {
    try {
      joinOnOpen();
      // Place any pass-and-play humans first; start() auto-fills remaining seats with bots.
      for (const [seat, name] of Object.entries(S.hotseats)) {
        send({ t: "addHuman", seat: +seat, name });
      }
      S.hotseats = {};
      if (serverSeats) {
        // Auto-start using the config captured from the server lobby.
        const players = serverSeats.length;
        if (S.party === "pegs-and-jokers") {
          send({ t: "start", config: { players, marbles: startConfig?.marbles ?? 5 } });
        } else {
          const cfg = { players, target: startConfig?.target ?? GAMES[S.party]?.target ?? 21 };
          if (startConfig?.botDifficulty) cfg.botDifficulty = startConfig.botDifficulty;
          send({ t: "start", config: cfg });
        }
      }
    } catch (err) {
      console.error("connectLocal onopen failed:", err);
      toast("Couldn't start game: " + (err?.message || err));
    }
  };
  sock.onmessage = onFrame;
  sock.onclose = () => { S.connected = false; };
  render();
}

// ---------- app bar ----------
function appbar(v, opts = {}) {
  return `<div class="appbar">
    <div class="brand"><div class="glyph">P</div><span class="wordmark">${esc(GAMES[S.party].label)}</span></div>
    <div class="spacer"></div>
    ${S.offline ? `<div class="roomtag">offline · ${S.hotseat ? "pass &amp; play" : "vs bots"}</div>` : `<div class="roomtag">room <b>${esc(S.room)}</b></div>`}
    ${opts.log ? `<button class="btn sm ghost" data-action="toggle-log">Log</button>` : ""}
    ${S.offline ? "" : `<button class="btn sm ghost" data-action="share-link">Share</button>`}
    <button class="btn sm ghost" data-action="leave">Leave</button>
  </div>`;
}

function logSheet() {
  if (!S.showLog) return "";
  const v = S.view;
  const tab = S.logTab;

  // --- Log tab ---
  const logBody = () => {
    const entries = v && v.log ? v.log : [];
    let dealtRows = "";
    // For Rummy: show own hand at the bottom (dealt state), and last-round held cards
    let rummyHandRows = "";
    if (S.party === "rummy500" && v) {
      // At round end, show held cards (what was in your hand when the round ended)
      if (v.lastRound && v.you != null) {
        const heldCards = v.lastRound.heldCards?.[v.you] ?? [];
        if (heldCards.length) {
          const heldMinis = heldCards.map((c) => cardHTML(c, { mini: true })).join("");
          rummyHandRows += `<div class="logrow hlj-dealt-row"><span class="hlj-dealt-name hlj-dealt-kitty">Your held cards</span><div class="hlj-dealt-cards">${heldMinis}</div></div>`;
        }
      }
      // Current hand at the very bottom
      if (v.yourHand && v.yourHand.length) {
        const RUMMY_SUIT_ORDER = { S: 0, H: 1, D: 2, C: 3 };
        const sortedHand = [...v.yourHand].sort((a, b) =>
          (a.joker ? 1 : 0) - (b.joker ? 1 : 0) ||
          (RUMMY_SUIT_ORDER[a.suit] ?? 4) - (RUMMY_SUIT_ORDER[b.suit] ?? 4) ||
          a.rank - b.rank
        );
        const handMinis = sortedHand.map((c) => cardHTML(c, { mini: true })).join("");
        rummyHandRows += `<div class="logrow hlj-dealt-row"><span class="hlj-dealt-name">Your hand</span><div class="hlj-dealt-cards">${handMinis}</div></div>`;
      }
    }
    const rows = entries.length
      ? [...entries].reverse().map((e) => `<div class="logrow">${logEntryHTML(v, e)}</div>`).join("") + dealtRows + rummyHandRows
      : dealtRows + rummyHandRows || `<div class="logrow" style="color:var(--ink-dim)">No moves yet.</div>`;
    return `<div class="loglist">${rows}</div>`;
  };

  // --- Melds tab ---
  const meldsBody = () => {
    const melds = v && v.melds ? v.melds : [];
    if (!melds.length) return `<div class="logrow" style="color:var(--ink-dim)">No melds on the table yet.</div>`;
    // Group by owner seat
    const byPlayer = {};
    for (const m of melds) {
      const s = m.owner ?? -1;
      if (!byPlayer[s]) byPlayer[s] = [];
      byPlayer[s].push(m);
    }
    return Object.entries(byPlayer).map(([seat, pmelds]) => {
      const name = v ? esc(seatName(v, +seat)) : `Seat ${+seat + 1}`;
      const meldRows = pmelds.map((m) => {
        const jokerRes = resolveJokers(m);
        const cards = m.cards.map((c, ci) =>
          cardHTML(c, { mini: true, jokerAs: jokerRes[ci] ?? undefined, inMeld: true })
        ).join("");
        const kind = m.kind === "set" ? "Set" : "Run";
        return `<div class="meld-log-row" data-action="open-meld" data-meldid="${m.id}"><span class="meld-kind">${kind}</span><div class="meld-log-cards">${cards}</div></div>`;
      }).join("");
      return `<div class="meld-log-player"><div class="meld-log-name">${name}</div>${meldRows}</div>`;
    }).join("");
  };

  const isRummy = S.party === "rummy500";
  const tabs = (t) => `<div class="log-tabs">
    <button class="log-tab${t === "log" ? " active" : ""}" data-action="log-tab" data-tab="log">Log</button>
    ${isRummy ? `<button class="log-tab${t === "melds" ? " active" : ""}" data-action="log-tab" data-tab="melds">Melds</button>` : ""}
  </div>`;

  return `<div class="logsheet">
      <div class="loghead">${tabs(tab)}<button class="btn sm ghost" data-action="download-state" title="Download game state for diagnostics">↓</button><button class="btn sm ghost" data-action="toggle-log">Close</button></div>
      <div class="logbody">${tab === "melds" ? meldsBody() : logBody()}</div>
    </div>`;
}

// shared table frame: pods distributed around the felt, center play area, your rail at the bottom
function tableShell(v, parts) {
  // pods can be [{seat,html},...] for compass layout, or legacy string[] for special cases
  const podItems = parts.pods;
  let feltPods;
  if (podItems.length && typeof podItems[0] === "string") {
    // legacy / special (e.g. pjstrip) — render in top rail
    feltPods = `<div class="rail top deal">${podItems.join("") || `<div class="callout">Waiting for players to arrive…</div>`}</div>`;
  } else {
    // compass layout: place each opponent pod on a circle, equidistant by angle.
    // Square perimeter layout: each player sits on an edge of the felt.
    const n = v.seats.length;
    const you = v.you;
    // Wall-aware layout shared with trick cards and bid chips (wallPerimPos):
    // classify by computed x, evenly re-space side walls, widen for 3+ pods.
    const podY2 = n >= 6 ? 50 : n >= 5 ? 65 : 79;
    const podBounds = { x1: 12, x2: 88, y1: 21, y2: podY2, wideY1: 16, wideY2: Math.max(podY2, 68) };
    const infos = podItems.map(({ seat, html }) => {
      const off = you == null
        ? podItems.findIndex(p => p.seat === seat) + 1
        : (seat - you + n) % n;
      const { x, y, side } = wallPerimPos(off, n, podBounds);
      return { html, x, y, side: `pos-${side}` };
    });
    const slots = infos.length
      ? infos.map(({ html, x, y, side }) => {
          // Side pods anchor flush to the felt edge so the card backs always sit
          // against the wall; only the vertical position comes from the perimeter.
          const pos = side === "pos-left"
            ? `top:${y}%;left:0;transform:translateY(-50%)`
            : side === "pos-right"
              ? `top:${y}%;right:0;transform:translateY(-50%)`
              : `top:${y}%;left:${x}%;transform:translate(-50%,-50%)`;
          return `<div class="pod-slot ${side}" style="position:absolute;${pos};z-index:2">${html}</div>`;
        }).join("")
      : `<div class="pod-slot" style="position:absolute;top:14%;left:50%;transform:translate(-50%,-50%);z-index:2"><div class="callout">Waiting for players to arrive…</div></div>`;
    feltPods = slots;
  }

  let self;
  if (v.you != null) {
    const myName = seatName(v, v.you);
    self = `<div class="hand deal ${parts.hand ? "" : "empty"}">${parts.hand || ""}</div>
      <div class="selfbar">
        ${avatarHTML(myName, { host: v.you === v.hostSeat })}
        <div class="selfbar-name-block">${parts.selfName ? parts.selfName : `<div class="name">${esc(myName)}</div>`}<div class="me-pts">${parts.selfMeta || ""}</div></div>
        ${parts.selfTurn || ""}
      </div>
      ${parts.selfExtra ? `<div class="self-extra">${parts.selfExtra}</div>` : ""}
      ${parts.actions !== null ? `<div class="actions">${parts.actions || `<span class="hint">Watching the table…</span>`}</div>` : ""}`;
  } else {
    self = `<div class="selfbar"><div class="name">Spectating</div><div class="me-pts">${parts.selfMeta || ""}</div></div>`;
  }
  return `<div class="table">
    ${appbar(v, { log: true })}
    <div class="felt-frame${parts.feltHeader ? ' has-frame-title' : ''}">
    ${parts.feltHeader ? `<div class="frame-title">${parts.feltHeader}</div>` : ""}
    ${parts.railCounters ? `<div class="rail-counters">${parts.railCounters}</div>` : ""}
    <div class="felt">
      <div class="felt-stage">
        ${feltPods}
        ${parts.feltTop ? `<div class="felt-top">${parts.feltTop}</div>` : ""}
        ${parts.feltOverlay ? `<div class="felt-overlay">${parts.feltOverlay}</div>` : ""}
        ${parts.cornerSuits ? `<div class="felt-corners" aria-hidden="true">${parts.cornerSuits}</div>` : ""}
        <div class="center${parts.centerFull ? ' full' : ''}">${parts.center}</div>
        ${parts.trick || ""}
        ${parts.feltBid || ""}
        ${parts.feltBottom ? `<div class="felt-bottom">${parts.feltBottom}</div>` : ""}
      </div>
    </div>
    </div>
    <div class="selfwrap-spacer"></div>
    ${parts.aboveSelf ? `<div class="above-self">${parts.aboveSelf}</div>` : ""}
    <div class="selfwrap">${self}</div>
  </div>${logSheet()}`;
}

// ---------- render router ----------
function render() {
  if (!S.party) return renderStart();
  if (!S.connected || !S.view) return renderConnecting();
  if (S.awaitingPass) return renderPass();
  const v = S.view;
  if (v.phase === "lobby") return renderLobby(v);
  if (S.party === "high-low-jack") return renderHLJ(v);
  if (S.party === "hearts") return renderHearts(v);
  if (S.party === "pegs-and-jokers") return renderPJ(v);
  return renderRummy(v);
}

function renderConnecting() {
  const gameName = S.party && GAMES[S.party] ? esc(GAMES[S.party].label) : "Parlor";
  const suit = S.party && GAMES[S.party] ? GAMES[S.party].suit : "\u2663";
  const sub = S.connected ? "Joined \u2014 dealing you in." : "Connecting\u2026";
  app.__set = `<div class="felt-screen">
    <div class="connect-card">
      <div class="connect-suit">${suit}</div>
      <div class="connect-name">${gameName}</div>
      <div class="connect-msg">${sub}</div>
      <div class="connect-dots"><span></span><span></span><span></span></div>
    </div>
  </div>`;
}

// ---------- pass-and-play hand-off ----------
function renderPass() {
  const v = S.view;
  const name = seatName(v, S.passTo);
  const ready = S.passReady;
  app.__set = `<div class="passwrap">
    <div class="passcard">
      <div class="passlogo">\u{1F0A0}</div>
      <p class="passlabel">Pass the device to</p>
      <h1 class="passname">${esc(name)}</h1>
      <p class="sub">Hand it over so no one else sees the cards, then tap below.</p>
      <button class="btn" style="width:100%;margin-top:20px" data-action="reveal-hand" ${ready ? "" : "disabled"}>
        ${ready ? `I’m ${esc(name)} — show my hand` : "One moment…"}
      </button>
      <button class="btn ghost sm" style="width:100%;margin-top:10px" data-action="leave">Leave game</button>
    </div>
  </div>`;
}

// ---------- start screen ----------

const GAME_CARD_META = {
  rummy500:          { suit: "♦", color: "red"   },
  "high-low-jack":   { suit: "♠", color: "black" },
  hearts:            { suit: "♥", color: "red"   },
  "pegs-and-jokers": { suit: "♣", color: "black" },
};

function renderStart() {
  const g = S.pickGame;
  // HLJ first (longest name, should be visible), then the rest
  const gameIds = ["high-low-jack", "rummy500", "hearts", "pegs-and-jokers"];

  // Wider spread so each card name is legible
  const positions = [
    { left: "0px",   top: "18px", rot: "-9deg" },
    { left: "86px",  top: "6px",  rot: "-2deg" },
    { left: "172px", top: "6px",  rot: "4deg"  },
    { left: "258px", top: "16px", rot: "10deg" },
  ];

  const gameCards = gameIds.map((id, i) => {
    const info = GAMES[id];
    const meta = GAME_CARD_META[id];
    const sel = id === g;
    const pos = positions[i];
    const posStyle = sel
      ? `left:${pos.left};z-index:10`
      : `left:${pos.left};top:${pos.top};transform:rotate(${pos.rot});z-index:${i + 1}`;
    return `<button class="tbl-card${sel ? " selected" : ""} ${meta.color}"
        style="${posStyle}" data-action="pick-game" data-game="${id}">
      <span class="tbl-card-corner tl">${meta.suit}</span>
      <span class="tbl-card-suit">${meta.suit}</span>
      <span class="tbl-card-name">${esc(info.label)}</span>
      <span class="tbl-card-corner br">${meta.suit}</span>
    </button>`;
  }).join("");

  app.__set = `
    <div class="felt-table">
      <div class="cb cb1"></div><div class="cb cb2"></div>
      <div class="cb cb3"></div><div class="cb cb4"></div>
      <div class="cb cb5"></div><div class="cb cb6"></div>

      <div class="felt-content">
        <h1 class="felt-title">Parlor</h1>
        <p class="felt-sub">a cozy room for cards</p>
        <div class="felt-rule"></div>

        <label class="felt-label">Your Name</label>
        <input class="felt-input" id="f-name" value="${esc(S.name || "")}"
          placeholder="e.g. Alex" autocomplete="off" />

        <label class="felt-label">Choose a Game</label>
        <div class="tbl-fan">
          <input type="hidden" id="f-game" value="${esc(g)}" />
          ${gameCards}
        </div>

        <label class="felt-label">Room Code</label>
        <input class="felt-input" id="f-room" value="${esc(S.room || "")}"
          placeholder="blank = new room" autocomplete="off" />

        <button class="felt-cta" data-action="connect">Take a Seat</button>

      </div>
    </div>`;
}
// Renders the HLJ scores strip. 2×2 grid: rows=BID/SCORE, cols=TeamA/TeamB.
// scores=null → lobby (ghost rings). scores=[a,b] → gameplay (filled numbers).
// highBid={seat,amount} → shows winning bid in that team's BID cell.
function hljScoresStrip(scores, highBid) {
  const isLobby = scores === null;

  const scoreChipA = isLobby
    ? `<div class="hlj-score-chip tA ghost"><span class="hlj-sc-ghost">A</span></div>`
    : `<div class="hlj-score-chip tA"><span class="hlj-sc-num">${scores[0]}</span></div>`;
  const scoreChipB = isLobby
    ? `<div class="hlj-score-chip tB ghost"><span class="hlj-sc-ghost">B</span></div>`
    : `<div class="hlj-score-chip tB"><span class="hlj-sc-num">${scores[1]}</span></div>`;

  const bidTeam = highBid != null ? highBid.seat % 2 : null;
  const bidChipA = (bidTeam === 0 && highBid)
    ? `<div class="hlj-score-chip tA"><span class="hlj-sc-num">${highBid.amount}</span></div>`
    : `<div class="hlj-score-chip tA ghost"><span class="hlj-sc-ghost">A</span></div>`;
  const bidChipB = (bidTeam === 1 && highBid)
    ? `<div class="hlj-score-chip tB"><span class="hlj-sc-num">${highBid.amount}</span></div>`
    : `<div class="hlj-score-chip tB ghost"><span class="hlj-sc-ghost">B</span></div>`;

  return `<div class="hlj-panel hlj-panel-grid">
    <div class="hlj-cell hlj-cell-label"><span class="hlj-row2-bid">BID</span></div>
    <div class="hlj-cell hlj-cell-chips">${bidChipA}${bidChipB}</div>
    <div class="hlj-cell hlj-cell-label hlj-cell-row2"><span class="hlj-row2-bid">SCORE</span></div>
    <div class="hlj-cell hlj-cell-chips hlj-cell-row2">${scoreChipA}${scoreChipB}</div>
  </div>`;
}
const HLJ_FELT_HEADER = `<div class="hlj-felt-title"><span class="hlj-t-red">HIGH</span> <span class="hlj-t-dark">LOW</span> <span class="hlj-t-red">JACK</span></div>`;

// ---------- lobby ----------
function renderLobby(v) {
  const isHost = v.you !== null && v.you === v.hostSeat;
  const isPJ = S.party === "pegs-and-jokers";
  const isHLJ = S.party === "high-low-jack";
  const isTeamGame = isHLJ || isPJ;
  const counts = isPJ ? [4] : GAMES[S.party].players;
  const link = `${location.origin}/?game=${S.party}&room=${encodeURIComponent(S.room)}`;
  const isRummyLobby = S.party === "rummy500";
  const DIFF_LABELS = ["Easy", "Medium", "Hard", "Expert"];
  const n = v.seats.length;
  const you = v.you;

  // Build a pod for each non-self seat (same positions as gameplay pods).
  const lbyPod = (s, i) => {
    const isEmpty = s.kind === "empty";
    const isBot = s.kind === "bot";
    const reserved = isHost && S.hotseats[i];
    const tc = isTeamGame ? (i % 2 === 0 ? "tA" : "tB") : "";
    const name = reserved ? esc(S.hotseats[i]) : isEmpty ? "Open" : esc(s.name || "Player");
    const initial = isEmpty ? "+" : isBot && !reserved ? "B" : name.charAt(0).toUpperCase();
    const avCls = isEmpty ? "empty" : reserved ? "local" : isBot ? "bot" : "human";
    const role = isEmpty ? "tap to add" : reserved ? "pass &amp; play" : isBot ? "bot" : i === v.hostSeat ? "host" : "player";
    const seatClick = isEmpty && isHost ? ` data-action="reserve-hotseat" data-seat="${i}" style="cursor:pointer"` : "";

    let removeBtn = "";
    if (reserved) {
      removeBtn = `<button class="lby-pod-remove" data-action="clear-hotseat" data-seat="${i}">✕</button>`;
    } else if (isBot && isHost) {
      const diff = isRummyLobby ? (v.botDifficulty?.[i] ?? 2) : 2;
      const diffPicker = isRummyLobby
        ? `<select class="difficulty-pick" data-action="set-bot-difficulty" data-seat="${i}">${DIFF_LABELS.map((l, d) => `<option value="${d}"${d === diff ? " selected" : ""}>${l}</option>`).join("")}</select>`
        : "";
      removeBtn = diffPicker + `<button class="lby-pod-remove" data-action="removebot" data-seat="${i}">✕</button>`;
    } else if (S.offline && s.kind === "human") {
      removeBtn = `<button class="lby-pod-remove" data-action="clearseat" data-seat="${i}">✕</button>`;
    }

    // Team games use outlined box-style seats
    if (isTeamGame) {
      const boxLabel = isEmpty ? "OPEN" : (isBot && !reserved ? "BOT" : name.toUpperCase().substring(0, 8));
      const boxIcon = isEmpty ? "+" : initial;
      return `<div class="lby-seat-box ${tc} ${isEmpty ? "lby-seat-empty" : ""}"${seatClick}>
        <div class="lby-seat-box-main">${boxIcon}</div>
        <div class="lby-seat-box-sub">${boxLabel}</div>
        ${removeBtn}
      </div>`;
    }

    return `<div class="pod lby-pod ${tc} ${isEmpty ? "lby-pod-empty" : ""}"${seatClick}>
      <div class="lby-pod-av ${avCls}">${initial}</div>
      <div class="lby-pod-name">${name}</div>
      <div class="lby-pod-role">${role}</div>
      ${removeBtn}
    </div>`;
  };

  // Pods: every seat that isn't "you" (or all seats if spectating)
  const pods = v.seats
    .map((s, i) => ({ seat: i, html: lbyPod(s, i) }))
    .filter(({ seat }) => seat !== you);

  // Poker-chip player count picker
  const chipRow = (action, opts, selected, note = "") =>
    `<div class="lby-cfg-row"><span class="lby-cfg-label">Players</span>
       <div class="lby-chip-row">${opts.map((c, idx) =>
         `<button class="lby-count-chip${c === selected ? " on" : ""}${idx % 2 === 1 ? " red" : ""}" data-action="${action}" data-count="${c}">${c}</button>`
       ).join("")}</div></div>${note ? `<p class="sub" style="margin:2px 0 10px 72px">${note}</p>` : ""}`;

  const cfgControls = isPJ
    ? chipRow("pj-setplayers", [4, 6], v.players, v.players === 6 ? "Two teams of three." : "Two pairs, partners opposite.") +
      `<div class="lby-cfg-row"><span class="lby-cfg-label">Marbles</span>
         <div class="seg">${GAMES["pegs-and-jokers"].marbles.map((m) => `<button class="${m === v.marbles ? "on" : ""}" data-action="pj-setmarbles" data-m="${m}">${m}</button>`).join("")}</div></div>`
    : isHLJ
    ? ""
    : chipRow("setcount", counts, v.players) +
      `<div class="lby-cfg-row"><span class="lby-cfg-label">Play to</span>
         <input class="lby-pts" id="f-target" type="number" min="1" value="${v.target ?? GAMES[S.party].target}" /></div>` +
      (S.party === "rummy500"
        ? `<div class="lby-cfg-row"><span class="lby-cfg-label">Must discard</span>
             <button class="lby-toggle${v.requireDiscard ? " on" : ""}" data-action="rummy-toggle-discard">${v.requireDiscard ? "On" : "Off"}</button></div>`
        : "");

  const hasHotseats = Object.keys(S.hotseats).length > 0;
  let shareRow = "";
  if (S.offline) {
    shareRow = `<p class="lby-mode-note">${hasHotseats ? "Pass &amp; Play — device is shared between turns." : "Offline — all bots play on this device."}</p>`;
  } else {
    shareRow = `<div class="lby-share-row">
      <button class="btn lby-share-btn" data-action="share-link">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
        Invite Players
      </button>
    </div>`;
  }

  // Score strip (shown in center for ongoing series)
  const seatedCount = v.seats.filter(s => s.kind !== "empty").length;
  const centerScore = isTeamGame && v.scores
    ? `<div class="lby-center-score">
        <span class="tA">A <b>${v.scores[0]}</b></span>
        <span class="lby-center-score-sep">vs</span>
        <span class="tB">B <b>${v.scores[1]}</b></span>
        <span class="lby-center-score-to">· to ${v.target ?? 21}</span>
      </div>`
    : `<div class="lby-center-status">${seatedCount} of ${n} seated</div>`;

  const center = isHLJ
    ? ""
    : `<div class="lby-center">
        <div class="lby-center-title">${esc(GAMES[S.party].label)}</div>
        ${centerScore}
        ${isHost ? `<div class="lby-center-cfg">${cfgControls}</div>` : ""}
      </div>`;

  // HLJ: title now lives on the felt overlay (not the wood frame)
  const feltTop = "";
  const feltHeader = "";

  const feltChips = isHLJ && isHost
    ? `<div class="lby-felt-chips"><span class="lby-fc-players">PLAYERS</span><div class="lby-fc-row">${counts.map((c, idx) => `<button class="lby-count-chip${c === v.players ? " on" : ""}${idx % 2 === 1 ? " red" : ""}" data-action="setcount" data-count="${c}">${c}</button>`).join("")}</div></div>`
    : "";
  const lobbyScores = isHLJ ? hljScoresStrip(null, null) : "";

  // Inline editable name in the selfbar
  const nameInput = `<div class="lby-name-row"><input class="lby-name-input" id="lby-name-input" value="${esc(S.name || "")}" placeholder="Your name" autocomplete="off" maxlength="24" size="10" /><button class="lby-name-btn" data-action="lby-rename">✓</button></div>`;
  const selfExtra = "";

  // Joker watermark + corner suits for the felt
  const feltOverlay = `<div class="lby-felt-watermark"></div>${isHLJ ? `<div class="hlj-felt-title-overlay"><span class="hlj-t-red">HIGH</span> <span class="hlj-t-dark">LOW</span> <span class="hlj-t-red">JACK</span></div>` : ""}`;
  const cornerSuits = ['♠','♥','♦','♣'].map((s,i) =>
    `<span class="felt-corner-suit ${i===1||i===2 ? 'red' : ''} ${ ['tl','tr','br','bl'][i] }">${s}</span>`
  ).join("");

  // Share + Deal on the same row
  const shareBtn = !S.offline
    ? `<button class="btn lby-share-btn" data-action="share-link"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg> Invite Players</button>`
    : "";
  const dealAction = isHost
    ? `<div class="lby-action-row">${shareBtn}<button class="btn lby-deal-btn" data-action="start">${isPJ ? "Deal &amp; Start" : "Deal the Cards"}</button></div>`
    : `<div class="lby-action-row">${shareBtn}${shareBtn ? "" : ""}<span class="hint">Waiting for the host to deal…</span></div>`;

  // My team badge for selfMeta
  const myTc = you != null && isTeamGame ? (you % 2 === 0 ? "A" : "B") : null;
  const selfMeta = myTc
    ? `<span class="teambadge t${myTc}">Team ${myTc}</span>`
    : you != null && v.seats[you] ? `<span class="lby-pod-role">${v.seats[you].kind === "human" ? (you === v.hostSeat ? "host" : "player") : ""}</span>` : "";

  // Settings modal
  const winsNeeded = v.winsNeeded ?? 1;
  const bestOf = winsNeeded <= 1 ? 1 : winsNeeded * 2 - 1;
  const settingsModal = isHost && S.lbySettingsOpen
    ? `<div class="modal-back" data-action="close-lby-settings">
        <div class="modal" data-stop="1">
          <div class="modalhead"><span>Settings</span><button class="btn sm ghost" data-action="close-lby-settings">Close</button></div>
          <div class="modalbody">
            ${isHLJ ? `<div class="lby-set-row">
              <span class="lby-set-label">Best of</span>
              <div class="seg">
                ${[1, 3, 5].map(nn => `<button class="${nn === bestOf ? "on" : ""}" data-action="lby-set-bestof" data-n="${nn}">${nn === 1 ? "1 game" : `${nn} games`}</button>`).join("")}
              </div>
            </div>` : ""}
            ${!S.offline ? `<div class="lby-set-row">
              <label class="lby-set-toggle">
                <input type="checkbox" data-action="toggle-bot-replacement" ${v.botReplacement ? "checked" : ""} />
                <span>Auto-replace disconnects with bots</span>
              </label>
            </div>` : ""}
          </div>
        </div>
      </div>`
    : "";

  const settingsBtn = isHost
    ? `<button class="btn sm ghost lby-gear-btn" data-action="open-lby-settings" title="Settings">⚙ Settings</button>`
    : "";

  // Spectator view: show all seats as pods (no selfwrap)
  if (you === null) {
    app.__set = tableShell(v, {
      pods: v.seats.map((s, i) => ({ seat: i, html: lbyPod(s, i) })),
      center,
      feltHeader,
      feltTop,
      feltOverlay,
      cornerSuits,
      feltBottom: feltChips,
      hand: null,
      selfMeta: "",
      selfTurn: null,
      selfExtra: null,
      actions: null,
    }) + settingsModal;
    return;
  }

  app.__set = tableShell(v, {
    pods,
    center,
    feltHeader,
    feltTop,
    feltOverlay,
    cornerSuits,
    feltBottom: feltChips,
    hand: "",
    selfName: nameInput,
    selfMeta,
    selfTurn: settingsBtn,
    selfExtra,
    actions: dealAction,
  }) + settingsModal;
}

// ---------- shared: game over ----------
function scoreList(rows) {
  return `<div class="seats">${rows
    .map(
      (r) => `<div class="seat ${r.you ? "me" : ""}">${avatarHTML(r.name)}
        <div class="nm">${esc(r.name)}${r.you ? ' <span class="chip you">you</span>' : ""}${r.win ? ' <span class="chip host">winner</span>' : ""}</div>
        <div class="tags"><b style="font-family:Fraunces,serif;font-size:22px;color:${r.win ? "var(--brass-hi)" : "var(--ink)"}">${r.score}</b></div></div>`,
    )
    .join("")}</div>`;
}

function renderGameOver(v, title, scoresHTML) {
  const isHost = v.you !== null && v.you === v.hostSeat;
  app.__set = `${appbar(v)}
    <div class="stage">
      <div class="panel cream" style="text-align:center">
        <div class="hero"><div class="logo">\u2660</div><h1>${esc(title)}</h1><p class="sub">Good game.</p></div>
      </div>
      <div class="panel"><h2 style="margin-bottom:10px">Final scores</h2>${scoresHTML}</div>
      <div class="panel" style="text-align:center">${
        isHost ? `<button class="btn" data-action="newgame">Deal a new game</button>` : `<p class="sub">Waiting for the host to deal again…</p>`
      }</div>
    </div>`;
}

// Perimeter layout: map t∈[0,1] to a point on the felt rectangle.
// Players placed clockwise around the table (viewed from above), so off=1 is to your left.
// Perimeter goes: bottom-left → left → top → right → bottom-right.
// x1/x2/y1/y2 are the clamped edge values (% of felt).
function perimPos(t, { x1 = 2, x2 = 98, y1 = 2, y2 = 96 } = {}) {
  const cx = 50;
  if (t < 1/8) {
    const s = t / (1/8);
    return { x: cx - (cx - x1) * s, y: y2 };
  } else if (t < 3/8) {
    const s = (t - 1/8) / (1/4);
    return { x: x1, y: y2 + (y1 - y2) * s };
  } else if (t < 5/8) {
    const s = (t - 3/8) / (1/4);
    return { x: x1 + (x2 - x1) * s, y: y1 };
  } else if (t < 7/8) {
    const s = (t - 5/8) / (1/4);
    return { x: x2, y: y1 + (y2 - y1) * s };
  } else {
    const s = (t - 7/8) / (1/8);
    return { x: x2 - (x2 - cx) * s, y: y2 };
  }
}

// Wall-aware perimeter position: classifies a seat onto a wall by its computed
// x (corner offsets land exactly on x1/x2), then evenly re-spaces side-wall
// seats so trick cards and bid chips track the pods. wideY1/wideY2 (optional)
// widen the side range when a wall holds 3+ seats (8-player tables).
function wallPerimPos(off, n, b) {
  const { x1, x2, y1, y2, wideY1 = y1, wideY2 = y2 } = b;
  const at = (o) => perimPos(o / n, { x1, x2, y1, y2 });
  const sideOf = (p) => (p.x <= x1 ? "left" : p.x >= x2 ? "right" : "top");
  const pos = at(off);
  const side = sideOf(pos);
  if (side === "top" || off === 0) return { ...pos, side };
  const wall = [];
  for (let o = 1; o < n; o++) if (sideOf(at(o)) === side) wall.push(o);
  const i = wall.indexOf(off);
  const yTop = wall.length >= 3 ? wideY1 : y1;
  const yBot = wall.length >= 3 ? wideY2 : y2;
  const f = wall.length === 1 ? 0.5 : i / (wall.length - 1);
  const fy = side === "left" ? 1 - f : f; // left wall walks bottom→top, right top→bottom
  let y;
  if (wall.length < 3) {
    y = yTop + (yBot - yTop) * fy;
  } else {
    // Non-uniform: middle pod matches 6-player single-pod position (y1+y2)/2
    const midY = (y1 + y2) / 2;
    if (fy <= 0.5) y = yTop + (midY - yTop) * (fy / 0.5);
    else y = midY + (yBot - midY) * ((fy - 0.5) / 0.5);
  }
  return { x: pos.x, y, side };
}

// Which card in a completed High Low Jack trick won it (port of engine
// trickWinner): highest trump — joker is the lowest trump — else highest of the
// led suit. Returns the index into the play-order cards array.
// Build a spatially-positioned trick div: each card placed on a circle,
// equidistant from center, evenly spaced by angle.
// `plays`  – [{card, seat, name?}]
// `you`    – viewer's seat index (null = spectator → top centre)
// `n`      – total seat count
// options  – winSeat: seat whose card gets .win; faded: dim the whole trick
function trickHTML(plays, you, n, { winSeat = null, faded = false, mini = true, collecting = false } = {}) {
  const circleStyle = (seat) => {
    if (you == null) return "top:20%;left:50%;transform:translate(-50%,-50%)";
    const off = (seat - you + n) % n;
    const bounds = mini ? { x1: 18, x2: 82, y1: 10, y2: 88 } : { x1: 22, x2: 78, y1: 16, y2: 74 };
    const { x, y } = wallPerimPos(off, n, bounds);
    return `top:${y}%;left:${x}%;transform:translate(-50%,-50%)`;
  };
  const cardRotation = (seat) => {
    if (you == null) return 0;
    const off = (seat - you + n) % n;
    return Math.round(off / n * 360);
  };
  const halfH = mini ? 31 : 44;
  if (collecting) {
    // Sort for fan: winner rightmost, rest by suit/rank
    const HLJ_SUIT_ORDER = { S: 0, H: 1, D: 2, C: 3 };
    const sorted = [...plays].sort((a, b) =>
      (a.seat === winSeat ? 1 : 0) - (b.seat === winSeat ? 1 : 0) ||
      (a.card.joker ? 1 : 0) - (b.card.joker ? 1 : 0) ||
      (HLJ_SUIT_ORDER[a.card.suit] ?? 4) - (HLJ_SUIT_ORDER[b.card.suit] ?? 4) ||
      a.card.rank - b.card.rank
    );
    const total = sorted.length;
    const spread = Math.min(70, (total - 1) * 12);
    const winPos = total - 1;
    // Fan cards: all arrive together
    const fanInner = sorted.map((p, i) => {
      const angle = total > 1 ? -spread / 2 + (spread / (total - 1)) * i : 0;
      const isWin = p.seat === winSeat;
      const winDelay = isWin ? `--win-anim-delay:380ms;` : "";
      const anim = isWin ? `fanArriveWin` : `fanArrive`;
      const style = `--fan-angle:${angle}deg;${winDelay}z-index:${isWin ? total + 1 : i};animation:${anim} .42s cubic-bezier(.2,.85,.25,1) both`;
      return `<div class="lt-fan-card collecting-card" style="${style}">${cardHTML(p.card, { win: isWin })}</div>`;
    }).join("");

    // Scattered cards: all fade out together
    const scatterInner = plays.map((p, idx) => {
      const style = `${circleStyle(p.seat)};--card-half-h:${halfH}px;z-index:${idx + 1};animation:scatterFade .25s ease-in both`;
      return `<div class="play" style="${style}"><div class="card-rotator" style="transform:rotate(${cardRotation(p.seat)}deg)">${cardHTML(p.card, { mini: false })}</div></div>`;
    }).join("");

    return `<div class="trick positioned collecting-scatter">${scatterInner}</div><div class="trick-fan-collect">${fanInner}</div>`;
  }
  const inner = plays.map((p, idx) => {
    const isWin = p.seat === winSeat;
    const style = `${circleStyle(p.seat)};--card-half-h:${halfH}px;z-index:${idx + 1}`;
    return `<div class="play${idx === 0 ? " lead" : ""}" style="${style}"><div class="card-rotator" style="transform:rotate(${cardRotation(p.seat)}deg)">${cardHTML(p.card, { mini, win: isWin })}</div><span class="who">${esc(p.name ?? "")}</span></div>`;
  }).join("");
  return `<div class="trick positioned${faded ? " faded" : ""}">${inner}</div>`;
}

function hljWinIdx(cards, trump) {
  if (!cards || !cards.length) return -1;
  const tval = (c) => (c.joker ? 0 : c.suit === trump ? c.rank : null);
  const trumps = cards.filter((c) => tval(c) != null);
  if (trumps.length) {
    let best = trumps[0];
    for (const c of trumps) if (tval(c) > tval(best)) best = c;
    return cards.indexOf(best);
  }
  const ledSuit = cards[0].joker ? trump : cards[0].suit;
  const followers = cards.filter((c) => !c.joker && c.suit === ledSuit);
  let best = followers[0];
  for (const c of followers) if (c.rank > best.rank) best = c;
  return cards.indexOf(best);
}

// ---------- High Low Jack ----------
function renderHLJ(v) {
  if (v.phase === "gameOver") {
    const w = v.winner;
    const you = v.you;
    const gw = v.gamesWon ?? [0, 0];
    const seriesLabel = (t) => (v.winsNeeded ?? 1) > 1 ? ` · ${gw[t]} win${gw[t] !== 1 ? "s" : ""}` : "";
    const rows = [
      { name: `Team A${seriesLabel(0)}`, score: v.scores[0], win: w === 0, you: you != null && you % 2 === 0 },
      { name: `Team B${seriesLabel(1)}`, score: v.scores[1], win: w === 1, you: you != null && you % 2 === 1 },
    ];
    return renderGameOver(v, w == null ? "Game over" : `Team ${w === 0 ? "A" : "B"} wins!`, scoreList(rows));
  }

  const lm = v.yourTurn ? v.legalMoves : [];
  const bids = lm.filter((m) => m.type === "bid");
  const canPass = lm.some((m) => m.type === "pass");

  const plays = new Set(lm.filter((m) => m.type === "play").map((m) => cardKey(m.card)));
  const highBid = v.highBid ? `${v.highBid.amount} (${esc(seatName(v, v.highBid.seat))})` : "\u2014";

  const teamLetter = (i) => (i % 2 === 0 ? "A" : "B");

  // pods (everyone but you), tagged with their team
  const pods = v.seats
    .map((s, i) =>
      i === v.you
        ? null
        : { seat: i, html: podHTML(v, i, {
            active: i === v.toAct,
            dealer: i === v.dealerSeat,
            highBid: v.phase === "playing" && v.trumpRevealed && v.highBid?.seat === i ? v.highBid.amount : null,
            team: teamLetter(i),
            partner: v.you != null && i % 2 === v.you % 2,
            backs: v.handCounts[i],
            cardCount: v.handCounts[i],
          }) },
    )
    .filter(Boolean);

  // center: trick area (trump watermark on felt separately)
  const you = v.you;
  const myTeam = you != null ? you % 2 : null;
  let hljTrick;
  let centerExtra = "";
  // Hold state takes priority over live currentTrick — prevents bot's new lead
  // card from interrupting the phantom pause / collecting animation.
  if (S.hljTrickHold) {
    const h = S.hljTrickHold;
    const trickPlays = h.trick.map((p) => ({ ...p, name: h.names[p.seat] ?? seatName(v, p.seat) }));
    if (h.collecting) {
      hljTrick = trickHTML(trickPlays, h.you, h.n, { mini: false, winSeat: h.winSeat, collecting: true });
    } else {
      hljTrick = trickHTML(trickPlays, h.you, h.n, { mini: false, winSeat: null, collecting: false });
    }
  } else if ((S.hljDripTrick ?? v.currentTrick).length) {
    const displayTrick = S.hljDripTrick ?? v.currentTrick;
    const trickPlays = displayTrick.map((p) => ({ ...p, name: seatName(v, p.seat) }));
    hljTrick = trickHTML(trickPlays, you, v.seats.length, { mini: false });
  } else if (v.phase !== "bidding" && v.lastTrick && S.hljHandTrickCount > 0) {
    const winIdx = hljWinIdx(v.lastTrick.cards, v.trump);
    const winCard = v.lastTrick.cards[winIdx];
    const ltCards = [...v.lastTrick.cards].sort((a, b) => {
      // winner always rightmost
      if (a === winCard) return 1;
      if (b === winCard) return -1;
      if (a.joker && b.joker) return 0;
      if (a.joker) return -1;
      if (b.joker) return 1;
      const suitOrder = { S: 0, H: 1, D: 2, C: 3 };
      return (suitOrder[a.suit] - suitOrder[b.suit]) || (a.rank - b.rank);
    });
    const origCards = v.lastTrick.cards;
    const total = ltCards.length;
    const spread = Math.min(70, (total - 1) * 12); // degrees total spread
    const fanCards = ltCards.map((c, i) => {
      const origIdx = origCards.indexOf(c);
      const angle = total > 1 ? -spread / 2 + (spread / (total - 1)) * i : 0;
      const isWin = origIdx === winIdx;
      return `<div class="lt-fan-card" style="--fan-angle:${angle}deg;--fan-i:${i};z-index:${isWin ? total + 1 : i}">${cardHTML(c, { win: isWin })}</div>`;
    }).join("");
    if (S.hljLastTrickOpen) {
      const expanded = `<div class="fan-inner lt-expanded-fan">${fanHand(ltCards, () => ({}))}</div>`;
      hljTrick = `<div class="lasttrick open" data-action="toggle-last-trick"><div class="lt-label">Last trick \u2014 won by ${esc(seatName(v, v.lastTrick.winner))} \u25b2</div>${expanded}</div>`;
    } else {
      hljTrick = `<div class="lasttrick" data-action="toggle-last-trick"><div class="lt-fan">${fanCards}</div><div class="lt-label">Last trick \u2014 won by ${esc(seatName(v, v.lastTrick.winner))} \u25bc</div></div>`;
    }
  } else if (v.phase === "bidding") {
    centerExtra = "";
  } else {
    centerExtra = `<div class="callout">Lead a card to open the trick.</div>`;
  }
  const center = centerExtra;

  // Joker watermark until trump is revealed (explicit selectTrump or first card played).
  const trumpMark = v.trump && v.trumpRevealed
    ? `<span class="trump-watermark ${RED.has(v.trump) ? "red" : ""}">${SUIT[v.trump]}</span>`
    : `<span class="trump-watermark joker-placeholder" role="img" aria-label="No trump chosen yet"></span>`;
  const feltOverlay = trumpMark + `<div class="hlj-felt-title-overlay"><span class="hlj-t-red">HIGH</span> <span class="hlj-t-dark">LOW</span> <span class="hlj-t-red">JACK</span></div>`;

  // hand (fanned), sorted by suit then rank, dim non-legal cards while it's your turn to play
  const HLJ_SUIT_ORDER = { S: 0, H: 1, D: 2, C: 3 };
  const sortedHand = [...v.yourHand].sort((a, b) =>
    (a.joker ? 1 : 0) - (b.joker ? 1 : 0) ||
    (HLJ_SUIT_ORDER[a.suit] ?? 4) - (HLJ_SUIT_ORDER[b.suit] ?? 4) ||
    a.rank - b.rank
  );
  const holdActive = !!S.hljTrickHold;
  const hand = `<div class="fan-inner">${fanHand(sortedHand, (c) => ({
    playable: !holdActive && plays.has(cardKey(c)),
    dim: !holdActive && plays.size > 0 && !plays.has(cardKey(c)),
    action: !holdActive && plays.has(cardKey(c)) ? "play-card" : "",
    key: cardKey(c),
  }))}</div>`;

  // Bid result tokens positioned on the felt near each player
  // plus your chip buttons anchored at the bottom of the felt
  const minBid = bids.length ? bids[0].amount : 2;
  const curHighAmt = v.highBid ? v.highBid.amount : null;
  const bidHistory = Array.isArray(v.bidHistory) ? v.bidHistory : [];

  // Bid token positions use the same circle formula as trick cards
  const bidPosStyle = (seat) => {
    const n = v.seats.length;
    if (you == null) return "top:20%;left:50%;transform:translate(-50%,-50%)";
    const off = (seat - you + n) % n;
    // User's own seat: fixed lower-center to match the chip panel position
    if (off === 0) return "top:87%;left:50%;transform:translate(-50%,-50%)";
    // Other seats: tighter bounds so chips appear inward from card backs
    const { x, y } = wallPerimPos(off, n, { x1: 26, x2: 74, y1: 33, y2: 71 });
    return `top:${y}%;left:${x}%;transform:translate(-50%,-50%)`;
  };
  const bidTokens = (() => {
    // While the bid-end hold is active, freeze the full bid overlay
    if (S.hljBidHold && v.phase === "playing") {
      const bh = S.hljBidHold;
      const holdPos = (seat) => {
        const n = bh.seats.length;
        if (bh.you == null) return "top:20%;left:50%;transform:translate(-50%,-50%)";
        const off = (seat - bh.you + n) % n;
        if (off === 0) return "top:87%;left:50%;transform:translate(-50%,-50%)";
        const { x, y } = wallPerimPos(off, n, { x1: 26, x2: 74, y1: 33, y2: 71 });
        return `top:${y}%;left:${x}%;transform:translate(-50%,-50%)`;
      };
      const highBidSeat = bh.highBid?.seat ?? null;
      const histToks = (bh.bidHistory ?? []).filter(b => !b.implicit).map(b => {
        const style = holdPos(b.seat);
        const label = b.type === "pass" ? "Pass" : String(b.amount);
        const isHigh = b.type === "bid" && b.seat === highBidSeat;
        const team = `t${b.seat % 2 === 0 ? "A" : "B"}`;
        const cls = b.type === "pass" ? "pass" : `chip ${team}${isHigh ? " high" : ""}`;
        return `<div class="hlj-bid-token ${cls}" style="${style}">${label}</div>`;
      }).join("");
      return histToks;
    }
    if (v.phase === "bidding") {
      const highBidSeat = v.highBid?.seat ?? null;
      const histToks = bidHistory.filter(b => !b.implicit).map(b => {
        const style = bidPosStyle(b.seat);
        const label = b.type === "pass" ? "Pass" : String(b.amount);
        const isHigh = b.type === "bid" && b.seat === highBidSeat;
        const team = `t${b.seat % 2 === 0 ? "A" : "B"}`;
        const cls = b.type === "pass" ? "pass" : `chip ${team}${isHigh ? " high" : ""}`;
        return `<div class="hlj-bid-token ${cls}" style="${style}">${label}</div>`;
      }).join("");
      return histToks;
    }
    if (v.phase === "playing" && v.highBid && !v.trumpRevealed) {
      const team = `t${v.highBid.seat % 2 === 0 ? "A" : "B"}`;
      const bidTok = `<div class="hlj-bid-token chip ${team} high" style="${bidPosStyle(v.highBid.seat)}">${v.highBid.amount}</div>`;
      return bidTok;
    }
    return "";
  })();
  const bidOverlay = bidTokens
    ? `<div class="hlj-bid-overlay">${bidTokens}</div>`
    : "";

  // Your chip buttons — shown for the whole bidding phase, dimmed until your turn
  const claimedAmounts = new Set(
    bidHistory.filter(b => b.type === "bid").map(b => b.amount)
  );
  const isDealer = v.you != null && v.dealerSeat === v.you;
  const userHasActed = v.you != null && bidHistory.some(b => b.seat === v.you);
  const myTeamCls = you != null ? `t${you % 2 === 0 ? "A" : "B"}` : "";
  const feltBidPanel = v.phase === "bidding" && v.you != null && !userHasActed
    ? `<div class="hlj-felt-bid${v.yourTurn ? "" : " waiting"}">
        <div class="hlj-chips">
          ${[2,3,4,5,6].map(n => {
            if (claimedAmounts.has(n)) {
              // Dealer can steal the current high bid
              if (isDealer && n === curHighAmt)
                return `<button class="hlj-chip ${myTeamCls} steal" data-action="move-bid" data-amount="${n}" ${!v.yourTurn ? "disabled" : ""}>STEAL</button>`;
              return "";
            }
            // Hide amounts that can't outbid the current high (non-dealer can't match, only beat)
            if (curHighAmt != null && n <= curHighAmt) return "";
            const legal = n >= minBid;
            return `<button class="hlj-chip ${myTeamCls}${!legal ? " blocked" : ""}" data-action="move-bid" data-amount="${n}" ${(!legal || !v.yourTurn) ? "disabled" : ""}>${n}</button>`;
          }).join("")}
          <button class="hlj-pass-btn" data-action="move-pass" ${!v.yourTurn ? "disabled" : ""}>Pass</button>
        </div>
      </div>`
    : "";
  const bidSlider = "";  // removed from selfExtra

  // Signal -- only shown for players who have bid (not passed)
  const signalLevels = ["weak", "medium", "strong"];
  const curSignal = v.you != null ? v.signals?.[v.you] : null;
  const sigIdx = curSignal ? signalLevels.indexOf(curSignal) : -1;
  const youHaveBid = v.you != null && Array.isArray(v.bidHistory) && v.bidHistory.some(b => b.seat === v.you && b.type === "bid");
  // Signal control hidden for now — architecture kept for later
  const signalControl = "";
  const trumpControl = "";

  const playHint = "";

  // Team score strip below hand
  const myTeamIdx = you != null ? you % 2 : 0; // 0=A, 1=B
  const oppTeamIdx = 1 - myTeamIdx;
  const myTeamLetter = myTeamIdx === 0 ? "A" : "B";
  const oppTeamLetter = myTeamIdx === 0 ? "B" : "A";
  const seriesA = v.gamesWon?.[myTeamIdx] ?? 0;
  const seriesB = v.gamesWon?.[oppTeamIdx] ?? 0;
  const seriesSuffix = (v.winsNeeded ?? 1) > 1 ? ` (${seriesA}\u2013${seriesB})` : "";
  const teamScores = `<div class="hlj-scores">
    <span class="hlj-score-pill t${myTeamLetter} mine"><span class="teamdot t${myTeamLetter}"></span>Team ${myTeamLetter}&nbsp;<b>${v.scores[myTeamIdx]}</b>${seriesSuffix}</span>
    <span class="hlj-score-pill t${oppTeamLetter}"><span class="teamdot t${oppTeamLetter}"></span>Team ${oppTeamLetter}&nbsp;<b>${v.scores[oppTeamIdx]}</b> \u00b7 to ${v.target}</span>
  </div>`;

  const selfExtra = `${teamScores}${signalControl}${trumpControl}${playHint}`;

  const partners = you != null ? v.seats.map((s, i) => i).filter((i) => i !== you && i % 2 === you % 2) : [];
  const partnerNames = partners.map((i) => seatName(v, i)).join(", ");
  const isYouDealer = you != null && you === v.dealerSeat;
  const selfMeta = you != null
    ? `<span class="teambadge t${you % 2 === 0 ? "A" : "B"}">Team ${you % 2 === 0 ? "A" : "B"}</span> <span class="me-partner">partner: ${esc(partnerNames || "\u2014")}</span>${v.phase === "playing" && v.trumpRevealed && v.highBid?.seat === you ? ` <span class="pod-dealer-badge bid ${myTeamCls}">${v.highBid.amount}</span>` : isYouDealer ? ` <span class="pod-dealer-badge">D</span>` : ""}`
    : `play to ${v.target}`;
  const selfTurn = v.yourTurn
    ? `<span class="turnflag">Your turn</span>`
    : `<span class="waitflag">${esc(seatName(v, v.toAct))}'s turn</span>`;

  // End-of-hand result popup
  const hljHandModal = (() => {
    const lh = v.lastHand;
    if (!lh || v.phase === "gameOver") return "";
    const handKey = JSON.stringify(lh);
    if (S.hljHandAcked === handKey) return "";
    // Wait for the trick-hold animation to finish before showing the result screen
    if (!S.hljHandVisible) return "";

    if (S.hljHandTimer == null) {
      S.hljHandTimer = setTimeout(() => {
        S.hljHandAcked = handKey;
        S.hljHandTimer = null;
        render();
      }, 30000);
    }

    const bidderTeamLetter = lh.bidderTeam === 0 ? "A" : "B";
    const bidderName = esc(seatName(v, lh.bidderSeat));

    const pts = lh.detail;
    const honors = [
      { label: "High",     team: pts.high },
      { label: "Low",      team: pts.low },
      { label: "Jack",     team: pts.jack },
      { label: "Bonhomme", team: pts.bonhomme },
    ];

    // Two-column layout: Team A column | Team B column
    const colA = honors.filter(h => h.team === 0 && h.team !== null && h.team !== undefined);
    const colB = honors.filter(h => h.team === 1 && h.team !== null && h.team !== undefined);
    const totalA = lh.pointsByTeam[0];
    const totalB = lh.pointsByTeam[1];

    const honorList = (items) => items.length
      ? items.map(h => `<div class="hlj-rr-honor">${h.label}</div>`).join("")
      : `<div class="hlj-rr-honor none">—</div>`;

    // Game point row: always show both teams' pip counts
    const gcA = pts.gameCount?.[0] ?? 0;
    const gcB = pts.gameCount?.[1] ?? 0;
    const gameRow = pts.game != null
      ? `<div class="hlj-rr-game-row">
          <span class="hlj-rr-game-label">Game</span>
          <span class="hlj-rr-game-pips${pts.game === 0 ? " win" : ""}">Team A: ${gcA}</span>
          <span class="hlj-rr-game-sep">·</span>
          <span class="hlj-rr-game-pips${pts.game === 1 ? " win" : ""}">Team B: ${gcB}</span>
        </div>`
      : "";

    const ptRows = `<div class="hlj-rr-twocol">
      <div class="hlj-rr-col tA">
        <div class="hlj-rr-colhdr tA">Team A · ${totalA} pt${totalA !== 1 ? "s" : ""}</div>
        ${honorList(colA)}
      </div>
      <div class="hlj-rr-col tB">
        <div class="hlj-rr-colhdr tB">Team B · ${totalB} pt${totalB !== 1 ? "s" : ""}</div>
        ${honorList(colB)}
      </div>
    </div>${gameRow}`;

    const made = lh.made;
    const scoreRows = [0, 1].map(t => {
      const letter = t === 0 ? "A" : "B";
      const delta = lh.deltaByTeam[t];
      const total = v.scores[t];
      const sign = delta > 0 ? "+" : "";
      const isBidder = t === lh.bidderTeam;
      return `<div class="hlj-rr-scorerow${isBidder && !made ? " setback" : ""}">
        <span class="hlj-rr-scoreteam t${letter}">Team ${letter}</span>
        <span class="hlj-rr-scoredelta">${sign}${delta}</span>
        <span class="hlj-rr-scoretotal">${total} pts</span>
      </div>`;
    }).join("");

    const kittyCards = (v.lastKitty || []).map(c => cardHTML(c, { mini: true })).join("");
    const kittySection = kittyCards
      ? `<div class="hlj-rr-section"><div class="hlj-rr-seclabel">Kitty</div><div class="hlj-rr-kitty">${kittyCards}</div></div>`
      : "";

    const dealtHands = v.lastDealtHands;
    const dealtHandsModal = dealtHands && S.hljShowDealtHands
      ? `<div class="modal-back" data-action="hlj-close-dealt-hands">
          <div class="modal" data-stop="1" style="max-width:360px">
            <div class="modalhead"><span>Dealt hands</span><button class="btn sm ghost" data-action="hlj-close-dealt-hands">Close</button></div>
            <div class="modalbody" style="padding:10px 14px 14px;display:flex;flex-direction:column;gap:12px">
              ${dealtHands.map((hand, seat) => {
                const sorted = [...hand].sort((a, b) => {
                  if (a.joker) return 1; if (b.joker) return -1;
                  const so = { S: 0, H: 1, D: 2, C: 3 };
                  return (so[a.suit] - so[b.suit]) || (a.rank - b.rank);
                });
                return `<div class="hlj-dh-row"><span class="hlj-dh-name">${esc(seatName(v, seat))}</span><div class="hlj-dh-cards">${sorted.map(c => cardHTML(c, { mini: true })).join("")}</div></div>`;
              }).join("")}
            </div>
          </div>
        </div>`
      : "";
    const dealtPile = dealtHands
      ? `<button class="hlj-dealt-pile-btn" data-action="hlj-show-dealt-hands"><span class="hlj-dealt-pile-stack">${dealtHands.flat().slice(0,4).map(c => cardHTML(c, { mini: true })).join("")}</span><span class="hlj-dealt-pile-label">Show dealt hands</span></button>`
      : "";

    return `<div class="hlj-result-page">
      ${dealtHandsModal}
      <div class="hlj-result-felt">
        <div class="hlj-result-scroll">
          <div class="hlj-result-headline">
            <div class="hlj-result-handover">Hand over</div>
            <div class="hlj-result-bidline">${bidderName} bid <b>${lh.bid}</b> for Team ${bidderTeamLetter}</div>
            <div class="hlj-result-verdict ${made ? "made" : "set"}">${made ? "Made it" : "Set back"}</div>
          </div>
          <div class="hlj-result-card">
            <div class="hlj-rr-seclabel">Points taken</div>
            ${ptRows}
          </div>
          ${kittySection ? `<div class="hlj-result-card">${kittySection}</div>` : ""}
          <div class="hlj-result-card hlj-result-scores">
            <div class="hlj-rr-seclabel">Score</div>
            ${scoreRows}
          </div>
          ${dealtPile}
          <button class="hlj-result-next-btn" data-action="hlj-ack-hand">Next hand →</button>
        </div>
      </div>
    </div>`;
  })();

  // If a hand result is pending acknowledgment, show a dedicated full-screen
  // result page instead of the table so the table isn't visible behind it.
  if (hljHandModal !== "") {
    app.__set = hljHandModal;
    return;
  }

  const cornerSuits = ['♠','♥','♦','♣'].map((s,i) =>
    `<span class="felt-corner-suit ${i===1||i===2 ? 'red' : ''} ${ ['tl','tr','br','bl'][i] }">${s}</span>`
  ).join("");
  app.__set = tableShell(v, { pods, center, feltHeader: "", trick: (hljTrick || "") + bidOverlay, feltBid: feltBidPanel, feltOverlay, cornerSuits, hand, actions: null, selfMeta, selfTurn, selfExtra });
}

// ---------- Rummy 500: client-side rule mirror ----------
// These mirror rummy-module.ts so the UI can disable illegal actions outright
// (the server still re-validates). Jokers are wild in both sets and runs.
function rIsSet(cards) {
  if (cards.length < 3) return false;
  const nat = cards.filter((c) => !c.joker);
  return nat.length > 0 && nat.every((c) => c.rank === nat[0].rank);
}
function rIsRun(cards) {
  if (cards.length < 3) return false;
  const nat = cards.filter((c) => !c.joker);
  const jokers = cards.length - nat.length;
  if (!nat.length) return false;
  const suit = nat[0].suit;
  if (!nat.every((c) => c.suit === suit)) return false;
  for (const ace of [1, 14]) {
    const ranks = nat.map((c) => (c.rank === 14 ? ace : c.rank)).sort((a, b) => a - b);
    if (new Set(ranks).size !== ranks.length) continue;
    const lo = ranks[0], hi = ranks[ranks.length - 1];
    if (lo < 1 || hi > 14) continue;
    const gaps = hi - lo + 1 - ranks.length;
    if (gaps < 0 || gaps > jokers) continue;
    const extra = jokers - gaps;
    if (hi - lo + 1 + extra > 14) continue;
    if ((lo - 1) + (14 - hi) < extra) continue;
    return true;
  }
  return false;
}
const rValidMeld = (cards) => rIsSet(cards) || rIsRun(cards);
const rCanLayoff = (meld, cards) =>
  meld.kind === "set" ? rIsSet([...meld.cards, ...cards]) : rIsRun([...meld.cards, ...cards]);

// Reconcile S.rummyOrder with the live hand: keep order, append new cards, drop gone ones.
function rummyOrdered(hand) {
  const ids = hand.map((c) => c.id);
  S.rummyOrder = S.rummyOrder.filter((id) => ids.includes(id));
  for (const id of ids) if (!S.rummyOrder.includes(id)) S.rummyOrder.push(id);
  return S.rummyOrder.map((id) => hand.find((c) => c.id === id)).filter(Boolean);
}
function rummySort(hand, mode) {
  const rank = (c) => (c.joker ? 100 : c.rank); // jokers sort to the end
  const suitOrder = { S: 0, H: 1, C: 2, D: 3 };
  const by = mode === "suit"
    ? (a, b) => (a.joker - b.joker) || (suitOrder[a.suit] - suitOrder[b.suit]) || (rank(a) - rank(b))
    : (a, b) => (rank(a) - rank(b)) || (suitOrder[a.suit] - suitOrder[b.suit]);
  S.rummyOrder = [...hand].sort(by).map((c) => c.id);
  render();
}

// ---------- Rummy 500 ----------

// Mirror of orderRunCards from rummy-module — returns parallel array of
// resolved {rank,suit} for each card (null for natural cards).
function resolveJokers(meld) {
  const cards = meld.cards;
  if (meld.kind === "set") {
    const naturalRank = cards.find((c) => !c.joker)?.rank;
    if (naturalRank == null) return cards.map(() => null);
    const usedSuits = new Set(cards.filter((c) => !c.joker).map((c) => c.suit));
    const freeSuits = ["S", "H", "C", "D"].filter((s) => !usedSuits.has(s));
    let si = 0;
    return cards.map((c) => c.joker ? { rank: naturalRank, suit: freeSuits[si++] ?? "S" } : null);
  }
  // run: mirror orderRunCards logic
  const naturals = cards.filter((c) => !c.joker);
  const jokers = cards.filter((c) => c.joker);
  if (!naturals.length) return cards.map(() => null);
  for (const aceRank of [1, 14]) {
    const eff = naturals.map((c) => ({ c, r: c.rank === 14 ? aceRank : c.rank })).sort((a, b) => a.r - b.r);
    const ranks = eff.map((x) => x.r);
    if (new Set(ranks).size !== ranks.length) continue;
    const low = ranks[0], high = ranks[ranks.length - 1];
    const gaps = high - low + 1 - ranks.length;
    if (gaps < 0 || gaps > jokers.length) continue;
    const extra = jokers.length - gaps;
    const after = Math.min(extra, 14 - high);
    const before = extra - after;
    if (before > low - 1) continue;
    const suit = naturals[0].suit; // runs are same suit
    const byRank = new Map(eff.map((x) => [x.r, x.c]));
    const jkAssign = [];
    for (let r = low - before; r <= high + after; r++) if (!byRank.has(r)) jkAssign.push(r);
    let ji = 0;
    // Map original jokers to their assigned ranks in order they appear in cards[]
    const jokerRanks = new Map();
    for (const jk of jokers) jokerRanks.set(jk, jkAssign[ji++]);
    return cards.map((c) => c.joker ? { rank: jokerRanks.get(c) ?? 0, suit } : null);
  }
  return cards.map(() => null);
}

// Can card `c` join the current selection and still potentially form a valid meld/layoff?
function rCompatible(sel, c, layMeld) {
  if (c.joker) return true;
  if (!sel.length) return true;
  if (layMeld) return rCanLayoff(layMeld, [...sel, c]);
  const naturals = sel.filter((s) => !s.joker);
  if (!naturals.length) return true; // only jokers selected so far
  const jokerCount = sel.filter((s) => s.joker).length;
  // Set: same rank, no duplicate suit
  const setRank = naturals[0].rank;
  if (naturals.every((s) => s.rank === setRank) && c.rank === setRank && !sel.some((s) => s.suit === c.suit))
    return true;
  // Run: same suit, rank fits in range with available jokers as gap-fill
  const runSuit = naturals[0].suit;
  if (naturals.every((s) => s.suit === runSuit) && c.suit === runSuit) {
    const allRanks = [...naturals.map((s) => s.rank), c.rank].sort((a, b) => a - b);
    const lo = allRanks[0], hi = allRanks[allRanks.length - 1];
    const gaps = hi - lo + 1 - allRanks.length;
    if (gaps >= 0 && gaps <= jokerCount) return true;
  }
  return false;
}

function renderRummy(v) {
  // prune stale selections (cards no longer in hand)
  const handIds = new Set(v.yourHand.map((c) => c.id));
  for (const id of [...S.rummySel]) if (!handIds.has(id)) S.rummySel.delete(id);

  if (v.phase === "gameOver") {
    const rows = v.seats.map((s, i) => ({ name: seatName(v, i), score: v.scores[i], win: i === v.winner, you: i === v.you }));
    return renderGameOver(v, v.winner == null ? "Game over" : `${seatName(v, v.winner)} wins!`, scoreList(rows));
  }

  const lm = v.yourTurn ? v.legalMoves : [];
  const canStock = lm.some((m) => m.type === "drawStock");
  const discardDraw = lm.find((m) => m.type === "drawDiscard");
  const bottom = v.discard.length ? v.discard[0] : null;
  const canTakePile = bottom && lm.some((m) => m.type === "drawDiscard" && m.cardId === bottom.id) && v.discard.length > 1;
  const top = v.discard.length ? v.discard[v.discard.length - 1] : null;
  const inPlay = v.yourTurn && v.turnPhase === "play";

  const pods = v.seats
    .map((s, i) =>
      i === v.you
        ? null
        : { seat: i, html: podHTML(v, i, {
            active: i === v.toAct,
            dealer: i === v.dealerSeat,
            count: v.handCounts[i],
            cardCount: v.handCounts[i],
            pts: v.scores[i],
            note: i === v.toAct && v.turnPhase ? v.turnPhase : null,
          }) },
    )
    .filter(Boolean);

  // center: stock + discard piles (mini), then melds on the felt
  const stock = `<div class="pile mini-pile">
      <div class="lbl">Stock</div>
      <div class="stockwrap" ${canStock ? `data-action="draw-stock" style="cursor:pointer"` : ""}>
        ${v.stockCount > 1 ? cardHTML({}, { back: true, mini: true, style: "position:absolute;top:2px;left:2px;opacity:.6" }) : ""}
        ${v.stockCount > 0 ? cardHTML({}, { back: true, mini: true }) : `<div class="card mini" style="opacity:.22"></div>`}
      </div>
      <div class="pts">${v.stockCount} left</div>
    </div>`;
  // Discard pile: clicking always opens the full pile modal.
  const peek = v.discard.slice(-5);
  const stackCards = peek
    .map((c, i) => {
      const off = (peek.length - 1 - i) * 4;
      const style = `position:absolute;left:${-off}px;top:${-off}px;z-index:${i}`;
      return cardHTML(c, { mini: true, style: style + (i < peek.length - 1 ? ";filter:brightness(.92)" : "") });
    })
    .join("");
  const discard = `<div class="pile mini-pile">
      <div class="lbl">Discard</div>
      <div class="discardstack" data-action="open-discard" title="View discard pile" style="cursor:pointer">
        ${top ? stackCards : `<div class="card mini" style="opacity:.22"></div>`}
      </div>
      <div class="pts">${v.discard.length} card${v.discard.length === 1 ? "" : "s"}</div>
    </div>`;
  // Compute selected cards early so melds can highlight valid layoff targets
  const orderedForMelds = rummyOrdered(v.yourHand);
  const selCardsForMelds = orderedForMelds.filter((c) => S.rummySel.has(c.id));

  const melds = v.melds.length
    ? `<div class="melds">${v.melds.map((m) => {
          const active = S.rummyLayoff === m.id;
          // Highlight melds that can accept the current hand selection as a layoff
          const validLayoff = inPlay && selCardsForMelds.length >= 1
            && S.rummyLayoff === null && rCanLayoff(m, selCardsForMelds);
          const jokerRes = resolveJokers(m);
          const meldAttrs = `data-action="open-meld" data-meldid="${m.id}"`;
          let inner;
          if (m.kind === "set") {
            // Fan like runs; put the odd-color card on top (last = highest z-index)
            const naturals = m.cards.filter((c) => !c.joker);
            const redCount = naturals.filter((c) => RED.has(c.suit)).length;
            const blackCount = naturals.length - redCount;
            const oddIsRed = redCount < blackCount; // minority color is the odd one
            const sorted = [...m.cards].sort((a, b) => {
              const aOdd = a.joker ? 0 : (RED.has(a.suit) === oddIsRed ? 1 : 0);
              const bOdd = b.joker ? 0 : (RED.has(b.suit) === oddIsRed ? 1 : 0);
              return aOdd - bOdd; // odd-color card sorts last (on top)
            });
            const n = sorted.length;
            const negMargin = n <= 1 ? 0 : Math.round(44 * (n - 2) / (n - 1));
            const allCards = sorted.map((c, ci) => {
              const ml = ci === 0 ? "" : `margin-left:-${negMargin}px`;
              return cardHTML(c, { mini: true, inMeld: true, style: ml });
            }).join("");
            inner = `<div class="run-dense tappable">${allCards}</div>`;
          } else {
            // Run: fixed total width of 2 mini cards; margin shrinks as count grows
            const n = m.cards.length;
            const negMargin = n <= 1 ? 0 : Math.round(44 * (n - 2) / (n - 1));
            const allCards = m.cards.map((c, ci) => {
              const ml = ci === 0 ? "" : `margin-left:-${negMargin}px`;
              return cardHTML(c, { mini: true, jokerAs: jokerRes[ci] ?? undefined, inMeld: true, style: ml });
            }).join("");
            inner = `<div class="run-dense tappable">${allCards}</div>`;
          }
          const meldClass = active ? "target" : validLayoff ? "layoff-hint" : "";
          return `<div class="meld tappable ${meldClass}" ${meldAttrs}>${inner}<span class="owner">${esc(seatName(v, m.owner))}</span></div>`;
        }).join("")}</div>`
    : `<div class="callout" style="font-size:13px">No melds down yet.</div>`;
  const center = `<div class="piles">${stock}${discard}</div>`;

  // hand: selected cards float to a row above the fan; unselected cards are fanned.
  // Cards incompatible with the current selection are dimmed.
  const ordered = rummyOrdered(v.yourHand);
  const selCards = ordered.filter((c) => S.rummySel.has(c.id));
  const fanCards = ordered.filter((c) => !S.rummySel.has(c.id));
  const layMeld = v.melds.find((m) => m.id === S.rummyLayoff);

  // Determine which unselected cards are compatible with the current selection
  const compatibleIds = inPlay && selCards.length
    ? new Set(fanCards.filter((c) => rCompatible(selCards, c, layMeld)).map((c) => c.id))
    : null; // null = no filtering

  const selRow = selCards.length
    ? `<div class="selrow">${selCards.map((c) => cardHTML(c, {
        action: "toggle-card", id: c.id, sel: true,
        must: c.id === v.mustMeldCardId,
      })).join("")}</div>`
    : "";
  const fan = fanHand(fanCards, (c) => {
    const incompatible = inPlay && compatibleIds != null && !compatibleIds.has(c.id);
    return {
      action: incompatible ? "" : "toggle-card",
      id: incompatible ? undefined : c.id,
      draggable: !incompatible,
      must: c.id === v.mustMeldCardId,
      playable: inPlay && !incompatible,
      dim: incompatible,
    };
  });
  const hand = selRow + (fan ? `<div class="fan-inner">${fan}</div>` : "");
  const canMeld = selCards.length >= 3 && rValidMeld(selCards);
  const canLay = !!layMeld && selCards.length >= 1 && rCanLayoff(layMeld, selCards);
  const canDiscard = selCards.length === 1 && v.mustMeldCardId == null;

  // sort controls (available whenever you hold cards) \u2014 single alternating button
  const nextSort = S.rummySort === "suit" ? "rank" : "suit";
  const sortBar = v.yourHand.length
    ? `<button class="btn ghost sm" data-action="sort-toggle">Sort ${nextSort === "suit" ? "\u2660\u2665 suit" : "1\u20139 rank"}</button>`
    : "";

  // actions
  const acts = [];
  if (v.yourTurn && v.turnPhase === "draw") {
    if (canStock) acts.push(`<button class="btn" data-action="draw-stock">Draw stock</button>`);
    acts.push(sortBar);
    acts.push(`<span class="hint">Draw from stock, or tap the discard pile to pick up cards.</span>`);
  } else if (inPlay) {
    const n = S.rummySel.size;
    if (canMeld) {
      acts.push(`<button class="btn" data-action="meld-selected">Play meld (${n})</button>`);
      acts.push(`<button class="btn ghost sm" data-action="clear-sel">Clear</button>`);
    } else if (canLay) {
      acts.push(`<button class="btn" data-action="layoff-selected">Lay off (${n})</button>`);
      acts.push(`<button class="btn ghost sm" data-action="clear-sel">Clear</button>`);
    } else if (canDiscard) {
      acts.push(`<button class="btn" data-action="discard-selected">Discard</button>`);
      acts.push(`<button class="btn ghost sm" data-action="clear-sel">Clear</button>`);
    } else if (n) {
      acts.push(`<button class="btn ghost sm" data-action="clear-sel">Clear</button>`);
    }
    acts.push(sortBar);
    if (v.mustMeldCardId != null) acts.push(`<span class="hint">The green card must be melded or laid off before you discard.</span>`);
    else if (canMeld) acts.push(`<span class="hint">Tap \u201cPlay meld\u201d to put these ${n} cards down.</span>`);
    else if (canLay) acts.push(`<span class="hint">Tap \u201cLay off\u201d to add these cards to the highlighted meld.</span>`);
    else if (n >= 3) acts.push(`<span class="hint">These cards don\u2019t form a valid meld.</span>`);
    else acts.push(`<span class="hint">Select cards to meld or lay off, or select one to discard. Tap a meld to target it.</span>`);
  } else {
    acts.push(sortBar);
  }

  const myScore = v.you != null ? v.scores[v.you] : null;
  const selfMeta = myScore != null
    ? `<span class="score-chip">${myScore}</span><span class="score-meta"> of ${v.target}</span>`
    : `play to ${v.target}`;
  const selfTurn = v.yourTurn
    ? `<span class="turnflag">Your turn \u2014 ${v.turnPhase === "draw" ? "draw" : "play"}</span>`
    : `<span class="waitflag">${esc(seatName(v, v.toAct))}'s turn</span>`;

  app.__set = tableShell(v, { pods, center, feltBottom: melds, hand, actions: acts.join(""), selfMeta, selfTurn }) + discardModal(v) + rummyMeldModal(v) + rummyRoundModal(v);
}

// Round-end summary popup: shown after a round finishes, auto-dismisses after 20s.
function rummyRoundModal(v) {
  if (!v.lastRound || v.phase === "gameOver") return "";
  const lr = v.lastRound;
  const roundKey = JSON.stringify(v.scores); // unique per round result
  if (S.rummyRoundAcked === roundKey) return "";

  // Brief pause before showing the summary so players can see the final state.
  if (!S.rummyRoundVisible) {
    if (S.rummyRoundTimer === null) {
      S.rummyRoundTimer = setTimeout(() => {
        S.rummyRoundVisible = true;
        S.rummyRoundTimer = null;
        render();
      }, 1800);
    }
    return ""; // modal not visible yet during the pause
  }

  // Start the 20s auto-dismiss timer once per round popup.
  if (S.rummyRoundTimer === null) {
    S.rummyRoundTimer = setTimeout(() => {
      S.rummyRoundAcked = roundKey;
      S.rummyRoundVisible = false;
      S.rummyRoundTimer = null;
      render();
    }, 20000);
  }

  const rows = v.seats.map((_, i) => {
    const name = esc(seatName(v, i));
    const melded = lr.meldedPts[i] ?? 0;
    const held = lr.heldPts[i] ?? 0;
    const net = lr.delta[i] ?? 0;
    const total = v.scores[i];
    const wentOut = i === lr.outSeat;
    const mathStr = wentOut
      ? `${melded > 0 ? `+${melded}` : melded}`
      : `${melded > 0 ? `+${melded}` : melded} − ${held}`;
    const netStr = net >= 0 ? `+${net}` : `${net}`;
    const heldHand = lr.heldCards?.[i] ?? [];
    const heldCardEls = !wentOut && heldHand.length
      ? `<div class="rr-held">${heldHand.map((c) => cardHTML(c, { mini: true })).join("")}</div>`
      : "";
    return `<div class="rr-row${wentOut ? " rr-out" : ""}">
      <div class="rr-name">${name}${wentOut ? " <span class='rr-badge'>went out</span>" : ""}</div>
      <div class="rr-math">${mathStr} = <b>${netStr}</b></div>
      <div class="rr-total">Total: ${total}</div>
      ${heldCardEls}
    </div>`;
  }).join("");

  return `<div class="modal-back" data-action="ack-round">
    <div class="modal" data-stop="1">
      <div class="modalhead"><span>Round over</span></div>
      <div class="modalbody rr-body">${rows}</div>
      <div style="padding:8px 14px 4px;text-align:right">
        <button class="btn" data-action="ack-round">Next hand</button>
      </div>
    </div>
  </div>`;
}

// Popup showing all cards in a single meld. Reachable by tapping any meld on the felt.
function rummyMeldModal(v) {
  if (S.rummyMeldOpen == null) return "";
  const m = v.melds.find((x) => x.id === S.rummyMeldOpen);
  if (!m) { S.rummyMeldOpen = null; return ""; }
  const inPlay = v.yourTurn && v.turnPhase === "play";
  const jokerRes = resolveJokers(m);
  const cards = m.cards.map((c, ci) =>
    cardHTML(c, { mini: true, jokerAs: jokerRes[ci] ?? undefined })
  ).join("");
  const kind = m.kind === "set" ? "Set" : "Run";
  const owner = esc(seatName(v, m.owner));
  const isTargeted = S.rummyLayoff === m.id;
  const layBtn = inPlay
    ? (isTargeted
        ? `<button class="btn ghost sm" data-action="unlayoff-meld">Remove lay-off target</button>`
        : `<button class="btn" data-action="layoff-meld" data-meldid="${m.id}">Lay off here</button>`)
    : "";
  return `<div class="modal-back" data-action="close-meld">
      <div class="modal" data-stop="1">
        <div class="modalhead"><span>${kind} — ${owner}</span>
          <button class="btn sm ghost" data-action="close-meld">Close</button></div>
        <div class="modalbody">
          <div class="meld-modal-cards">${cards}</div>
          ${layBtn ? `<div style="margin-top:10px">${layBtn}</div>` : ""}
        </div>
      </div>
    </div>`;
}

// Popup listing the whole discard pile. During draw phase, cards are clickable
// when legal; non-legal deeper cards are greyed out.
function discardModal(v) {
  if (!S.discardOpen) return "";
  const canDraw = v.yourTurn && v.turnPhase === "draw";
  const lm = canDraw ? v.legalMoves : [];
  // Deeper-card legal ids (from generateMoves); top card is ALWAYS legal when canDraw.
  const deepLegalIds = new Set(lm.filter((m) => m.type === "drawDiscard").map((m) => m.cardId));
  const n = v.discard.length;
  const cards = n
    ? v.discard.map((c, i) => {
        const isTop = i === n - 1;
        // Top card is always takeable; deeper cards only if engine says so.
        const legal = canDraw && (isTop || deepLegalIds.has(c.id));
        const label = isTop ? "top" : i === 0 && n > 1 ? "bottom" : "";
        const cardEl = legal
          ? cardHTML(c, { mini: true, playable: true, action: "draw-discard", id: c.id })
          : cardHTML(c, { mini: true, style: "opacity:.35" });
        const sweepLabel = !isTop && legal ? `<span class="sweep-label">Takes ${n - i} cards</span>` : "";
        return `<div class="dcard ${label}">${cardEl}${sweepLabel}</div>`;
      }).join("")
    : `<div class="callout" style="font-size:13px">The discard pile is empty.</div>`;
  const hint = canDraw
    ? `<p class="sub" style="margin:8px 14px 0">Tap a card to take it and everything above it. Greyed cards can't be taken this turn.</p>`
    : `<p class="sub" style="margin:8px 14px 0">Oldest first \u2014 top card is highlighted.</p>`;
  return `<div class="modal-back" data-action="close-discard">
      <div class="modal" data-stop="1">
        <div class="modalhead"><span>Discard pile \u2014 ${n} card${n === 1 ? "" : "s"}</span>
          <button class="btn sm ghost" data-action="close-discard">Close</button></div>
        <div class="modalbody"><div class="dgrid">${cards}</div></div>
        ${hint}
      </div>
    </div>`;
}

// ---------- actions ----------
// ---------- Hearts (Black Lady) ----------
// Pass direction from the seat offset the server reports (0 = a "hold" hand).
const passDir = (offset, players) =>
  offset === 0 ? "hold" : offset === 1 ? "left" : offset === players - 1 ? "right" : "across";

function renderHearts(v) {
  // Prune stale pass selections (cards that left the hand after the exchange).
  const handIds = new Set(v.yourHand.map((c) => c.id));
  for (const id of [...S.heartsPass]) if (!handIds.has(id)) S.heartsPass.delete(id);

  if (v.phase === "gameOver") {
    const rows = v.seats.map((s, i) => ({ name: seatName(v, i), score: v.scores[i], win: i === v.winner, you: i === v.you }));
    // Lowest score wins, so the title still points at v.winner (server picks the min).
    return renderGameOver(v, v.winner == null ? "Game over" : `${seatName(v, v.winner)} wins!`, scoreList(rows));
  }

  const passing = v.phase === "passing";
  // Hearts cards carry ids; legalMoves give the playable card ids for this turn.
  const plays = new Set(
    (v.yourTurn && !passing ? v.legalMoves : []).filter((m) => m.type === "play").map((m) => m.card),
  );

  // Pods (everyone but you): running total is the big number; cards left as the
  // stack count; a small note for who's to play / points taken this hand.
  const pods = v.seats
    .map((s, i) =>
      i === v.you
        ? null
        : { seat: i, html: podHTML(v, i, {
            active: i === v.toAct,
            backs: v.handCounts[i],
            cardCount: v.handCounts[i],
            pts: v.scores[i],
            note: passing ? null : i === v.toAct ? "to play" : v.points[i] ? `+${v.points[i]} this hand` : null,
            extraClass: "hearts-backs",
          }) },
    )
    .filter(Boolean);

  // Center: passing prompt, or the crests + the trick (kept showing the last
  // completed trick for a beat once it's swept, so each card is visible).
  let center, heartsTrick;
  if (passing) {
    const dir = passDir(v.passOffset, v.players);
    center = `<div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center">
        <span class="crest">passing <b>${dir}</b></span>
        <span class="crest">hand ${v.handNo + 1}</span>
      </div>
      <div class="callout">${
        v.youPassed ? "Your cards are away \u2014 waiting for the table." : `Choose 3 cards to pass ${dir}.`
      }</div>`;
  } else {
    const crests = `<div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center"><span class="crest">hand ${v.handNo + 1}</span></div>`;
    const showLast = v.currentTrick.length === 0 && v.lastTrick;
    const winSeat = showLast ? v.lastTrick.winner : null;
    if (v.currentTrick.length) {
      const plays = v.currentTrick.map((p) => ({ ...p, name: seatName(v, p.seat) }));
      heartsTrick = trickHTML(plays, v.you, v.seats.length);
    } else if (showLast) {
      const plays = v.lastTrick.cards.map((p) => ({ ...p, name: seatName(v, p.seat) }));
      heartsTrick = trickHTML(plays, v.you, v.seats.length, { winSeat, faded: true });
    }
    const note = showLast
      ? `<div class="callout" style="font-size:13px">Trick to ${esc(seatName(v, v.lastTrick.winner))}.</div>`
      : !v.currentTrick.length ? `<div class="callout">Lead a card to open the trick.</div>` : "";
    center = `${crests}${note}`;
  }

  // Hand: in passing, selected cards lift into a selrow above the fan (Rummy-style).
  let hand;
  if (passing && !v.youPassed) {
    const selCards = v.yourHand.filter((c) => S.heartsPass.has(c.id));
    const fanCards = v.yourHand.filter((c) => !S.heartsPass.has(c.id));
    const selRow = selCards.length
      ? `<div class="selrow">${selCards.map((c) => cardHTML(c, { action: "toggle-pass", id: c.id, sel: true })).join("")}</div>`
      : "";
    const full = S.heartsPass.size >= 3;
    const fan = fanHand(fanCards, (c) => ({ action: full ? "" : "toggle-pass", id: c.id, playable: !full, dim: full }));
    hand = selRow + (fan ? `<div class="fan-inner">${fan}</div>` : "");
  } else {
    hand = `<div class="fan-inner">${fanHand(v.yourHand, (c) => {
      if (passing) return { id: c.id, dim: true };
      const can = plays.has(c.id);
      return { action: can ? "play-hearts" : "", id: c.id, playable: can, dim: plays.size > 0 && !can };
    })}</div>`;
  }

  // Actions.
  const acts = [];
  if (passing && !v.youPassed) {
    const n = S.heartsPass.size;
    acts.push(`<button class="btn" data-action="pass-3" ${v.yourTurn && n === 3 ? "" : "disabled"}>Pass 3${n ? ` (${n}/3)` : ""}</button>`);
    acts.push(`<span class="hint">${n === 3 ? "Tap a selected card to swap it out." : v.yourTurn ? `Select ${3 - n} more card${3 - n === 1 ? "" : "s"} to pass.` : "Stage 3 cards \u2014 you'll confirm on your turn."}</span>`);
  } else if (passing) {
    acts.push(`<span class="hint">Passed \u2014 waiting for the others.</span>`);
  }

  const you = v.you;
  const selfMeta = you != null ? `Score ${v.scores[you]} \u00b7 play to ${v.target} \u00b7 low wins` : `play to ${v.target} \u00b7 low wins`;
  const selfTurn = v.yourTurn
    ? `<span class="turnflag">${passing ? "Your pass" : "Your turn"}</span>`
    : `<span class="waitflag">${esc(seatName(v, v.toAct))}${passing ? " is passing" : "'s turn"}</span>`;

  const heartsFeltOverlay = v.heartsBroken
    ? `<span class="trump-watermark hearts-broken">♥</span>`
    : `<span class="trump-watermark hearts-unbroken">♥</span>`;
  const heartsCornerSuits = ['♠','♥','♦','♣'].map((s,i) =>
    `<span class="felt-corner-suit ${i===1||i===2?'red':''} ${['tl','tr','br','bl'][i]}">${s}</span>`
  ).join("");

  // Cylinder counters embedded in the wood rail — one per seat, compass-positioned
  const cylinderHTML = (count, pos) => {
    const d = String(count ?? 0).padStart(2, "0");
    return `<div class="rail-cyl rail-cyl-${pos}" title="${d} cards">
      <div class="cyl-drum"><span class="cyl-digit">${d[0]}</span><span class="cyl-digit">${d[1]}</span></div>
    </div>`;
  };
  const cylinders = v.seats.map((_, i) => {
    if (i === v.you) return "";
    const offset = ((i - (v.you ?? 0)) + v.players) % v.players;
    const pos = v.players === 2 ? "top"
      : v.players === 3 ? (offset === 1 ? "left" : "right")
      : offset === 1 ? "left" : offset === v.players - 1 ? "right" : "top";
    return cylinderHTML(v.handCounts[i], pos);
  }).join("");

  app.__set = tableShell(v, { pods, center, trick: heartsTrick, feltOverlay: heartsFeltOverlay, cornerSuits: heartsCornerSuits, railCounters: cylinders, hand, actions: acts.join(""), selfMeta, selfTurn });
}

// ---------- Pegs & Jokers ----------
const pjCardLabel = (c) => (!c ? "" : c.joker ? "Joker" : `${rankLabel(c.rank)}${SUIT[c.suit]}`);

function pegXY(board, peg) {
  if (peg.loc.z === "ring") return board.ring[peg.loc.r];
  if (peg.loc.z === "castle") return board.castles[peg.owner][peg.loc.i];
  return board.starts[peg.owner][peg.loc.i];
}

// A painted golf tee standing in a hole: contact shadow, tapered shaft, a
// cupped head with paint sheen and a gloss highlight. Color drives gradient
// stops via CSS vars so one gradient serves every seat color.
function pjTee(x, y, color, glow) {
  const top = y - 3.6, hr = 2.15;
  const f = (n) => n.toFixed(2);
  return `<g style="--tc:${color};--tc-hi:${shade(color, 48)};--tc-sh:${shade(color, -42)}" ${glow ? 'filter="url(#pjglow)"' : ""}>
    <ellipse cx="${f(x + 0.5)}" cy="${f(y + 0.6)}" rx="2.4" ry="0.85" fill="#000" opacity="0.34"/>
    <path d="M ${f(x - 0.62)},${f(top)} L ${f(x + 0.62)},${f(top)} L ${f(x + 0.2)},${f(y + 0.2)} L ${f(x - 0.2)},${f(y + 0.2)} Z" fill="var(--tc-sh)"/>
    <path d="M ${f(x - 0.62)},${f(top)} L ${f(x - 0.05)},${f(top)} L ${f(x - 0.08)},${f(y + 0.2)} L ${f(x - 0.2)},${f(y + 0.2)} Z" fill="var(--tc)" opacity="0.55"/>
    <ellipse cx="${f(x)}" cy="${f(top)}" rx="${hr}" ry="${f(hr * 0.74)}" fill="url(#pjhead)" stroke="${glow ? "#fff" : "#180f08"}" stroke-width="${glow ? 0.65 : 0.32}"/>
    <ellipse cx="${f(x)}" cy="${f(top - 0.22)}" rx="${f(hr * 0.6)}" ry="${f(hr * 0.36)}" fill="#000" opacity="0.18"/>
    <ellipse cx="${f(x - 0.55)}" cy="${f(top - 0.5)}" rx="0.85" ry="0.5" fill="#fff" opacity="0.62"/>
  </g>`;
}

// The dark-wood board: a grained, beveled rectangular frame assembled from
// trapezoidal panels (slanted seams), a recessed table showing through the
// hollow, wooden castle arms, drilled holes with depth, and golf-tee pegs.
function pjBoardSVG(v, glow) {
  const b = v.board;
  const W = b.viewW, H = b.viewH, C = b.center, P = b.players;
  const f = (n) => n.toFixed(2);
  const hole = (h) => `<g>
      <circle cx="${f(h.x)}" cy="${f(h.y)}" r="1.75" fill="url(#pjhole)"/>
      <circle cx="${f(h.x - 0.18)}" cy="${f(h.y - 0.18)}" r="1.75" fill="none" stroke="var(--wood-hi)" stroke-width="0.22" opacity="0.35"/>
    </g>`;
  let s = `<svg class="pjsvg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" preserveAspectRatio="xMidYMid meet" style="aspect-ratio:${W}/${H}">
    <defs>
      <linearGradient id="pjwood" x1="0" y1="0" x2="0.7" y2="1">
        <stop offset="0%" stop-color="var(--wood-3)"/><stop offset="45%" stop-color="var(--wood-2)"/><stop offset="100%" stop-color="var(--wood-1)"/>
      </linearGradient>
      <radialGradient id="pjhole" cx="42%" cy="38%" r="62%">
        <stop offset="0%" stop-color="#070402"/><stop offset="65%" stop-color="#130c06"/><stop offset="100%" stop-color="#2a1a0d"/>
      </radialGradient>
      <linearGradient id="pjhead" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--tc-hi)"/><stop offset="52%" stop-color="var(--tc)"/><stop offset="100%" stop-color="var(--tc-sh)"/>
      </linearGradient>
      <linearGradient id="pjsheen" x1="0" y1="0" x2="0.4" y2="1">
        <stop offset="0%" stop-color="#fff" stop-opacity="0.10"/><stop offset="38%" stop-color="#fff" stop-opacity="0"/><stop offset="100%" stop-color="#000" stop-opacity="0.22"/>
      </linearGradient>
      <filter id="pjgrain" x="0" y="0" width="100%" height="100%">
        <feTurbulence type="fractalNoise" baseFrequency="0.018 0.46" numOctaves="2" seed="11" result="n"/>
        <feColorMatrix in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.5 0"/>
      </filter>
      <filter id="pjgrainv" x="0" y="0" width="100%" height="100%">
        <feTurbulence type="fractalNoise" baseFrequency="0.4 0.02" numOctaves="2" seed="5" result="n"/>
        <feColorMatrix in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.42 0"/>
      </filter>
      <filter id="pjglow" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="1.3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    </defs>
    <rect x="0" y="0" width="${W}" height="${H}" rx="5" fill="url(#pjwood)"/>
    <rect x="0" y="0" width="${W}" height="${H}" rx="5" fill="#000" filter="url(#pjgrain)" opacity="0.5" style="mix-blend-mode:multiply"/>
    <rect x="0" y="0" width="${W}" height="${H}" rx="5" fill="url(#pjsheen)"/>
    <rect x="0.5" y="0.5" width="${f(W - 1)}" height="${f(H - 1)}" rx="4.6" fill="none" stroke="var(--wood-edge)" stroke-width="0.7"/>`;
  // inset green felt: for 4p use a thick frame (hi=27) that fully encloses both
  // the ring track holes and the diagonal castle arm holes inside the wood band.
  const feltInset = P === 4 ? 27 : b.hollow.x;
  const ho = P === 4 ? { x: feltInset, y: feltInset, w: W - 2 * feltInset, h: H - 2 * feltInset } : b.hollow;
  s += `<rect x="${f(ho.x - 1)}" y="${f(ho.y - 1)}" width="${f(ho.w + 2)}" height="${f(ho.h + 2)}" rx="3.6" fill="#000" opacity="0.6"/>`;
  s += `<rect x="${f(ho.x)}" y="${f(ho.y)}" width="${f(ho.w)}" height="${f(ho.h)}" rx="3" fill="#1c5c32"/>`;
  s += `<rect x="${f(ho.x)}" y="${f(ho.y)}" width="${f(ho.w)}" height="${f(ho.h)}" rx="3" fill="#000" filter="url(#pjgrainv)" opacity="0.12" style="mix-blend-mode:multiply"/>`;
  s += `<rect x="${f(ho.x + 0.4)}" y="${f(ho.y + 0.4)}" width="${f(ho.w - 0.8)}" height="${f(ho.h - 0.8)}" rx="2.6" fill="none" stroke="rgba(255,255,255,0.07)" stroke-width="0.5"/>`;
  // castle arms: wooden bars from each corner/midpoint diagonally inward to the last heaven hole
  for (let p = 0; p < P; p++) {
    const arm = b.castleArmStarts[p], last = b.castles[p][b.castles[p].length - 1];
    s += `<line x1="${f(arm.x)}" y1="${f(arm.y + 0.35)}" x2="${f(last.x)}" y2="${f(last.y + 0.35)}" stroke="#000" stroke-width="5.2" stroke-linecap="round" opacity="0.35"/>`;
    s += `<line x1="${f(arm.x)}" y1="${f(arm.y)}" x2="${f(last.x)}" y2="${f(last.y)}" stroke="url(#pjwood)" stroke-width="4.8" stroke-linecap="round"/>`;
    s += `<line x1="${f(arm.x)}" y1="${f(arm.y)}" x2="${f(last.x)}" y2="${f(last.y)}" stroke="var(--wood-hi)" stroke-width="0.5" stroke-linecap="round" opacity="0.28" transform="translate(-0.4,-0.5)"/>`;
    s += `<line x1="${f(arm.x)}" y1="${f(arm.y)}" x2="${f(last.x)}" y2="${f(last.y)}" fill="#000" filter="url(#pjgrain)" opacity="0.4" stroke="transparent" stroke-width="5" style="mix-blend-mode:multiply"/>`;
  }
  // holes: ring, then each player's castle + start
  for (const h of b.ring) s += hole(h);
  for (let p = 0; p < P; p++) { for (const h of b.castles[p]) s += hole(h); for (const h of b.starts[p]) s += hole(h); }
  // exit collars (colored ring marking where each player joins the track)
  for (let p = 0; p < P; p++) { const h = b.ring[b.exits[p]]; s += `<circle cx="${f(h.x)}" cy="${f(h.y)}" r="2.5" fill="none" stroke="${PJ_PEG[p]}" stroke-width="0.55" opacity="0.9"/>`; }
  // pegs as golf tees
  for (const peg of v.pegs) { const h = pegXY(b, peg); s += pjTee(h.x, h.y, PJ_PEG[peg.owner], glow.has(peg.owner + ":" + peg.idx)); }
  s += `</svg>`;
  return s;
}

function pjMoveLabel(v, m) {
  const tag = (ref) => `peg ${ref.idx + 1}${ref.owner !== v.you ? " (partner)" : ""}`;
  const cap = (str) => str.charAt(0).toUpperCase() + str.slice(1);
  if (m.type === "move") return `${cap(tag(m.marble))} \u2192 ahead ${m.steps}`;
  if (m.type === "comeOut") return `Bring ${tag(m.marble)} out`;
  if (m.type === "split7") return `Split 7: ${tag(m.a.marble)} +${m.a.steps}, ${tag(m.b.marble)} +${m.b.steps}`;
  if (m.type === "joker") {
    const victim = v.pegs.find((p) => p.loc.z === "ring" && p.loc.r === m.target);
    return `Joker: send ${victim ? esc(seatName(v, victim.owner)) : "a rival"} home`;
  }
  return `Discard ${pjCardLabel(v.yourHand.find((c) => c.id === m.cardId))}`;
}

function renderPJ(v) {
  if (v.phase === "gameOver") {
    const perTeam = (v.players / 2) * v.marbles;
    const tally = (t) => v.homeCounts.reduce((a, c, p) => a + (p % 2 === t ? c : 0), 0);
    const seatsOf = (t) => v.seats.map((_, i) => i).filter((i) => i % 2 === t).map((i) => i + 1).join(" & ");
    const rows = [
      { name: `Team A \u00b7 seats ${seatsOf(0)}`, score: `${tally(0)}/${perTeam}`, win: v.winner === 0, you: v.you != null && v.you % 2 === 0 },
      { name: `Team B \u00b7 seats ${seatsOf(1)}`, score: `${tally(1)}/${perTeam}`, win: v.winner === 1, you: v.you != null && v.you % 2 === 1 },
    ];
    return renderGameOver(v, v.winner == null ? "Game over" : `Team ${v.winner === 0 ? "A" : "B"} wins!`, scoreList(rows));
  }

  const yours = v.yourTurn;
  const allForfeit = yours && v.legalMoves.length > 0 && v.legalMoves.every((m) => m.type === "forfeit");
  // Keep a stale card selection from sticking if it's no longer in hand.
  if (S.pjCard != null && !v.yourHand.some((c) => c.id === S.pjCard)) S.pjCard = null;
  const candidates = !yours ? [] : allForfeit ? v.legalMoves : S.pjCard == null ? [] : v.legalMoves.filter((m) => m.cardId === S.pjCard);
  S.pjMoves = candidates;

  const glow = new Set();
  for (const m of candidates) {
    if (m.type === "split7") { glow.add(m.a.marble.owner + ":" + m.a.marble.idx); glow.add(m.b.marble.owner + ":" + m.b.marble.idx); }
    else if (m.marble) glow.add(m.marble.owner + ":" + m.marble.idx);
  }

  // top rail: a strip of seats with peg color, name, and pegs-home count
  const strip = v.seats
    .map((s, i) => `<div class="pjseat ${i === v.toAct ? "active" : ""} ${i === v.you ? "me" : ""}">
        <span class="dot" style="background:${PJ_PEG[i]}"></span>
        <span class="nm">${esc(seatName(v, i))}</span><span class="hm">${v.homeCounts[i]}/${v.marbles}</span>
      </div>`)
    .join("");
  const pods = [`<div class="pjstrip">${strip}</div>`];

  // Authentic scale: show the whole board, as large as the viewport allows.
  const maxW = `min(94vw, ${((v.board.viewW / v.board.viewH) * 90).toFixed(1)}vh)`;
  const center = `<div class="pjwrap" style="max-width:${maxW}">${pjBoardSVG(v, glow)}</div>`;

  // hand: tap a usable card to reveal its moves — wrap in row so cards lay horizontal
  const usable = new Set(v.legalMoves.filter((m) => "cardId" in m).map((m) => m.cardId));
  const hand = `<div class="pj-hand-row">${v.yourHand
    .map((c) => `<span class="pjcardslot" ${yours ? `data-action="pj-pick-card" data-cardid="${c.id}"` : ""}>${cardHTML(c, { playable: yours && usable.has(c.id), dim: yours && !usable.has(c.id), sel: S.pjCard === c.id })}</span>`)
    .join("")}</div>`;

  const acts = [];
  if (yours && allForfeit) {
    acts.push(`<span class="hint">No legal move \u2014 discard a card to pass.</span>`);
    candidates.forEach((m, i) => acts.push(`<button class="btn ghost sm" data-action="pj-move" data-mi="${i}">Discard ${pjCardLabel(v.yourHand.find((c) => c.id === m.cardId))}</button>`));
  } else if (yours && S.pjCard == null) {
    acts.push(`<span class="hint">Tap a glowing card to see its moves.</span>`);
  } else if (yours && candidates.length === 0) {
    acts.push(`<span class="hint">No move with that card \u2014 pick another.</span>`);
  } else if (yours) {
    candidates.forEach((m, i) => acts.push(`<button class="btn sm" data-action="pj-move" data-mi="${i}">${pjMoveLabel(v, m)}</button>`));
  }

  const perTeam = (v.players / 2) * v.marbles;
  const homeMine = v.you != null ? v.homeCounts.reduce((a, c, p) => a + (p % 2 === v.you % 2 ? c : 0), 0) : 0;
  const selfMeta = v.you != null ? `Team ${v.you % 2 === 0 ? "A" : "B"} \u00b7 ${homeMine}/${perTeam} home \u00b7 first team all-home wins` : `first team all-home wins`;
  const playingPartner = yours && v.playingFor.length && v.playingFor[0] !== v.you;
  const selfTurn = yours
    ? `<span class="turnflag">Your turn${playingPartner ? " \u2014 playing teammate" : ""}</span>`
    : `<span class="waitflag">${esc(seatName(v, v.toAct))}'s turn</span>`;

  app.__set = tableShell(v, { pods, center, centerFull: true, hand, actions: acts.join(""), selfMeta, selfTurn });
}

function doConnect() {
  const name = document.getElementById("f-name").value.trim() || "Player 1";
  const game = document.getElementById("f-game").value;
  let room = document.getElementById("f-room").value.trim();
  if (!GAMES[game]) return toast("Pick a game.");
  S.name = name;
  S.party = game;
  localStorage.setItem("cg_name", name);
  if (!room) room = Math.random().toString(36).slice(2, 7);
  S.room = room;
  history.replaceState(null, "", `/?game=${game}&room=${encodeURIComponent(room)}`);
  connect();
}

function shareLink() {
  const link = `${location.origin}/?game=${S.party}&room=${encodeURIComponent(S.room)}`;
  const game = GAMES[S.party]?.label ?? "Parlor";
  if (navigator.share) {
    navigator.share({ title: game, text: `Join my ${game} game!`, url: link }).catch(() => {});
  } else {
    navigator.clipboard?.writeText(link).then(() => toast("Link copied."), () => toast(link));
  }
}

function doLeave() {
  S.intentionalClose = true;
  if (!S.offline) send({ t: "leave" });
  try { S.ws?.close(); } catch {}
  S.view = null;
  S.connected = false;
  S.party = null;
  S.offline = false;
  S.hotseat = false;
  S.hotseats = {};
  S.awaitingPass = false;
  S.revealedSeat = null;
  history.replaceState(null, "", "/");
  renderStart();
}

function doStart() {
  S.revealedSeat = 0;
  S.awaitingPass = false;
  const v = S.view;
  const hasHotseats = Object.keys(S.hotseats).length > 0;
  // If the only human is the host (no remote humans) OR the host has added
  // pass-and-play seats, drop the server and run locally.
  const nonHostHumans = v.seats.filter((s, i) => s.kind === "human" && i !== v.you).length;
  if (nonHostHumans === 0 || hasHotseats) {
    S.intentionalClose = true;
    try { S.ws?.close(); } catch {}
    S.connected = false;
    S.view = null;
    const target = S.party === "high-low-jack" ? 21 : (parseInt(document.getElementById("f-target")?.value, 10) || GAMES[S.party]?.target);
    connectLocal(v.seats, { target, marbles: v.marbles, botDifficulty: v.botDifficulty });
    return;
  }
  if (S.party === "pegs-and-jokers") return send({ t: "start", config: { players: v.players, marbles: v.marbles } });
  const target = S.party === "high-low-jack" ? 21 : (parseInt(document.getElementById("f-target")?.value, 10) || GAMES[S.party].target);
  send({ t: "start", config: { players: v.players, target, botDifficulty: v.botDifficulty } });
}

function toggleSel(id) {
  if (S.rummySel.has(id)) S.rummySel.delete(id);
  else S.rummySel.add(id);
  render();
}
function doMeld() {
  const cards = [...S.rummySel];
  if (cards.length < 3) return toast("Select at least 3 cards to meld.");
  send({ t: "move", move: { type: "meld", seat: S.view.you, cards } });
  S.rummySel.clear();
}
function doLayoff() {
  if (S.rummyLayoff === null) return toast("Tap a meld and choose “Lay off here”.");
  const cards = [...S.rummySel];
  if (!cards.length) return toast("Select cards to lay off.");
  send({ t: "move", move: { type: "layoff", seat: S.view.you, meldId: S.rummyLayoff, cards } });
  S.rummySel.clear();
  S.rummyLayoff = null;
}
function doDiscard() {
  if (S.rummySel.size !== 1) return toast("Select exactly one card to discard.");
  const cardId = [...S.rummySel][0];
  send({ t: "move", move: { type: "discard", seat: S.view.you, cardId } });
  S.rummySel.clear();
}

// ---------- delegated events ----------
app.addEventListener("click", (e) => {
  const t = e.target.closest("[data-action]");
  if (!t) return;
  // clicks inside the modal shouldn't fall through to the backdrop's close
  if (t.classList.contains("modal-back") && e.target.closest("[data-stop]")) return;
  const v = S.view;
  switch (t.dataset.action) {
    case "open-discard": S.discardOpen = true; return render();
    case "close-discard": S.discardOpen = false; return render();
    case "sort-toggle": { const m = S.rummySort === "suit" ? "rank" : "suit"; S.rummySort = m; return rummySort(v.yourHand, m); }
    case "pick-game": S.pickGame = t.dataset.game; return renderStart();
    case "set-theme": {
      S.theme = t.dataset.t;
      localStorage.setItem("cg_theme", S.theme);
      applyTheme(S.theme);
      return renderStart();
    }
    case "download-state": {
      const payload = { ts: new Date().toISOString(), party: S.party, roomId: S.roomId, view: S.view };
      const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `gamestate-${S.party}-${Date.now()}.json`; a.click();
      URL.revokeObjectURL(url);
      return;
    }
    case "toggle-log": S.showLog = !S.showLog; return render();
    case "log-tab": S.logTab = t.dataset.tab; return render();
    case "expand-log": { const eid = +t.dataset.entryid; S.logExpandedId = S.logExpandedId === eid ? null : eid; return render(); }
    case "connect": return doConnect();
    case "share-link": return shareLink();
    case "leave": return doLeave();
    case "sit": return send({ t: "sit", seat: +t.dataset.seat });
    case "addbot": return send({ t: "addBot", seat: +t.dataset.seat });
    case "set-bot-difficulty": {
      const seat = +t.dataset.seat;
      const diff = +t.value;
      const cur = v.botDifficulty ? [...v.botDifficulty] : Array(v.players).fill(2);
      cur[seat] = diff;
      return send({ t: "setConfig", config: { players: v.players, target: v.target, botDifficulty: cur } });
    }
    case "removebot": return send({ t: "removeBot", seat: +t.dataset.seat });
    case "addhuman": {
      const seat = +t.dataset.seat;
      const name = (prompt("Player name?", `Player ${seat + 1}`) || "").trim();
      if (name) send({ t: "addHuman", seat, name });
      return;
    }
    case "clearseat": return send({ t: "clearSeat", seat: +t.dataset.seat });
    case "reserve-hotseat": {
      const seat = +t.dataset.seat;
      const name = (prompt("Player name?", `Player ${seat + 1}`) || "").trim();
      if (!name) return;
      S.hotseats[seat] = name;
      return render();
    }
    case "clear-hotseat": {
      delete S.hotseats[+t.dataset.seat];
      return render();
    }
    case "lby-rename": {
      const inp = document.getElementById("lby-name-input");
      const newName = inp ? inp.value.trim() : "";
      if (newName) { S.name = newName; localStorage.setItem("cg_name", newName); render(); }
      return;
    }
    case "open-lby-settings": S.lbySettingsOpen = true; return render();
    case "close-lby-settings": S.lbySettingsOpen = false; return render();
    case "lby-set-bestof": {
      const n = +t.dataset.n;
      return send({ t: "setConfig", config: { players: v.players, target: v.target, bestOf: n } });
    }
    case "toggle-bot-replacement": return send({ t: "setBotReplacement", enabled: t.checked });
    case "replace-seat": return send({ t: "replaceSeat", seat: +t.dataset.seat });
    case "toggle-last-trick": S.hljLastTrickOpen = !S.hljLastTrickOpen; return render();
    case "reveal-hand": S.revealedSeat = S.passTo; S.awaitingPass = false; return render();
    case "setcount": {
      const target = parseInt(document.getElementById("f-target")?.value, 10) || GAMES[S.party].target;
      const config = { players: +t.dataset.count, target };
      if (v.botDifficulty) config.botDifficulty = v.botDifficulty;
      if (v.requireDiscard != null) config.requireDiscard = v.requireDiscard;
      return send({ t: "setConfig", config });
    }
    case "rummy-toggle-discard": {
      const target = parseInt(document.getElementById("f-target")?.value, 10) || GAMES[S.party].target;
      const config = { players: v.players, target, requireDiscard: !v.requireDiscard };
      if (v.botDifficulty) config.botDifficulty = v.botDifficulty;
      return send({ t: "setConfig", config });
    }
    case "start": return doStart();
    case "newgame": S.revealedSeat = null; S.awaitingPass = false; return send({ t: "newGame" });
    case "move-bid": return send({ t: "move", move: { type: "bid", seat: v.you, amount: +t.dataset.amount } });
    case "hlj-bid-confirm": {
      const amt = +(document.getElementById("hlj-bid-slider")?.value ?? 2);
      return send({ t: "move", move: { type: "bid", seat: v.you, amount: amt } });
    }
    case "move-pass": return send({ t: "move", move: { type: "pass", seat: v.you } });

    case "signal": return send({ t: "aux", payload: t.dataset.level });
    case "play-card": {
      const c = v.yourHand.find((x) => cardKey(x) === t.dataset.key);
      if (c) send({ t: "move", move: { type: "play", seat: v.you, card: c } });
      return;
    }
    case "draw-stock": return send({ t: "move", move: { type: "drawStock", seat: v.you } });
    case "draw-discard": S.discardOpen = false; return send({ t: "move", move: { type: "drawDiscard", seat: v.you, cardId: +t.dataset.cardid } });
    case "reveal-joker": {
      t.classList.add("joker-pulse");
      setTimeout(() => t.classList.remove("joker-pulse"), 700);
      return;
    }
    case "toggle-card": return toggleSel(+t.dataset.cardid);
    case "hlj-ack-hand": {
      const lh = S.view && S.view.lastHand;
      if (lh) S.hljHandAcked = JSON.stringify(lh);
      if (S.hljHandTimer) { clearTimeout(S.hljHandTimer); S.hljHandTimer = null; }
      S.hljShowDealtHands = false;
      S.hljHandVisible = false;
      return render();
    }
    case "hlj-show-dealt-hands": S.hljShowDealtHands = true; return render();
    case "hlj-close-dealt-hands": S.hljShowDealtHands = false; return render();
    case "ack-round": {
      const lr = S.view && S.view.lastRound;
      if (lr) S.rummyRoundAcked = JSON.stringify(S.view.scores);
      if (S.rummyRoundTimer) { clearTimeout(S.rummyRoundTimer); S.rummyRoundTimer = null; }
      S.rummyRoundVisible = false;
      return render();
    }
    case "open-meld": {
      const meldId = +t.dataset.meldid;
      const selNow = [...S.rummySel].map((id) => v.yourHand.find((c) => c.id === id)).filter(Boolean);
      const meldTarget = v.melds.find((m) => m.id === meldId);
      // If cards already selected and this meld accepts them, go straight to layoff mode
      if (selNow.length >= 1 && S.rummyLayoff === null && meldTarget && rCanLayoff(meldTarget, selNow)) {
        S.rummyLayoff = meldId;
      } else {
        S.rummyMeldOpen = meldId;
      }
      return render();
    }
    case "close-meld": S.rummyMeldOpen = null; return render();
    case "layoff-meld": S.rummyLayoff = +t.dataset.meldid; S.rummyMeldOpen = null; return render();
    case "unlayoff-meld": S.rummyLayoff = null; S.rummyMeldOpen = null; return render();

    case "meld-selected": return doMeld();
    case "layoff-selected": return doLayoff();
    case "discard-selected": return doDiscard();
    case "clear-sel": S.rummySel.clear(); S.rummyLayoff = null; return render();
    case "toggle-pass": {
      const id = +t.dataset.cardid;
      if (S.heartsPass.has(id)) S.heartsPass.delete(id);
      else if (S.heartsPass.size >= 3) return toast("You pass exactly 3 cards.");
      else S.heartsPass.add(id);
      return render();
    }
    case "pass-3": {
      if (S.heartsPass.size !== 3) return toast("Select exactly 3 cards to pass.");
      send({ t: "move", move: { type: "pass", seat: v.you, cards: [...S.heartsPass] } });
      S.heartsPass.clear();
      render();
      return;
    }
    case "clear-pass": S.heartsPass.clear(); return render();
    case "play-hearts": return send({ t: "move", move: { type: "play", seat: v.you, card: +t.dataset.cardid } });
    case "pj-setplayers": return send({ t: "setConfig", config: { players: +t.dataset.count, marbles: v.marbles } });
    case "pj-setmarbles": return send({ t: "setConfig", config: { players: v.players, marbles: +t.dataset.m } });
    case "pj-pick-card": S.pjCard = S.pjCard === +t.dataset.cardid ? null : +t.dataset.cardid; return render();
    case "pj-move": {
      const m = S.pjMoves[+t.dataset.mi];
      if (m) send({ t: "move", move: m });
      S.pjCard = null;
      return;
    }
  }
});

// ---------- drag to reorder your hand (Rummy) ----------
// We track the drop target during the drag, then reorder S.rummyOrder once on
// drop — re-rendering mid-drag would cancel the native drag in some browsers.
function handCard(el) {
  const c = el && el.closest(".hand [data-cardid]");
  return c ? +c.dataset.cardid : null;
}
app.addEventListener("dragstart", (e) => {
  const id = handCard(e.target);
  if (id == null) return;
  S.dragId = id;
  S.dropBeforeId = null;
  e.dataTransfer.effectAllowed = "move";
  e.target.closest("[data-cardid]")?.classList.add("dragging");
});
app.addEventListener("dragover", (e) => {
  if (S.dragId == null) return;
  e.preventDefault();
  const el = e.target.closest && e.target.closest(".hand [data-cardid]");
  if (!el) return;
  const over = +el.dataset.cardid;
  const r = el.getBoundingClientRect();
  const after = e.clientX > r.left + r.width / 2; // dropped on the right half → after this card
  const ids = S.rummyOrder.filter((x) => x !== S.dragId);
  const pos = ids.indexOf(over) + (after ? 1 : 0);
  S.dropBeforeId = pos >= ids.length ? null : ids[pos];
});
function endDrag(e) {
  if (S.dragId == null) return;
  if (e) e.preventDefault();
  const ids = S.rummyOrder.filter((x) => x !== S.dragId);
  const idx = S.dropBeforeId == null ? ids.length : ids.indexOf(S.dropBeforeId);
  ids.splice(idx < 0 ? ids.length : idx, 0, S.dragId);
  S.rummyOrder = ids;
  S.dragId = null;
  S.dropBeforeId = null;
  render();
}
app.addEventListener("drop", endDrag);
app.addEventListener("dragend", endDrag);

// keep the host's "play to" value in the shared lobby config (so re-renders don't lose it)
app.addEventListener("change", (e) => {
  if (e.target.id === "f-target" && S.view && S.view.phase === "lobby") {
    const target = parseInt(e.target.value, 10);
    if (target > 0) {
      const cfg = { players: S.view.players, target };
      if (S.view.botDifficulty) cfg.botDifficulty = S.view.botDifficulty;
      send({ t: "setConfig", config: cfg });
    }
  }
});

app.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.id === "lby-name-input") dispatch("lby-rename");
});

// ---------- init ----------
function init() {
  S.pid = localStorage.getItem("cg_pid");
  if (!S.pid) {
    S.pid = (crypto.randomUUID && crypto.randomUUID()) || `p_${Math.random().toString(36).slice(2)}${Date.now()}`;
    localStorage.setItem("cg_pid", S.pid);
  }
  S.name = localStorage.getItem("cg_name") || "";
  S.theme = localStorage.getItem("cg_theme") || "midnight";
  applyTheme(S.theme);
  const q = new URLSearchParams(location.search);
  const game = q.get("game");
  const room = q.get("room");
  if (game && GAMES[game]) { S.party = game; S.pickGame = game; }
  if (room) S.room = room;
  if (S.party && S.room && S.name) connect();
  else { S.party = S.party || null; renderStart(); }
}
init();
