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
    return `<div class="${cls.join(" ")}"${st}${action}><img class="joker-img" src="/joker_black.png" alt="Joker">${badge}</div>`;
  }
  if (RED.has(c.suit)) cls.push("red");
  const r = rankLabel(c.rank);
  const s = SUIT[c.suit];
  const corner = `<b>${r}</b><i>${s}</i>`;
  if (o.mini) {
    return `<div class="${cls.join(" ")}"${st} ${a.join(" ")}><span class="corner tl">${corner}</span></div>`;
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
  const backs = Math.min(o.count || 0, 4);
  const mb = Array.from({ length: backs }, () => `<span class="mb"></span>`).join("");
  const isDisconnected = v.disconnectedSeats && v.disconnectedSeats.includes(i);
  const isHost = v.you === v.hostSeat && v.you !== null;
  const replaceBtn = isDisconnected && isHost && !S.offline
    ? `<button class="btn sm danger" data-action="replace-seat" data-seat="${i}">Replace</button>`
    : "";
  const disconnectedBadge = isDisconnected ? `<span class="chip" style="background:var(--danger,#c0392b);color:#fff;font-size:10px">away</span>` : "";
  return `<div class="pod ${o.active ? "active" : ""} ${o.partner ? "partner" : ""} ${o.team ? "t" + o.team : ""} ${isDisconnected ? "disconnected" : ""}">
    ${o.team ? `<span class="teamchip t${o.team}">${o.team}</span>` : ""}
    ${o.dealer ? `<span class="dealer">D</span>` : ""}
    <div class="ministack">${mb}${avatarHTML(name)}</div>
    <div class="pod-info">
      <span class="name">${esc(name)}${disconnectedBadge}</span>
      ${o.pts != null ? `<span class="pts">${o.pts}</span>` : ""}
      <span class="count">${o.count}</span>
    </div>
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
    // If the round result changed (new round ended), reset the ack so the popup shows again.
    const prevKey = prev?.lastRound ? JSON.stringify(prev.scores) : null;
    const newKey  = msg.view?.lastRound ? JSON.stringify(msg.view.scores) : null;
    if (newKey && newKey !== prevKey && newKey !== S.rummyRoundAcked) {
      if (S.rummyRoundTimer) { clearTimeout(S.rummyRoundTimer); S.rummyRoundTimer = null; }
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
  }
  else if (msg.t === "error") { toast(msg.message); }
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
    ${S.offline ? "" : `<button class="btn sm ghost" data-action="copy-link">Share</button>`}
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
    const rows = entries.length
      ? entries.slice(-40).reverse().map((e) => `<div class="logrow">${logEntryHTML(v, e)}</div>`).join("")
      : `<div class="logrow" style="color:var(--ink-dim)">No moves yet.</div>`;
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
      <div class="loghead">${tabs(tab)}<button class="btn sm ghost" data-action="toggle-log">Close</button></div>
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
    // compass layout: distribute opponents around the table
    const n = v.seats.length;
    const you = v.you;
    // Map seat offset (1..n-1) to a CSS position class
    // Layout per player count (opponents = n-1):
    //   2p: [top]
    //   3p: [left, right]
    //   4p: [left, top, right]
    //   5p: [left, tl, tr, right]
    //   6p: [left, tl, tl2, tr2, tr, right]
    //   7p: [left, tl, tl2, top, tr2, tr, right]
    //   8p: same as 7p (max supported)
    const LAYOUTS = {
      1: ["pos-top"],
      2: ["pos-left", "pos-right"],
      3: ["pos-left", "pos-top", "pos-right"],
      4: ["pos-left", "pos-top pos-tl", "pos-top pos-tr", "pos-right"],
      5: ["pos-left", "pos-top pos-tl", "pos-top", "pos-top pos-tr", "pos-right"],
      6: ["pos-left", "pos-top pos-tl", "pos-top pos-tl2", "pos-top pos-tr2", "pos-top pos-tr", "pos-right"],
      7: ["pos-left", "pos-top pos-tl", "pos-top pos-tl2", "pos-top", "pos-top pos-tr2", "pos-top pos-tr", "pos-right"],
    };
    const layout = LAYOUTS[n - 1] || LAYOUTS[7];
    const slots = podItems.length
      ? podItems.map(({ seat, html }, idx) => {
          const cls = layout[idx] || "pos-top";
          return `<div class="pod-slot ${cls}">${html}</div>`;
        }).join("")
      : `<div class="pod-slot pos-top"><div class="callout">Waiting for players to arrive…</div></div>`;
    feltPods = slots;
  }

  let self;
  if (v.you != null) {
    const myName = seatName(v, v.you);
    self = `<div class="hand deal ${parts.hand ? "" : "empty"}">${parts.hand || ""}</div>
      <div class="selfbar">
        ${avatarHTML(myName, { host: v.you === v.hostSeat })}
        <div><div class="name">${esc(myName)}</div><div class="me-pts">${parts.selfMeta || ""}</div></div>
        ${parts.selfTurn || ""}
      </div>
      ${parts.selfExtra ? `<div class="self-extra">${parts.selfExtra}</div>` : ""}
      ${parts.actions !== null ? `<div class="actions">${parts.actions || `<span class="hint">Watching the table…</span>`}</div>` : ""}`;
  } else {
    self = `<div class="selfbar"><div class="name">Spectating</div><div class="me-pts">${parts.selfMeta || ""}</div></div>`;
  }
  return `<div class="table">
    ${appbar(v, { log: true })}
    <div class="felt">
      ${feltPods}
      ${parts.feltOverlay ? `<div class="felt-overlay">${parts.feltOverlay}</div>` : ""}
      <div class="center">${parts.center}</div>
      ${parts.trick || ""}
      ${parts.feltBottom ? `<div class="felt-bottom">${parts.feltBottom}</div>` : ""}
    </div>
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

        <div class="felt-theme-row">${themePickerHTML()}</div>
      </div>
    </div>`;
}
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

  const renderSeat = (s, i) => {
    const you = i === v.you;
    const isEmpty = s.kind === "empty";
    const reserved = !you && isHost && S.hotseats[i];
    const diff = isRummyLobby ? (v.botDifficulty?.[i] ?? 2) : 2;
    const tc = isTeamGame ? (i % 2 === 0 ? "tA" : "tB") : "";

    // Single compact action per seat — no stacked button pairs
    let action = "";
    if (reserved) {
      action = `<button class="lby-act danger" data-action="clear-hotseat" data-seat="${i}">✕</button>`;
    } else if (isEmpty && isHost) {
      action = `<button class="lby-act add" data-action="addbot" data-seat="${i}">+ Bot</button>`;
    } else if (s.kind === "bot" && isHost) {
      const diffPicker = isRummyLobby
        ? `<select class="difficulty-pick" data-action="set-bot-difficulty" data-seat="${i}">${DIFF_LABELS.map((l, d) => `<option value="${d}"${d === diff ? " selected" : ""}>${l}</option>`).join("")}</select>`
        : "";
      action = diffPicker + `<button class="lby-act danger" data-action="removebot" data-seat="${i}">✕</button>`;
    } else if (S.offline && s.kind === "human" && !you) {
      action = `<button class="lby-act danger" data-action="clearseat" data-seat="${i}">✕</button>`;
    }

    const displayName = reserved ? esc(S.hotseats[i]) : isEmpty ? "Open" : esc(s.name || "Player");
    const initials = reserved ? S.hotseats[i].charAt(0).toUpperCase()
      : !isEmpty ? (s.name || "?").charAt(0).toUpperCase()
      : "";
    const avClass = isEmpty ? "empty" : reserved ? "local" : you ? "you" : s.kind === "bot" ? "bot" : "human";
    const avIcon = s.kind === "bot" && !reserved ? "\u265F" : initials;

    let role = isEmpty ? "open" : reserved ? "pass & play" : s.kind === "bot" ? "bot" : you ? "you" : i === v.hostSeat ? "host" : "player";

    return `<div class="lby-seat ${isEmpty ? "empty" : ""} ${you ? "me" : ""} ${tc}">
      <div class="lby-av ${avClass}">${avIcon}</div>
      <div class="lby-seat-info">
        <div class="lby-seat-name">${displayName}</div>
        <div class="lby-seat-role">${role}</div>
      </div>
      ${action ? `<div class="lby-seat-action">${action}</div>` : ""}
    </div>`;
  };

  // For team games: two compact columns. Non-team: single list.
  let seatsHTML;
  if (isTeamGame) {
    const idxA = v.seats.map((_, i) => i).filter(i => i % 2 === 0);
    const idxB = v.seats.map((_, i) => i).filter(i => i % 2 === 1);
    seatsHTML = `<div class="lby-teams">
      <div class="lby-team tA">
        <div class="lby-team-hdr">Team A</div>
        ${idxA.map(i => renderSeat(v.seats[i], i)).join("")}
      </div>
      <div class="lby-team tB">
        <div class="lby-team-hdr">Team B</div>
        ${idxB.map(i => renderSeat(v.seats[i], i)).join("")}
      </div>
    </div>`;
  } else {
    seatsHTML = `<div class="lby-seat-list">${v.seats.map((s, i) => renderSeat(s, i)).join("")}</div>`;
  }

  // Pass & Play — one section-level button, not per-seat
  const emptySeats = v.seats.map((s,i)=>({s,i})).filter(({s,i})=> s.kind==="empty" && i!==v.you);
  const passPlayBtn = isHost && emptySeats.length > 0
    ? `<button class="lby-passplay-btn" data-action="reserve-hotseat" data-seat="${emptySeats[0].i}">+ Add Pass &amp; Play Player</button>`
    : "";
  const hasHotseats = Object.keys(S.hotseats).length > 0;

  // Config controls (host only, compact)
  const cfgControls = isPJ
    ? `<div class="lby-cfg-row"><span class="lby-cfg-label">Players</span>
         <div class="seg">${[4,6].map(c=>`<button class="${c===v.players?"on":""}" data-action="pj-setplayers" data-count="${c}">${c}</button>`).join("")}</div></div>
       <div class="lby-cfg-row"><span class="lby-cfg-label">Marbles</span>
         <div class="seg">${GAMES["pegs-and-jokers"].marbles.map(m=>`<button class="${m===v.marbles?"on":""}" data-action="pj-setmarbles" data-m="${m}">${m}</button>`).join("")}</div></div>`
    : `<div class="lby-cfg-row"><span class="lby-cfg-label">Players</span>
         <div class="seg">${counts.map(c=>`<button class="${c===v.players?"on":""}" data-action="setcount" data-count="${c}">${c}</button>`).join("")}</div></div>
       <div class="lby-cfg-row"><span class="lby-cfg-label">Play to</span>
         <input class="lby-pts" id="f-target" type="number" min="1" value="${v.target ?? GAMES[S.party].target}" /></div>`;

  const botReplacementToggle = !S.offline
    ? `<label class="lby-replace-toggle"><input type="checkbox" data-action="toggle-bot-replacement" ${v.botReplacement?"checked":""} /> Auto-replace disconnects with bots</label>`
    : "";

  let shareRow = "";
  if (S.offline) {
    shareRow = `<p class="lby-mode-note">${hasHotseats ? "Pass &amp; Play \u2014 device shared between turns." : "Offline \u2014 bots on this device."}</p>`;
  } else {
    shareRow = `<div class="lby-share-row">
      <input class="lby-link-input" readonly value="${esc(link)}" onclick="this.select()" />
      <button class="btn sm" data-action="copy-link">Copy link</button>
    </div>`;
  }

  const cfgSection = isHost ? `<div class="lby-cfg">${cfgControls}${botReplacementToggle}</div>` : "";
  const dealBtn = isHost
    ? `<button class="felt-cta" data-action="start">${isPJ ? "Deal &amp; Start" : "Deal the Cards"}</button>`
    : `<p class="lby-waiting">Waiting for the host to deal\u2026</p>`;

  app.__set = `${appbar(v)}
    <div class="lby-wrap">
      <div class="felt-content">
        <div class="lby-title">${esc(GAMES[S.party].label)}</div>
        ${shareRow}
        ${seatsHTML}
        ${passPlayBtn}
        ${cfgSection}
        ${dealBtn}
      </div>
    </div>`;
}


