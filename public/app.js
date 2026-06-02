// Card Games client — vanilla ES module, native WebSocket, no build step.
// Talks the wire protocol from src/game.ts and renders each game's redacted view.
// The server is the rules authority: we mostly turn `view.legalMoves` into
// controls, and for Rummy melds we let the player select cards and submit —
// the server validates and replies with an error if a move is illegal.

const SUIT = { S: "\u2660", H: "\u2665", D: "\u2666", C: "\u2663" };
const RED = new Set(["H", "D"]);
const GAMES = {
  rummy500: { label: "Rummy 500", players: [2, 3, 4, 5, 6, 7, 8], target: 500 },
  "high-low-jack": { label: "High Low Jack", players: [4, 6, 8], target: 21 },
};

const app = document.getElementById("app");
const toastEl = document.getElementById("toast");

const S = {
  pid: null,
  name: "",
  party: null,
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

function cardHTML(c, o = {}) {
  if (o.back) return `<div class="card back ${o.mini ? "mini" : ""}"></div>`;
  const cls = ["card"];
  if (o.mini) cls.push("mini");
  if (o.playable) cls.push("playable");
  if (o.selected) cls.push("selected");
  if (o.must) cls.push("must");
  const a = [];
  if (o.action) a.push(`data-action="${o.action}"`);
  if (o.key) a.push(`data-key="${o.key}"`);
  if (o.id !== undefined) a.push(`data-cardid="${o.id}"`);
  if (c.joker) {
    cls.push("red");
    return `<div class="${cls.join(" ")}" ${a.join(" ")}><span class="r">\u2605</span><span class="s">Jk</span></div>`;
  }
  if (RED.has(c.suit)) cls.push("red");
  return `<div class="${cls.join(" ")}" ${a.join(" ")}><span class="r">${rankLabel(c.rank)}</span><span class="s">${SUIT[c.suit]}</span></div>`;
}

function seatName(v, i) {
  const s = v.seats[i];
  if (!s || s.kind === "empty") return `Seat ${i + 1}`;
  return s.name || (s.kind === "bot" ? `Bot ${i + 1}` : `Seat ${i + 1}`);
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

// ---------- top bar ----------
function topBar(v) {
  const link = `${location.origin}/?game=${S.party}&room=${encodeURIComponent(S.room)}`;
  return `
    <div class="panel row between">
      <div><strong>${esc(GAMES[S.party].label)}</strong> <span class="muted">· room ${esc(S.room)}</span></div>
      <div class="row">
        <button class="sm ghost" data-action="copy-link" title="${esc(link)}">Copy link</button>
        <button class="sm ghost" data-action="leave">Leave</button>
      </div>
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
  app.innerHTML = `${topBar({})}<div class="panel center"><h2>Connecting…</h2><p class="muted">Reaching the table.</p></div>`;
}

// ---------- start screen ----------
function renderStart() {
  const g = S.party || "rummy500";
  app.innerHTML = `
    <div class="brand"><div class="suits"><span>\u2660</span> <span class="r">\u2665</span> <span class="r">\u2666</span> <span>\u2663</span></div></div>
    <h1 class="center">Card Games</h1>
    <p class="center muted">High Low Jack &amp; Rummy 500 — play with friends and bots.</p>
    <div class="panel">
      <div class="field"><label>Your name</label><input id="f-name" value="${esc(S.name || "")}" placeholder="e.g. Alex" autocomplete="off" /></div>
      <div class="field"><label>Game</label>
        <select id="f-game">
          <option value="rummy500" ${g === "rummy500" ? "selected" : ""}>Rummy 500</option>
          <option value="high-low-jack" ${g === "high-low-jack" ? "selected" : ""}>High Low Jack</option>
        </select>
      </div>
      <div class="field"><label>Room code</label><input id="f-room" value="${esc(S.room || "")}" placeholder="leave blank to create a new room" autocomplete="off" /></div>
      <div class="row"><button class="primary" data-action="connect">Join / Create room</button></div>
    </div>`;
}

// ---------- lobby ----------
function renderLobby(v) {
  const isHost = v.you !== null && v.you === v.hostSeat;
  const counts = GAMES[S.party].players;

  const seats = v.seats
    .map((s, i) => {
      const you = i === v.you;
      let right = "";
      if (s.kind === "empty") {
        right =
          `<button class="sm" data-action="sit" data-seat="${i}">Sit</button>` +
          (isHost ? `<button class="sm ghost" data-action="addbot" data-seat="${i}">+ Bot</button>` : "");
      } else if (s.kind === "bot" && isHost) {
        right = `<button class="sm danger" data-action="removebot" data-seat="${i}">Remove</button>`;
      }
      const label =
        s.kind === "empty" ? `<span class="empty">Empty</span>` : `<span class="who">${esc(s.name || "Player")}</span>`;
      const tag =
        s.kind === "bot"
          ? `<span class="tag">bot</span>`
          : you
          ? `<span class="tag">you${i === v.hostSeat ? " · host" : ""}</span>`
          : s.kind === "human"
          ? `<span class="tag">player${i === v.hostSeat ? " · host" : ""}</span>`
          : "";
      return `<div class="seat ${you ? "you" : ""}"><div class="badge">${i + 1}</div><div>${label} ${tag}</div><div class="spacer"></div>${right}</div>`;
    })
    .join("");

  const hostPanel = isHost
    ? `<div class="panel">
         <h2>Start the game</h2>
         <div class="field"><label>Players</label><div class="row">${counts
           .map((c) => `<button class="sm ${c === v.players ? "primary" : ""}" data-action="setcount" data-count="${c}">${c}</button>`)
           .join("")}</div></div>
         <div class="field"><label>Play to (points)</label><input id="f-target" type="number" min="1" value="${v.target}" /></div>
         <p class="muted">Players can sit in any empty seat; choose more seats to make room. Empty seats become bots when you deal.</p>
         <button class="primary" data-action="start">Deal</button>
       </div>`
    : `<div class="panel center muted">Waiting for the host to start…</div>`;

  app.innerHTML = `
    ${topBar(v)}
    <div class="panel">
      <h2>Lobby</h2>
      <div class="linkbox"><code>${esc(location.origin)}/?game=${S.party}&amp;room=${esc(S.room)}</code><button class="sm" data-action="copy-link">Copy</button></div>
      <p class="muted">Share this link so others can join this room.</p>
    </div>
    <div class="panel"><h2>Seats</h2><div class="seats">${seats}</div></div>
    ${hostPanel}`;
}

// ---------- shared: game over ----------
function renderGameOver(v, text, scoreboard) {
  const isHost = v.you !== null && v.you === v.hostSeat;
  app.innerHTML = `
    ${topBar(v)}
    <div class="banner"><h2>${esc(text)}</h2></div>
    <div class="panel"><h2>Final scores</h2>${scoreboard}</div>
    <div class="panel center">
      ${isHost ? `<button class="primary" data-action="newgame">New game</button>` : `<span class="muted">Waiting for the host to start a new game…</span>`}
    </div>`;
}

// ---------- High Low Jack ----------
function renderHLJ(v) {
  const teamScore = (t) => `<div class="s"><b>${v.scores[t]}</b>Team ${t === 0 ? "A" : "B"}${v.you != null && v.you % 2 === t ? " · you" : ""}</div>`;
  if (v.phase === "gameOver") {
    const w = v.winner;
    return renderGameOver(
      v,
      w == null ? "Game over" : `Team ${w === 0 ? "A" : "B"} wins!`,
      `<div class="scoreboard">${teamScore(0)}${teamScore(1)}</div>`,
    );
  }

  const lm = v.yourTurn ? v.legalMoves : [];
  const bids = lm.filter((m) => m.type === "bid");
  const canPass = lm.some((m) => m.type === "pass");
  const trumpChoices = lm.filter((m) => m.type === "selectTrump");
  const plays = new Set(lm.filter((m) => m.type === "play").map((m) => cardKey(m.card)));

  const seatStrip = v.seats
    .map((s, i) => {
      const tags = [];
      if (i === v.dealerSeat) tags.push(`<span class="chip">dealer</span>`);
      if (i === v.toAct) tags.push(`<span class="chip gold">to act</span>`);
      if (v.signals[i]) tags.push(`<span class="chip">${esc(v.signals[i])}</span>`);
      return `<div class="seat ${i === v.you ? "you" : ""} ${i === v.toAct ? "active" : ""}">
        <div class="badge">${i + 1}</div>
        <div><span class="who">${esc(seatName(v, i))}</span> <span class="tag">${v.handCounts[i]} cards · team ${i % 2 === 0 ? "A" : "B"}</span></div>
        <div class="spacer"></div><div class="chips">${tags.join("")}</div>
      </div>`;
    })
    .join("");

  const trick = v.currentTrick.length
    ? v.currentTrick.map((p) => `<div class="play">${cardHTML(p.card, { mini: true })}<small>${esc(seatName(v, p.seat))}</small></div>`).join("")
    : `<span class="muted">No cards played yet.</span>`;

  const hand = v.yourHand
    .map((c) => cardHTML(c, { playable: plays.has(cardKey(c)), action: plays.has(cardKey(c)) ? "play-card" : "", key: cardKey(c) }))
    .join("");

  // action bar
  let actions = "";
  if (v.yourTurn) {
    if (bids.length) actions += bids.map((m) => `<button data-action="move-bid" data-amount="${m.amount}">Bid ${m.amount}</button>`).join("");
    if (canPass) actions += `<button class="ghost" data-action="move-pass">Pass</button>`;
    if (trumpChoices.length)
      actions += `<span class="muted" style="align-self:center">Choose trump:</span>` +
        trumpChoices.map((m) => `<button data-action="move-trump" data-suit="${m.suit}">${SUIT[m.suit]}</button>`).join("");
    if (plays.size) actions += `<span class="muted" style="align-self:center">Tap a highlighted card to play.</span>`;
  }
  const signalBar =
    v.phase === "bidding" && v.you != null
      ? `<div class="actionbar"><span class="muted" style="align-self:center">Signal your hand:</span>
           <button class="sm" data-action="signal" data-level="strong">Strong</button>
           <button class="sm" data-action="signal" data-level="medium">Medium</button>
           <button class="sm" data-action="signal" data-level="weak">Weak</button></div>`
      : "";

  const highBid = v.highBid ? `${v.highBid.amount} by ${esc(seatName(v, v.highBid.seat))}` : "—";

  app.innerHTML = `
    ${topBar(v)}
    <div class="panel row between">
      <div class="scoreboard">${teamScore(0)}${teamScore(1)}</div>
      <div class="row"><span class="chip">play to ${v.target}</span><span class="chip gold">trump ${v.trump ? SUIT[v.trump] : "—"}</span></div>
    </div>
    <div class="panel">
      <div class="row between"><div class="turnflag">${v.yourTurn ? "Your turn" : `${esc(seatName(v, v.toAct))}'s turn`}</div><div class="chip">${v.phase === "bidding" ? `high bid: ${highBid}` : ""}</div></div>
      <div class="seats" style="margin-top:10px">${seatStrip}</div>
    </div>
    <div class="panel"><h2>Table</h2><div class="trick">${trick}</div></div>
    <div class="panel">
      <h2>Your hand</h2>
      <div class="hand">${hand || '<span class="muted">No cards.</span>'}</div>
      ${actions ? `<div class="actionbar">${actions}</div>` : ""}
      ${signalBar}
    </div>`;
}

// ---------- Rummy 500 ----------
function renderRummy(v) {
  // prune stale selections (cards no longer in hand)
  const handIds = new Set(v.yourHand.map((c) => c.id));
  for (const id of [...S.rummySel]) if (!handIds.has(id)) S.rummySel.delete(id);

  const scoreboard = `<div class="scoreboard">${v.scores
    .map((sc, i) => `<div class="s"><b>${sc}</b>${esc(seatName(v, i))}${i === v.you ? " · you" : ""}</div>`)
    .join("")}</div>`;

  if (v.phase === "gameOver") {
    return renderGameOver(v, v.winner == null ? "Game over" : `${seatName(v, v.winner)} wins!`, scoreboard);
  }

  const lm = v.yourTurn ? v.legalMoves : [];
  const canStock = lm.some((m) => m.type === "drawStock");
  const discardDraw = lm.find((m) => m.type === "drawDiscard");
  const top = v.discard.length ? v.discard[v.discard.length - 1] : null;

  const seatStrip = v.seats
    .map((s, i) => {
      const tags = [];
      if (i === v.dealerSeat) tags.push(`<span class="chip">dealer</span>`);
      if (i === v.toAct) tags.push(`<span class="chip gold">to act${i === v.toAct && v.turnPhase ? " · " + v.turnPhase : ""}</span>`);
      return `<div class="seat ${i === v.you ? "you" : ""} ${i === v.toAct ? "active" : ""}">
        <div class="badge">${i + 1}</div>
        <div><span class="who">${esc(seatName(v, i))}</span> <span class="tag">${v.handCounts[i]} cards</span></div>
        <div class="spacer"></div><div class="chips">${tags.join("")}</div></div>`;
    })
    .join("");

  const melds = v.melds.length
    ? v.melds
        .map((m) => {
          const active = S.rummyLayoff === m.id;
          const cards = m.cards.map((c) => cardHTML(c, { mini: true })).join("");
          return `<div class="meld ${v.yourTurn && v.turnPhase === "play" ? "target" : ""} ${active ? "target" : ""}" data-action="select-meld" data-meldid="${m.id}">${cards}<span class="owner">${esc(seatName(v, m.owner))}</span></div>`;
        })
        .join("")
    : `<span class="muted">No melds on the table yet.</span>`;

  const hand = v.yourHand
    .map((c) =>
      cardHTML(c, {
        action: "toggle-card",
        id: c.id,
        selected: S.rummySel.has(c.id),
        must: c.id === v.mustMeldCardId,
        playable: v.yourTurn && v.turnPhase === "play",
      }),
    )
    .join("");

  // actions
  let actions = "";
  if (v.yourTurn && v.turnPhase === "draw") {
    if (canStock) actions += `<button data-action="draw-stock">Draw from stock</button>`;
    if (discardDraw && top) actions += `<button data-action="draw-discard" data-cardid="${top.id}">Take ${rankLabel(top.rank)}${SUIT[top.suit]} from discard</button>`;
    actions += `<span class="muted" style="align-self:center">Draw to begin your turn.</span>`;
  } else if (v.yourTurn && v.turnPhase === "play") {
    const n = S.rummySel.size;
    actions += `<button data-action="meld-selected" ${n >= 3 ? "" : "disabled"}>Meld ${n ? `(${n})` : ""}</button>`;
    actions += `<button data-action="layoff-selected" ${n >= 1 && S.rummyLayoff !== null ? "" : "disabled"}>Lay off${S.rummyLayoff !== null ? " \u2192 selected meld" : ""}</button>`;
    actions += `<button data-action="discard-selected" ${n === 1 ? "" : "disabled"}>Discard</button>`;
    if (n) actions += `<button class="ghost sm" data-action="clear-sel">Clear</button>`;
  }

  const mustHint =
    v.yourTurn && v.mustMeldCardId != null
      ? `<p class="muted">You took a card from the discard — it's outlined and must be melded or laid off before you can discard.</p>`
      : v.yourTurn && v.turnPhase === "play"
      ? `<p class="muted">Select cards, then Meld (3+), Lay off (tap a table meld first), or Discard (one card).</p>`
      : "";

  app.innerHTML = `
    ${topBar(v)}
    <div class="panel row between">
      ${scoreboard}
      <span class="chip">play to ${v.target}</span>
    </div>
    <div class="panel">
      <div class="turnflag">${v.yourTurn ? `Your turn — ${v.turnPhase === "draw" ? "draw" : "meld / discard"}` : `${esc(seatName(v, v.toAct))}'s turn`}</div>
      <div class="seats" style="margin-top:10px">${seatStrip}</div>
    </div>
    <div class="panel">
      <h2>Table</h2>
      <div class="pile">
        <div class="col">${cardHTML({}, { back: true })}<small>stock: ${v.stockCount}</small></div>
        <div class="col">${top ? cardHTML(top) : '<div class="card" style="opacity:.3"></div>'}<small>discard: ${v.discard.length}</small></div>
      </div>
      <div style="margin-top:14px">${melds}</div>
    </div>
    <div class="panel">
      <h2>Your hand</h2>
      <div class="hand">${hand || '<span class="muted">No cards.</span>'}</div>
      ${actions ? `<div class="actionbar">${actions}</div>` : ""}
      ${mustHint}
    </div>`;
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
  if (game && GAMES[game]) S.party = game;
  if (room) S.room = room;
  if (S.party && S.room && S.name) connect();
  else { S.party = S.party || null; renderStart(); }
}
init();
