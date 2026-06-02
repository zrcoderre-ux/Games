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
  connected: false,
  intentionalClose: false,
  view: null,
  rummySel: new Set(), // selected card ids
  rummyLayoff: null, // selected meld id for layoff
};

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
  return `<div class="pod ${o.active ? "active" : ""} ${o.partner ? "partner" : ""}">
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

// ---------- networking ----------
function send(m) {
  if (S.ws && S.ws.readyState === WebSocket.OPEN) S.ws.send(JSON.stringify(m));
}

function connect() {
  S.intentionalClose = false;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${location.host}/parties/${S.party}/${encodeURIComponent(S.room)}`;
  const ws = new WebSocket(url);
  S.ws = ws;
  ws.onopen = () => {
    S.connected = true;
    send({ t: "join", pid: S.pid, name: S.name });
  };
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.t === "view") { S.view = msg.view; render(); }
    else if (msg.t === "error") { toast(msg.message); }
  };
  ws.onclose = () => {
    S.connected = false;
    if (S.intentionalClose) return;
    render();
    setTimeout(() => { if (!S.connected && !S.intentionalClose) connect(); }, 1500);
  };
  ws.onerror = () => {};
  render();
}

// ---------- app bar ----------
function appbar(v) {
  return `<div class="appbar">
    <div class="brand"><div class="glyph">P</div><span class="wordmark">${esc(GAMES[S.party].label)}</span></div>
    <div class="spacer"></div>
    <div class="roomtag">room <b>${esc(S.room)}</b></div>
    <button class="btn sm ghost" data-action="copy-link">Share</button>
    <button class="btn sm ghost" data-action="leave">Leave</button>
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
  return `${appbar(v)}<div class="table">
    <div class="rail top deal">${railPods}</div>
    <div class="center">${parts.center}</div>
    <div class="selfwrap">${self}</div>
  </div>`;
}

// ---------- render router ----------
function render() {
  if (!S.party) return renderStart();
  if (!S.connected || !S.view) return renderConnecting();
  const v = S.view;
  if (v.phase === "lobby") return renderLobby(v);
  if (S.party === "high-low-jack") return renderHLJ(v);
  return renderRummy(v);
}

function renderConnecting() {
  app.innerHTML = `${appbar({})}
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
  app.innerHTML = `
    <div class="stage" style="justify-content:center;padding-top:6vh">
      <div class="panel cream">
        <div class="hero"><div class="logo">\u2660</div><h1>Parlor</h1><p class="tag">a cozy room for cards</p></div>
        <input type="hidden" id="f-game" value="${esc(g)}" />
        <label>Your name</label>
        <input class="field" id="f-name" value="${esc(S.name || "")}" placeholder="e.g. Alex" autocomplete="off" />
        <label>Pick a game</label>
        <div class="games">${cards}</div>
        <label>Room code</label>
        <input class="field" id="f-room" value="${esc(S.room || "")}" placeholder="blank = new room" autocomplete="off" />
        <div style="margin-top:18px"><button class="btn" style="width:100%" data-action="connect">Take a seat</button></div>
      </div>
    </div>`;
}

