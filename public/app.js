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
  pickGame: "rummy500", // start-screen selection
  room: null,
  ws: null,
  offline: false, // playing locally vs bots (no server)
  connected: false,
  intentionalClose: false,
  view: null,
  rummySel: new Set(), // selected card ids
  rummyLayoff: null, // selected meld id for layoff
  rummyOrder: [], // display order of your hand (card ids) for sort + drag/drop
  discardOpen: false, // discard-pile popup open?
  dragId: null, // card id being dragged within the hand
  dropBeforeId: null, // drop target (insert before this card id; null = end)
  heartsPass: new Set(), // selected card ids to pass (Hearts)
  pjCard: null, // selected card id (Pegs & Jokers)
  pjMoves: [], // candidate moves currently shown as buttons (Pegs & Jokers)
  showLog: false,
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
    cls.push("red");
    return `<div class="${cls.join(" ")}"${st} ${a.join(" ")}><span class="corner tl"><b>\u2605</b></span><span class="pip">\u2605</span><span class="corner br"><b>\u2605</b></span></div>`;
  }
  if (RED.has(c.suit)) cls.push("red");
  const r = rankLabel(c.rank);
  const s = SUIT[c.suit];
  const corner = `<b>${r}</b><i>${s}</i>`;
  const court = c.rank >= 11 && c.rank <= 13;
  const center = court
    ? `<span class="court">${r}<span style="font-size:.55em;margin-left:1px">${s}</span></span>`
    : `<span class="pip">${s}</span>`;
  return `<div class="${cls.join(" ")}"${st} ${a.join(" ")}><span class="corner tl">${corner}</span>${center}<span class="corner br">${corner}</span></div>`;
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
  return `<div class="pod ${o.active ? "active" : ""} ${o.partner ? "partner" : ""} ${o.team ? "t" + o.team : ""}">
    ${o.team ? `<span class="teamchip t${o.team}">${o.team}</span>` : ""}
    ${o.dealer ? `<span class="dealer">D</span>` : ""}
    <div class="ministack">${mb}</div>
    ${avatarHTML(name)}
    <div class="name">${esc(name)}</div>
    ${o.note ? `<div class="note">${esc(o.note)}</div>` : ""}
    <div class="nums"><span class="count">${o.count}</span>${o.pts != null ? `<span class="pts">${o.pts}</span>` : ""}</div>
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
  const tail = e.tail ? ` ${esc(e.tail)}` : "";
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
  if (msg.t === "view") { S.view = msg.view; render(); }
  else if (msg.t === "error") { toast(msg.message); }
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
    S.connected = false;
    if (S.intentionalClose || S.offline) return;
    if (!opened) return fallback();
    render();
    setTimeout(() => { if (!S.connected && !S.intentionalClose) connect(); }, 1500);
  };
  ws.onerror = () => { if (!opened) fallback(); };
  render();
}

let localMod = null;
async function connectLocal() {
  S.offline = true;
  try {
    if (!localMod) localMod = await import("/local.js");
  } catch (err) {
    return toast("Couldn't load offline mode.");
  }
  const sock = localMod.createLocalSocket(S.party);
  S.ws = sock;
  sock.onopen = joinOnOpen;
  sock.onmessage = onFrame;
  sock.onclose = () => { S.connected = false; };
  render();
}

// ---------- app bar ----------
function appbar(v, opts = {}) {
  return `<div class="appbar">
    <div class="brand"><div class="glyph">P</div><span class="wordmark">${esc(GAMES[S.party].label)}</span></div>
    <div class="spacer"></div>
    ${S.offline ? `<div class="roomtag">offline · vs bots</div>` : `<div class="roomtag">room <b>${esc(S.room)}</b></div>`}
    ${opts.log ? `<button class="btn sm ghost" data-action="toggle-log">Log</button>` : ""}
    ${S.offline ? "" : `<button class="btn sm ghost" data-action="copy-link">Share</button>`}
    <button class="btn sm ghost" data-action="leave">Leave</button>
  </div>`;
}

function logSheet() {
  if (!S.showLog) return "";
  const v = S.view;
  const entries = v && v.log ? v.log : [];
  const rows = entries.length
    ? entries.slice(-40).reverse().map((e) => `<div class="logrow">${logEntryHTML(v, e)}</div>`).join("")
    : `<div class="logrow" style="color:var(--ink-dim)">No moves yet — they'll appear here as the hand plays out.</div>`;
  return `<div class="logsheet">
      <div class="loghead"><span>Move log</span><button class="btn sm ghost" data-action="toggle-log">Close</button></div>
      <div class="loglist">${rows}</div>
    </div>`;
}

