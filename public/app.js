// Bonhomme — card games client. Vanilla ES module, native WebSocket, no build step.
// The server is the rules authority: we turn `view.legalMoves` into controls, and
// for Rummy melds we let the player select cards and submit — the server validates.
// This file's RENDER layer draws a cozy bonhomme table; all networking/protocol is unchanged.

const SUIT = { S: "\u2660", H: "\u2665", D: "\u2666", C: "\u2663" };
const RED = new Set(["H", "D"]);
const GAMES = {
  rummy500: {
    label: "Rummy 500",
    players: [2, 3, 4, 5, 6, 7, 8],
    target: 500,
    maxTarget: 1000, // highest "play to" (the server enforces the same cap)
    suit: "\u2665",
    blurb: "Draw, build runs & sets, race to 500.",
    range: "2\u20138 players",
  },
  "high-low-jack": {
    label: "High Low Jack",
    players: [4, 6, 8],
    target: 21,
    maxTarget: 21,
    suit: "\u2660",
    blurb: "Bid, take trump tricks, chase the Jack.",
    range: "4 / 6 / 8 players",
  },
  hearts: {
    label: "Hearts",
    players: [3, 4, 5],
    target: 100,
    maxTarget: 200,
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

// Inline icons (stroke = currentColor) for the top bar, rails, sheets and seats.
const svg = (d, w = 2.1) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
  back: svg(`<path d="M15 18l-6-6 6-6"/>`, 2.4),
  log: svg(`<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="4.5" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="4.5" cy="18" r="1.2" fill="currentColor" stroke="none"/>`),
  share: svg(`<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/>`),
  gear: svg(`<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>`, 1.8),
  close: svg(`<path d="M6 6l12 12M18 6L6 18"/>`, 2.4),
  download: svg(`<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>`),
  check: svg(`<path d="M5 12.5l4.5 4.5L19 7.5"/>`, 2.6),
  plus: svg(`<path d="M12 5v14M5 12h14"/>`, 2.4),
};

const app = document.getElementById("app");
const toastEl = document.getElementById("toast");

const S = {
  pid: null,
  name: "",
  party: null,
  pickGame: null, // start-screen selection
  room: null,
  ws: null,
  offline: false, // playing locally vs bots (no server)
  tutorial: false, // single-player guided practice hand armed in the lobby
  hotseat: false, // 2+ local humans sharing the device (pass-and-play)
  revealedSeat: null, // which human seat's hand is currently unlocked on screen
  awaitingPass: false, // showing the privacy hand-off screen
  passTo: null, // seat we're passing the device to
  passReady: false, // hand-off delay elapsed; reveal button enabled
  passTimer: null, // hand-off delay setTimeout handle
  connected: false,
  intentionalClose: false,
  joinedOnline: false, // a socket to this room has opened at least once (drops then retry, never go offline)
  connectSlow: false, // first join is taking a while: offer "Play offline"
  retryMs: 0, // current reconnect backoff
  retryTimer: null, // pending reconnect setTimeout handle
  view: null,
  sentFor: null, // the view a move / advance tap was last sent for (see sendOnce)
  rummySel: new Set(), // selected card ids
  rummyLayoff: null, // selected meld id for layoff
  rummyMeldOpen: null, // meld id whose popup is open
  rummyRoundShown: null, // round key (rummyRoundKey) whose summary screen this device showed
  rummyRoundAcked: null, // round key whose summary this device dismissed ("Next hand" / Close)
  hljHandAcked: null, // JSON key of the lastHand already dismissed
  hljHandTimer: null, // auto-dismiss setTimeout handle
  hljShowDealtHands: false,
  hljBidHold: null,   // frozen bid overlay shown briefly after bidding ends
  hljBidHoldTimer: null,
  hljLastTrickOpen: false, // client-only: whether last trick is expanded as a hand fan
  heartsLastTrickOpen: false, // same, for Hearts
  heartsLastTrickKey: null,   // key of last seen lastTrick (for collecting animation trigger)
  heartsCollecting: null,     // { plays, winSeat, ts } while scatter→fan anim is playing
  heartsHandAcked: null, // hand key (heartsHandKey) of the lastHand already dismissed
  heartsHandTimer: null, // auto-dismiss setTimeout handle
  heartsReceivedCards: [], // card ids just received via pass, highlighted in the hand for 5s
  heartsReceivedTimer: null, // clears heartsReceivedCards after 5s
  hljSignalTimer: null,    // unused, kept for wire-compat
  rummyOrder: [], // display order of your hand (card ids) for sort + drag/drop
  rummySort: "suit", // last sort mode used; next click alternates
  rummyDrawnCard: null, // card just drawn from stock (shown as preview above hand)
  rummyDrawnTimer: null, // auto-dismiss timer for drawn card preview
  theme: "midnight", // "midnight" | "velvet" | "baize" | "parchment"

  discardOpen: false, // discard-pile popup open?
  dragId: null, // card id being dragged within the hand
  dropBeforeId: null, // drop target (insert before this card id; null = end)
  heartsPass: new Set(), // selected card ids to pass (Hearts)
  heartsOrder: [], // display order of hand card ids (Hearts sort)
  hotseats: {}, // seat → name for pass-and-play reservations (pre-start, client-only)
  pjCard: null, // selected card id (Pegs & Jokers)
  pjMoves: [], // candidate moves currently shown as buttons (Pegs & Jokers)
  lbySettingsOpen: false,
  confirmLeave: false, // "leave this game?" dialog open
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
  const prevValue = a.getAttribute("value"); // rendered value before this morph
  for (let i = a.attributes.length - 1; i >= 0; i--) {
    const n = a.attributes[i].name;
    if (!b.hasAttribute(n)) a.removeAttribute(n);
  }
  for (const at of b.attributes) {
    if (a.getAttribute(at.name) !== at.value) a.setAttribute(at.name, at.value);
  }
  // keep form fields usable: sync value/checked unless the user is editing it now,
  // and only when the rendered value actually changed — an unrelated re-render must
  // not wipe what the user typed (e.g. a room code, then tapping a game card).
  if ((a.nodeName === "INPUT" || a.nodeName === "TEXTAREA" || a.nodeName === "SELECT") && a !== document.activeElement) {
    const bv = b.getAttribute("value");
    if (bv != null && bv !== prevValue && a.value !== bv) a.value = bv;
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
function applyTheme(id) {
  // One parlor look; the attribute is kept so old saved prefs are harmless.
  document.documentElement.setAttribute("data-theme", id);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = "#0b2016";
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
  if (o.fresh) cls.push("fresh");
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
    const jokerSrc = S.party === "high-low-jack" ? "/bonhomme-card.webp" : "/joker-card.webp";
    return `<div class="${cls.join(" ")}"${st}${action}><img class="joker-img" src="${jokerSrc}" alt="Joker">${badge}</div>`;
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
  const teamCls = o.team ? ` t${o.team}` : "";
  const style = o.team ? "" : ` style="--av-1:${a};--av-2:${b}"`;
  const label = o.team ? o.team : esc(initials(name));
  return `<div class="avatar${o.big ? " big" : ""}${teamCls}"${style}>${label}${o.host && !o.team ? `<span class="crown">\u265B</span>` : ""}</div>`;
}

// "away" chip and the host's Replace button for a seat whose human dropped.
// Shared by the table pods and the Rummy phone ledger, so every layout can
// unstick a game that is waiting on a disconnected player.
function seatPresence(v, i) {
  const away = !!(v.disconnectedSeats && v.disconnectedSeats.includes(i));
  const isHost = v.you === v.hostSeat && v.you !== null;
  return {
    away,
    badge: away ? `<span class="pod-away">away</span>` : "",
    replaceBtn: away && isHost && !S.offline
      ? `<button class="btn sm danger" data-action="replace-seat" data-seat="${i}">Replace</button>`
      : "",
  };
}

// opponent pod: a stack of card backs (or an avatar) over a name plate
function podHTML(v, i, o = {}) {
  const name = seatName(v, i);
  const cardCount = o.cardCount != null ? o.cardCount : null;
  const mb = `<span class="mb"></span>`.repeat(4);
  const { away: isDisconnected, badge: away, replaceBtn } = seatPresence(v, i);
  const dot = o.team ? `<span class="teamdot t${o.team}"></span>` : "";
  const countInPlate = cardCount != null && !o.avatar;
  const plate = `<div class="pod-plate">${dot}<span class="pod-name">${esc(name)}</span>${countInPlate ? `<span class="pod-count" title="${cardCount} cards">${cardCount}</span>` : ""}${away}</div>`;
  const mainBlock = o.avatar
    ? `<div class="pod-av-id">
        <span class="pod-av">${esc(initials(name))}</span>
        ${cardCount != null ? `<span class="pod-av-count" title="${cardCount} cards">${cardCount}</span>` : ""}
      </div>`
    : `<div class="ministack">${mb}</div>`;
  const badge = o.highBid != null ? `<div class="pod-dealer-badge bid" title="Winning bid">${o.highBid}</div>`
    : o.dealer ? `<div class="pod-dealer-badge" title="Dealer">D</div>` : "";
  // HLJ confidence signal (public for the whole hand): its own chip on the
  // stack's other corner, apart from the dealer / bid chip.
  const signal = o.signal ? `<div class="pod-dealer-badge signal pod-signal">${o.signal}</div>` : "";
  const cls = ["pod", o.active && "active", o.partner && "partner", o.team && `t${o.team}`, isDisconnected && "disconnected", o.extraClass].filter(Boolean).join(" ");
  return `<div class="${cls}">
    ${mainBlock}
    ${plate}
    ${badge}
    ${signal}
    ${o.pts != null ? `<div class="pod-info"><span class="pts" title="Score">${o.pts}</span></div>` : ""}
    ${o.note ? `<div class="note">${esc(o.note)}</div>` : ""}
    ${replaceBtn}
  </div>`;
}

// Landscape puts the controls in side rails and lets the felt take the height.
const isRails = () => window.matchMedia("(orientation: landscape)").matches;

// Card width + usable width for the player's hand; mirrors the CSS breakpoints.
function handMetrics() {
  const W = window.innerWidth || 390, H = window.innerHeight || 800;
  if (isRails()) {
    const tall = H >= 600;
    const cardW = tall ? (W >= 1400 && H >= 800 ? 92 : 84) : 62;
    const rails = tall ? 2 * (W >= 1400 && H >= 800 ? 150 : 132) + 56 : 2 * 66 + 48;
    const feltW = Math.min(W - rails, (H - 16) * 1.95);
    return { cardW, avail: Math.max(260, Math.min(feltW - 24, tall ? 900 : 620)) };
  }
  const cardW = W >= 600 ? 82 : W <= 360 ? 60 : 66;
  return { cardW, avail: Math.min(W - 20, W >= 600 ? 760 : 440) };
}

// Fanned hand with per-card rotation + arc. Cards overlap just enough to fit
// the available width; very large hands shrink the cards, then scroll sideways.
// Returns the full scroller markup (.fan-scroll > .fan-inner > cards).
function fanHand(cards, optFn, { arcScale = 1, cls = "", cardW: forceW = null, avail: forceAvail = null } = {}) {
  const n = cards.length;
  if (!n) return "";
  const m = handMetrics();
  let cardW = forceW || m.cardW;
  const avail = forceAvail || m.avail;
  const MIN = 0.34, MAX = 0.68; // visible slice per card, as a fraction of its width
  const room = avail - 24; // fan-inner side padding
  let step = n > 1 ? (room - cardW) / (n - 1) : 0;
  if (n > 1 && !forceW && step < cardW * MIN) {
    // shrink the cards (down to ~3/4 size) before resorting to a scrolling hand
    const fit = Math.floor(room / (1 + MIN * (n - 1)));
    cardW = Math.max(Math.round(cardW * 0.76), Math.min(cardW, fit));
    step = (room - cardW) / (n - 1);
  }
  step = Math.max(cardW * MIN, Math.min(cardW * MAX, step));
  const overflows = n > 1 && cardW + (n - 1) * step > room + 1;
  const overlap = step - cardW; // negative => overlap
  const spread = Math.min(3, 24 / n);
  const arc = (n > 2 ? Math.min(13, n * 1.4) : 0) * arcScale;
  const mid = (n - 1) / 2 || 1;
  const inner = cards
    .map((c, i) => {
      const off = i - (n - 1) / 2;
      const rot = off * spread;
      const lift = -arc * (1 - (off / mid) ** 2);
      const o = optFn(c, i) || {};
      o.style = `--w:${cardW}px;${i ? `margin-left:${overlap.toFixed(1)}px;` : ""}transform:rotate(${rot.toFixed(2)}deg) translateY(${lift.toFixed(1)}px);z-index:${i + 1};`;
      // Drag-to-play: a touch drag on a card must reach the pointer handlers,
      // not become a browser pan (which fires pointercancel). A hand too wide
      // for the screen keeps its pan-x so it can still scroll sideways.
      if (!overflows && (o.action === "play-card" || o.action === "toggle-card")) o.style += "touch-action:none;";
      return cardHTML(c, o);
    })
    .join("");
  return `<div class="fan-scroll${overflows ? " overflows" : ""}"><div class="fan-inner${cls ? " " + cls : ""}" style="--w:${cardW}px">${inner}</div></div>`;
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
// A turn move or a gate tap is sent at most once per view: a double tap, a tap
// racing the auto-play timer, or a second tap on a held trick waits for the
// next frame (or an error, which re-arms it) instead of drawing an error toast.
function sendOnce(m) {
  if (S.view && S.sentFor === S.view) return;
  S.sentFor = S.view;
  clearTimeout(_autoPlayTimer);
  _autoPlayTimer = null;
  send(m);
}

// Shared frame handler for both the real socket and the offline LocalRoom.
function onFrame(e) {
  let msg;
  try { msg = JSON.parse(e.data); } catch { return; }
  if (msg.t === "view") {
    const prev = S.view;
    S.view = msg.view;
    // A game starting or ending (for every client, not just the host who dealt)
    // drops the last game's client-side UI state; and in pass-and-play, when the
    // device starts showing a different seat's hand, none of the previous seat's
    // hand state may carry over.
    if (prev && msg.view && (prev.phase === "lobby") !== (msg.view.phase === "lobby")) resetGameUi();
    else if (prev && msg.view && prev.you !== msg.view.you) resetSeatUi(msg.view);
    // HLJ: lastHand stays in the view for the whole next hand. Arriving mid-game
    // (a reload, a late join) must not put an old hand's result page over the
    // table — only one that ended moments ago (next hand not yet bid on) shows.
    if (!prev && S.party === "high-low-jack" && msg.view?.lastHand
        && !(msg.view.phase === "bidding" && !(msg.view.bidHistory ?? []).length)) {
      S.hljHandAcked = JSON.stringify(msg.view.lastHand);
    }
    // Hearts likewise: once the next hand's first trick is under way, the last
    // hand's result page is old news.
    if (!prev && S.party === "hearts" && msg.view?.lastHand && (msg.view.trickNo > 0 || msg.view.currentTrick?.length)) {
      S.heartsHandAcked = heartsHandKey(msg.view);
    }
    // Pass-and-play reservations only make sense on seats that are still open.
    if (msg.view?.phase === "lobby") {
      for (const k of Object.keys(S.hotseats)) {
        if (+k >= msg.view.seats.length || msg.view.seats[+k].kind !== "empty") delete S.hotseats[k];
      }
    }
    // HLJ: freeze bid overlay briefly when bidding ends so the dealer's chip is visible
    if (S.party === "high-low-jack" && prev?.phase === "bidding" && msg.view?.phase === "playing") {
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
    // HLJ trick pacing now lives entirely on the server: the `trickComplete` gate
    // holds the full trick + winner, and the render reads it straight from the view.
    const v = msg.view;
    if (S.party === "rummy500" && v && v.yourHand && v.you != null) {
      // Auto-sort: whenever the hand gains card(s) or a new round is dealt, re-apply the current sort.
      const prevHand = prev?.yourHand ?? [];
      if (v.yourHand.length > prevHand.length || (prev && prev.phase !== v.phase)) {
        S.rummyOrder = [...v.yourHand].sort(rummyCmp(S.rummySort)).map((c) => c.id);
      }
      // "You drew this": only for your own stock draw (the stock shrank by one
      // and one unseen card came in), never for a discard everyone saw taken.
      if (prev && prev.you === v.you && prev.yourTurn && prev.turnPhase === "draw"
          && v.yourTurn && v.turnPhase === "play" && v.stockCount === prev.stockCount - 1) {
        const had = new Set(prevHand.map((c) => c.id));
        const drawn = v.yourHand.filter((c) => !had.has(c.id));
        if (drawn.length === 1) showDrawn(drawn[0]);
      }
    }
    // Hearts: the cards a pass brings in sit apart for a few seconds — only for
    // a pass this seat was seen making (passing -> play, same hand and seat), so
    // a hold hand, a reload or a pass-and-play hand-off never flags a whole hand.
    if (S.party === "hearts" && prev && v && prev.phase === "passing" && (v.phase === "playing" || v.phase === "trickComplete")
        && v.you != null && prev.you === v.you && prev.handNo === v.handNo) {
      const had = new Set(prev.yourHand.map((c) => c.id));
      const received = v.yourHand.filter((c) => !had.has(c.id)).map((c) => c.id);
      if (received.length) {
        clearTimeout(S.heartsReceivedTimer);
        S.heartsReceivedCards = received;
        S.heartsReceivedTimer = setTimeout(() => {
          S.heartsReceivedCards = [];
          S.heartsReceivedTimer = null;
          render();
        }, 5000);
      }
    }
    maybePromptPass();
    render();
    // Tutorial: arm on the lobby->game transition (single human only), then feed each
    // frame. Gated on a lone human seat, not S.offline (a solo deal from an online
    // lobby runs in a LocalRoom, but the gate shouldn't care where the game lives).
    if (S.tutorial && prev?.phase === "lobby" && S.view && S.view.phase !== "lobby"
        && S.view.seats && S.view.seats.filter((s) => s.kind === "human").length === 1) {
      window.Tutorial?.start(S.party);
    }
    window.Tutorial?.onView?.(S.view);
    maybeAutoPlay(msg.view);
  }
  else if (msg.t === "error") { S.sentFor = null; toast(msg.message); }
}

// Auto-play: when it's your turn in HLJ playing phase and only one card is legal,
// play it automatically after a short delay so the game flows without tap-spam.
let _autoPlayTimer = null;
function maybeAutoPlay(v) {
  if (_autoPlayTimer) { clearTimeout(_autoPlayTimer); _autoPlayTimer = null; }
  if (!v || !v.yourTurn) return;
  // Pass-and-play: never play for a seat whose owner hasn't taken the device yet —
  // a move behind the hand-off screen would hand the view to the next person.
  if (S.hotseat && (S.awaitingPass || v.you !== S.revealedSeat)) return;
  const legal = v.legalMoves || [];
  if (legal.length !== 1) return;
  const move = legal[0];
  // Only auto-play card-play moves (not bidding choices, select-trump, etc.)
  if (move.type !== "play") return;
  const delay = S.party === "high-low-jack" ? 1200 : 900;
  _autoPlayTimer = setTimeout(() => {
    _autoPlayTimer = null;
    if (S.view === v) sendOnce({ t: "move", move });
  }, delay);
}

// Pass-and-play privacy gate: when the active hand belongs to a different local
// human than the one currently looking, hide everything behind a hand-off
// screen until they confirm they're ready. The view frame already holds the
// next player's cards, but the interstitial renders none of them.
// The gate keys off the seat the current frame shows (not a latched value): if
// the view moves on while the screen is up, the screen re-targets that seat, so
// it always names the person whose hand a reveal will actually show.
function maybePromptPass() {
  const v = S.view;
  S.hotseat = S.offline && !!v && v.seats && v.seats.filter((s) => s.kind === "human").length >= 2;
  if (!S.hotseat || v.phase === "lobby" || v.phase === "gameOver") {
    // nothing private on screen: lobby / final scores
    S.awaitingPass = false;
    return;
  }
  if (v.you == null) return;
  if (S.awaitingPass ? v.you === S.passTo : v.you === S.revealedSeat) return;
  S.passTo = v.you;
  S.awaitingPass = true;
  S.passReady = false;
  // A short beat so the device can actually change hands before it unlocks.
  clearTimeout(S.passTimer);
  S.passTimer = setTimeout(() => { S.passTimer = null; S.passReady = true; if (S.awaitingPass) render(); }, 1400);
}

// Per-seat client caches (selection, hand order, "you drew this", received cards).
// Cleared whenever the device starts showing a different seat's hand.
function resetSeatUi(v) {
  clearDrawn();
  S.rummySel.clear();
  S.rummyLayoff = null;
  S.rummyMeldOpen = null;
  S.discardOpen = false;
  S.heartsPass.clear();
  clearTimeout(S.heartsReceivedTimer);
  S.heartsReceivedTimer = null;
  S.heartsReceivedCards = [];
  S.pjCard = null;
  // Start the new seat's hand sorted, so nothing in it looks "just received".
  const hand = v?.yourHand ?? [];
  const suitOrder = { S: 0, H: 1, C: 2, D: 3 };
  S.heartsOrder = [...hand].sort((a, b) => (suitOrder[a.suit] - suitOrder[b.suit]) || (a.rank - b.rank)).map((c) => c.id);
  S.rummyOrder = [...hand].sort(rummyCmp(S.rummySort)).map((c) => c.id);
}

// Everything a finished or abandoned game leaves behind on the client
// (selections, open sheets, pending popups and their timers).
function resetGameUi() {
  for (const k of ["hljHandTimer", "hljBidHoldTimer", "heartsHandTimer", "heartsReceivedTimer", "rummyDrawnTimer", "passTimer"]) {
    clearTimeout(S[k]);
    S[k] = null;
  }
  clearTimeout(_autoPlayTimer);
  _autoPlayTimer = null;
  resetSeatUi(null);
  S.showLog = false;
  S.confirmLeave = false;
  S.logTab = "log";
  S.logExpandedId = null;
  S.lbySettingsOpen = false;
  // Hand/round keys restart with each game, so last game's acks must not carry over.
  S.rummyRoundShown = null;
  S.rummyRoundAcked = null;
  S.heartsHandAcked = null;
  S.hljBidHold = null;
  S.hljShowDealtHands = false;
  S.hljLastTrickOpen = false;
  S.heartsLastTrickOpen = false;
  S.heartsCollecting = null;
  S.pjMoves = [];
  S.awaitingPass = false;
  S.passReady = false;
}

function joinOnOpen() {
  S.connected = true;
  send({ t: "join", pid: S.pid, name: S.name });
}

function connect() {
  S.intentionalClose = false;
  if (S.offline) return connectLocal();
  clearTimeout(S.retryTimer);
  S.retryTimer = null;

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${location.host}/parties/${S.party}/${encodeURIComponent(S.room)}`;
  const ws = new WebSocket(url);
  S.ws = ws;
  S.connectSlow = false;
  let opened = false;

  // Only the current socket may act: events from one we've already replaced
  // (a retry, Leave, the hand-off to local play) are ignored.
  const live = () => S.ws === ws && !S.intentionalClose && !S.offline;
  // The socket failed before opening, or dropped after.
  const failed = () => {
    clearTimeout(slowTimer);
    if (!live()) return;
    S.connected = false;
    // A room we've reached is never silently swapped for an offline bot game:
    // keep retrying with backoff (the Reconnecting screen offers "Play offline").
    if (S.joinedOnline) return scheduleReconnect();
    // First join and the server is unreachable: play offline vs bots.
    toast("No connection — playing offline vs bots.");
    connectLocal();
  };
  // A slow first join offers "Play offline" rather than switching on its own (a
  // friend's invite link on a slow network); a reconnect that hangs is retried.
  const slowTimer = setTimeout(() => {
    if (opened || !live()) return;
    if (!S.joinedOnline) { S.connectSlow = true; return render(); }
    try { ws.close(); } catch {}
    failed();
  }, S.joinedOnline ? 8000 : 3500);

  ws.onopen = () => {
    if (S.ws !== ws) { try { ws.close(); } catch {} return; }
    opened = true;
    clearTimeout(slowTimer);
    S.joinedOnline = true;
    S.connectSlow = false;
    S.retryMs = 0;
    joinOnOpen();
  };
  ws.onmessage = (e) => { if (S.ws === ws) onFrame(e); };
  ws.onclose = failed;
  ws.onerror = () => { if (!opened) failed(); };
  render();
}

// Reconnect with backoff (1.5 s, 3 s, 6 s … capped at 15 s) while showing "Reconnecting…".
function scheduleReconnect() {
  if (S.retryTimer) return;
  S.retryMs = Math.min(15000, S.retryMs ? S.retryMs * 2 : 1500);
  S.retryTimer = setTimeout(() => {
    S.retryTimer = null;
    if (!S.connected && !S.intentionalClose && !S.offline && S.party) connect();
  }, S.retryMs);
  render();
}
// The network came back / the app returned to the foreground: retry right away.
function reconnectNow() {
  if (!S.joinedOnline || S.offline || S.intentionalClose || !S.party) return;
  if (S.ws && S.ws.readyState <= 1) return; // connecting or open
  S.retryMs = 0;
  connect();
}
window.addEventListener("online", reconnectNow);

// The user chose to stop waiting for the server: abandon the room (so a reload
// doesn't land back in it) and play this game vs bots on the device.
function doPlayOffline() {
  const ws = S.ws;
  S.ws = null; // its late events are now ignored
  try { ws?.close(); } catch {}
  clearTimeout(S.retryTimer);
  S.retryTimer = null;
  S.joinedOnline = false;
  S.connectSlow = false;
  S.connected = false;
  S.view = null;
  S.hotseats = {};
  resetGameUi();
  history.replaceState(null, "", `/?game=${S.party}`);
  connectLocal();
}

let localMod = null;
// handoff: move a lobby into a fresh LocalRoom — { seats, you, config, start }.
// `seats` is the source table and `you` this device's seat in it. The LocalRoom
// seats the joiner at 0, so the layout is rotated to put `you` there (relative
// order, and so partnerships, are kept). The table is sized from `config` first,
// every other local human (pass-and-play guests and S.hotseats reservations) is
// re-seated, and it is dealt with the full lobby `config` when `start` is set.
async function connectLocal(handoff = null) {
  S.offline = true;
  const hotseats = S.hotseats;
  S.hotseats = {};
  try {
    if (!localMod) localMod = await import("/local.js?v=20261004c");
  } catch (err) {
    // No offline bundle (e.g. never cached): back to the start screen, still
    // prefilled with this game and room, rather than a dead "Connecting…".
    S.offline = false;
    S.connected = false;
    S.view = null;
    S.joinedOnline = false;
    S.pickGame = S.party;
    S.party = null;
    history.replaceState(null, "", "/");
    renderStart();
    return toast("Couldn't load offline mode.");
  }
  if (!S.offline || !S.party) return; // left while the bundle was loading
  const sock = localMod.createLocalSocket(S.party);
  S.ws = sock;
  sock.onopen = () => {
    if (S.ws !== sock) return;
    try {
      joinOnOpen();
      if (handoff) {
        const n = handoff.seats.length;
        const you = handoff.you ?? 0;
        const at = (i) => (i - you + n) % n;
        const config = { ...handoff.config, players: n };
        if (Array.isArray(config.botDifficulty)) {
          const bd = config.botDifficulty;
          config.botDifficulty = Array.from({ length: n }, (_, j) => bd[(j + you) % n] ?? 2);
        }
        send({ t: "setConfig", config });
        handoff.seats.forEach((s, i) => {
          const name = s.kind === "human" ? s.name || `Player ${at(i) + 1}` : s.kind === "empty" ? hotseats[i] : null;
          if (i !== you && name) send({ t: "addHuman", seat: at(i), name });
        });
        if (handoff.start) send({ t: "start", config });
      }
    } catch (err) {
      console.error("connectLocal onopen failed:", err);
      toast("Couldn't start game: " + (err?.message || err));
    }
  };
  sock.onmessage = (e) => { if (S.ws === sock) onFrame(e); };
  sock.onclose = () => { if (S.ws === sock) S.connected = false; };
  render();
}

// ---------- app bar ----------
// Top bar. In portrait it's a row (Leave · title · scores/Log); in landscape the
// CSS dissolves it so each control lands in a side rail (see styles §19).
function appbar(v, o = {}) {
  const g = GAMES[S.party];
  const where = S.offline ? "Offline" : `Room <b>${esc(S.room)}</b>`;
  const sub = [where, o.sub].filter(Boolean).join(" · ");
  const inGame = v.phase !== "lobby";
  return `<header class="appbar">
    <div class="bar-start">
      <button class="iconbtn" data-action="leave" aria-label="Leave table" title="Leave table">${ICON.back}<span class="lbl">Leave</span></button>
      ${o.start || ""}
    </div>
    <div class="bar-title"><span class="bar-game">${esc(g ? g.label : "Bonhomme")}</span><span class="bar-sub">${sub}</span></div>
    <div class="bar-end">
      ${o.scores ? `<div class="scoreboard">${o.scores}</div>` : ""}
      ${!S.offline && inGame ? `<button class="iconbtn" data-action="share-link" aria-label="Invite players" title="Invite players">${ICON.share}<span class="lbl">Invite</span></button>` : ""}
      ${inGame ? `<button class="iconbtn" data-action="toggle-log" aria-label="Move log" title="Move log">${ICON.log}<span class="lbl">Log</span></button>` : ""}
    </div>
  </header>`;
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
      : dealtRows + rummyHandRows || `<div class="logrow empty">No moves yet.</div>`;
    return `<div class="loglist">${rows}</div>`;
  };

  // --- Melds tab ---
  const meldsBody = () => {
    const melds = v && v.melds ? v.melds : [];
    if (!melds.length) return `<div class="logrow empty">No melds on the table yet.</div>`;
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
  const head = isRummy
    ? `<div class="log-tabs" role="tablist">
        <button class="log-tab${tab === "log" ? " active" : ""}" data-action="log-tab" data-tab="log" role="tab" aria-selected="${tab === "log"}">Log</button>
        <button class="log-tab${tab === "melds" ? " active" : ""}" data-action="log-tab" data-tab="melds" role="tab" aria-selected="${tab === "melds"}">Melds</button>
      </div>`
    : `<span class="sheet-title">Move log</span>`;

  return `<div class="sheet-back" data-action="toggle-log"></div>
    <div class="logsheet" role="dialog" aria-label="Move log">
      <div class="sheet-grip"></div>
      <div class="loghead">${head}<div class="loghead-tools">
        ${S.offline ? "" : `<button class="iconbtn sm" data-action="share-link" title="Invite players" aria-label="Invite players">${ICON.share}</button>`}
        <button class="iconbtn sm" data-action="download-state" title="Download game state (diagnostics)" aria-label="Download game state">${ICON.download}</button>
        <button class="iconbtn sm" data-action="toggle-log" title="Close" aria-label="Close log">${ICON.close}</button>
      </div></div>
      <div class="logbody">${tab === "melds" && isRummy ? meldsBody() : logBody()}</div>
    </div>`;
}

// "Leave this game?" — only while a hand is in progress.
function leaveConfirm() {
  if (!S.confirmLeave) return "";
  const v = S.view;
  const others = v ? v.seats.filter((s, i) => s.kind === "human" && i !== v.you).length : 0;
  const solo = S.offline || others === 0; // nobody else here: leaving ends the game
  return `<div class="modal-back" data-action="leave-cancel">
      <div class="modal" data-stop="1" role="alertdialog" aria-label="Leave game" style="max-width:360px">
        <div class="modalhead"><span>Leave this game?</span></div>
        <div class="modalbody">
          <p class="confirm-text">${solo
            ? "This game will end and can't be resumed."
            : "You'll give up your seat — a bot takes over your hand for the rest of the game."}</p>
          <div class="modal-actions">
            <button class="btn ghost" data-action="leave-cancel">Stay</button>
            <button class="btn danger" data-action="leave-confirm">Leave</button>
          </div>
        </div>
      </div>
    </div>`;
}

// shared table frame: pods distributed around the felt, center play area, your rail at the bottom
function tableShell(v, parts) {
  // Wide (landscape) felts pull the side pods in off the walls.
  const isLandscape = isRails();
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
    // y1/y2 = vertical range for side-wall pods. Tuned per player count so
    // each wall's pods don't crowd the center or the top/bottom rails.
    //   n=2: 1 top opp — y1/y2 irrelevant (topY=9 handles it)
    //   n=3: 1 per side → single pod lands at (y1+y2)/2 = 50%
    //   n=4: 1 per side → 50%; 1 top → topY
    //   n=5: 1 per side, 2 at top
    //   n=6,7: 2 per side → spread y1→y2 (n=7 has 2 top pods too)
    //   n=8: 3 per side → wideY extension handles overflow
    const podY1 = n === 6 || n === 7 ? 36 : 28;
    const podY2 = n >= 8 ? 55 : n >= 6 ? 74 : n >= 5 ? 68 : 82;
    const podBounds = { x1: 12, x2: 88, y1: podY1, y2: podY2, wideY1: 22, wideY2: Math.max(podY2, 72), topY: 9 };
    // Spectators see the table from seat 0's chair (as trick cards and bid
    // tokens do): seat 0's pod takes the bottom slot, which has no self rail.
    const anchor = you ?? 0;
    const infos = podItems.map(({ seat, html }) => {
      const off = (seat - anchor + n) % n;
      if (off === 0) return { html, x: 50, y: null, side: "pos-bottom" };
      // Both orientations use the same compass perimeter so landscape mirrors
      // portrait player positioning.
      const { x, y, side } = wallPerimPos(off, n, podBounds);
      return { html, x, y, side: `pos-${side}` };
    });
    const slots = infos.length
      ? infos.map(({ html, x, y, side }) => {
          if (side === "pos-bottom") {
            return `<div class="pod-slot pos-bottom" style="position:absolute;bottom:3%;left:50%;transform:translateX(-50%);z-index:2">${html}</div>`;
          }
          // Portrait: side pods anchor flush to the felt edge (narrow felt).
          // Landscape: bring side pods in off the wall so they read like the
          // portrait compass instead of hugging the far edges.
          const insetSide = isLandscape && (side === "pos-left" || side === "pos-right");
          // Arc the side pods: higher pods sit further toward center, the lowest
          // stays flush. shift grows with height above the bottom reference (~72%).
          // A lone pod on a wall (3–4 seats) stays put so the trick card beside
          // it has room.
          let arcShift = n <= 4 ? 0 : Math.max(0, 72 - y) * 0.24;
          // HLJ 8-player landscape: swap the side pods' horizontal distances from
          // center. Top & bottom side pods move out to the middle pod's distance;
          // the middle pod moves out to the bottom pod's (flush) distance. Vertical
          // rows are unchanged, and the top-centre pod (side "top") is untouched.
          if (S.party === "high-low-jack" && n === 8 && (side === "pos-left" || side === "pos-right")) {
            const midShift = Math.max(0, 72 - 55) * 0.24; // original middle-row shift
            const botShift = Math.max(0, 72 - 82) * 0.24; // original bottom-row shift (0)
            // y rows for n=8 side walls are ~{28 top, 55 middle, 82 bottom}.
            arcShift = y >= 41.5 && y < 68.5 ? botShift : midShift;
          }
          const ax = side === "pos-left" ? x + arcShift : x - arcShift;
          // Raise higher side pods (lowest row stays put) so the top side pods
          // rise toward the top pod — top edge ~halfway up the top pod.
          const ay = y - Math.max(0, 72 - y) * 0.22;
          const pos = insetSide
            ? `top:${ay}%;left:${ax}%;transform:translate(-50%,-50%)`
            : side === "pos-left"
              ? `top:${y}%;left:0;transform:translateY(-50%)`
              : side === "pos-right"
                ? `top:${y}%;right:0;transform:translateY(-50%)`
                : `top:${y}%;left:${x}%;transform:translate(-50%,-50%)`;
          return `<div class="pod-slot ${side}" style="position:absolute;${pos};z-index:2">${html}</div>`;
        }).join("")
      : (parts.feltLedger ? "" : `<div class="pod-slot" style="position:absolute;top:14%;left:50%;transform:translate(-50%,-50%);z-index:2"><div class="callout">Waiting for players to arrive…</div></div>`);
    feltPods = slots;
  }

  let self;
  if (v.you != null) {
    const myName = seatName(v, v.you);
    const nameHtml = parts.selfName || `<span class="name">${esc(myName)}</span>`;
    self = `<div class="hand deal${parts.hand ? "" : " empty"}">${parts.hand || ""}</div>
      <div class="selfbar">
        ${avatarHTML(myName, { host: v.you === v.hostSeat, team: parts.selfTeam })}
        <div class="selfbar-name-block">${nameHtml}<span class="me-pts">${parts.selfMeta || ""}</span></div>
        ${parts.selfTurn || ""}
      </div>
      ${parts.selfExtra ? `<div class="self-extra">${parts.selfExtra}</div>` : ""}
      ${parts.actions ? `<div class="actions">${parts.actions}</div>` : ""}`;
  } else {
    self = `<div class="selfbar spectating"><div class="selfbar-name-block"><span class="name">Spectating</span><span class="me-pts">${parts.selfMeta || ""}</span></div></div>`;
  }
  const tableCls = ["table", `g-${S.party}`, v.phase === "lobby" ? "is-lobby" : "is-game", parts.hand ? "" : "no-hand"].filter(Boolean).join(" ");
  const stageCls = ["felt-stage", parts.feltLedger && "has-ledger", parts.ledgerLandscape && "ledger-landscape", parts.ledgerSplit && "ledger-split"].filter(Boolean).join(" ");
  const centerCls = ["center", parts.centerFull && "full", parts.centerBottom && "at-bottom"].filter(Boolean).join(" ");
  return `<div class="${tableCls}">
    ${appbar(v, { scores: parts.scores, start: parts.barStart, sub: parts.barSub })}
    <div class="felt-frame">
      <div class="felt">
        ${parts.feltOverlay ? `<div class="felt-overlay">${parts.feltOverlay}</div>` : ""}
        ${parts.cornerSuits ? `<div class="felt-corners" aria-hidden="true">${parts.cornerSuits}</div>` : ""}
        <div class="${stageCls}">
          ${feltPods}
          ${parts.feltLedger ? `<div class="felt-ledger"${parts.ledgerRows ? ` style="--rows:${parts.ledgerRows}"` : ""}>${parts.feltLedger}</div>` : ""}
          <div class="${centerCls}">${parts.center || ""}</div>
          ${parts.trick || ""}
          ${parts.feltBid || ""}
          ${parts.feltBottom ? `<div class="felt-bottom">${parts.feltBottom}</div>` : ""}
        </div>
      </div>
    </div>
    <div class="selfwrap">${self}</div>
  </div>${logSheet()}${leaveConfirm()}`;
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
  const g = S.party && GAMES[S.party];
  const gameName = g ? esc(g.label) : "Bonhomme";
  const suit = g ? g.suit : "♣";
  const red = suit === "♥" || suit === "♦";
  const reconnecting = S.joinedOnline && !S.offline && !S.connected;
  const sub = S.connected ? "Joined — dealing you in…"
    : reconnecting ? "Connection lost — reconnecting…"
    : S.connectSlow ? "Still connecting…" : "Finding your table…";
  // Going offline is always the player's explicit choice once a room is involved.
  const offerOffline = !S.offline && !S.connected && (reconnecting || S.connectSlow);
  app.__set = `<div class="felt-screen">
    <div class="connect-card" role="status">
      <div class="connect-suit${red ? " red" : ""}">${suit}</div>
      <div class="connect-name">${gameName}</div>
      <div class="connect-msg">${sub}</div>
      <div class="connect-dots" aria-hidden="true"><span></span><span></span><span></span></div>
      ${offerOffline ? `<div class="connect-acts">
        <button class="btn" data-action="play-offline">Play offline vs bots</button>
        <button class="btn ghost" data-action="leave">Leave</button>
      </div>` : `<button class="btn ghost sm" data-action="leave">${reconnecting ? "Leave" : "Cancel"}</button>`}
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
      <div class="passlogo" aria-hidden="true"></div>
      <p class="passlabel">Pass the device to</p>
      <h1 class="passname">${esc(name)}</h1>
      <p class="sub">Hand it over so nobody else sees the cards, then tap below.</p>
      <button class="btn" data-action="reveal-hand" ${ready ? "" : "disabled"}>
        ${ready ? `I’m ${esc(name)} — show my hand` : "One moment…"}
      </button>
      <button class="btn ghost" data-action="leave">Leave game</button>
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
  // Pegs & Jokers hidden until ready for prime time
  const gameIds = ["rummy500", "high-low-jack", "hearts"];

  // Spread three cards with a slight fan
  const positions = [
    { left: "0px",   top: "16px", rot: "-7deg" },
    { left: "86px",  top: "4px",  rot: "0deg"  },
    { left: "172px", top: "14px", rot: "7deg"  },
  ];

  const gameCards = gameIds.map((id, i) => {
    const info = GAMES[id];
    const meta = GAME_CARD_META[id];
    const sel = id === g;
    const pos = positions[i];
    const posStyle = sel
      ? `left:${pos.left};z-index:10`
      : `left:${pos.left};top:${pos.top};transform:rotate(${pos.rot});z-index:${i + 1}`;
    return `<button class="tbl-card${sel ? " selected" : ""} ${meta.color}" style="${posStyle}"
        data-action="pick-game" data-game="${id}" aria-pressed="${sel}" aria-label="${esc(info.label)}">
      <span class="tbl-card-corner tl" aria-hidden="true">${meta.suit}</span>
      <span class="tbl-card-name">${esc(info.label)}</span>
      <span class="tbl-card-corner br" aria-hidden="true">${meta.suit}</span>
    </button>`;
  }).join("");

  const info = g && GAMES[g];
  const blurb = info
    ? `<div class="hs-blurb"><b>${esc(info.range)}</b>${esc(info.blurb)}</div>`
    : `<div class="hs-blurb muted">Tap a card to choose your game.</div>`;

  app.__set = `
    <div class="hs-rail">
      <div class="hs-felt">
        <div class="hs-brand">
          <h1 class="hs-title">BONHOMME!</h1>
          <p class="hs-tag">Classic card games with friends &amp; bots</p>
          <div class="hs-hero"><div class="hs-wm" role="img" aria-label="Jester hat"></div></div>
        </div>
        <div class="hs-form">
          <div class="hs-lbl hs-lbl-game" id="hs-pick-label">Choose a Game</div>
          <div class="tbl-fan" role="group" aria-labelledby="hs-pick-label">
            <input type="hidden" id="f-game" value="${esc(g || "")}" />
            <div class="tbl-fan-inner">${gameCards}</div>
          </div>
          ${blurb}
          <div class="hs-fields">
            <label class="hs-field"><span class="hs-lbl hs-lbl-name">Your Name</span>
              <input class="hs-fld" id="f-name" value="${esc(S.name || "")}" placeholder="e.g. Alex" autocomplete="nickname" maxlength="24" enterkeyhint="go" /></label>
            <label class="hs-field"><span class="hs-lbl hs-lbl-room">Room Code</span>
              <input class="hs-fld" id="f-room" value="${esc(S.room || "")}" placeholder="New room" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="go" /></label>
          </div>
          <button class="hs-cta" data-action="connect">Take a Seat</button>
        </div>
      </div>
    </div>`;
  requestAnimationFrame(() => {
    if (document.activeElement instanceof HTMLButtonElement) document.activeElement.blur();
  });
}
// Layout math (hand fan, pod insets, trick positions) depends on the viewport,
// so re-render when it changes shape. Debounced: resize fires continuously.
let _resizeT = null;
window.addEventListener("resize", () => {
  clearTimeout(_resizeT);
  _resizeT = setTimeout(() => { if (S.party) { try { render(); } catch {} } }, 120);
});
window.matchMedia("(orientation:landscape)").addEventListener("change", () => render());
// iOS standalone web apps can fire a transient portrait orientation/resize while
// the screen locks; if the matching landscape event is missed on unlock, the
// JS-baked layout can get stuck in portrait. Re-render whenever the app returns
// to the foreground (immediately and again after the viewport settles) so the
// layout follows the device's real orientation rather than a stale snapshot.
const rerenderForViewport = () => { try { render(); } catch {} };
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) { rerenderForViewport(); setTimeout(rerenderForViewport, 300); reconnectNow(); }
});
window.addEventListener("pageshow", rerenderForViewport);
// ---------- lobby ----------
function renderLobby(v) {
  const isHost = v.you !== null && v.you === v.hostSeat;
  const isPJ = S.party === "pegs-and-jokers";
  const isHLJ = S.party === "high-low-jack";
  const isRummyLobby = S.party === "rummy500";
  const isTeamGame = isHLJ || isPJ;
  const counts = isPJ ? [4, 6] : GAMES[S.party].players;
  const DIFF_LABELS = ["Easy", "Medium", "Hard", "Expert"];
  const n = v.seats.length;
  const you = v.you;
  const hasHotseats = Object.keys(S.hotseats).length > 0;
  const removeBtn = (action, i, label) =>
    `<button class="seat-remove" data-action="${action}" data-seat="${i}" aria-label="${label}" title="${label}">${ICON.close}</button>`;

  // Rummy bot level for a seat (applied on "change", sent with the full lobby config).
  const diffPicker = (i) => {
    const diff = v.botDifficulty?.[i] ?? 2;
    return `<select class="difficulty-pick" data-action="set-bot-difficulty" data-seat="${i}" value="${diff}" aria-label="Seat ${i + 1} bot difficulty">${DIFF_LABELS.map((l, d) => `<option value="${d}"${d === diff ? " selected" : ""}>${l}</option>`).join("")}</select>`;
  };
  // Empty seats: the host may reserve one for a pass-and-play guest — but only
  // while no other online player is seated, since that deal runs on this device.
  // Everyone else (spectators too) can sit in one; so can the host once friends
  // are here (e.g. to pick a partner in a team game).
  const remoteHumans = S.offline ? 0 : v.seats.filter((s, i) => s.kind === "human" && i !== you).length;
  const emptyAction = isHost && (S.offline || remoteHumans === 0) ? "reserve-hotseat" : S.offline ? null : "sit";

  // A seat around the table: avatar (or a dashed "+" for an open seat) over a name plate.
  const seatToken = (s, i) => {
    const isEmpty = s.kind === "empty";
    const isBot = s.kind === "bot";
    const reserved = isHost && isEmpty && S.hotseats[i];
    const tc = isTeamGame ? (i % 2 === 0 ? "tA" : "tB") : "";
    const kind = reserved ? "local" : isEmpty ? "empty" : isBot ? "bot" : "human";
    const rawName = reserved ? S.hotseats[i] : isEmpty ? "" : (s.name || (isBot ? "Bot" : "Player"));
    const act = isEmpty && !reserved ? emptyAction : null;
    const label = isEmpty && !reserved ? (act === "sit" ? "Sit here" : act ? "Add player" : "Open seat") : rawName;
    const role = reserved ? "Pass & play" : isBot ? "Bot" : !isEmpty && i === v.hostSeat ? "Host" : "";
    const av = isEmpty && !reserved ? ICON.plus : esc(initials(rawName));
    const actLabel = act === "sit" ? `Sit in seat ${i + 1}` : `Add a pass-and-play player in seat ${i + 1}`;
    const avEl = act
      ? `<button class="seat-av" data-action="${act}" data-seat="${i}" aria-label="${actLabel}" title="${actLabel}">${av}</button>`
      : `<span class="seat-av">${av}</span>`;
    let extra = "";
    if (reserved) extra = removeBtn("clear-hotseat", i, "Remove player");
    else if (isBot && isHost) extra = removeBtn("removebot", i, "Remove bot") + (isRummyLobby ? diffPicker(i) : "");
    else if (S.offline && s.kind === "human" && i !== v.hostSeat) extra = removeBtn("clearseat", i, "Remove player");
    return `<div class="seat-token ${tc} is-${kind}${act ? " can-" + act : ""}">
      ${avEl}
      <span class="seat-name">${esc(label)}</span>
      ${role ? `<span class="seat-role">${role}</span>` : ""}
      ${extra}
    </div>`;
  };

  const pods = v.seats
    .map((s, i) => ({ seat: i, html: seatToken(s, i) }))
    .filter(({ seat }) => seat !== you);

  // centre panel: game, room, who's here, and (for the host) the table size
  const seated = v.seats.filter((s, i) => s.kind !== "empty" || (isHost && S.hotseats[i])).length;
  const where = S.offline ? "Offline table" : `Room <b>${esc(S.room)}</b>`;
  const series = isTeamGame && v.scores && (v.scores[0] || v.scores[1])
    ? `<div class="lby-series"><span class="teamcircle tA">A</span><b>${v.scores[0]}</b><span>vs</span><b>${v.scores[1]}</b><span class="teamcircle tB">B</span></div>`
    : "";
  const countChips = isHost && counts.length > 1
    ? `<div class="lby-cfg"><span class="lby-cfg-label">Players</span><div class="lby-chip-row">${counts.map((c, idx) =>
        `<button class="lby-count-chip${c === v.players ? " on" : ""}${idx % 2 === 1 ? " red" : ""}" data-action="${isPJ ? "pj-setplayers" : "setcount"}" data-count="${c}" aria-pressed="${c === v.players}" aria-label="${c} players">${c}</button>`
      ).join("")}</div></div>`
    : "";
  const marbles = isPJ && isHost
    ? `<div class="lby-cfg"><span class="lby-cfg-label">Marbles</span><div class="seg">${GAMES["pegs-and-jokers"].marbles.map((m) => `<button class="${m === v.marbles ? "on" : ""}" data-action="pj-setmarbles" data-m="${m}">${m}</button>`).join("")}</div></div>`
    : "";
  const note = !isHost ? ""
    : hasHotseats ? "Pass &amp; play — the device is handed around between turns."
    : S.offline ? "Bots fill every empty seat when you deal."
    : "Invite friends, or deal now — bots fill any empty seats.";
  const center = `<div class="lby-panel">
      <div class="lby-title">${esc(GAMES[S.party].label)}</div>
      <div class="lby-meta">${where} · ${seated}/${n} seated</div>
      ${series}
      ${isHost ? countChips + marbles : `<div class="lby-wait">Waiting for the host to deal…</div>`}
      ${note ? `<div class="lby-note">${note}</div>` : ""}
    </div>`;

  // your seat: editable name
  const nameInput = `<div class="lby-name-row"><input class="lby-name-input" value="${esc(S.name || "")}" placeholder="Your name" autocomplete="nickname" maxlength="24" enterkeyhint="done" aria-label="Your name" /><button class="lby-name-btn" data-action="lby-rename" aria-label="Save name" title="Save name">${ICON.check}</button></div>`;
  const myTc = you != null && isTeamGame ? (you % 2 === 0 ? "A" : "B") : null;
  const selfMeta = you != null && v.seats[you]
    ? `<span class="lby-role">${you === v.hostSeat ? "Host" : "Player"}${myTc ? ` · Team ${myTc}` : ""}</span>`
    : "";

  // actions: Invite · Tutorial · Deal
  const shareBtn = !S.offline
    ? `<button class="btn ghost lby-share-btn" data-action="share-link">${ICON.share}Invite</button>`
    : "";
  // Tutorial: single human only (no pass-and-play). Works online or offline — in
  // production a solo "vs bots" game is a normal server room, not S.offline, and in
  // the lobby the other seats are still empty (bots fill them on deal), so we gate on
  // a lone human seat rather than the offline flag.
  const singlePlayer = !hasHotseats && v.seats.filter((s) => s.kind === "human").length === 1;
  const tutorialBtn = isHost && singlePlayer
    ? `<button class="btn ghost lby-tutorial-btn${S.tutorial ? " active" : ""}" data-action="toggle-tutorial" aria-pressed="${S.tutorial ? "true" : "false"}" title="Play a guided practice hand">${S.tutorial ? `${ICON.check}Tutorial` : "Tutorial"}</button>`
    : "";
  const actions = isHost
    ? `${shareBtn}${tutorialBtn}<button class="btn lby-deal-btn" data-action="start">Deal</button>`
    : `${shareBtn}<span class="hint">The host deals when everyone’s seated.</span>`;

  // settings (host)
  const winsNeeded = v.winsNeeded ?? 1;
  const bestOf = winsNeeded <= 1 ? 1 : winsNeeded * 2 - 1;
  const settingsModal = isHost && S.lbySettingsOpen
    ? `<div class="modal-back" data-action="close-lby-settings">
        <div class="modal" data-stop="1" role="dialog" aria-label="Table settings">
          <div class="modalhead"><span>Table settings</span><button class="iconbtn sm" data-action="close-lby-settings" aria-label="Close">${ICON.close}</button></div>
          <div class="modalbody"><div class="set-list">
            ${isHLJ ? `<div class="set-row">
              <span>Match length<small>First team to 21 wins a game</small></span>
              <div class="seg">${[1, 3].map((nn) => `<button class="${nn === bestOf ? "on" : ""}" data-action="lby-set-bestof" data-n="${nn}">${nn === 1 ? "1 game" : `Best of ${nn}`}</button>`).join("")}</div>
            </div>` : ""}
            ${(isRummyLobby || S.party === "hearts") ? `<div class="set-row">
              <span>Play to<small>${S.party === "hearts" ? "Lowest score wins when someone reaches it" : "First to reach it wins"} · up to ${GAMES[S.party].maxTarget}</small></span>
              <input class="lby-pts" id="f-target" type="number" inputmode="numeric" min="1" max="${GAMES[S.party].maxTarget}" value="${v.target ?? GAMES[S.party].target}" aria-label="Target score" />
            </div>` : ""}
            ${isRummyLobby ? `<div class="set-row">
              <span>Must discard to go out<small>Your last card has to be a discard</small></span>
              <button class="lby-toggle${v.requireDiscard ? " on" : ""}" data-action="rummy-toggle-discard" aria-pressed="${!!v.requireDiscard}">${v.requireDiscard ? "On" : "Off"}</button>
            </div>
            ${v.seats.map((s, i) => s.kind === "bot" || (s.kind === "empty" && !S.hotseats[i])
              ? `<div class="set-row">
              <span>Seat ${i + 1} bot<small>${s.kind === "bot" ? "Seated now" : "Joins when you deal"}</small></span>
              ${diffPicker(i)}
            </div>` : "").join("")}` : ""}
            ${!S.offline ? `<div class="set-row">
              <span>Replace disconnects<small>A bot plays for anyone who drops out</small></span>
              <label class="switch"><input type="checkbox" data-action="toggle-bot-replacement" ${v.botReplacement ? "checked" : ""} aria-label="Auto-replace disconnects with bots" /><span></span></label>
            </div>` : ""}
          </div></div>
        </div>
      </div>`
    : "";
  const settingsBtn = isHost
    ? `<button class="iconbtn lby-gear-btn" data-action="open-lby-settings" aria-label="Table settings" title="Table settings">${ICON.gear}<span class="lbl">Settings</span></button>`
    : "";

  const feltOverlay = `<div class="lby-felt-watermark"></div>`;
  const cornerSuits = ["♠", "♥", "♦", "♣"].map((s, i) =>
    `<span class="felt-corner-suit ${i === 1 || i === 2 ? "red" : ""} ${["tl", "tr", "br", "bl"][i]}">${s}</span>`
  ).join("");

  // Spectator view: every seat around the table, no player bar
  if (you === null) {
    app.__set = tableShell(v, {
      pods: v.seats.map((s, i) => ({ seat: i, html: seatToken(s, i) })),
      center, feltOverlay, cornerSuits, hand: null, selfMeta: "", actions: null,
    });
    return;
  }

  app.__set = tableShell(v, {
    pods, center, feltOverlay, cornerSuits,
    hand: "",
    selfName: nameInput,
    selfMeta,
    selfTeam: myTc,
    actions,
    barStart: settingsBtn,
  }) + settingsModal;
}

// ---------- shared: game over ----------
// rows: [{ name, score, win, you }] — already in seat order; shown best-first.
function scoreList(rows, { lowWins = false } = {}) {
  const sorted = rows.map((r, i) => ({ ...r, i })).sort((a, b) =>
    (b.win - a.win) || (typeof a.score === "number" && typeof b.score === "number" ? (lowWins ? a.score - b.score : b.score - a.score) : 0) || a.i - b.i);
  return `<div class="standings">${sorted
    .map((r, k) => `<div class="standing${r.you ? " me" : ""}${r.win ? " win" : ""}">
        <span class="standing-rank">${r.win ? "♛" : k + 1}</span>
        ${avatarHTML(r.name, { team: r.team })}
        <span class="standing-name">${esc(r.name)}${r.you ? "<small>you</small>" : ""}</span>
        <span class="standing-score">${r.score}</span>
      </div>`)
    .join("")}</div>`;
}

// Results pages keep the move log one tap away (Leave sits with the actions),
// so the whole final hand can be reviewed.
function resultTools() {
  return `<div class="result-tools"><button class="iconbtn" data-action="toggle-log" aria-label="Move log" title="Move log">${ICON.log}<span class="lbl">Log</span></button></div>`;
}
// One labelled card on a results page.
const resultCard = (label, body) => `<section class="result-card"><div class="result-label">${label}</div>${body}</section>`;

// `o.last` (optional) is the deciding hand/round's breakdown, shown above the totals.
function renderGameOver(v, title, scoresHTML, o = {}) {
  // Offline every seated human shares this device, so whoever holds it can redeal.
  const isHost = v.you !== null && (v.you === v.hostSeat || S.offline);
  const g = GAMES[S.party];
  app.__set = `<div class="result-page">
    ${resultTools()}
    <div class="result-scroll">
      <div class="result-head">
        <div class="result-eyebrow">${esc(g ? g.label : "")} · Game over</div>
        <div class="result-crown" aria-hidden="true">♛</div>
        <h1 class="result-title">${esc(title)}</h1>
        <p class="result-sub">${o.sub || "Good game."}</p>
      </div>
      ${o.last || ""}
      ${resultCard("Final scores", scoresHTML)}
      <div class="result-actions">
        ${isHost ? `<button class="btn" data-action="newgame">Deal a new game</button>` : `<p class="result-wait">Waiting for the host to deal again…</p>`}
        <button class="btn ghost" data-action="leave">Leave table</button>
      </div>
    </div>
  </div>${logSheet()}`;
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

// Ellipse position: place seat off/n evenly around an oval (clockwise from bottom).
function ovalPos(off, n, { cx = 50, cy, rx, ry }) {
  const t = off / n;
  return {
    x: cx - rx * Math.sin(2 * Math.PI * t),
    y: cy + ry * Math.cos(2 * Math.PI * t),
  };
}

// Wall-aware perimeter position: classifies a seat onto a wall by its computed
// x (corner offsets land exactly on x1/x2), then evenly re-spaces side-wall
// seats so trick cards and bid chips track the pods. wideY1/wideY2 (optional)
// widen the side range when a wall holds 3+ seats (8-player tables).
function wallPerimPos(off, n, b) {
  const { x1, x2, y1, y2, wideY1 = y1, wideY2 = y2, topY = y1 } = b;
  const at = (o) => perimPos(o / n, { x1, x2, y1, y2 });
  const sideOf = (p) => (p.x <= x1 ? "left" : p.x >= x2 ? "right" : "top");
  const pos = at(off);
  const side = sideOf(pos);
  // Top-wall player uses topY (lets it sit higher than side-wall reference y1).
  if (side === "top") return { ...pos, y: topY, side };
  if (off === 0) return { ...pos, side };
  const wall = [];
  for (let o = 1; o < n; o++) if (sideOf(at(o)) === side) wall.push(o);
  const i = wall.indexOf(off);
  const yTop = wall.length >= 3 ? wideY1 : y1;
  const yBot = wall.length >= 3 ? wideY2 : y2;
  const f = wall.length === 1 ? 0.5 : i / (wall.length - 1);
  const fy = side === "left" ? 1 - f : f; // left wall walks bottom→top, right top→bottom
  let y;
  if (wall.length >= 3 && yBot > y2) {
    // Extended bounds (pods only): top two slots at y1/y2, third extrapolates equally below
    const step = y2 - y1;
    if (fy <= 0.5) y = y1 + step * (fy / 0.5);
    else y = y2 + step * ((fy - 0.5) / 0.5);
  } else {
    y = yTop + (yBot - yTop) * fy;
  }
  return { x: pos.x, y, side };
}

// Which card in a completed High Low Jack trick won it (port of engine
// trickWinner): highest trump — joker is the lowest trump — else highest of the
// led suit. Returns the index into the play-order cards array.
// Build a spatially-positioned trick div: each card placed on a circle,
// equidistant from center, evenly spaced by angle.
// `plays`  – [{card, seat, name?}]
// `you`    – viewer's seat index (null = spectator → laid out from seat 0)
// `n`      – total seat count
// options  – winSeat: seat whose card gets .win; faded: dim the whole trick
function trickHTML(plays, you, n, { winSeat = null, faded = false, mini = true, collecting = false } = {}) {
  const rails = isRails();
  const anchor = you ?? 0; // a spectator sees the table from seat 0's chair
  const circleStyle = (seat) => {
    const off = (seat - anchor + n) % n;
    let x, y;
    if (rails) {
      // Landscape: an orderly oval ring widened for the short, wide felt. Your
      // own card sits at the bottom of the ring, just above your hand (the felt
      // stage already stops above the hand). The centre sits low (cy 54) so the
      // top card tucks just under the top pod.
      ({ x, y } = ovalPos(off, n, { cx: 50, cy: 54, rx: 27, ry: 25 }));
      // 8-player: drop the bottom side row (off 1 = bottom-left, off n-1 =
      // bottom-right) a bit lower so those cards sit nearer their players.
      if (n === 8 && (off === 1 || off === n - 1)) y += 6;
      // Spectator: seat 0's pod sits at the bottom of this short felt; clear it.
      if (off === 0 && you == null) y -= 16;
      // Top-pod card (player directly across, even tables): nudge up so its gap
      // from the top pod matches the user's card-to-hand gap.
      if (n % 2 === 0 && off === n / 2) y -= 4;
      return `top:${y}%;left:${x}%;transform:translate(-50%,-50%)`;
    }
    if (mini) {
      ({ x, y } = wallPerimPos(off, n, { x1: 18, x2: 82, y1: 18, y2: 88 }));
    } else {
      ({ x, y } = ovalPos(off, n, { cx: 50, cy: 53, rx: 24, ry: 26 }));
    }
    return `top:${y}%;left:${x}%;transform:translate(-50%,-50%)`;
  };
  const cardRotation = (seat) => {
    const off = (seat - anchor + n) % n;
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
    return `<div class="play${idx === 0 ? " lead" : ""}" style="${style}"><div class="card-rotator" style="transform:rotate(${cardRotation(p.seat)}deg)">${cardHTML(p.card, { mini, win: isWin })}</div></div>`;
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

// Returns true if at least one teammate hasn't yet had a bid turn after `you`
// (and could therefore use the confidence signal). For a bid of 6, everyone
// between you and the dealer gets an implicit pass, so only the dealer remains.
function hljTeammateStillToBid(v, bidAmount) {
  const you = v.you;
  const n = v.seats.length;
  const dealer = v.dealerSeat;
  if (you === dealer) return false; // dealer bids last; nobody after
  const actedSeats = new Set((v.bidHistory ?? []).map(b => b.seat));
  if (bidAmount === 6) {
    // Only the dealer remains; did they act already? (shouldn't be, but guard)
    return dealer % 2 === you % 2 && !actedSeats.has(dealer);
  }
  // Normal bid: seats from you+1 up to dealer (inclusive) still have turns
  for (let i = 1; i <= n; i++) {
    const seat = (you + i) % n;
    if (!actedSeats.has(seat) && seat % 2 === you % 2) return true;
    if (seat === dealer) break; // dealer is last; stop here
  }
  return false;
}

function renderHLJ(v) {
  if (v.phase === "gameOver") {
    const w = v.winner;
    const you = v.you;
    const isHost = you !== null && (you === v.hostSeat || S.offline); // offline: shared device
    const winLabel = w == null ? "Game over" : `Team ${w === 0 ? "A" : "B"} wins!`;
    const winTeamCls = w != null ? `t${w === 0 ? "A" : "B"}` : "";
    const lh = v.lastHand;

    let handSection = "";
    if (lh) {
      const bidderTeamLetter = lh.bidderTeam === 0 ? "A" : "B";
      const bidderName = esc(seatName(v, lh.bidderSeat));
      const pts = lh.detail;
      const honors = [
        { label: "High", team: pts.high },
        { label: "Low", team: pts.low },
        { label: "Jack", team: pts.jack },
        { label: "Bonhomme", team: pts.bonhomme },
      ];
      const colA = honors.filter(h => h.team === 0 && h.team != null);
      const colB = honors.filter(h => h.team === 1 && h.team != null);
      const gcA = pts.gameCount?.[0] ?? 0;
      const gcB = pts.gameCount?.[1] ?? 0;
      const gameHonor = pts.game != null
        ? `<div class="hlj-rr-honor">Game <span class="hlj-rr-game-gc tA">${gcA}</span><span class="hlj-rr-game-gc-sep">·</span><span class="hlj-rr-game-gc tB">${gcB}</span></div>`
        : "";
      if (pts.game === 0) colA.push({ label: "_game_" });
      if (pts.game === 1) colB.push({ label: "_game_" });
      const honorList = (items) => items.length
        ? items.map(h => h.label === "_game_" ? gameHonor : `<div class="hlj-rr-honor">${h.label}</div>`).join("")
        : `<div class="hlj-rr-honor none">—</div>`;
      const ptRows = `<div class="hlj-rr-twocol">
        <div class="hlj-rr-col tA"><div class="hlj-rr-colhdr tA">Team A · ${lh.pointsByTeam[0]} pt${lh.pointsByTeam[0] !== 1 ? "s" : ""}</div>${honorList(colA)}</div>
        <div class="hlj-rr-col tB"><div class="hlj-rr-colhdr tB">Team B · ${lh.pointsByTeam[1]} pt${lh.pointsByTeam[1] !== 1 ? "s" : ""}</div>${honorList(colB)}</div>
      </div>`;
      const scoreRows = [0, 1].map(t => {
        const letter = t === 0 ? "A" : "B";
        const delta = lh.deltaByTeam[t];
        const total = lh.finalScores?.[t] ?? v.scores[t];
        const sign = delta > 0 ? "+" : "";
        const isBidder = t === lh.bidderTeam;
        return `<div class="hlj-rr-scorerow${isBidder && !lh.made ? " setback" : ""}">
          <span class="hlj-rr-scoreteam t${letter}">Team ${letter}</span>
          <span class="hlj-rr-scoredelta">${sign}${delta}</span>
          <span class="hlj-rr-scoretotal">${total} pts</span>
        </div>`;
      }).join("");
      const kittyCards = (v.lastKitty || []).map(c => cardHTML(c, { mini: true })).join("");
      const kittySection = kittyCards
        ? `<div class="hlj-result-card"><div class="hlj-rr-section"><div class="hlj-rr-seclabel">Kitty</div><div class="hlj-rr-kitty">${kittyCards}</div></div></div>`
        : "";
      handSection = `
        <div class="hlj-result-headline">
          <div class="hlj-result-handover hlj-result-gameover-banner ${winTeamCls}">${winLabel}</div>
          <div class="hlj-result-bidline">${bidderName} bid <b>${lh.bid}</b> for Team ${bidderTeamLetter}</div>
          <div class="hlj-result-verdict ${lh.made ? "made" : "set"}">${lh.made ? "Made it" : "Set back"}</div>
        </div>
        <div class="hlj-result-card">
          <div class="hlj-rr-seclabel">Points taken</div>
          ${ptRows}
        </div>
        ${kittySection}
        <div class="hlj-result-card hlj-result-scores">
          <div class="hlj-rr-seclabel">Final score</div>
          ${scoreRows}
        </div>`;
    } else {
      handSection = `<div class="hlj-result-headline"><div class="hlj-result-handover hlj-result-gameover-banner ${winTeamCls}">${winLabel}</div></div>`;
    }

    const nextBtn = isHost
      ? `<div class="result-actions"><button class="btn hlj-result-next-btn" data-action="newgame">Deal a new game</button><button class="btn ghost" data-action="leave">Leave table</button></div>`
      : `<div class="result-actions"><p class="result-wait">Waiting for the host to deal again…</p><button class="btn ghost" data-action="leave">Leave table</button></div>`;

    // Leave sits with the actions, so nobody is stuck on the final scores
    // waiting for a host who may never deal again; the log stays reachable.
    app.__set = `<div class="hlj-result-page">
      ${resultTools()}
      <div class="hlj-result-felt">
        <div class="hlj-result-scroll">
          ${handSection}
          ${nextBtn}
        </div>
      </div>
      ${logSheet()}
    </div>`;
    return;
  }

  const lm = v.yourTurn ? v.legalMoves : [];
  const bids = lm.filter((m) => m.type === "bid");
  const canPass = lm.some((m) => m.type === "pass");

  const plays = new Set(lm.filter((m) => m.type === "play").map((m) => cardKey(m.card)));
  const highBid = v.highBid ? `${v.highBid.amount} (${esc(seatName(v, v.highBid.seat))})` : "\u2014";

  const teamLetter = (i) => (i % 2 === 0 ? "A" : "B");

  // Confidence-signal image maps — declared before any use (pod badges, your
  // chip, and the picker) to avoid a temporal-dead-zone ReferenceError that
  // would throw mid-render and freeze the table.
  const SIGNAL_SRCS = { weak: "/low-signal.webp", medium: "/medium-signal.webp", strong: "/high-signal.webp" };
  const SIGNAL_LABELS = { weak: "Weak", medium: "Medium", strong: "Strong" };
  // Signals are public for the whole hand (bots read every seat's), so each
  // seat that has signalled shows its badge through bidding and play.
  const signalImg = (i) => {
    const lvl = v.signals?.[i];
    return SIGNAL_SRCS[lvl] ? `<img src="${SIGNAL_SRCS[lvl]}" alt="${SIGNAL_LABELS[lvl]}" class="signal-img">` : "";
  };

  // pods (everyone but you), tagged with their team
  const pods = v.seats
    .map((s, i) =>
      i === v.you
        ? null
        : { seat: i, html: podHTML(v, i, {
            active: i === v.toAct,
            dealer: i === v.dealerSeat,
            // Once the bid is taken (playing phase and its trick gates), the winner's
            // pod shows the bid chip for the rest of the hand — replacing the dealer "D" chip
            // when the dealer won. Skip during the brief bid-reveal freeze, when
            // the floating chips are shown instead.
            highBid: (v.phase === "playing" || v.phase === "trickComplete") && !S.hljBidHold && v.highBid?.seat === i && i !== v.you ? v.highBid.amount : null,
            signal: signalImg(i),
            team: teamLetter(i),
            partner: v.you != null && i % 2 === v.you % 2,
            backs: v.handCounts[i],
          }) },
    )
    .filter(Boolean);

  // center: trick area (trump watermark on felt separately)
  const you = v.you;
  const myTeam = you != null ? you % 2 : null;
  let hljTrick;
  let centerExtra = "";
  // Trick pacing now lives on the server. The center is a pure function of
  // view.phase + currentTrick + trickWinner + lastTrick.
  // `lastTrick` falls back to the previous hand's final trick when tricksWon is
  // empty (start of a new hand) — treat that as stale so it isn't shown as "Last trick".
  const ltFresh = v.lastTrick && !(v.lastHand
    && JSON.stringify(v.lastTrick) === JSON.stringify(v.lastHand.lastTrick));
  if (v.phase === "trickComplete") {
    // Completed trick held on the felt with the winner highlighted; tap (or the
    // server's auto-advance timer) clears it.
    const trickPlays = v.currentTrick.map((p) => ({ ...p, name: seatName(v, p.seat) }));
    const winName = v.trickWinner != null ? esc(seatName(v, v.trickWinner)) : null;
    const trickEl = trickHTML(trickPlays, you, v.seats.length, { mini: false, winSeat: v.trickWinner });
    // A spectator can't advance the gate: no tap target, no "Tap to continue".
    const hint = [winName ? `<b>${winName}</b> takes it` : "", you != null ? "Tap to continue" : ""].filter(Boolean).join(" · ");
    hljTrick = `<div class="trick-gate${you != null ? "" : " view-only"}"${you != null ? ` data-action="advance-trick"` : ""}>${trickEl}`
      + (hint ? `<div class="trick-gate-hint">${hint}</div>` : "") + `</div>`;
  } else if (v.phase === "playing" && v.currentTrick.length) {
    const trickPlays = v.currentTrick.map((p) => ({ ...p, name: seatName(v, p.seat) }));
    hljTrick = trickHTML(trickPlays, you, v.seats.length, { mini: false });
  } else if (v.phase !== "bidding" && ltFresh) {
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
      const expanded = fanHand(ltCards, () => ({}), { cls: "lt-expanded-fan", cardW: 60, avail: 340 });
      hljTrick = `<div class="lasttrick open" data-action="toggle-last-trick"><div class="lt-label">Last trick \u00b7 ${esc(seatName(v, v.lastTrick.winner))} \u25b4</div>${expanded}</div>`;
    } else {
      hljTrick = `<div class="lasttrick" data-action="toggle-last-trick"><div class="lt-fan">${fanCards}</div><div class="lt-label">Last trick \u00b7 ${esc(seatName(v, v.lastTrick.winner))} \u25be</div></div>`;
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
  const feltOverlay = trumpMark;

  // While the end-of-hand result is pending (hold animation or modal not yet
  // acked), the view already carries next-hand state — suppress all of it.
  const handResultPending = v.lastHand && S.hljHandAcked !== JSON.stringify(v.lastHand);

  // hand (fanned), sorted by suit then rank, dim non-legal cards while it's your turn to play
  const HLJ_SUIT_ORDER = { S: 0, H: 1, D: 2, C: 3 };
  const sortedHand = handResultPending ? [] : [...v.yourHand].sort((a, b) =>
    (a.joker ? 1 : 0) - (b.joker ? 1 : 0) ||
    (HLJ_SUIT_ORDER[a.suit] ?? 4) - (HLJ_SUIT_ORDER[b.suit] ?? 4) ||
    a.rank - b.rank
  );
  const holdActive = v.phase === "trickComplete"; // cards aren't playable during the gate
  const hand = fanHand(sortedHand, (c) => ({
    playable: !holdActive && plays.size < sortedHand.length && plays.has(cardKey(c)),
    dim: !holdActive && plays.size > 0 && !plays.has(cardKey(c)),
    action: !holdActive && plays.has(cardKey(c)) ? "play-card" : "",
    key: cardKey(c),
  }));

  // Bid result tokens positioned on the felt near each player
  // plus your chip buttons anchored at the bottom of the felt
  const minBid = bids.length ? bids[0].amount : 2;
  const curHighAmt = v.highBid ? v.highBid.amount : null;
  const bidHistory = Array.isArray(v.bidHistory) ? v.bidHistory : [];

  // On a wide (landscape) felt, drop the top bid token lower so it clears the
  // top pod, and raise the bottom reference accordingly.
  const rails = isRails();
  const bidBounds = rails
    ? { x1: 22, x2: 78, y1: 40, y2: 76, topY: 30 }
    : { x1: 26, x2: 74, y1: 33, y2: 71, topY: 21 };
  // Bid token position for `seat` on a table of n seen from `me` (same wall
  // layout as the pods, pulled in toward the centre). Spectators see the
  // table from seat 0's chair.
  const bidPos = (seat, n, me) => {
    const off = (seat - (me ?? 0) + n) % n;
    // Your own token: low and centred, clear of the confidence chips. A
    // spectator's seat-0 token sits higher, above seat 0's pod.
    if (off === 0) return `top:${me == null ? 62 : rails ? 74 : 76}%;left:50%;transform:translate(-50%,-50%)`;
    const { x, y } = wallPerimPos(off, n, bidBounds);
    // Match the side-pod arc: higher side chips sit further toward center.
    const isSide = x < bidBounds.x1 + 1 || x > bidBounds.x2 - 1;
    const arcShift = rails && isSide ? Math.max(0, 78 - y) * 0.15 : 0;
    const ax = x < 50 ? x + arcShift : x - arcShift;
    return `top:${y}%;left:${ax}%;transform:translate(-50%,-50%)`;
  };
  const bidPosStyle = (seat) => bidPos(seat, v.seats.length, you);
  // The user's own bid chip is rendered as a direct felt-stage sibling (outside
  // the overlay) so it stacks above the bid bar like the bar itself.
  let selfBidToken = "";
  const tokenHTML = (b, highBidSeat, posStyle) => {
    const label = b.type === "pass" ? "Pass" : String(b.amount);
    const isHigh = b.type === "bid" && b.seat === highBidSeat;
    const team = `t${b.seat % 2 === 0 ? "A" : "B"}`;
    const cls = b.type === "pass" ? "pass" : `chip ${team}${isHigh ? " high" : ""}`;
    return `<div class="hlj-bid-token ${cls}" style="${posStyle(b.seat)}">${label}</div>`;
  };
  const bidTokens = (() => {
    // While the bid-end hold is active, freeze the full bid overlay
    if (S.hljBidHold && v.phase === "playing") {
      const bh = S.hljBidHold;
      const holdPos = (seat) => bidPos(seat, bh.seats.length, bh.you);
      const highBidSeat = bh.highBid?.seat ?? null;
      let toks = "";
      (bh.bidHistory ?? []).filter(b => !b.implicit).forEach(b => {
        const html = tokenHTML(b, highBidSeat, holdPos);
        if (bh.you != null && b.seat === bh.you) selfBidToken += html; else toks += html;
      });
      return toks;
    }
    if (v.phase === "bidding" && !handResultPending) {
      const highBidSeat = v.highBid?.seat ?? null;
      let toks = "";
      bidHistory.filter(b => !b.implicit).forEach(b => {
        const html = tokenHTML(b, highBidSeat, bidPosStyle);
        if (you != null && b.seat === you) selfBidToken += html; else toks += html;
      });
      return toks;
    }
    if (v.highBid && v.phase === "bidding") {
      // This branch is never the user's own seat, so it stays in the overlay.
      // During play the winner's bid lives on their pod badge (see pods above),
      // so no floating token is needed once the bid is taken.
      return tokenHTML({ type: "bid", seat: v.highBid.seat, amount: v.highBid.amount }, v.highBid.seat, bidPosStyle);
    }
    return "";
  })();
  const bidOverlay =
    (bidTokens ? `<div class="hlj-bid-overlay">${bidTokens}</div>` : "") + selfBidToken;

  // Your chip buttons — shown for the whole bidding phase, dimmed until your turn
  const claimedAmounts = new Set(
    bidHistory.filter(b => b.type === "bid").map(b => b.amount)
  );
  const isDealer = v.you != null && v.dealerSeat === v.you;
  const userHasActed = v.you != null && bidHistory.some(b => b.seat === v.you);
  const myTeamCls = you != null ? `t${you % 2 === 0 ? "A" : "B"}` : "";
  const signalLevels = ["weak", "medium", "strong"];
  const curSignal = v.you != null ? v.signals?.[v.you] : null;
  // The confidence-pick gate waits on one bidder (pendingSignalSeat): only they
  // get the picker; everyone else (spectators too) sees who the table waits on.
  const gateSeat = v.pendingSignal ? (v.pendingSignalSeat ?? null) : null;
  const showSignalPicker = gateSeat != null && gateSeat === v.you;
  const gateWait = gateSeat != null && !showSignalPicker
    ? `<div class="hlj-felt-bid gate-wait"><span class="gate-wait-msg">${esc(seatName(v, gateSeat))} is choosing a signal…</span></div>`
    : "";

  // Bid chips on the felt (hidden once player has bid).
  // Signal picker also on the felt, replacing the bid chips after player bids.
  const feltBidPanel = v.phase === "bidding" && !handResultPending && (v.you != null || gateWait)
    ? showSignalPicker
      ? `<div class="hlj-felt-bid">
          <div class="hlj-signal-felt">${signalLevels.map(lvl =>
            `<button class="hlj-signal-btn${curSignal === lvl ? " active" : ""}" data-action="signal" data-level="${lvl}" title="${SIGNAL_LABELS[lvl]}" tabindex="-1"><img src="${SIGNAL_SRCS[lvl]}" alt="${SIGNAL_LABELS[lvl]}" class="signal-img"></button>`
          ).join("")}</div>
        </div>`
      : gateWait
      ? gateWait
      : !userHasActed
        ? `<div class="hlj-felt-bid${v.yourTurn ? "" : " waiting"}">
            <div class="hlj-chips">
              ${[2,3,4,5,6].map(n => {
                if (claimedAmounts.has(n)) {
                  if (isDealer && n === curHighAmt)
                    return `<button class="hlj-chip ${myTeamCls} steal" data-action="move-bid" data-amount="${n}" ${!v.yourTurn ? "disabled" : ""}>STEAL</button>`;
                  return "";
                }
                if (curHighAmt != null && n <= curHighAmt) return "";
                const legal = n >= minBid;
                return `<button class="hlj-chip ${myTeamCls}${!legal ? " blocked" : ""}" data-action="move-bid" data-amount="${n}" ${(!legal || !v.yourTurn) ? "disabled" : ""}>${n}</button>`;
              }).join("")}
              <button class="hlj-pass-btn" data-action="move-pass" ${!v.yourTurn || !canPass ? "disabled" : ""}${v.yourTurn && !canPass ? ` title="Everyone passed \u2014 the dealer must bid"` : ""}>Pass</button>
            </div>
          </div>`
        : ""
    : "";
  // Team scores — in the top bar (portrait) or the rail corners (landscape), A then B.
  const myTeamIdx = you != null ? you % 2 : null;
  const winsNeeded = v.winsNeeded ?? 1;
  const scores = [0, 1].map((t) => {
    const L = t === 0 ? "A" : "B";
    const mine = t === myTeamIdx;
    const pips = winsNeeded > 1
      ? `<span class="pips" aria-hidden="true">${Array.from({ length: winsNeeded }, (_, k) => `<i class="${k < (v.gamesWon?.[t] ?? 0) ? "on" : ""}"></i>`).join("")}</span>`
      : "";
    return `<span class="score-pill t${L}${mine ? " mine" : ""}" title="Team ${L}${mine ? " (your team)" : ""} \u00b7 ${v.scores[t]} of ${v.target}">`
      + `<span class="teamcircle t${L}">${L}</span><b>${v.scores[t]}</b>${pips}</span>`;
  }).join("");

  const isYouDealer = you != null && you === v.dealerSeat;
  const selfTeam = you != null ? (you % 2 === 0 ? "A" : "B") : null;
  // Your own signal (once given) sits beside your bid / dealer chip for the hand.
  const selfSignal = you != null && signalImg(you) ? `<span class="pod-dealer-badge signal">${signalImg(you)}</span>` : "";
  const myBadge = you == null ? ""
    : (v.phase === "playing" || v.phase === "trickComplete") && v.highBid?.seat === you
      ? `<span class="pod-dealer-badge bid ${myTeamCls}" title="Your winning bid">${v.highBid.amount}</span>`
    : isYouDealer ? `<span class="pod-dealer-badge" title="You deal">D</span>` : "";
  const selfMeta = you != null
    ? `${selfSignal}${myBadge}<span>Team ${selfTeam} \u00b7 to ${v.target}</span>`
    : `play to ${v.target}`;
  const selfTurn = handResultPending
    ? ""
    : v.yourTurn
    ? `<span class="turnflag">${v.phase === "bidding" ? "Your bid" : "Your turn"}</span>`
    : showSignalPicker && v.phase === "bidding"
    ? `<span class="turnflag">Your signal</span>`
    : v.toAct != null
    ? `<span class="waitflag"><span>${esc(seatName(v, v.toAct))}${v.phase === "bidding" ? " is bidding" : "\u2019s turn"}</span></span>`
    : "";

  // End-of-hand result popup
  const hljHandModal = (() => {
    const lh = v.lastHand;
    if (!lh || v.phase === "gameOver") return "";
    const handKey = JSON.stringify(lh);
    if (S.hljHandAcked === handKey) return "";
    // The server's final-trick gate (trickComplete) already elapsed before lastHand
    // appears, so the result screen can show as soon as it arrives.

    if (S.hljHandTimer == null) {
      S.hljHandTimer = setTimeout(() => {
        S.hljHandAcked = handKey;
        S.hljHandTimer = null;
        S.hljShowDealtHands = false; // an open dealt-hands sheet closes with its page
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

    // Game honor: goes under the winning team, shows both pip counts in team colors
    const gcA = pts.gameCount?.[0] ?? 0;
    const gcB = pts.gameCount?.[1] ?? 0;
    const gameHonor = pts.game != null
      ? `<div class="hlj-rr-honor">Game <span class="hlj-rr-game-gc tA">${gcA}</span><span class="hlj-rr-game-gc-sep">·</span><span class="hlj-rr-game-gc tB">${gcB}</span></div>`
      : "";
    if (pts.game === 0) colA.push({ label: "_game_" });
    if (pts.game === 1) colB.push({ label: "_game_" });

    const honorList = (items) => items.length
      ? items.map(h => h.label === "_game_" ? gameHonor : `<div class="hlj-rr-honor">${h.label}</div>`).join("")
      : `<div class="hlj-rr-honor none">—</div>`;

    const ptRows = `<div class="hlj-rr-twocol">
      <div class="hlj-rr-col tA">
        <div class="hlj-rr-colhdr tA">Team A · ${totalA} pt${totalA !== 1 ? "s" : ""}</div>
        ${honorList(colA)}
      </div>
      <div class="hlj-rr-col tB">
        <div class="hlj-rr-colhdr tB">Team B · ${totalB} pt${totalB !== 1 ? "s" : ""}</div>
        ${honorList(colB)}
      </div>
    </div>`;

    const made = lh.made;
    // A hand that wins a game mid-series is followed at once by the next game's
    // deal (scores back to 0): show that hand's own totals and who won the game.
    const gameWon = lh.gameWinner != null;
    const wonA = v.gamesWon?.[0] ?? 0, wonB = v.gamesWon?.[1] ?? 0;
    const scoreRows = [0, 1].map(t => {
      const letter = t === 0 ? "A" : "B";
      const delta = lh.deltaByTeam[t];
      const total = lh.finalScores?.[t] ?? v.scores[t];
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
            <div class="modalhead"><span>Dealt hands</span><button class="iconbtn sm" data-action="hlj-close-dealt-hands" aria-label="Close">${ICON.close}</button></div>
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
            ${gameWon
              ? `<div class="hlj-result-handover hlj-result-gameover-banner t${lh.gameWinner === 0 ? "A" : "B"}">Team ${lh.gameWinner === 0 ? "A" : "B"} wins game ${wonA + wonB}</div>`
              : `<div class="hlj-result-handover">Hand over</div>`}
            <div class="hlj-result-bidline">${bidderName} bid <b>${lh.bid}</b> for Team ${bidderTeamLetter}</div>
            <div class="hlj-result-verdict ${made ? "made" : "set"}">${made ? "Made it" : "Set back"}</div>
          </div>
          <div class="hlj-result-card">
            <div class="hlj-rr-seclabel">Points taken</div>
            ${ptRows}
          </div>
          ${kittySection ? `<div class="hlj-result-card">${kittySection}</div>` : ""}
          <div class="hlj-result-card hlj-result-scores">
            <div class="hlj-rr-seclabel">${gameWon ? `Final score \u00b7 series A ${wonA} \u2013 B ${wonB}` : "Score"}</div>
            ${scoreRows}
          </div>
          ${dealtPile}
          <button class="btn hlj-result-next-btn" data-action="hlj-ack-hand">${gameWon ? "Next game" : "Next hand"} \u2192</button>
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
  app.__set = tableShell(v, { pods, center, trick: (hljTrick || "") + bidOverlay, feltBid: feltBidPanel, feltOverlay, cornerSuits, hand, actions: null, selfMeta, selfTeam, selfTurn, scores });
}

// ---------- Rummy 500: client-side rule mirror ----------
// These mirror rummy-module.ts so the UI can disable illegal actions outright
// (the server still re-validates). Jokers are wild in both sets and runs.
// A set is 3-4 cards of one rank, each natural a different suit (even with two decks).
function rIsSet(cards) {
  if (cards.length < 3 || cards.length > 4) return false;
  const nat = cards.filter((c) => !c.joker);
  return nat.length > 0 && nat.every((c) => c.rank === nat[0].rank)
    && new Set(nat.map((c) => c.suit)).size === nat.length;
}
// An Ace is low (A-2-3) or high (Q-K-A), never both, so one reading spans
// slots A(1)..K(13) or 2..A(14) and a run holds at most 13 cards.
const rMinSlot = (ace) => (ace === 1 ? 1 : 2);
const rMaxSlot = (ace) => (ace === 1 ? 13 : 14);
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
    if ((lo - rMinSlot(ace)) + (rMaxSlot(ace) - hi) < extra) continue;
    return true;
  }
  return false;
}
const rValidMeld = (cards) => rIsSet(cards) || rIsRun(cards);
const rCanLayoff = (meld, cards) =>
  meld.kind === "set" ? rIsSet([...meld.cards, ...cards]) : rIsRun([...meld.cards, ...cards]);
// With "Must discard" on, no meld or lay-off may empty the hand (the engine's
// requireDiscard check): a card has to be left to go out on.
const rKeepsDiscard = (v, cards) => !v.requireDiscard || cards.length < v.yourHand.length;

// The forced card (deep discard pickup). While it is pending, a meld or lay-off
// that leaves it out is refused unless the card can still go down in one move
// afterwards. A port of rummy-module's findSetContaining / findRunContaining /
// trioWith / runBridge / forcedPlays / forcedPlayable, quirks included, so the
// UI offers exactly the plays the engine accepts.
function rSetWith(hand, c) {
  if (c.joker) return null;
  const seen = new Map([[c.suit, c]]);
  for (const x of hand) if (!x.joker && x.rank === c.rank && !seen.has(x.suit)) seen.set(x.suit, x);
  const g = [...seen.values()];
  if (g.length >= 3) return g.slice(0, 4);
  const jokers = hand.filter((x) => x.joker);
  if (g.length >= 1 && g.length + jokers.length >= 3) return [...g, ...jokers.slice(0, 3 - g.length)];
  return null;
}
function rRunWith(hand, c) {
  if (c.joker) return null;
  const inSuit = hand.filter((x) => x.suit === c.suit && !x.joker);
  const jokers = hand.filter((x) => x.joker);
  for (const ace of [1, 14]) {
    const byRank = new Map();
    for (const x of inSuit) { const r = x.rank === 14 ? ace : x.rank; if (!byRank.has(r)) byRank.set(r, x); }
    const cr = c.rank === 14 ? ace : c.rank;
    byRank.set(cr, c);
    for (let lo = Math.max(1, cr - 2); lo <= cr; lo++) {
      for (let hi = cr; hi <= Math.min(14, cr + 2); hi++) {
        if (hi - lo + 1 < 3) continue;
        let nat = 0;
        for (let r = lo; r <= hi; r++) if (byRank.has(r)) nat++;
        if (nat < 1 || hi - lo + 1 - nat > jokers.length) continue;
        const jk = [...jokers];
        const cards = [];
        for (let r = lo; r <= hi; r++) cards.push(byRank.has(r) ? byRank.get(r) : jk.shift());
        if (cards.includes(c)) return cards;
      }
    }
  }
  return null;
}
// Is there a three-card meld of `f` plus two of `others`?
function rTrioWith(others, f) {
  if (f.joker) {
    const nats = others.filter((c) => !c.joker);
    if (nats.length && others.some((c) => c.joker)) return true;
    for (let i = 0; i < nats.length; i++)
      for (let j = i + 1; j < nats.length; j++) if (rValidMeld([f, nats[i], nats[j]])) return true;
    return false;
  }
  const pool = [f, ...others];
  const set = rSetWith(pool, f)?.slice(0, 3);
  if (set && rIsSet(set)) return true;
  const run = rRunWith(pool, f);
  return !!run && run.length === 3 && rIsRun(run);
}
// How many `pool` cards `f` needs to join the run `run` (0 = fits alone), or -1.
function rRunBridge(run, f, pool) {
  if (rIsRun([...run, f])) return 0;
  const nat = run.filter((c) => !c.joker);
  if (f.joker || !nat.length || nat[0].suit !== f.suit) return -1;
  const runJokers = run.length - nat.length;
  let best = -1;
  for (const ace of [1, 14]) {
    const eff = (c) => (c.rank === 14 ? ace : c.rank);
    const ranks = new Set(nat.map(eff));
    if (ranks.has(eff(f))) continue;
    ranks.add(eff(f));
    const lo = Math.min(...ranks), hi = Math.max(...ranks);
    const holes = [];
    for (let r = lo + 1; r < hi; r++) if (!ranks.has(r)) holes.push(r);
    const need = holes.length - runJokers;
    const bridge = [];
    for (const r of holes) {
      if (bridge.length >= need) break;
      const c = pool.find((x) => !x.joker && x.suit === f.suit && eff(x) === r);
      if (c) bridge.push(c);
    }
    for (const j of pool) if (j.joker && bridge.length < need) bridge.push(j);
    if (bridge.length < need || !rIsRun([...run, f, ...bridge])) continue;
    if (best < 0 || bridge.length < best) best = bridge.length;
  }
  return best;
}
// Can `f` (in `hand`) still go down in one move onto `melds` — keeping a card
// back to discard when requireDiscard is on?
function rForcedPlayable(hand, f, melds, requireDiscard) {
  const others = hand.filter((c) => c.id !== f.id);
  const fits = (n) => !requireDiscard || n < hand.length;
  if (rTrioWith(others, f) && fits(3)) return true;
  return melds.some((m) => {
    if (m.kind === "set") return rIsSet([...m.cards, f]) && fits(1);
    const n = rRunBridge(m.cards, f, others);
    return n >= 0 && fits(n + 1);
  });
}
// Would playing `cards` (a new meld, or a lay-off onto `meld`) strand the
// pending forced card? Mirrors the engine's check in isLegal.
function rStrandsForced(v, cards, meld = null) {
  const fid = v.mustMeldCardId;
  if (fid == null || cards.some((c) => c.id === fid)) return false;
  const f = v.yourHand.find((c) => c.id === fid);
  if (!f) return false;
  const ids = new Set(cards.map((c) => c.id));
  const rest = v.yourHand.filter((c) => !ids.has(c.id));
  const melds = meld
    ? v.melds.map((m) => (m.id === meld.id ? { ...m, cards: [...m.cards, ...cards] } : m))
    : [...v.melds, { id: -1, kind: rIsSet(cards) ? "set" : "run", cards }];
  return !rForcedPlayable(rest, f, melds, v.requireDiscard);
}
const R_STRANDS = "That would strand the green card \u2014 keep what it needs to go down this turn.";

// Reconcile S.rummyOrder with the live hand: keep order, append new cards, drop gone ones.
function rummyOrdered(hand) {
  const ids = hand.map((c) => c.id);
  S.rummyOrder = S.rummyOrder.filter((id) => ids.includes(id));
  for (const id of ids) if (!S.rummyOrder.includes(id)) S.rummyOrder.push(id);
  return S.rummyOrder.map((id) => hand.find((c) => c.id === id)).filter(Boolean);
}
// Hand order for a sort mode; jokers go to the end either way.
function rummyCmp(mode) {
  const rank = (c) => (c.joker ? 100 : c.rank);
  const suitOrder = { S: 0, H: 1, C: 2, D: 3 };
  return mode === "suit"
    ? (a, b) => ((a.joker ? 1 : 0) - (b.joker ? 1 : 0)) || (suitOrder[a.suit] - suitOrder[b.suit]) || (rank(a) - rank(b))
    : (a, b) => (rank(a) - rank(b)) || (suitOrder[a.suit] - suitOrder[b.suit]);
}
function rummySort(hand, mode) {
  S.rummyOrder = [...hand].sort(rummyCmp(mode)).map((c) => c.id);
  render();
}

// "You drew this" preview (armed in onFrame on your own stock draw).
function showDrawn(card) {
  clearTimeout(S.rummyDrawnTimer);
  S.rummyDrawnCard = card;
  S.rummyDrawnTimer = setTimeout(() => {
    S.rummyDrawnCard = null;
    S.rummyDrawnTimer = null;
    render();
  }, 3000);
}
function clearDrawn() {
  clearTimeout(S.rummyDrawnTimer);
  S.rummyDrawnTimer = null;
  S.rummyDrawnCard = null;
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

// Can card `c` join the current selection and still potentially form a valid
// meld/layoff? `pool` is the rest of the hand (unselected cards other than c):
// its cards may still fill a run's gaps, so the answer doesn't depend on the
// order the cards were tapped (3\u2663 then 5\u2663 is fine while 4\u2663 is in hand).
// With no lay-off target chosen, a lay-off onto any of `melds` (the table)
// counts too, so 5\u2665 + 9\u2665 for a 6-7-8\u2665 run aren't dimmed.
function rCompatible(sel, c, layMeld, pool = [], melds = []) {
  if (c.joker) return true;
  if (!sel.length) return true;
  const cards = [...sel, c];
  // Adding cards never repairs a set, so a set lay-off must hold as it is.
  const fits = (m) => (m.kind === "set" ? rCanLayoff(m, cards) : rRunFillable([...m.cards, ...cards], pool));
  if (layMeld) return fits(layMeld);
  const naturals = cards.filter((s) => !s.joker);
  // Set: same rank, distinct suits (jokers carry no suit of their own), at most 4.
  if (cards.length <= 4 && naturals.every((s) => s.rank === c.rank)
      && new Set(naturals.map((s) => s.suit)).size === naturals.length) return true;
  return rRunFillable(cards, pool) || melds.some(fits);
}

// Could `cards` become (part of) one run once gaps are filled from `pool`?
// Gaps take the jokers already in `cards` first; any left over must still fit
// at the ends. Mirrors rIsRun's ace-low / ace-high handling.
function rRunFillable(cards, pool) {
  const naturals = cards.filter((s) => !s.joker);
  const jokers = cards.length - naturals.length;
  if (!naturals.length) return true;
  const suit = naturals[0].suit;
  if (!naturals.every((s) => s.suit === suit)) return false;
  const poolJokers = pool.filter((p) => p.joker).length;
  for (const ace of [1, 14]) {
    const ranks = naturals.map((s) => (s.rank === 14 ? ace : s.rank)).sort((a, b) => a - b);
    if (new Set(ranks).size !== ranks.length) continue;
    const lo = ranks[0], hi = ranks[ranks.length - 1];
    const gaps = hi - lo + 1 - ranks.length;
    if (jokers >= gaps) {
      if ((lo - rMinSlot(ace)) + (rMaxSlot(ace) - hi) >= jokers - gaps) return true;
      continue;
    }
    // Gap ranks the pool holds in this suit (an ace is never inside a run).
    const fill = new Set(pool.filter((p) => !p.joker && p.suit === suit && p.rank > lo && p.rank < hi && !ranks.includes(p.rank)).map((p) => p.rank)).size;
    if (gaps - jokers <= fill + poolJokers) return true;
  }
  return false;
}

function rummyMeldInner(m) {
  const jokerRes = resolveJokers(m);
  let inner;
  if (m.kind === "set") {
    const naturals = m.cards.filter((c) => !c.joker);
    const redCount = naturals.filter((c) => RED.has(c.suit)).length;
    const blackCount = naturals.length - redCount;
    const oddIsRed = redCount < blackCount;
    const sorted = [...m.cards].sort((a, b) => {
      const aOdd = a.joker ? 0 : (RED.has(a.suit) === oddIsRed ? 1 : 0);
      const bOdd = b.joker ? 0 : (RED.has(b.suit) === oddIsRed ? 1 : 0);
      return aOdd - bOdd;
    });
    const n = sorted.length;
    const negMargin = n <= 1 ? 0 : Math.round(44 * (n - 2) / (n - 1));
    const allCards = sorted.map((c, ci) => {
      const ml = ci === 0 ? "" : `margin-left:-${negMargin}px`;
      return cardHTML(c, { mini: true, inMeld: true, style: ml });
    }).join("");
    inner = `<div class="run-dense tappable">${allCards}</div>`;
  } else {
    const n = m.cards.length;
    const negMargin = n <= 1 ? 0 : Math.round(44 * (n - 2) / (n - 1));
    const allCards = m.cards.map((c, ci) => {
      const ml = ci === 0 ? "" : `margin-left:-${negMargin}px`;
      return cardHTML(c, { mini: true, jokerAs: jokerRes[ci] ?? undefined, inMeld: true, style: ml });
    }).join("");
    inner = `<div class="run-dense tappable">${allCards}</div>`;
  }
  return inner;
}

function rummyLedgerRows(v, ctx) {
  const me = v.you;
  const byOwner = {};
  for (const m of v.melds) (byOwner[m.owner] ||= []).push(m);
  const order = v.seats.map((s, i) => i).filter((i) => i !== me).concat(me == null ? [] : [me]);
  return order.map((i) => {
    const active = i === v.toAct;
    const you = i === me;
    const name = esc(seatName(v, i));
    const count = you ? (v.yourHand ? v.yourHand.length : 0) : (v.handCounts[i] ?? 0);
    const badge = `<span class="ledger-count" title="${count} cards in hand">${count}</span>`;
    const nameplate = `<span class="ledger-av" style="--avseat:${i}">${you ? "You" : name}</span>`;
    const myMelds = byOwner[i] || [];
    const ribbon = myMelds.length
      ? `<div class="ledger-ribbon">${myMelds.map((m) => ctx.meldTile(m)).join("")}</div>`
      : `<div class="ledger-empty">No melds yet</div>`;
    // Same "away" chip and host Replace button the table pods carry.
    const presence = seatPresence(v, i);
    const presenceEl = presence.away ? `<div class="ledger-away">${presence.badge}${presence.replaceBtn}</div>` : "";
    return `<div class="ledger-row${active ? " active" : ""}${you ? " you" : ""}${presence.away ? " disconnected" : ""}">
      <div class="ledger-id">${nameplate}${badge}</div>
      ${presenceEl}
      ${ribbon}
      <span class="ledger-score" title="Score">${v.scores[i] ?? 0}</span>
    </div>`;
  });
}

function rummyLedgerHTML(v, ctx) {
  return `<div class="ledger-head">Players &amp; melds</div>${rummyLedgerRows(v, ctx).join("")}`;
}

// Landscape: split players into two columns (left / right), piles go between.
function rummyLedgerSplit(v, ctx) {
  const rows = rummyLedgerRows(v, ctx);
  const half = Math.ceil(rows.length / 2);
  const left = rows.slice(0, half).join("");
  const right = rows.slice(half).join("");
  return `<div class="ledger-col left">${left}</div><div class="ledger-col right">${right}</div>`;
}

function renderRummy(v) {
  // prune stale selections (cards no longer in hand)
  const handIds = new Set(v.yourHand.map((c) => c.id));
  for (const id of [...S.rummySel]) if (!handIds.has(id)) S.rummySel.delete(id);
  // The "you drew this" preview belongs to your turn and to the card in hand.
  if (S.rummyDrawnCard && (!v.yourTurn || !handIds.has(S.rummyDrawnCard.id))) clearDrawn();

  if (v.phase === "handComplete" || v.phase === "gameOver") {
    // Card and meld ids are reused by the next deal: nothing chosen this round
    // may carry into it.
    S.rummySel.clear();
    S.rummyLayoff = null;
    S.rummyMeldOpen = null;
    S.discardOpen = false;
  }
  if (v.phase === "handComplete") {
    S.rummyRoundShown = rummyRoundKey(v);
    return void (app.__set = rummyHandCompleteScreen(v));
  }

  if (v.phase === "gameOver") {
    const rows = v.seats.map((s, i) => ({ name: seatName(v, i), score: v.scores[i], win: i === v.winner, you: i === v.you }));
    // The deciding round goes straight to game over, so its breakdown lives here.
    const lr = v.lastRound;
    const last = lr
      ? resultCard(`Last round · ${lr.outSeat != null ? `${esc(seatName(v, lr.outSeat))} went out` : "stock exhausted"}`,
          `<div class="rhc-players">${rummyRoundPlayers(v, lr)}</div>`)
      : "";
    return renderGameOver(v, v.winner == null ? "Game over" : `${seatName(v, v.winner)} wins!`, scoreList(rows), { last });
  }

  const lm = v.yourTurn ? v.legalMoves : [];
  const canStock = lm.some((m) => m.type === "drawStock");
  const discardDraw = lm.find((m) => m.type === "drawDiscard");
  const bottom = v.discard.length ? v.discard[0] : null;
  const canTakePile = bottom && lm.some((m) => m.type === "drawDiscard" && m.cardId === bottom.id) && v.discard.length > 1;
  const top = v.discard.length ? v.discard[v.discard.length - 1] : null;
  const inPlay = v.yourTurn && v.turnPhase === "play";
  // A lay-off target only lives for the play phase it was picked in, and only
  // while that meld is still on the table.
  if (S.rummyLayoff !== null && (!inPlay || !v.melds.some((m) => m.id === S.rummyLayoff))) S.rummyLayoff = null;

  const pods = v.seats
    .map((s, i) =>
      i === v.you
        ? null
        : { seat: i, html: podHTML(v, i, {
            active: i === v.toAct,
            dealer: i === v.dealerSeat,
            cardCount: v.handCounts[i],
            pts: v.scores[i],
            note: i === v.toAct && v.turnPhase ? (v.turnPhase === "draw" ? "drawing…" : "playing…") : null,
          }) },
    )
    .filter(Boolean);

  // center: stock + discard piles
  const stock = `<div class="pile mini-pile">
      <div class="lbl">Stock</div>
      <div class="stockwrap${canStock ? " can-draw" : ""}" ${canStock ? `data-action="draw-stock" style="cursor:pointer" title="Draw from the stock"` : ""}>
        ${v.stockCount > 1 ? cardHTML({}, { back: true, mini: true, style: "position:absolute;top:2px;left:2px;opacity:.6" }) : ""}
        ${v.stockCount > 0 ? cardHTML({}, { back: true, mini: true }) : `<div class="pile-empty"></div>`}
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
      <div class="discardstack" data-action="open-discard" title="View the discard pile" style="cursor:pointer">
        ${top ? stackCards : `<div class="pile-empty"></div>`}
      </div>
      <div class="pts">${v.discard.length} card${v.discard.length === 1 ? "" : "s"}</div>
    </div>`;
  const center = `<div class="piles">${stock}${discard}</div>`;

  // Selected cards lift in place; cards that can't join the selection dim.
  const ordered = rummyOrdered(v.yourHand);
  const selCards = ordered.filter((c) => S.rummySel.has(c.id));
  const layMeld = v.melds.find((m) => m.id === S.rummyLayoff);

  // Melds: highlight the target meld, and any meld the selection could lay off
  // onto — the same highlight on the felt and in the phone ledger.
  const meldClass = (m) => S.rummyLayoff === m.id ? "target"
    : inPlay && selCards.length && S.rummyLayoff === null
      && rCanLayoff(m, selCards) && rKeepsDiscard(v, selCards)
      && !rStrandsForced(v, selCards, m) ? "layoff-hint" : "";
  const meldTile = (m) => `<div class="meld tappable ${meldClass(m)}" data-action="open-meld" data-meldid="${m.id}">${rummyMeldInner(m)}<span class="owner">${esc(seatName(v, m.owner))}</span></div>`;
  const meldsInner = v.melds.length
    ? `<div class="melds">${v.melds.map(meldTile).join("")}</div>`
    : `<div class="callout" style="font-size:13px">No melds down yet.</div>`;
  // Clicking the strip (but not an individual meld) opens the melds tab of the log.
  const melds = `<div class="rummy-melds-scroll" data-action="open-melds-log" title="View all melds">${meldsInner}</div>`;

  const compatibleIds = inPlay && selCards.length
    ? new Set(ordered.filter((c) => !S.rummySel.has(c.id)
        && rCompatible(selCards, c, layMeld, ordered.filter((p) => p !== c && !S.rummySel.has(p.id)), v.melds)).map((c) => c.id))
    : null; // null = no filtering
  const hand = fanHand(ordered, (c) => {
    const sel = S.rummySel.has(c.id);
    const incompatible = !sel && inPlay && compatibleIds != null && !compatibleIds.has(c.id);
    return {
      action: incompatible ? "" : "toggle-card",
      id: incompatible ? undefined : c.id,
      draggable: !incompatible,
      must: c.id === v.mustMeldCardId,
      playable: inPlay && !incompatible,
      dim: incompatible,
      sel,
      fresh: c.id === S.rummyDrawnCard?.id,
    };
  }, { arcScale: 0.6 });
  const keepsDiscard = rKeepsDiscard(v, selCards);
  const meldFits = selCards.length >= 3 && rValidMeld(selCards) && keepsDiscard;
  const layFits = !!layMeld && selCards.length >= 1 && rCanLayoff(layMeld, selCards) && keepsDiscard;
  // A pending forced card refuses any play that would leave it no way down.
  const canMeld = meldFits && !rStrandsForced(v, selCards);
  const canLay = layFits && !rStrandsForced(v, selCards, layMeld);
  const strands = !canMeld && !canLay && (meldFits || layFits);
  const canDiscard = selCards.length === 1 && v.mustMeldCardId == null;

  // sort controls (available whenever you hold cards) — single alternating button
  const nextSort = S.rummySort === "suit" ? "rank" : "suit";
  const sortBar = v.yourHand.length
    ? `<button class="btn ghost sm" data-action="sort-toggle" title="Sort by ${nextSort}">Sort<span class="btn-extra"> by ${nextSort}</span></button>`
    : "";

  // actions
  const acts = [];
  if (v.yourTurn && v.turnPhase === "draw") {
    if (canStock) acts.push(`<button class="btn" data-action="draw-stock">Draw<span class="btn-extra"> from stock</span></button>`);
    acts.push(sortBar);
    acts.push(`<span class="hint">Draw from the stock, or tap the discard pile to pick up cards.</span>`);
  } else if (inPlay) {
    const n = S.rummySel.size;
    if (canMeld) acts.push(`<button class="btn" data-action="meld-selected">Meld ${n}</button>`);
    else if (canLay) acts.push(`<button class="btn" data-action="layoff-selected">Lay off ${n}</button>`);
    else if (canDiscard) acts.push(`<button class="btn" data-action="discard-selected">Discard</button>`);
    if (n) acts.push(`<button class="btn ghost sm" data-action="clear-sel">Clear</button>`);
    acts.push(sortBar);
    // Rule reasons (.key) stay visible where the other hints are hidden.
    if (strands) acts.push(`<span class="hint key">${R_STRANDS}</span>`);
    else if (v.mustMeldCardId != null) acts.push(`<span class="hint key">Meld or lay off the green-ringed card before you discard.</span>`);
    else if (!keepsDiscard) acts.push(`<span class="hint key">Must discard is on — keep a card back to go out on.</span>`);
    else if (canMeld) acts.push(`<span class="hint">These ${n} cards make a meld — put them down.</span>`);
    else if (canLay) acts.push(`<span class="hint">Lay these cards off onto the highlighted meld.</span>`);
    else if (n >= 3) acts.push(`<span class="hint">These cards don’t form a valid meld.</span>`);
    else acts.push(`<span class="hint">Select cards to meld, tap a meld to lay off, or select one card to discard.</span>`);
  } else {
    acts.push(sortBar);
  }

  const myScore = v.you != null ? v.scores[v.you] : null;
  const selfMeta = (myScore != null
    ? `Score <b>${myScore}</b> / ${v.target}`
    : `play to ${v.target}`) + (v.tiebreak ? " · tiebreak round" : "");
  const selfTurn = v.yourTurn
    ? `<span class="turnflag">${v.turnPhase === "draw" ? "Your draw" : "Your play"}</span>`
    : v.toAct != null
    ? `<span class="waitflag"><span>${esc(seatName(v, v.toAct))}’s turn</span></span>`
    : "";

  // Watermarks (felt overlay + corner suits) are disabled for Rummy 500.
  const ledgerCtx = { meldTile };
  const useLedger = window.matchMedia("(max-width:1023px)").matches;
  const isLandscape = isRails();
  const rummyParts = useLedger
    ? isLandscape
      ? { pods: [], feltLedger: rummyLedgerSplit(v, ledgerCtx), ledgerRows: v.seats.length,
          center, centerBottom: false, ledgerLandscape: true, ledgerSplit: true,
          hand, actions: acts.join(""), selfMeta, selfTurn }
      : { pods: [], feltLedger: rummyLedgerHTML(v, ledgerCtx), ledgerRows: v.seats.length,
          center, centerBottom: true,
          hand, actions: acts.join(""), selfMeta, selfTurn }
    : { pods, center, feltBottom: melds, hand, actions: acts.join(""), selfMeta, selfTurn };
  app.__set = tableShell(v, rummyParts) + discardModal(v) + rummyMeldModal(v) + rummyRoundModal(v);
}

// A round's identity: the id of its round-end log row (ids only grow within a
// game), so two rounds that happen to score alike are still told apart.
const rummyRoundEnd = (e) => /^(goes out\b|Stock exhausted)/.test(e.msg || "");
function rummyRoundKey(v) {
  const log = v.log ?? [];
  for (let k = log.length - 1; k >= 0; k--) if (rummyRoundEnd(log[k])) return log[k].id;
  return null;
}

// Any seated player's "Next hand" deals on for the whole table. Whoever was
// still reading the summary gets it back over the new deal until they close it.
function rummyRoundModal(v) {
  const key = rummyRoundKey(v);
  if (!v.lastRound || key == null || S.rummyRoundShown !== key || S.rummyRoundAcked === key) return "";
  return rummyRoundSummary(v, "Last round", `<button class="btn" data-action="ack-round">Close</button>`);
}

// Seat that placed each card melded this round (card id -> seat). A melded card
// scores for whoever put it down (lay-offs score for the layer, not the meld's
// owner), so the round summary lists cards by placer. Uses the engine's per-card
// `by` when present, else this round's "melded" / "laid off" log rows; a card
// neither covers (log trimmed) falls back to its meld's owner.
function rummyPlacers(v, lr) {
  const by = new Map();
  for (const m of lr.lastMelds ?? []) for (const c of m.cards) if (c.by != null) by.set(c.id, c.by);
  // This round's rows lie between the previous round-end row and this one's
  // (card ids repeat every round, so older rows must not count).
  const log = v.log ?? [];
  let end = log.length - 1;
  while (end >= 0 && !rummyRoundEnd(log[end])) end--;
  let start = end - 1;
  while (start >= 0 && !rummyRoundEnd(log[start])) start--;
  for (let k = start + 1; k < end; k++) {
    const e = log[k];
    if (e.msg !== "melded" && e.msg !== "laid off") continue;
    for (const c of e.cards ?? []) if (!by.has(c.id)) by.set(c.id, e.seat);
  }
  return by;
}

// Per-player round breakdown: melded points (cards they placed, grouped by meld)
// minus the cards caught in hand. Shared by the round summary and game over.
function rummyRoundPlayers(v, lr) {
  const placers = rummyPlacers(v, lr);
  return v.seats.map((_, i) => {
    const name = esc(seatName(v, i));
    const net = lr.delta[i] ?? 0;
    const netStr = net >= 0 ? `+${net}` : `${net}`;
    const total = v.scores[i];
    const wentOut = i === lr.outSeat;

    // How the delta is made up (the engine's own split).
    const breakdown = lr.meldedPts && lr.heldPts
      ? `<div class="rhc-breakdown">Melded +${lr.meldedPts[i]} · held −${lr.heldPts[i]}</div>`
      : "";

    // Cards this player placed (green border), one group per meld they added to
    const meldsEl = (lr.lastMelds ?? []).map((m) => {
      const jokerRes = resolveJokers(m);
      const mine = m.cards
        .map((c, ci) => ({ c, as: jokerRes[ci] }))
        .filter(({ c }) => (placers.get(c.id) ?? m.owner) === i);
      return mine.length
        ? `<div class="rhc-meld">${mine.map(({ c, as }) => cardHTML(c, { mini: true, jokerAs: as ?? undefined })).join("")}</div>`
        : "";
    }).join("");

    // Held cards (red border)
    const heldCards = lr.heldCards?.[i] ?? [];
    const heldEl = heldCards.length
      ? `<div class="rhc-cards rhc-held">${heldCards.map((c) => cardHTML(c, { mini: true })).join("")}</div>`
      : "";

    return `<div class="rhc-player${wentOut ? " rhc-went-out" : ""}">
      <div class="rhc-player-hdr">
        <span class="rhc-player-name">${name}${wentOut ? ` <span class='rr-badge'>went out</span>` : ""}</span>
        <span class="rhc-delta ${net >= 0 ? "pos" : "neg"}">${netStr}</span>
        <span class="rhc-total">/ ${total}</span>
      </div>
      ${breakdown}
      ${meldsEl ? `<div class="rhc-melds">${meldsEl}</div>` : ""}
      ${heldEl}
    </div>`;
  }).join("");
}

// Full-screen hand-complete overlay shown when phase === "handComplete".
function rummyHandCompleteScreen(v) {
  if (!v.lastRound) return "";
  const nextBtn = v.you != null
    ? `<button class="btn" data-action="advance-round">Next hand →</button>`
    : `<p class="result-wait">Waiting for a player to deal the next hand…</p>`;
  return rummyRoundSummary(v, "Round over", nextBtn) + logSheet() + leaveConfirm();
}

// The round summary page. It carries Leave and Log, so no one — a spectator
// included — is stuck on it until a seated player moves on.
function rummyRoundSummary(v, eyebrow, footHTML) {
  const lr = v.lastRound;
  const heading = lr.outSeat != null
    ? `${esc(seatName(v, lr.outSeat))} went out`
    : "Stock exhausted";
  // Past the target with the lead shared: the game plays on (engine tie rule).
  const tie = v.tiebreak
    ? `<div class="rhc-tie">Tied for the lead at ${Math.max(...v.scores)} — another round decides</div>`
    : "";
  return `<div class="rhc-wrap">
    <div class="rhc-modal">
      <div class="rhc-head">
        <button class="iconbtn sm rhc-leave" data-action="leave" aria-label="Leave table" title="Leave table">${ICON.back}</button>
        <button class="iconbtn sm rhc-log" data-action="toggle-log" aria-label="Move log" title="Move log">${ICON.log}</button>
        <small>${eyebrow}</small>${heading}
      </div>${tie}
      <div class="rhc-body">${rummyRoundPlayers(v, lr)}</div>
      <div class="rhc-foot">${footHTML}</div>
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
        <div class="modalhead"><span>${kind} \u00b7 ${owner}</span>
          <button class="iconbtn sm" data-action="close-meld" aria-label="Close">${ICON.close}</button></div>
        <div class="modalbody">
          <div class="meld-modal-cards">${cards}</div>
          ${layBtn ? `<div class="modal-actions">${layBtn}</div>` : ""}
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
    ? `<p class="modal-note">Tap a card to take it and everything above it. Greyed-out cards can\u2019t be taken this turn.</p>`
    : `<p class="modal-note">Oldest first \u2014 the top card is outlined.</p>`;
  return `<div class="modal-back" data-action="close-discard">
      <div class="modal" data-stop="1">
        <div class="modalhead"><span>Discard pile \u00b7 ${n} card${n === 1 ? "" : "s"}</span>
          <button class="iconbtn sm" data-action="close-discard" aria-label="Close">${ICON.close}</button></div>
        <div class="modalbody"><div class="dgrid">${cards}</div></div>
        ${hint}
      </div>
    </div>`;
}

// ---------- actions ----------
// ---------- Hearts (Black Lady) ----------
// Pass direction from the seat offset the server reports (0 = a "hold" hand).
// Across is the seat straight opposite; at 5 players offsets 2 and 3 are two
// seats to the left and two to the right.
const passDir = (offset, players) =>
  offset === 0 ? "hold" : offset === 1 ? "left" : offset === players - 1 ? "right"
  : offset * 2 === players ? "across"
  : offset * 2 < players ? `${PASS_COUNT[offset] ?? offset} to the left` : `${PASS_COUNT[players - offset] ?? players - offset} to the right`;
const PASS_COUNT = ["", "one", "two", "three"];

// The hand a lastHand belongs to: handNo has already moved past it and only
// grows within a game, so two hands that score alike (a repeat moon) differ.
const heartsHandKey = (v) => v.handNo;

function renderHearts(v) {
  // Prune stale pass selections (cards that left the hand after the exchange).
  const handIds = new Set(v.yourHand.map((c) => c.id));
  for (const id of [...S.heartsPass]) if (!handIds.has(id)) S.heartsPass.delete(id);

  if (v.phase === "gameOver") {
    const rows = v.seats.map((s, i) => ({ name: seatName(v, i), score: v.scores[i], win: i === v.winner, you: i === v.you }));
    // The game-ending hand never gets its own result screen, so show what it
    // scored (and a moon shot) above the totals.
    const lh = v.lastHand;
    const last = lh
      ? resultCard("Last hand", `${lh.shooter != null ? `<p class="result-note">${esc(seatName(v, lh.shooter))} shot the moon!</p>` : ""}${
          scoreList(v.seats.map((s, i) => ({ name: seatName(v, i), score: `${lh.delta[i] > 0 ? "+" : ""}${lh.delta[i]}`, you: i === v.you })), { lowWins: true })}`)
      : "";
    // Lowest score wins, so the title still points at v.winner (server picks the min).
    return renderGameOver(v, v.winner == null ? "Game over" : `${seatName(v, v.winner)} wins!`, scoreList(rows, { lowWins: true }), { sub: "Lowest score wins.", last });
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
            avatar: true,
            extraClass: "hearts-pod",
            cardCount: v.handCounts[i],
            pts: v.scores[i],
            note: passing ? null : i === v.toAct ? "to play" : v.points[i] ? `+${v.points[i]} this hand` : null,
          }) },
    )
    .filter(Boolean);

  // Center: passing prompt, or the crests + the trick (kept showing the last
  // completed trick for a beat once it's swept, so each card is visible).
  let center, heartsTrick;
  if (passing) {
    const dir = passDir(v.passOffset, v.players);
    center = `<div class="crestrow">
        <span class="crest">Hand <b>${v.handNo + 1}</b></span>
        <span class="crest">Passing <b>${dir}</b></span>
      </div>
      ${v.youPassed ? `<div class="callout">Your cards are away \u2014 waiting for the table.</div>` : ""}`;
  } else {
    const crests = `<div class="crestrow"><span class="crest">Hand <b>${v.handNo + 1}</b></span></div>`;
    if (v.phase === "trickComplete") {
      // Trick-gate: show the completed trick with a tap-to-continue overlay.
      const trickPlays = v.currentTrick.map((p) => ({ ...p, name: seatName(v, p.seat) }));
      const winName = v.trickWinner != null ? esc(seatName(v, v.trickWinner)) : null;
      const trickEl = trickHTML(trickPlays, v.you, v.seats.length, { mini: false, winSeat: v.trickWinner });
      // A spectator can't advance the gate: no tap target, no "Tap to continue".
      const hint = [winName ? `<b>${winName}</b> takes it` : "", v.you != null ? "Tap to continue" : ""].filter(Boolean).join(" · ");
      heartsTrick = `<div class="trick-gate${v.you != null ? "" : " view-only"}"${v.you != null ? ` data-action="advance-trick"` : ""}>${trickEl}`
        + (hint ? `<div class="trick-gate-hint">${hint}</div>` : "") + `</div>`;
      center = crests;
    } else {
      const showLast = v.currentTrick.length === 0 && v.lastTrick;
      const winSeat = showLast ? v.lastTrick.winner : null;

      // Collecting animation: detect when a new trick is collected and briefly
      // show the scatter→fan animation before settling on the static last-trick fan.
      if (showLast) {
        const ltKey = `${v.handNo}:${v.lastTrick.winner}:${v.lastTrick.cards.map(p => p.card.id ?? p.card.rank + p.card.suit).join(",")}`;
        if (ltKey !== S.heartsLastTrickKey) {
          S.heartsLastTrickKey = ltKey;
          const collectPlays = v.lastTrick.cards.map((p) => ({ ...p, name: seatName(v, p.seat) }));
          S.heartsCollecting = { plays: collectPlays, winSeat: v.lastTrick.winner, ts: Date.now() };
          setTimeout(() => { S.heartsCollecting = null; render(); }, 500);
        }
      } else {
        S.heartsCollecting = null;
      }

      if (v.currentTrick.length) {
        const plays = v.currentTrick.map((p) => ({ ...p, name: seatName(v, p.seat) }));
        heartsTrick = trickHTML(plays, v.you, v.seats.length, { mini: false });
      } else if (S.heartsCollecting) {
        // Show scatter→fan collecting animation for ~500ms after trick is collected.
        heartsTrick = trickHTML(S.heartsCollecting.plays, v.you, v.seats.length,
          { mini: false, collecting: true, winSeat: S.heartsCollecting.winSeat });
      } else if (showLast && !S.heartsLastTrickOpen) {
        // Collapsed last-trick fan.
        const ltCards = v.lastTrick.cards.map((p) => p.card);
        const total = ltCards.length;
        const fanCards = v.lastTrick.cards.map((p, i) => {
          const angle = total <= 1 ? 0 : ((i / (total - 1)) - 0.5) * 40;
          const isWin = p.seat === winSeat;
          return `<div class="lt-fan-card" style="--fan-angle:${angle}deg;--fan-i:${i};z-index:${isWin ? total + 1 : i}">${cardHTML(p.card, { win: isWin })}</div>`;
        }).join("");
        heartsTrick = `<div class="lasttrick" data-action="toggle-last-trick"><div class="lt-fan">${fanCards}</div><div class="lt-label">Last trick \u00b7 ${esc(seatName(v, v.lastTrick.winner))} \u25be</div></div>`;
      } else if (showLast && S.heartsLastTrickOpen) {
        const expanded = fanHand(v.lastTrick.cards.map(p => p.card), () => ({}), { cls: "lt-expanded-fan", cardW: 60, avail: 340 });
        heartsTrick = `<div class="lasttrick open" data-action="toggle-last-trick"><div class="lt-label">Last trick \u00b7 ${esc(seatName(v, v.lastTrick.winner))} \u25b4</div>${expanded}</div>`;
      }
      const note = showLast
        ? ""
        : !v.currentTrick.length ? `<div class="callout">Lead a card to open the trick.</div>` : "";
      center = `${crests}${note}`;
    }
  }

  // Reconcile hearts sort order with live hand: a new deal, the pass exchange or
  // a reload brings several unseen cards at once, so the whole hand is sorted
  // afresh (the cards a pass brought in are flagged in onFrame).
  { const ids = v.yourHand.map((c) => c.id);
    const knownIds = new Set(S.heartsOrder);
    const newCards = ids.filter((id) => !knownIds.has(id));
    if (newCards.length > 1) {
      const suitOrder = { S: 0, H: 1, C: 2, D: 3 };
      S.heartsOrder = [...v.yourHand].sort((a, b) => (suitOrder[a.suit] - suitOrder[b.suit]) || (a.rank - b.rank)).map((c) => c.id);
    } else {
      S.heartsOrder = S.heartsOrder.filter((id) => ids.includes(id));
      for (const id of ids) if (!S.heartsOrder.includes(id)) S.heartsOrder.push(id);
    }
  }
  // Once the first card of the trick is played, received-cards preview is no longer needed.
  if (v.currentTrick?.length > 0 && S.heartsReceivedCards.length > 0) {
    S.heartsReceivedCards = [];
    if (S.heartsReceivedTimer) { clearTimeout(S.heartsReceivedTimer); S.heartsReceivedTimer = null; }
  }
  const heartsHand = S.heartsOrder.map((id) => v.yourHand.find((c) => c.id === id)).filter(Boolean);

  // Hand: cards chosen to pass lift in place; cards just received glow for a
  // few seconds after the exchange — still playable, since the leader may have
  // been passed the lowest club.
  const receivedSet = new Set(S.heartsReceivedCards);
  const playOpts = (c) => {
    const can = plays.has(c.id);
    return { action: can ? "play-hearts" : "", id: c.id, playable: can, dim: plays.size > 0 && !can, fresh: receivedSet.has(c.id) };
  };
  let hand;
  if (passing && !v.youPassed) {
    const full = S.heartsPass.size >= 3;
    hand = fanHand(heartsHand, (c) => {
      const sel = S.heartsPass.has(c.id);
      return { action: full && !sel ? "" : "toggle-pass", id: c.id, sel, playable: !full || sel, dim: full && !sel };
    });
  } else {
    hand = fanHand(heartsHand, (c) => (passing ? { id: c.id, dim: true } : playOpts(c)));
  }

  // Actions.
  const acts = [];
  if (passing && !v.youPassed) {
    const n = S.heartsPass.size;
    const dir = passDir(v.passOffset, v.players);
    acts.push(`<button class="btn" data-action="pass-3" ${v.yourTurn && n === 3 ? "" : "disabled"}>Pass ${dir}${n && n < 3 ? ` (${n}/3)` : ""}</button>`);
    if (n) acts.push(`<button class="btn ghost sm" data-action="clear-pass">Clear</button>`);
    acts.push(`<span class="hint">${n === 3 ? (v.yourTurn ? "Ready — tap a lifted card to swap it out." : "Ready — you’ll confirm on your turn.") : `Choose ${3 - n} more card${3 - n === 1 ? "" : "s"} to pass ${dir}.`}</span>`);
  } else if (passing) {
    acts.push(`<span class="hint">Passed — waiting for the others.</span>`);
  } else if (v.you != null) {
    const cue = v.yourTurn ? "Tap a highlighted card to play it."
      : v.phase === "trickComplete" ? "Tap the trick to continue." : "";
    if (cue) acts.push(`<span class="hint">${cue}</span>`);
  }

  const you = v.you;
  const selfMeta = (you != null ? `Score <b>${v.scores[you]}</b> · to ${v.target}, low wins` : `play to ${v.target} · low wins`)
    + (v.tiebreak ? " · tiebreak hand" : "");
  // Nobody is to act during the trick gate (toAct is null): name the trick's winner.
  const selfTurn = v.yourTurn
    ? `<span class="turnflag">${passing ? "Your pass" : "Your turn"}</span>`
    : v.toAct != null
    ? `<span class="waitflag"><span>${esc(seatName(v, v.toAct))}${passing ? " is passing" : "’s turn"}</span></span>`
    : v.phase === "trickComplete" && v.trickWinner != null
    ? `<span class="waitflag"><span>Trick to ${esc(seatName(v, v.trickWinner))}</span></span>`
    : "";

  const ledSuit = (v.currentTrick?.length && !passing)
    ? v.currentTrick[0].card?.suit
    : null;
  const heartsFeltOverlay = ledSuit
    ? `<span class="trump-watermark ${RED.has(ledSuit) ? "red" : ""}">${SUIT[ledSuit]}</span>`
    : `<span class="trump-watermark hearts-unbroken">♥</span>`;
  const heartsCornerSuits = ['tl','tr','br','bl'].map((pos) =>
    `<span class="felt-corner-suit ${v.heartsBroken ? 'broken' : ''} ${pos}">♥</span>`
  ).join("");

  // End-of-hand result modal (Hearts).
  const heartsHandModal = (() => {
    const lh = v.lastHand;
    if (!lh || v.phase === "gameOver") return "";
    const handKey = heartsHandKey(v);
    if (S.heartsHandAcked === handKey) return "";
    if (S.heartsHandTimer == null) {
      S.heartsHandTimer = setTimeout(() => {
        S.heartsHandAcked = handKey;
        S.heartsHandTimer = null;
        render();
      }, 30000);
    }
    const { delta, shooter } = lh;
    const moonSeat = shooter;
    const headline = (moonSeat != null
      ? `<div class="hlj-result-verdict made">${esc(seatName(v, moonSeat))} shot the moon!</div>`
      : "")
      // Target reached but the low score is shared: the engine plays on.
      + (v.tiebreak ? `<div class="hlj-result-bidline">Tied for low at ${Math.min(...v.scores)} \u2014 playing another hand</div>` : "");
    const scoreRows = v.seats.map((_, i) => {
      const d = delta[i];
      const total = v.scores[i];
      const sign = d > 0 ? "+" : "";
      const isMoon = i === moonSeat;
      return `<div class="hlj-rr-scorerow${isMoon ? " made" : ""}">
        <span class="hlj-rr-scoreteam">${esc(seatName(v, i))}${i === v.you ? " (you)" : ""}</span>
        <span class="hlj-rr-scoredelta${d === 0 && moonSeat != null && i === moonSeat ? " made" : d > 0 ? " set" : ""}">${sign}${d}</span>
        <span class="hlj-rr-scoretotal">${total} pts</span>
      </div>`;
    }).join("");
    return `<div class="hlj-result-page">
      <div class="hlj-result-felt">
        <div class="hlj-result-scroll">
          <div class="hlj-result-headline">
            <div class="hlj-result-handover">Hand over</div>
            ${headline}
          </div>
          <div class="hlj-result-card hlj-result-scores">
            <div class="hlj-rr-seclabel">Score — play to ${v.target}, low wins</div>
            ${scoreRows}
          </div>
          <button class="btn hlj-result-next-btn" data-action="hearts-ack-hand">Next hand \u2192</button>
        </div>
      </div>
    </div>`;
  })();

  if (heartsHandModal !== "") {
    app.__set = heartsHandModal;
    return;
  }

  app.__set = tableShell(v, { pods, center, trick: heartsTrick, feltOverlay: heartsFeltOverlay, cornerSuits: heartsCornerSuits, hand, actions: acts.join(""), selfMeta, selfTurn });
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
      { name: `Team A \u00b7 seats ${seatsOf(0)}`, team: "A", score: `${tally(0)}/${perTeam}`, win: v.winner === 0, you: v.you != null && v.you % 2 === 0 },
      { name: `Team B \u00b7 seats ${seatsOf(1)}`, team: "B", score: `${tally(1)}/${perTeam}`, win: v.winner === 1, you: v.you != null && v.you % 2 === 1 },
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
  // The board scales to whatever space the felt has (see .g-pegs-and-jokers in styles).
  const center = `<div class="pjwrap">${pjBoardSVG(v, glow)}</div>`;

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
  const selfTeam = v.you != null ? (v.you % 2 === 0 ? "A" : "B") : null;
  const selfMeta = v.you != null ? `${homeMine}/${perTeam} home \u00b7 first team all-home wins` : `first team all-home wins`;
  const playingPartner = yours && v.playingFor.length && v.playingFor[0] !== v.you;
  const selfTurn = yours
    ? `<span class="turnflag">Your turn${playingPartner ? " \u2014 playing teammate" : ""}</span>`
    : v.toAct != null
    ? `<span class="waitflag"><span>${esc(seatName(v, v.toAct))}\u2019s turn</span></span>`
    : "";

  app.__set = tableShell(v, { pods, center, centerFull: true, hand, actions: acts.join(""), selfMeta, selfTeam, selfTurn });
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
  S.joinedOnline = false;
  S.retryMs = 0;
  history.replaceState(null, "", `/?game=${game}&room=${encodeURIComponent(room)}`);
  connect();
}

function shareLink() {
  const link = `${location.origin}/?game=${S.party}&room=${encodeURIComponent(S.room)}`;
  const game = GAMES[S.party]?.label ?? "Bonhomme";
  if (navigator.share) {
    navigator.share({ title: game, text: `Join my ${game} game!`, url: link }).catch(() => {});
  } else {
    navigator.clipboard?.writeText(link).then(() => toast("Link copied."), () => toast(link));
  }
}

function doLeave() {
  window.Tutorial?.stop();
  S.intentionalClose = true;
  if (!S.offline) send({ t: "leave" });
  try { S.ws?.close(); } catch {}
  S.ws = null;
  clearTimeout(S.retryTimer);
  S.retryTimer = null;
  S.retryMs = 0;
  S.joinedOnline = false;
  S.connectSlow = false;
  S.view = null;
  S.connected = false;
  S.party = null;
  S.offline = false;
  S.tutorial = false;
  S.hotseat = false;
  S.hotseats = {};
  S.revealedSeat = null;
  resetGameUi();
  history.replaceState(null, "", "/");
  renderStart();
}

// The FULL lobby config, read from the authoritative view (never the DOM), with
// `over` on top. Every setConfig and start goes through here, so changing one
// option can't silently reset the others.
function lobbyConfig(v, over = {}) {
  const players = over.players ?? v.players;
  if (S.party === "pegs-and-jokers") return { players, marbles: v.marbles, ...over };
  const c = { players, target: v.target ?? GAMES[S.party].target };
  if (S.party === "high-low-jack") c.bestOf = Math.max(1, (v.winsNeeded ?? 1) * 2 - 1);
  if (S.party === "rummy500") {
    c.requireDiscard = !!v.requireDiscard;
    c.botDifficulty = Array.from({ length: players }, (_, i) => v.botDifficulty?.[i] ?? 2);
  }
  return { ...c, ...over };
}

function doStart() {
  const v = S.view;
  if (!v) return;
  const config = lobbyConfig(v);
  const hasHotseats = Object.keys(S.hotseats).length > 0;
  const remoteHumans = S.offline ? 0 : v.seats.filter((s, i) => s.kind === "human" && i !== v.you).length;
  // Pass & play runs on this device, so it can't take online players along.
  if (hasHotseats && remoteHumans > 0) {
    return toast("Pass & Play can't include online players — clear the reserved seats first.");
  }
  resetGameUi();
  if (S.offline) {
    // Already local: seat the new pass-and-play guests in this room (it keeps
    // the last game's guests and is already sized to the table), then deal.
    S.revealedSeat = v.you;
    for (const [seat, name] of Object.entries(S.hotseats)) send({ t: "addHuman", seat: +seat, name });
    S.hotseats = {};
    return send({ t: "start", config });
  }
  if (remoteHumans === 0) {
    // Solo vs bots or pass & play from an online lobby: the deal runs in a
    // LocalRoom on this device. Give the seat back and point the URL away from
    // the room first, so neither the server nor a reload is left holding it.
    send({ t: "leave" });
    S.intentionalClose = true;
    try { S.ws?.close(); } catch {}
    S.ws = null;
    S.joinedOnline = false;
    S.connected = false;
    S.view = null;
    S.revealedSeat = 0; // the hand-off seats this device at 0
    history.replaceState(null, "", `/?game=${S.party}`);
    return connectLocal({ seats: v.seats, you: v.you, config, start: true });
  }
  send({ t: "start", config });
}

// Lobby rename: update this device's name and the seat everyone sees (a repeat
// join for our pid renames the seat, on the server and in a LocalRoom alike).
function renameFrom(inp) {
  const newName = inp ? inp.value.trim().slice(0, 24) : "";
  if (!newName) return;
  const changed = newName !== S.name;
  S.name = newName;
  localStorage.setItem("cg_name", newName);
  inp.blur();
  // Re-joining with the same pid renames your seat for everyone.
  send({ t: "join", pid: S.pid, name: newName });
  if (changed) toast("Name updated.");
  render();
}

function toggleSel(id) {
  if (S.rummySel.has(id)) S.rummySel.delete(id);
  else S.rummySel.add(id);
  render();
}
// Meld / lay off / discard keep the selection until the server answers: the
// next view drops the played cards from it, and a rejected move leaves it on
// screen, intact, beside the error. A lay-off target is used up either way.
function doMeld() {
  const cards = [...S.rummySel];
  if (cards.length < 3) return toast("Select at least 3 cards to meld.");
  sendOnce({ t: "move", move: { type: "meld", seat: S.view.you, cards } });
  S.rummyLayoff = null;
  render();
}
function doLayoff() {
  if (S.rummyLayoff === null) return toast("Tap a meld and choose “Lay off here”.");
  const cards = [...S.rummySel];
  if (!cards.length) return toast("Select cards to lay off.");
  sendOnce({ t: "move", move: { type: "layoff", seat: S.view.you, meldId: S.rummyLayoff, cards } });
  S.rummyLayoff = null;
  render();
}
function doDiscard() {
  if (S.rummySel.size !== 1) return toast("Select exactly one card to discard.");
  const cardId = [...S.rummySel][0];
  sendOnce({ t: "move", move: { type: "discard", seat: S.view.you, cardId } });
  S.rummyLayoff = null;
  render();
}

// ---------- delegated events ----------
app.addEventListener("click", (e) => {
  // Suppress the click that fires after a completed drag-to-play gesture.
  if (DPT.suppress) { DPT.suppress = false; return; }
  const t = e.target.closest("[data-action]");
  if (!t) return;
  // clicks inside the modal shouldn't fall through to the backdrop's close
  if (t.classList.contains("modal-back") && e.target.closest("[data-stop]")) return;
  const v = S.view;
  switch (t.dataset.action) {
    case "open-discard": S.discardOpen = true; return render();
    case "close-discard": S.discardOpen = false; return render();
    case "sort-toggle": { const m = S.rummySort === "suit" ? "rank" : "suit"; S.rummySort = m; return rummySort(v.yourHand, m); }
    case "sort-hearts": { const suitOrder = { S: 0, H: 1, C: 2, D: 3 }; S.heartsOrder = [...v.yourHand].sort((a, b) => (suitOrder[a.suit] - suitOrder[b.suit]) || (a.rank - b.rank)).map((c) => c.id); return render(); }
    case "pick-game": {
      // keep anything typed so far — the re-render resets fields to S.*
      const nm = document.getElementById("f-name"), rm = document.getElementById("f-room");
      if (nm) S.name = nm.value;
      if (rm) S.room = rm.value.trim() || null;
      S.pickGame = t.dataset.game;
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
    case "open-melds-log": S.showLog = true; S.logTab = "melds"; return render();
    case "log-tab": S.logTab = t.dataset.tab; return render();
    case "expand-log": { const eid = +t.dataset.entryid; S.logExpandedId = S.logExpandedId === eid ? null : eid; return render(); }
    case "connect": return doConnect();
    case "share-link": return shareLink();
    case "leave": {
      // Mid-game, confirm first: leaving hands your seat to a bot (or ends a solo game).
      const live = v && S.connected && v.phase !== "lobby" && v.phase !== "gameOver";
      if (live && !S.confirmLeave) { S.confirmLeave = true; return render(); }
      return doLeave();
    }
    case "leave-confirm": return doLeave();
    case "leave-cancel": S.confirmLeave = false; return render();
    case "play-offline": return doPlayOffline();
    case "sit": return send({ t: "sit", seat: +t.dataset.seat });
    case "addbot": return send({ t: "addBot", seat: +t.dataset.seat });
    case "set-bot-difficulty": return; // applied on "change" (see below); a click just opens the picker
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
    case "lby-rename": return renameFrom(t.closest(".lby-name-row")?.querySelector("input"));
    case "open-lby-settings": S.lbySettingsOpen = true; return render();
    case "close-lby-settings": S.lbySettingsOpen = false; return render();
    case "lby-set-bestof": return send({ t: "setConfig", config: lobbyConfig(v, { bestOf: +t.dataset.n }) });
    case "toggle-bot-replacement": return send({ t: "setBotReplacement", enabled: t.checked });
    case "toggle-tutorial": S.tutorial = !S.tutorial; return render();
    case "replace-seat": return send({ t: "replaceSeat", seat: +t.dataset.seat });
    case "toggle-last-trick": if (S.party === "hearts") S.heartsLastTrickOpen = !S.heartsLastTrickOpen; else S.hljLastTrickOpen = !S.hljLastTrickOpen; return render();
    case "advance-trick": return sendOnce({ t: "advance" });
    case "reveal-hand": {
      // Reveal only the seat the frame on screen belongs to; if it moved on,
      // re-target the hand-off screen to that seat instead.
      if (!v || v.you !== S.passTo) { maybePromptPass(); return render(); }
      S.revealedSeat = S.passTo;
      S.awaitingPass = false;
      render();
      return maybeAutoPlay(v);
    }
    case "setcount": return send({ t: "setConfig", config: lobbyConfig(v, { players: +t.dataset.count }) });
    case "rummy-toggle-discard": return send({ t: "setConfig", config: lobbyConfig(v, { requireDiscard: !v.requireDiscard }) });
    case "start": return doStart();
    case "newgame": {
      S.revealedSeat = null;
      S.awaitingPass = false;
      resetGameUi();
      // Offline the game can end on a pass-and-play guest's seat, but the next
      // lobby is the host's: rebuild it from the host's seat (guests kept, bots
      // back to open seats, same settings) rather than one nobody can deal.
      if (S.offline && v && v.hostSeat != null && v.you !== v.hostSeat) {
        const seats = v.seats.map((s) => (s.kind === "bot" ? { kind: "empty", name: null } : s));
        try { S.ws?.close(); } catch {}
        S.connected = false;
        S.view = null;
        return connectLocal({ seats, you: v.hostSeat, config: lobbyConfig(v), start: false });
      }
      return send({ t: "newGame" });
    }
    case "move-bid": {
      const amt = +t.dataset.amount;
      // Open confidence window if a teammate still has a turn; bots wait server-side.
      return sendOnce({ t: "move", move: { type: "bid", seat: v.you, amount: amt } });
    }
    case "hlj-bid-confirm": {
      const amt = +(document.getElementById("hlj-bid-slider")?.value ?? 2);
      return sendOnce({ t: "move", move: { type: "bid", seat: v.you, amount: amt } });
    }
    case "move-pass": return sendOnce({ t: "move", move: { type: "pass", seat: v.you } });

    case "signal":
      return send({ t: "aux", payload: t.dataset.level });
    case "play-card": {
      const c = v.yourHand.find((x) => cardKey(x) === t.dataset.key);
      if (c) sendOnce({ t: "move", move: { type: "play", seat: v.you, card: c } });
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
      return render();
    }
    case "hearts-ack-hand": {
      if (S.view?.lastHand) S.heartsHandAcked = heartsHandKey(S.view);
      if (S.heartsHandTimer) { clearTimeout(S.heartsHandTimer); S.heartsHandTimer = null; }
      return render();
    }
    case "hlj-show-dealt-hands": S.hljShowDealtHands = true; return render();
    case "hlj-close-dealt-hands": S.hljShowDealtHands = false; return render();
    case "ack-round":
      if (v) S.rummyRoundAcked = rummyRoundKey(v);
      return render();
    case "advance-round":
      if (v) S.rummyRoundAcked = rummyRoundKey(v);
      return sendOnce({ t: "advance" });
    case "dismiss-drawn":
      clearDrawn();
      return render();
    case "open-meld": {
      const meldId = +t.dataset.meldid;
      const selNow = [...S.rummySel].map((id) => v.yourHand.find((c) => c.id === id)).filter(Boolean);
      const meldTarget = v.melds.find((m) => m.id === meldId);
      // In your play phase, cards already selected that this meld accepts are laid
      // off at once; otherwise (planning off-turn, or before drawing) it just opens.
      if (v.yourTurn && v.turnPhase === "play" && selNow.length >= 1 && S.rummyLayoff === null && meldTarget
          && rCanLayoff(meldTarget, selNow) && rKeepsDiscard(v, selNow)) {
        if (rStrandsForced(v, selNow, meldTarget)) toast(R_STRANDS);
        else {
          S.rummyLayoff = meldId;
          return doLayoff();
        }
      }
      S.rummyMeldOpen = meldId;
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
    case "play-hearts": return sendOnce({ t: "move", move: { type: "play", seat: v.you, card: +t.dataset.cardid } });
    case "pj-setplayers": return send({ t: "setConfig", config: lobbyConfig(v, { players: +t.dataset.count }) });
    case "pj-setmarbles": return send({ t: "setConfig", config: lobbyConfig(v, { marbles: +t.dataset.m }) });
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
// With a mouse this native drag also replaces the pointer drag-to-play below,
// so a drop on the discard pile or a meld plays the card the same way.
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
  const id = S.dragId, before = S.dropBeforeId;
  S.dragId = null;
  S.dropBeforeId = null;
  const at = e?.type === "drop" && e.target.closest ? e.target : null;
  const zone = at && S.party === "rummy500" ? rummyDropZoneAt(e.clientX, e.clientY) : null;
  if (zone) {
    DPT.game = "rummy";
    DPT.cid = id;
    dptExecute(zone);
  } else if (at && at.closest(".hand")) {
    // Reorder only on a drop inside the hand; released anywhere else, nothing moves.
    const ids = S.rummyOrder.filter((x) => x !== id);
    const idx = before == null ? ids.length : ids.indexOf(before);
    ids.splice(idx < 0 ? ids.length : idx, 0, id);
    S.rummyOrder = ids;
  }
  render();
}
app.addEventListener("drop", endDrag);
app.addEventListener("dragend", endDrag);

// ---------- drag-to-play (pointer events — touch + mouse) ----------
// A ghost card follows the pointer; releasing over a valid drop zone sends the move.
// Separate from the native-drag hand-reorder system above.
const DPT = {
  ptId: null,     // tracked pointerId (null = no active gesture)
  game: null,     // "hlj" | "hearts" | "rummy"
  ckey: null,     // HLJ: cardKey string
  cid: null,      // Hearts / Rummy: card id (int)
  cardEl: null,   // source card element
  ghost: null,    // floating clone element
  ox: 0, oy: 0,  // pointer-start coords (for threshold check)
  started: false, // drag threshold (10 px) crossed?
  suppress: false,// absorb the click that follows touch-pointerup
  // Hearts-specific: direction not yet committed — don't block scroll yet
  _hPending: null, // { ptId, card, cid, ox, oy }
};

app.addEventListener("pointerdown", (e) => {
  if (DPT.ptId !== null || DPT._hPending) return; // already tracking
  const card = e.target.closest(".card[data-action]");
  if (!card) return;
  const a = card.dataset.action;
  if (a === "play-hearts") {
    // Don't claim the pointer yet — wait for direction detection so the
    // {passive:false} global pointermove doesn't block horizontal scroll.
    DPT._hPending = { ptId: e.pointerId, card, cid: +card.dataset.cardid, ox: e.clientX, oy: e.clientY };
    return;
  }
  if      (a === "play-card")   { DPT.game = "hlj";   DPT.ckey = card.dataset.key; DPT.cid = null; }
  else if (a === "toggle-card") { DPT.game = "rummy";  DPT.cid = +card.dataset.cardid; DPT.ckey = null; }
  else return;
  DPT.ptId    = e.pointerId;
  DPT.cardEl  = card;
  DPT.ox      = e.clientX;
  DPT.oy      = e.clientY;
  DPT.started = false;
  DPT.ghost   = null;
  // Let native drag (Rummy hand reorder) cancel our gesture cleanly.
  card.addEventListener("dragstart", () => { DPT.ptId = null; DPT.started = false; }, { once: true });
});

document.addEventListener("pointermove", (e) => {
  if (e.pointerId !== DPT.ptId) return;
  if (!DPT.started) {
    const dx = Math.abs(e.clientX - DPT.ox);
    const dy = Math.abs(e.clientY - DPT.oy);
    if (Math.hypot(dx, dy) < 10) return;
    // Primarily horizontal → let the browser handle it as a scroll gesture
    if (dx > dy) { DPT.ptId = null; DPT.started = false; return; }
    DPT.started = true;
    const r = DPT.cardEl.getBoundingClientRect();
    const g = DPT.cardEl.cloneNode(true);
    Object.assign(g.style, {
      position: "fixed", zIndex: "9999", pointerEvents: "none",
      opacity: "0.85", transform: "scale(1.1) rotate(-4deg)",
      width: r.width + "px", height: r.height + "px",
      left: r.left + "px", top: r.top + "px", transition: "none",
    });
    g._ox = e.clientX - r.left;
    g._oy = e.clientY - r.top;
    document.body.appendChild(g);
    DPT.ghost = g;
    dptHighlight(true);
  }
  e.preventDefault();
  if (DPT.ghost) {
    DPT.ghost.style.left = (e.clientX - DPT.ghost._ox) + "px";
    DPT.ghost.style.top  = (e.clientY - DPT.ghost._oy) + "px";
  }
}, { passive: false });

// Passive direction-detection for Hearts cards: lets horizontal swipes reach
// the .fan-scroll container natively; only claims the pointer for vertical drags.
document.addEventListener("pointermove", (e) => {
  if (!DPT._hPending || e.pointerId !== DPT._hPending.ptId) return;
  const { card, cid, ox, oy } = DPT._hPending;
  const dx = Math.abs(e.clientX - ox);
  const dy = Math.abs(e.clientY - oy);
  if (Math.hypot(dx, dy) < 10) return; // wait for intentional movement
  DPT._hPending = null;
  if (dx >= dy) return; // horizontal → browser handles scroll, we're done
  // Vertical drag: claim the pointer so the browser cancels any pending scroll
  try { card.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
  DPT.game    = "hearts";
  DPT.cid     = cid;
  DPT.ckey    = null;
  DPT.ptId    = e.pointerId;
  DPT.cardEl  = card;
  DPT.ox      = ox;
  DPT.oy      = oy;
  DPT.started = false;
  DPT.ghost   = null;
}, { passive: true });

// The Rummy drop zone (discard pile or a meld) under a point. On phones the
// hand's transparent scroll box overlaps the bottom of the felt, so look
// beneath it — but never through a card.
function rummyDropZoneAt(x, y) {
  const hit = document.elementsFromPoint(x, y).find((el) => el.closest(".card, .discardstack, [data-meldid]"));
  return hit && hit.closest(".discardstack, [data-meldid]") ? hit : null;
}

function dptEnd(e) {
  // Also cancel any pending Hearts direction-detection
  if (DPT._hPending && e.pointerId === DPT._hPending.ptId) DPT._hPending = null;
  if (e.pointerId !== DPT.ptId) return;
  DPT.ptId = null;
  dptHighlight(false);
  if (DPT.ghost) DPT.ghost.style.display = "none"; // hide so elementFromPoint sees beneath it
  const target = !DPT.started ? null
    : (DPT.game === "rummy" && rummyDropZoneAt(e.clientX, e.clientY)) || document.elementFromPoint(e.clientX, e.clientY);
  if (DPT.ghost) { DPT.ghost.remove(); DPT.ghost = null; }
  if (DPT.started) {
    DPT.suppress = true;
    setTimeout(() => { DPT.suppress = false; }, 300);
    dptExecute(target);
  }
  DPT.started = false;
}
document.addEventListener("pointerup",     dptEnd);
document.addEventListener("pointercancel", (e) => {
  if (e.pointerId !== DPT.ptId) return;
  DPT.ptId = null; DPT.started = false;
  dptHighlight(false);
  if (DPT.ghost) { DPT.ghost.remove(); DPT.ghost = null; }
});

function dptHighlight(on) {
  if (DPT.game === "hlj" || DPT.game === "hearts") {
    document.querySelectorAll(".felt").forEach((el) => el.classList.toggle("dpt-target", on));
  } else if (DPT.game === "rummy") {
    document.querySelectorAll(".discardstack, .meld").forEach((el) => el.classList.toggle("dpt-target", on));
  }
}

function dptExecute(target) {
  const v = S.view;
  if (!v || !target) return;
  if (DPT.game === "hlj") {
    // Drop anywhere on the center felt plays the card.
    if (target.closest(".felt-frame")) {
      const c = v.yourHand.find((x) => cardKey(x) === DPT.ckey);
      if (c) sendOnce({ t: "move", move: { type: "play", seat: v.you, card: c } });
    }
  } else if (DPT.game === "hearts") {
    if (target.closest(".felt-frame")) {
      sendOnce({ t: "move", move: { type: "play", seat: v.you, card: DPT.cid } });
    }
  } else if (DPT.game === "rummy") {
    if (!v.yourTurn || v.turnPhase !== "play") return;
    // Drop on a meld → lay off.
    const meldEl = target.closest("[data-meldid]");
    if (meldEl) {
      const meldId = +meldEl.dataset.meldid;
      const meld   = v.melds.find((m) => m.id === meldId);
      const card   = v.yourHand.find((c) => c.id === DPT.cid);
      if (meld && card && rCanLayoff(meld, [card]) && rKeepsDiscard(v, [card])) {
        if (rStrandsForced(v, [card], meld)) toast(R_STRANDS);
        else sendOnce({ t: "move", move: { type: "layoff", seat: v.you, meldId, cards: [DPT.cid] } });
      } else {
        toast("That card can’t be laid off there.");
      }
      return;
    }
    // Drop on the discard pile → discard.
    if (target.closest(".discardstack")) {
      S.rummyLayoff = null;
      sendOnce({ t: "move", move: { type: "discard", seat: v.you, cardId: DPT.cid } });
    }
  }
}

// Lobby settings that are form fields: keep them in the shared lobby config (so
// re-renders don't lose them), always sent as the full config.
app.addEventListener("change", (e) => {
  const v = S.view;
  if (!v || v.phase !== "lobby") return;
  // the host's "play to" value
  if (e.target.id === "f-target") {
    const target = Number(e.target.value);
    const max = GAMES[S.party].maxTarget;
    if (Number.isInteger(target) && target >= 1 && target <= max) send({ t: "setConfig", config: lobbyConfig(v, { target }) });
    else { e.target.value = v.target ?? ""; toast(`Play to: pick a whole number from 1 to ${max}.`); }
  }
  // Rummy bot level for a seat ("change" is what a native picker fires on iOS)
  if (e.target.matches?.(".difficulty-pick")) {
    const botDifficulty = lobbyConfig(v).botDifficulty;
    botDifficulty[+e.target.dataset.seat] = +e.target.value;
    send({ t: "setConfig", config: lobbyConfig(v, { botDifficulty }) });
  }
});

app.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  if (e.target.classList?.contains("lby-name-input")) { e.preventDefault(); renameFrom(e.target); }
  else if (e.target.id === "f-name" || e.target.id === "f-room") { e.preventDefault(); doConnect(); }
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
  if (game && GAMES[game]) S.pickGame = game;
  if (room) S.room = room;
  // Only a full link (game + room, and a name to join with) goes straight to the
  // table; otherwise the start screen, prefilled — with no party set, so a later
  // re-render can't strand it on "Connecting…" (e.g. /?game=x after a solo deal).
  if (S.pickGame && S.room && S.name) { S.party = S.pickGame; connect(); }
  else renderStart();
}
init();