// ---------- lobby ----------
function renderLobby(v) {
  const isHost = v.you !== null && v.you === v.hostSeat;
  const counts = GAMES[S.party].players;
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

  const hostPanel = isHost
    ? `<div class="panel">
         <h2>Set up the table</h2>
         <label>Players</label>
         <div class="seg">${counts.map((c) => `<button class="${c === v.players ? "on" : ""}" data-action="setcount" data-count="${c}">${c}</button>`).join("")}</div>
         <label>Play to (points)</label>
         <input class="field" id="f-target" type="number" min="1" value="${v.target}" />
         <p class="sub" style="margin-top:10px">Anyone can sit in an open seat. Empty seats become bots when you deal.</p>
         <div style="margin-top:14px"><button class="btn" style="width:100%" data-action="start">Deal the cards</button></div>
       </div>`
    : `<div class="panel" style="text-align:center"><p class="sub">Waiting for the host to deal…</p></div>`;

  app.innerHTML = `${appbar(v)}
    <div class="stage">
      <div class="panel cream">
        <h2>Lobby</h2>
        <p class="sub">Share this link so friends can pull up a chair.</p>
        <div style="display:flex;gap:8px;margin-top:10px;align-items:center">
          <input class="field" readonly value="${esc(link)}" style="font-size:13px" onclick="this.select()" />
          <button class="btn sm" data-action="copy-link">Copy</button>
        </div>
      </div>
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
  app.innerHTML = `${appbar(v)}
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

  // pods (everyone but you)
  const pods = v.seats
    .map((s, i) =>
      i === v.you
        ? ""
        : podHTML(v, i, {
            active: i === v.toAct,
            dealer: i === v.dealerSeat,
            partner: v.you != null && i % 2 === v.you % 2,
            count: v.handCounts[i],
            note: v.phase === "bidding" && v.signals[i] ? v.signals[i] : null,
          }),
    )
    .filter(Boolean);

  // center: crests + trick
  const trumpCrest = `<span class="crest"><span class="suit ${v.trump && RED.has(v.trump) ? "red" : "blk"}">${v.trump ? SUIT[v.trump] : "\u2014"}</span> trump</span>`;
  const bidCrest = v.phase === "bidding" ? `<span class="crest">high bid: ${highBid}</span>` : "";
  const trick = v.currentTrick.length
    ? `<div class="trick">${v.currentTrick
        .map((p, idx) => `<div class="play ${idx === 0 ? "lead" : ""}">${cardHTML(p.card, { mini: true })}<span class="who">${esc(seatName(v, p.seat))}</span></div>`)
        .join("")}</div>`
    : `<div class="callout">${v.phase === "bidding" ? "The table is bidding." : "Lead a card to open the trick."}</div>`;
  const center = `<div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center">${trumpCrest}${bidCrest}</div>${trick}`;

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

  const you = v.you;
  const selfMeta = you != null ? `Team ${you % 2 === 0 ? "A" : "B"} \u00b7 A ${v.scores[0]} \u2014 B ${v.scores[1]} \u00b7 to ${v.target}` : `play to ${v.target}`;
  const selfTurn = v.yourTurn
    ? `<span class="turnflag">Your turn</span>`
    : `<span class="waitflag">${esc(seatName(v, v.toAct))}'s turn</span>`;

  app.innerHTML = tableShell(v, { pods, center, hand, actions: acts.join(""), selfMeta, selfTurn });
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
  const discard = `<div class="pile">
      <div class="lbl">Discard</div>
      ${top ? cardHTML(top, { action: discardDraw ? "draw-discard" : "", id: top.id, playable: !!discardDraw }) : `<div class="card" style="opacity:.22"></div>`}
      <div class="pts">${v.discard.length}</div>
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

  // hand (fanned), highlight the must-meld card, dim when not your play turn
  const hand = fanHand(v.yourHand, (c) => ({
    action: "toggle-card",
    id: c.id,
    sel: S.rummySel.has(c.id),
    must: c.id === v.mustMeldCardId,
    playable: inPlay,
    dim: !inPlay && !S.rummySel.has(c.id),
  }));

  // actions
  const acts = [];
  if (v.yourTurn && v.turnPhase === "draw") {
    if (canStock) acts.push(`<button class="btn" data-action="draw-stock">Draw stock</button>`);
    if (discardDraw && top) acts.push(`<button class="btn ghost" data-action="draw-discard" data-cardid="${top.id}">Take ${rankLabel(top.rank)}${SUIT[top.suit]}</button>`);
    acts.push(`<span class="hint">Draw to begin your turn.</span>`);
  } else if (inPlay) {
    const n = S.rummySel.size;
    acts.push(`<button class="btn" data-action="meld-selected" ${n >= 3 ? "" : "disabled"}>Meld${n ? ` (${n})` : ""}</button>`);
    acts.push(`<button class="btn ghost" data-action="layoff-selected" ${n >= 1 && S.rummyLayoff !== null ? "" : "disabled"}>Lay off</button>`);
    acts.push(`<button class="btn" data-action="discard-selected" ${n === 1 ? "" : "disabled"}>Discard</button>`);
    if (n) acts.push(`<button class="btn ghost sm" data-action="clear-sel">Clear</button>`);
    if (v.mustMeldCardId != null) acts.push(`<span class="hint">The green card must be melded or laid off before you discard.</span>`);
    else acts.push(`<span class="hint">Select cards \u2192 Meld (3+), Lay off (tap a meld), or Discard (one).</span>`);
  }

  const selfMeta = v.you != null ? `Score ${v.scores[v.you]} \u00b7 play to ${v.target}` : `play to ${v.target}`;
  const selfTurn = v.yourTurn
    ? `<span class="turnflag">Your turn \u2014 ${v.turnPhase === "draw" ? "draw" : "play"}</span>`
    : `<span class="waitflag">${esc(seatName(v, v.toAct))}'s turn</span>`;

  app.innerHTML = tableShell(v, { pods, center, hand, actions: acts.join(""), selfMeta, selfTurn });
}

// ---------- actions ----------
function doConnect() {
  const name = document.getElementById("f-name").value.trim();
  const game = document.getElementById("f-game").value;
  let room = document.getElementById("f-room").value.trim();
  if (!name) return toast("Enter a name first.");
  if (!GAMES[game]) return toast("Pick a game.");
  if (!room) room = Math.random().toString(36).slice(2, 7);
  S.name = name;
  S.party = game;
  S.room = room;
  localStorage.setItem("cg_name", name);
  history.replaceState(null, "", `/?game=${game}&room=${encodeURIComponent(room)}`);
  connect();
}

function copyLink() {
  const link = `${location.origin}/?game=${S.party}&room=${encodeURIComponent(S.room)}`;
  navigator.clipboard?.writeText(link).then(() => toast("Link copied."), () => toast(link));
}

function doLeave() {
  S.intentionalClose = true;
  send({ t: "leave" });
  try { S.ws?.close(); } catch {}
  S.view = null;
  S.connected = false;
  S.party = null;
  history.replaceState(null, "", "/");
  renderStart();
}

function doStart() {
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
  const v = S.view;
  switch (t.dataset.action) {
    case "pick-game": S.pickGame = t.dataset.game; return renderStart();
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
  }
});

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
