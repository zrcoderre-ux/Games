// game.ts — the generic, game-agnostic seam every game plugs into.
//
// Nothing here knows about trump, melds, teams, or any specific game. A game is
// a pure module implementing Game<...>; the room server (room-server.ts) hosts
// any such module without understanding its rules. To add a game you write a
// module here-shaped and a 3-line Durable Object subclass — you never touch the
// server.

// ---------- seat occupancy (generic) ----------

export type SeatKind = "human" | "bot" | "empty";
export type SeatInfo = { kind: SeatKind; name: string | null };

// Public room scaffolding handed to the module so its view can render who is
// seated, who is host, and whether the room is still in the lobby.
export type RoomMeta = {
  seats: SeatInfo[];
  hostSeat: number | null;
  players: number;
  inLobby: boolean;
  botReplacement: boolean;       // auto-replace disconnected players after 60 s
  disconnectedSeats: number[];   // seats where the human has closed their connection
};

// ---------- move log (generic, authoritative) ----------
// A game appends LogEntry rows as moves are applied; the server ships them in
// each view so every client (including reconnects) sees the same history.
// Entries carry no player NAMES — only the actor's seat — so names are resolved
// client-side, consistent with the rest of the UI and robust to renames.
export type LogCard = { rank: number; suit: string } | { joker: true };
export type LogEntry = {
  id: number; // monotonic within a game, for stable client keys
  seat: number | null; // the actor (client prepends their name); null = table/system event
  msg: string; // text without names, e.g. "played", "bid 3", "takes the trick"
  cards?: LogCard[]; // optional cards rendered inline after msg
  suit?: string; // optional bare suit glyph (e.g. trump called)
  tail?: string; // optional text rendered after the cards
};

// ---------- the contract ----------

// Every move identifies its actor, so the server can authorize it without
// understanding the move's internal shape.
export interface SeatedMove {
  seat: number;
}

export interface GameMeta {
  id: string; // "high-low-jack", "rummy-500"
  name: string;
  supportedPlayerCounts: number[];
}

// Generic over the game's own State, Move, lobby Config, and redacted View.
export interface Game<State, Move extends SeatedMove, Config, View> {
  readonly meta: GameMeta;

  // How many seats a config needs, so the server can size the table before any
  // state is dealt.
  seatCount(config: Config): number;

  // Deal a fresh game. Throws on an invalid config. `seed` is the ONLY source
  // of randomness, threaded through State for deterministic replay/testing.
  createGame(config: Config, seed: number): State;

  // The ONLY authority on turn order. null = nobody to act (game over, etc.).
  // A turn may span several moves (Rummy draw -> meld -> discard); this reports
  // the same seat until applyMove decides to advance it.
  seatToAct(state: State): number | null;

  // Cheap authorization check for an incoming move, used on the server's hot
  // path. Small-move-set games may delegate to legalMoves(); combinatorial
  // games (Rummy melds) implement a direct validator instead.
  isLegal(state: State, move: Move): boolean;

  // Enumerate legal moves for the seat to act — for the client UI and simple
  // bots. May be expensive; the server never calls this to authorize a move.
  legalMoves(state: State): Move[];

  // The pure transition. Decides the next seat to act internally.
  applyMove(state: State, move: Move): State;

  isOver(state: State): boolean;

  // The only thing a seat may see; hides every other zone (other hands, the
  // stock's contents/order, the kitty...). seat === null means a spectator.
  redact(state: State, seat: number | null, meta: RoomMeta): View;

  // The view shown while still in the lobby, before any state is dealt.
  lobbyView(config: Config, seat: number | null, meta: RoomMeta): View;

  // A bot's move for the seat to act. Reads only its own (redactable) info.
  aiMove(state: State, seat: number): Move;

  // OPTIONAL: ms between bot moves (default 1600). Set lower for fast-paced games.
  botStepMs?: number;

  // OPTIONAL: side actions that do NOT advance the turn (Pitch hand signals).
  // Games without them (Rummy) omit this property entirely.
  aux?: {
    apply(state: State, seat: number, payload: unknown): State;
    // A bot may emit one as it comes to act (e.g. reveal hand confidence).
    botAux?(state: State, seat: number): unknown | null;
  };
}

// ---------- wire protocol (generic) ----------

export type ClientMessage<Config, Move> =
  | { t: "join"; pid: string; name: string } // identify / reclaim a seat on reconnect
  | { t: "sit"; seat: number } // take a specific empty seat
  | { t: "leave" } // give up your seat (becomes a bot if a game is running)
  | { t: "addBot"; seat: number } // host fills an empty lobby seat with an AI
  | { t: "removeBot"; seat: number } // host clears a bot from a lobby seat
  | { t: "setConfig"; config: Config } // host resizes the lobby table / options before dealing
  | { t: "start"; config: Config } // host fills empty seats with bots and deals
  | { t: "move"; move: Move } // a game action (opaque to the server)
  | { t: "aux"; payload: unknown } // a non-turn side action (opaque to the server)
  | { t: "newGame" } // after game over, reset to the lobby
  | { t: "setBotReplacement"; enabled: boolean } // host toggles auto bot-replacement
  | { t: "replaceSeat"; seat: number }; // host immediately replaces a disconnected player

export type ServerMessage<View> =
  | { t: "view"; view: View }
  | { t: "error"; message: string };