// shared table frame: pods on the top rail, center play area, your rail at the bottom
function tableShell(v, parts) {
  const railPods = parts.pods.join("") || `<div class="callout">Waiting for players to arrive…</div>`;
  let self;
  if (v.you != null) {
    const myName = seatName(v, v.you);
    self = `<div class="selfbar">
        ${avatarHTML(myName, { host: v.you === v.hostSeat })}
        <div><div class="name">${esc(myName)}</div><div class="me-pts">${parts.selfMeta || ""}</div></div>
        ${parts.selfTurn || ""}
      </div>
      <div class="hand deal ${parts.hand ? "" : "empty"}">${parts.hand || ""}</div>
      <div class="actions">${parts.actions || `<span class="hint">Watching the table…</span>`}</div>`;
  } else {
    self = `<div class="selfbar"><div class="name">Spectating</div><div class="me-pts">${parts.selfMeta || ""}</div></div>`;
  }
  return `${appbar(v, { log: true })}<div class="table">
    <div class="rail top deal">${railPods}</div>
    <div class="center">${parts.center}</div>
    <div class="selfwrap">${self}</div>
  </div>${logSheet()}`;
}

// ---------- render router ----------
function render() {
  if (!S.party) return renderStart();
  if (!S.connected || !S.view) return renderConnecting();
  const v = S.view;
  if (v.phase === "lobby") return renderLobby(v);
  if (S.party === "high-low-jack") return renderHLJ(v);
  if (S.party === "hearts") return renderHearts(v);
  if (S.party === "pegs-and-jokers") return renderPJ(v);
  return renderRummy(v);
}

function renderConnecting() {
  app.__set = `${appbar({})}
    <div class="stage"><div class="panel cream" style="text-align:center">
      <div class="hero"><div class="logo">\u2663</div><h2>Reaching the table…</h2>
      <p class="sub">${S.connected ? "Joined — dealing you in." : "Connecting to the room."}</p></div>
    </div></div>`;
}

// ---------- start screen ----------
function renderStart() {
  const g = S.pickGame;
  const cards = Object.entries(GAMES)
    .map(([id, info]) =>
      `<button class="gamecard ${id === g ? "on" : ""}" data-action="pick-game" data-game="${id}">
        <span class="ic" data-s="${info.suit}"></span>
        <div class="meta"><h3>${esc(info.label)}</h3><p>${esc(info.blurb)}</p><p style="color:var(--ink-dim);margin-top:2px">${esc(info.range)}</p></div>
        <span class="go">${id === g ? "\u25C9" : "\u25CB"}</span>
      </button>`,
    )
    .join("");
  app.__set = `
    <div class="stage" style="justify-content:center;padding-top:6vh">
      <div class="panel cream">
        <div class="hero"><div class="logo">\u2660</div><h1>Parlor</h1><p class="tag">a cozy room for cards</p></div>
        <input type="hidden" id="f-game" value="${esc(g)}" />
        <label>Your name</label>
        <input class="field" id="f-name" value="${esc(S.name || "")}" placeholder="e.g. Alex" autocomplete="off" />
        <label>Pick a game</label>
        <div class="games">${cards}</div>
        <label>Room code</label>
        <input class="field" id="f-room" value="${esc(S.room || "")}" placeholder="blank = new room" autocomplete="off" ${S.offline ? "disabled" : ""} />
        <label class="toggle">
          <input type="checkbox" id="f-offline" ${S.offline ? "checked" : ""} data-action="toggle-offline" />
          <span>Play offline vs bots <em>— no connection, you + computer players</em></span>
        </label>
        <div style="margin-top:18px"><button class="btn" style="width:100%" data-action="connect">${S.offline ? "Play offline" : "Take a seat"}</button></div>
      </div>
    </div>`;
}

// ---------- lobby ----------
function renderLobby(v) {
  const isHost = v.you !== null && v.you === v.hostSeat;
  const isPJ = S.party === "pegs-and-jokers";
  const counts = isPJ ? [4] : GAMES[S.party].players;
  const link = `${location.origin}/?game=${S.party}&room=${encodeURIComponent(S.room)}`;

  const seats = v.seats
    .map((s, i) => {
      const you = i === v.you;
      const isEmpty = s.kind === "empty";
      const av = isEmpty
        ? `<div class="avatar" style="--av-1:#5a3c22;--av-2:#3f2a17;color:var(--ink-dim);font-size:14px">${i + 1}</div>`
        : avatarHTML(s.name || "Player", { host: i === v.hostSeat });
      const role = isEmpty ? "open seat" : s.kind === "bot" ? "computer" : i === v.hostSeat ? "host" : "player";
      const tags = [];
      if (you) tags.push(`<span class="chip you">you</span>`);
      else if (i === v.hostSeat && !isEmpty) tags.push(`<span class="chip host">host</span>`);
      if (s.kind === "bot") tags.push(`<span class="chip bot">bot</span>`);
      if (isEmpty) tags.push(`<span class="chip empty">empty</span>`);
      let ctrl = "";
      if (isEmpty) {
        ctrl = `<button class="btn sm" data-action="sit" data-seat="${i}">Sit</button>` +
          (isHost ? `<button class="btn sm ghost" data-action="addbot" data-seat="${i}">+ Bot</button>` : "");
      } else if (s.kind === "bot" && isHost) {
        ctrl = `<button class="btn sm danger" data-action="removebot" data-seat="${i}">Remove</button>`;
      }
      return `<div class="seat ${you ? "me" : ""}">${av}
        <div><div class="nm">${isEmpty ? `Seat ${i + 1}` : esc(s.name || "Player")}</div><div class="rl">${role}</div></div>
        <div class="tags">${tags.join("")}${ctrl}</div></div>`;
    })
    .join("");

  const cfgControls = isPJ
    ? `<label>Players</label>
         <div class="seg">${[4, 6].map((c) => `<button class="${c === v.players ? "on" : ""}" data-action="pj-setplayers" data-count="${c}">${c}</button>`).join("")}</div>
         <p class="sub" style="margin:4px 0 0">${v.players === 6 ? "Two teams of three (alternating seats)." : "Two pairs (partners opposite)."}</p>
         <label>Marbles per player</label>
         <div class="seg">${GAMES["pegs-and-jokers"].marbles.map((m) => `<button class="${m === v.marbles ? "on" : ""}" data-action="pj-setmarbles" data-m="${m}">${m}</button>`).join("")}</div>`
    : `<label>Players</label>
         <div class="seg">${counts.map((c) => `<button class="${c === v.players ? "on" : ""}" data-action="setcount" data-count="${c}">${c}</button>`).join("")}</div>
         <label>Play to (points)</label>
         <input class="field" id="f-target" type="number" min="1" value="${v.target}" />`;

  const hostPanel = isHost
    ? `<div class="panel">
         <h2>Set up the table</h2>
         ${cfgControls}
         <p class="sub" style="margin-top:10px">Anyone can sit in an open seat. Empty seats become bots when you deal.</p>
         <div style="margin-top:14px"><button class="btn" style="width:100%" data-action="start">${isPJ ? "Deal & start" : "Deal the cards"}</button></div>
       </div>`
    : `<div class="panel" style="text-align:center"><p class="sub">Waiting for the host to deal…</p></div>`;

  const sharePanel = S.offline
    ? `<div class="panel cream">
        <h2>Offline game</h2>
        <p class="sub">Playing on this device against the computer. Add or remove bots below, then deal.</p>
      </div>`
    : `<div class="panel cream">
        <h2>Lobby</h2>
        <p class="sub">Share this link so friends can pull up a chair.</p>
        <div style="display:flex;gap:8px;margin-top:10px;align-items:center">
          <input class="field" readonly value="${esc(link)}" style="font-size:13px" onclick="this.select()" />
          <button class="btn sm" data-action="copy-link">Copy</button>
        </div>
      </div>`;
  app.__set = `${appbar(v)}
    <div class="stage">
      ${sharePanel}
      <div class="panel"><h2 style="margin-bottom:10px">Seats</h2><div class="seats">${seats}</div></div>
      ${hostPanel}
    </div>`;
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

// Which card in a completed High Low Jack trick won it (port of engine
// trickWinner): highest trump — joker is the lowest trump — else highest of the
// led suit. Returns the index into the play-order cards array.
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
    const rows = [
      { name: "Team A", score: v.scores[0], win: w === 0, you: you != null && you % 2 === 0 },
      { name: "Team B", score: v.scores[1], win: w === 1, you: you != null && you % 2 === 1 },
    ];
    return renderGameOver(v, w == null ? "Game over" : `Team ${w === 0 ? "A" : "B"} wins!`, scoreList(rows));
  }

  const lm = v.yourTurn ? v.legalMoves : [];
  const bids = lm.filter((m) => m.type === "bid");
  const canPass = lm.some((m) => m.type === "pass");
  const trumpChoices = lm.filter((m) => m.type === "selectTrump");
  const plays = new Set(lm.filter((m) => m.type === "play").map((m) => cardKey(m.card)));
  const highBid = v.highBid ? `${v.highBid.amount} (${esc(seatName(v, v.highBid.seat))})` : "\u2014";

  const teamLetter = (i) => (i % 2 === 0 ? "A" : "B");

  // pods (everyone but you), tagged with their team
  const pods = v.seats
    .map((s, i) =>
      i === v.you
        ? ""
        : podHTML(v, i, {
            active: i === v.toAct,
            dealer: i === v.dealerSeat,
            team: teamLetter(i),
            partner: v.you != null && i % 2 === v.you % 2,
            count: v.handCounts[i],
            note: v.phase === "bidding" && v.signals[i] ? v.signals[i] : null,
          }),
    )
    .filter(Boolean);

  // center: trump + team scores, then the trick (or the last completed trick)
  const you = v.you;
  const myTeam = you != null ? you % 2 : null;
  const trumpCrest = `<span class="crest"><span class="suit ${v.trump && RED.has(v.trump) ? "red" : "blk"}">${v.trump ? SUIT[v.trump] : "\u2014"}</span> trump</span>`;
  const teamCrest = (t) =>
    `<span class="crest score t${t === 0 ? "A" : "B"} ${myTeam === t ? "mine" : ""}"><span class="teamdot t${t === 0 ? "A" : "B"}"></span>Team ${t === 0 ? "A" : "B"} ${v.scores[t]}${myTeam === t ? " \u00b7 you" : ""}</span>`;
  const bidCrest = v.phase === "bidding" ? `<span class="crest">high bid: ${highBid}</span>` : "";
  let trick;
  if (v.currentTrick.length) {
    trick = `<div class="trick">${v.currentTrick
      .map((p, idx) => `<div class="play ${idx === 0 ? "lead" : ""}">${cardHTML(p.card, { mini: true })}<span class="who t${teamLetter(p.seat)}">${esc(seatName(v, p.seat))}</span></div>`)
      .join("")}</div>`;
  } else if (v.phase !== "bidding" && v.lastTrick) {
    const winIdx = hljWinIdx(v.lastTrick.cards, v.trump);
    trick = `<div class="lasttrick"><div class="lt-label">Last trick \u2014 won by ${esc(seatName(v, v.lastTrick.winner))}</div><div class="trick faded">${v.lastTrick.cards
      .map((c, idx) => `<div class="play">${cardHTML(c, { mini: true, win: idx === winIdx })}</div>`)
      .join("")}</div></div>`;
  } else {
    trick = `<div class="callout">${v.phase === "bidding" ? "The table is bidding." : "Lead a card to open the trick."}</div>`;
  }
  const center = `<div class="crestrow">${trumpCrest}${teamCrest(0)}${teamCrest(1)}${bidCrest}</div>${trick}`;

  // hand (fanned), dim non-legal cards while it's your turn to play
  const hand = fanHand(v.yourHand, (c) => ({
    playable: plays.has(cardKey(c)),
    dim: plays.size > 0 && !plays.has(cardKey(c)),
    action: plays.has(cardKey(c)) ? "play-card" : "",
    key: cardKey(c),
  }));

  // actions
  const acts = [];
  if (v.yourTurn) {
    bids.forEach((m) => acts.push(`<button class="btn sm" data-action="move-bid" data-amount="${m.amount}">Bid ${m.amount}</button>`));
    if (canPass) acts.push(`<button class="btn ghost sm" data-action="move-pass">Pass</button>`);
    if (trumpChoices.length) {
      acts.push(`<span class="hint">Choose trump:</span>`);
      trumpChoices.forEach((m) =>
        acts.push(`<button class="btn sm" data-action="move-trump" data-suit="${m.suit}"><span style="font-size:18px;color:${RED.has(m.suit) ? "var(--suit-red)" : "#2a2018"}">${SUIT[m.suit]}</span></button>`),
      );
    }
    if (plays.size) acts.push(`<span class="hint">Tap a glowing card to play.</span>`);
  }
  if (v.phase === "bidding" && v.you != null) {
    acts.push(`<span class="hint">Signal partner:</span>`);
    ["strong", "medium", "weak"].forEach((l) =>
      acts.push(`<button class="btn ghost sm" data-action="signal" data-level="${l}">${l[0].toUpperCase() + l.slice(1)}</button>`),
    );
  }

  const partners = you != null ? v.seats.map((s, i) => i).filter((i) => i !== you && i % 2 === you % 2) : [];
  const partnerNames = partners.map((i) => seatName(v, i)).join(", ");
  const selfMeta =
    you != null
      ? `<span class="teambadge t${you % 2 === 0 ? "A" : "B"}">Team ${you % 2 === 0 ? "A" : "B"}</span> <span class="me-partner">partner: ${esc(partnerNames || "\u2014")}</span>`
      : `play to ${v.target}`;
  const selfTurn = v.yourTurn
    ? `<span class="turnflag">Your turn</span>`
    : `<span class="waitflag">${esc(seatName(v, v.toAct))}'s turn</span>`;

  app.__set = tableShell(v, { pods, center, hand, actions: acts.join(""), selfMeta, selfTurn });
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
  const top = v.discard.length ? v.discard[v.discard.length - 1] : null;
  const inPlay = v.yourTurn && v.turnPhase === "play";

  const pods = v.seats
    .map((s, i) =>
      i === v.you
        ? ""
        : podHTML(v, i, {
            active: i === v.toAct,
            dealer: i === v.dealerSeat,
            count: v.handCounts[i],
            pts: v.scores[i],
            note: i === v.toAct && v.turnPhase ? v.turnPhase : null,
          }),
    )
    .filter(Boolean);

  // center: stock + discard piles, then melds on the felt
  const stock = `<div class="pile">
      <div class="lbl">Stock</div>
      <div class="stockwrap" ${canStock ? `data-action="draw-stock" style="cursor:pointer"` : ""}>
        ${v.stockCount > 1 ? cardHTML({}, { back: true, style: "position:absolute;top:3px;left:3px;opacity:.6" }) : ""}
        ${v.stockCount > 0 ? cardHTML({}, { back: true }) : `<div class="card" style="opacity:.22"></div>`}
      </div>
      <div class="pts">${v.stockCount} left</div>
    </div>`;
  // Discard pile: the previous cards peek out beneath the top card; tapping the
  // pile opens a popup with the full list. The top card itself is the draw target.
  const peek = v.discard.slice(-5); // a few cards fanned beneath the top
  const stackCards = peek
    .map((c, i) => {
      const isTop = i === peek.length - 1;
      const off = (peek.length - 1 - i) * 7; // older cards shifted up-left
      const style = `position:absolute;left:${-off}px;top:${-off}px;z-index:${i}`;
      if (isTop)
        return cardHTML(c, { action: discardDraw ? "draw-discard" : "", id: c.id, playable: !!discardDraw, style });
      return cardHTML(c, { style: style + ";filter:brightness(.92)" });
    })
    .join("");
  const discard = `<div class="pile">
      <div class="lbl">Discard</div>
      <div class="discardstack" data-action="open-discard" title="View the whole discard pile">
        ${top ? stackCards : `<div class="card" style="opacity:.22"></div>`}
      </div>
      <div class="pts">${v.discard.length} card${v.discard.length === 1 ? "" : "s"}</div>
    </div>`;
  const melds = v.melds.length
    ? `<div class="melds">${v.melds
        .map((m) => {
          const active = S.rummyLayoff === m.id;
          const cards = m.cards.map((c) => cardHTML(c, { mini: true })).join("");
          return `<div class="meld ${inPlay ? "tappable" : ""} ${active ? "target" : ""}" ${inPlay ? `data-action="select-meld" data-meldid="${m.id}"` : ""}><div class="row">${cards}</div><span class="owner">${esc(seatName(v, m.owner))}</span></div>`;
        })
        .join("")}</div>`
    : `<div class="callout" style="font-size:13px">No melds down yet.</div>`;
  const center = `<div class="piles">${stock}${discard}</div>${melds}`;

  // hand (fanned, in the player's chosen order), highlight the must-meld card,
  // dim when not your play turn; cards are draggable to reorder.
  const ordered = rummyOrdered(v.yourHand);
  const hand = fanHand(ordered, (c) => ({
    action: "toggle-card",
    id: c.id,
    draggable: true,
    sel: S.rummySel.has(c.id),
    must: c.id === v.mustMeldCardId,
    playable: inPlay,
    dim: !inPlay && !S.rummySel.has(c.id),
  }));

  // selected card objects, for client-side legality of the action buttons
  const selCards = ordered.filter((c) => S.rummySel.has(c.id));
  const layMeld = v.melds.find((m) => m.id === S.rummyLayoff);
  const canMeld = selCards.length >= 3 && rValidMeld(selCards);
  const canLay = !!layMeld && selCards.length >= 1 && rCanLayoff(layMeld, selCards);
  const canDiscard = selCards.length === 1 && v.mustMeldCardId == null;

  // sort controls (available whenever you hold cards)
  const sortBar = v.yourHand.length
    ? `<button class="btn ghost sm" data-action="sort-suit">Sort \u2660\u2665</button>
       <button class="btn ghost sm" data-action="sort-rank">Sort 1\u20139</button>`
    : "";

  // actions
  const acts = [];
  if (v.yourTurn && v.turnPhase === "draw") {
    if (canStock) acts.push(`<button class="btn" data-action="draw-stock">Draw stock</button>`);
    if (discardDraw && top) acts.push(`<button class="btn ghost" data-action="draw-discard" data-cardid="${top.id}">Take ${top.joker ? "\u2605" : rankLabel(top.rank) + SUIT[top.suit]}</button>`);
    acts.push(sortBar);
    acts.push(`<span class="hint">Draw to begin your turn \u2014 the top discard is always yours to take.</span>`);
  } else if (inPlay) {
    const n = S.rummySel.size;
    acts.push(`<button class="btn" data-action="meld-selected" ${canMeld ? "" : "disabled"}>Meld${n ? ` (${n})` : ""}</button>`);
    acts.push(`<button class="btn ghost" data-action="layoff-selected" ${canLay ? "" : "disabled"}>Lay off</button>`);
    acts.push(`<button class="btn" data-action="discard-selected" ${canDiscard ? "" : "disabled"}>Discard</button>`);
    if (n) acts.push(`<button class="btn ghost sm" data-action="clear-sel">Clear</button>`);
    acts.push(sortBar);
    if (v.mustMeldCardId != null) acts.push(`<span class="hint">The green card must be melded or laid off before you discard.</span>`);
    else acts.push(`<span class="hint">Select cards \u2192 Meld (3+), Lay off (tap a meld), or Discard (one). Drag to reorder.</span>`);
  } else {
    acts.push(sortBar);
  }

  const selfMeta = v.you != null ? `Score ${v.scores[v.you]} \u00b7 play to ${v.target}` : `play to ${v.target}`;
  const selfTurn = v.yourTurn
    ? `<span class="turnflag">Your turn \u2014 ${v.turnPhase === "draw" ? "draw" : "play"}</span>`
    : `<span class="waitflag">${esc(seatName(v, v.toAct))}'s turn</span>`;

  app.__set = tableShell(v, { pods, center, hand, actions: acts.join(""), selfMeta, selfTurn }) + discardModal(v);
}

// Popup listing the whole discard pile, newest at the top-right.
function discardModal(v) {
  if (!S.discardOpen) return "";
  const cards = v.discard.length
    ? v.discard.map((c, i) => `<div class="dcard ${i === v.discard.length - 1 ? "top" : ""}">${cardHTML(c, { mini: true })}</div>`).join("")
    : `<div class="callout" style="font-size:13px">The discard pile is empty.</div>`;
  return `<div class="modal-back" data-action="close-discard">
      <div class="modal" data-stop="1">
        <div class="modalhead"><span>Discard pile \u2014 ${v.discard.length} card${v.discard.length === 1 ? "" : "s"}</span>
          <button class="btn sm ghost" data-action="close-discard">Close</button></div>
        <div class="modalbody"><div class="dgrid">${cards}</div></div>
        <p class="sub" style="margin:8px 14px 0">Oldest first \u2014 the highlighted card is on top.</p>
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
        ? ""
        : podHTML(v, i, {
            active: i === v.toAct,
            count: v.handCounts[i],
            pts: v.scores[i],
            note: passing ? null : i === v.toAct ? "to play" : v.points[i] ? `+${v.points[i]} this hand` : null,
          }),
    )
    .filter(Boolean);

  // Center: passing prompt, or the crests + the trick (kept showing the last
  // completed trick for a beat once it's swept, so each card is visible).
  let center;
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
    const broken = `<span class="crest"><span class="suit red">\u2665</span> ${v.heartsBroken ? "broken" : "not broken"}</span>`;
    const crests = `<div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center">${broken}<span class="crest">hand ${v.handNo + 1}</span></div>`;
    const showLast = v.currentTrick.length === 0 && v.lastTrick;
    const cards = v.currentTrick.length ? v.currentTrick : showLast ? v.lastTrick.cards : [];
    const winSeat = showLast ? v.lastTrick.winner : null;
    const trick = cards.length
      ? `<div class="trick">${cards
          .map((p, idx) => `<div class="play ${idx === 0 ? "lead" : ""}">${cardHTML(p.card, { mini: true, win: p.seat === winSeat })}<span class="who">${esc(seatName(v, p.seat))}</span></div>`)
          .join("")}</div>`
      : `<div class="callout">Lead a card to open the trick.</div>`;
    const note = showLast
      ? `<div class="callout" style="font-size:13px">Trick to ${esc(seatName(v, v.lastTrick.winner))}.</div>`
      : "";
    center = `${crests}${trick}${note}`;
  }

  // Hand: in passing, tap to (de)select up to 3; in play, tap a glowing legal card.
  const hand = fanHand(v.yourHand, (c) => {
    if (passing) {
      return { action: v.youPassed ? "" : "toggle-pass", id: c.id, sel: S.heartsPass.has(c.id), playable: !v.youPassed, dim: v.youPassed };
    }
    const can = plays.has(c.id);
    return { action: can ? "play-hearts" : "", id: c.id, playable: can, dim: plays.size > 0 && !can };
  });

  // Actions.
  const acts = [];
  if (passing && !v.youPassed) {
    const n = S.heartsPass.size;
    acts.push(`<button class="btn" data-action="pass-3" ${v.yourTurn && n === 3 ? "" : "disabled"}>Pass 3${n ? ` (${n})` : ""}</button>`);
    if (n) acts.push(`<button class="btn ghost sm" data-action="clear-pass">Clear</button>`);
    acts.push(`<span class="hint">${v.yourTurn ? "Select exactly 3 cards to pass." : "Stage 3 cards \u2014 you'll confirm on your turn."}</span>`);
  } else if (passing) {
    acts.push(`<span class="hint">Passed \u2014 waiting for the others.</span>`);
  } else if (v.yourTurn && plays.size) {
    acts.push(`<span class="hint">Tap a glowing card to play.</span>`);
  }

  const you = v.you;
  const selfMeta = you != null ? `Score ${v.scores[you]} \u00b7 play to ${v.target} \u00b7 low wins` : `play to ${v.target} \u00b7 low wins`;
  const selfTurn = v.yourTurn
    ? `<span class="turnflag">${passing ? "Your pass" : "Your turn"}</span>`
    : `<span class="waitflag">${esc(seatName(v, v.toAct))}${passing ? " is passing" : "'s turn"}</span>`;

  app.__set = tableShell(v, { pods, center, hand, actions: acts.join(""), selfMeta, selfTurn });
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
  let s = `<svg class="pjsvg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
    <defs>
      <linearGradient id="pjwood" x1="0" y1="0" x2="0.7" y2="1">
        <stop offset="0%" stop-color="var(--wood-3)"/><stop offset="45%" stop-color="var(--wood-2)"/><stop offset="100%" stop-color="var(--wood-1)"/>
      </linearGradient>
      <radialGradient id="pjtable" cx="50%" cy="46%" r="65%">
        <stop offset="0%" stop-color="#3c2611"/><stop offset="72%" stop-color="#241608"/><stop offset="100%" stop-color="var(--wood-0)"/>
      </radialGradient>
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
  // slanted panel seams: a beveled groove crossing the wood band toward centre
  for (const sp of b.seams) {
    const dx = C.x - sp.x, dy = C.y - sp.y, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L;
    const ox = sp.x - ux * 8, oy = sp.y - uy * 8, ix = sp.x + ux * 5, iy = sp.y + uy * 5;
    s += `<line x1="${f(ox)}" y1="${f(oy)}" x2="${f(ix)}" y2="${f(iy)}" stroke="#0b0805" stroke-width="0.8" opacity="0.6"/>`;
    s += `<line x1="${f(ox + 0.55)}" y1="${f(oy)}" x2="${f(ix + 0.55)}" y2="${f(iy)}" stroke="var(--wood-hi)" stroke-width="0.3" opacity="0.32"/>`;
  }
  // recessed table: a dark rim (shadow of the raised frame) then the grained surface
  const ho = b.hollow;
  s += `<rect x="${f(ho.x - 1)}" y="${f(ho.y - 1)}" width="${f(ho.w + 2)}" height="${f(ho.h + 2)}" rx="3.6" fill="#000" opacity="0.55"/>`;
  s += `<rect x="${f(ho.x)}" y="${f(ho.y)}" width="${f(ho.w)}" height="${f(ho.h)}" rx="3" fill="url(#pjtable)"/>`;
  s += `<rect x="${f(ho.x)}" y="${f(ho.y)}" width="${f(ho.w)}" height="${f(ho.h)}" rx="3" fill="#000" filter="url(#pjgrainv)" opacity="0.4" style="mix-blend-mode:multiply"/>`;
  s += `<rect x="${f(ho.x + 0.4)}" y="${f(ho.y + 0.4)}" width="${f(ho.w - 0.8)}" height="${f(ho.h - 0.8)}" rx="2.6" fill="none" stroke="#000" stroke-width="0.5" opacity="0.4"/>`;
  // castle arms: a wooden bar from each rail entry inward to the last heaven hole
  for (let p = 0; p < P; p++) {
    const cm = b.ring[b.castleEntries[p]], last = b.castles[p][b.castles[p].length - 1];
    s += `<line x1="${f(cm.x)}" y1="${f(cm.y + 0.35)}" x2="${f(last.x)}" y2="${f(last.y + 0.35)}" stroke="#000" stroke-width="4.8" stroke-linecap="round" opacity="0.3"/>`;
    s += `<line x1="${f(cm.x)}" y1="${f(cm.y)}" x2="${f(last.x)}" y2="${f(last.y)}" stroke="url(#pjwood)" stroke-width="4.4" stroke-linecap="round"/>`;
    s += `<line x1="${f(cm.x)}" y1="${f(cm.y)}" x2="${f(last.x)}" y2="${f(last.y)}" stroke="var(--wood-hi)" stroke-width="0.5" stroke-linecap="round" opacity="0.25" transform="translate(-0.4,-0.5)"/>`;
  }
  // centre hub
  s += `<circle cx="${C.x}" cy="${C.y}" r="3.6" fill="url(#pjwood)" stroke="var(--wood-edge)" stroke-width="0.4"/>`;
  s += `<circle cx="${C.x}" cy="${C.y}" r="3.6" fill="#000" filter="url(#pjgrain)" opacity="0.4" style="mix-blend-mode:multiply"/>`;
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

  // hand: tap a usable card to reveal its moves
  const usable = new Set(v.legalMoves.filter((m) => "cardId" in m).map((m) => m.cardId));
  const hand = v.yourHand
    .map((c) => `<span class="pjcardslot" ${yours ? `data-action="pj-pick-card" data-cardid="${c.id}"` : ""}>${cardHTML(c, { playable: yours && usable.has(c.id), dim: yours && !usable.has(c.id), sel: S.pjCard === c.id })}</span>`)
    .join("");

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

  app.__set = tableShell(v, { pods, center, hand, actions: acts.join(""), selfMeta, selfTurn });
}

function doConnect() {
  const name = document.getElementById("f-name").value.trim();
  const game = document.getElementById("f-game").value;
  let room = document.getElementById("f-room").value.trim();
  if (!name) return toast("Enter a name first.");
  if (!GAMES[game]) return toast("Pick a game.");
  S.offline = !!document.getElementById("f-offline")?.checked;
  S.name = name;
  S.party = game;
  localStorage.setItem("cg_name", name);
  if (S.offline) {
    S.room = "solo";
    history.replaceState(null, "", `/?game=${game}`);
  } else {
    if (!room) room = Math.random().toString(36).slice(2, 7);
    S.room = room;
    history.replaceState(null, "", `/?game=${game}&room=${encodeURIComponent(room)}`);
  }
  connect();
}

function copyLink() {
  const link = `${location.origin}/?game=${S.party}&room=${encodeURIComponent(S.room)}`;
  navigator.clipboard?.writeText(link).then(() => toast("Link copied."), () => toast(link));
}

function doLeave() {
  S.intentionalClose = true;
  if (!S.offline) send({ t: "leave" });
  try { S.ws?.close(); } catch {}
  S.view = null;
  S.connected = false;
  S.party = null;
  S.offline = false;
  history.replaceState(null, "", "/");
  renderStart();
}

function doStart() {
  if (S.party === "pegs-and-jokers") return send({ t: "start", config: { players: S.view.players, marbles: S.view.marbles } });
  const target = parseInt(document.getElementById("f-target")?.value, 10) || GAMES[S.party].target;
  send({ t: "start", config: { players: S.view.players, target } });
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
  if (S.rummyLayoff === null) return toast("Tap a table meld to lay onto.");
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
    case "sort-suit": return rummySort(v.yourHand, "suit");
    case "sort-rank": return rummySort(v.yourHand, "rank");
    case "pick-game": S.pickGame = t.dataset.game; return renderStart();
    case "toggle-offline": S.offline = !!t.checked; return renderStart();
    case "toggle-log": S.showLog = !S.showLog; return render();
    case "connect": return doConnect();
    case "copy-link": return copyLink();
    case "leave": return doLeave();
    case "sit": return send({ t: "sit", seat: +t.dataset.seat });
    case "addbot": return send({ t: "addBot", seat: +t.dataset.seat });
    case "removebot": return send({ t: "removeBot", seat: +t.dataset.seat });
    case "setcount": {
      const target = parseInt(document.getElementById("f-target")?.value, 10) || GAMES[S.party].target;
      return send({ t: "setConfig", config: { players: +t.dataset.count, target } });
    }
    case "start": return doStart();
    case "newgame": return send({ t: "newGame" });
    case "move-bid": return send({ t: "move", move: { type: "bid", seat: v.you, amount: +t.dataset.amount } });
    case "move-pass": return send({ t: "move", move: { type: "pass", seat: v.you } });
    case "move-trump": return send({ t: "move", move: { type: "selectTrump", seat: v.you, suit: t.dataset.suit } });
    case "signal": return send({ t: "aux", payload: t.dataset.level });
    case "play-card": {
      const c = v.yourHand.find((x) => cardKey(x) === t.dataset.key);
      if (c) send({ t: "move", move: { type: "play", seat: v.you, card: c } });
      return;
    }
    case "draw-stock": return send({ t: "move", move: { type: "drawStock", seat: v.you } });
    case "draw-discard": return send({ t: "move", move: { type: "drawDiscard", seat: v.you, cardId: +t.dataset.cardid } });
    case "toggle-card": return toggleSel(+t.dataset.cardid);
    case "select-meld": S.rummyLayoff = S.rummyLayoff === +t.dataset.meldid ? null : +t.dataset.meldid; return render();
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
    if (target > 0) send({ t: "setConfig", config: { players: S.view.players, target } });
  }
});

// ---------- init ----------
function init() {
  S.pid = localStorage.getItem("cg_pid");
  if (!S.pid) {
    S.pid = (crypto.randomUUID && crypto.randomUUID()) || `p_${Math.random().toString(36).slice(2)}${Date.now()}`;
    localStorage.setItem("cg_pid", S.pid);
  }
  S.name = localStorage.getItem("cg_name") || "";
  const q = new URLSearchParams(location.search);
  const game = q.get("game");
  const room = q.get("room");
  if (game && GAMES[game]) { S.party = game; S.pickGame = game; }
  if (room) S.room = room;
  if (S.party && S.room && S.name) connect();
  else { S.party = S.party || null; renderStart(); }
}
init();
