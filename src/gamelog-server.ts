// gamelog-server.ts — a single Durable Object that serializes finished-hand
// records from every room into one append-only feed and serves it as JSONL.
// One named instance ("singleton") handles all rooms, so appends never race.
import { DurableObject } from "cloudflare:workers";

export class GameLogServer extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as any);
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS hands (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         game TEXT NOT NULL,
         ts   TEXT NOT NULL,
         record TEXT NOT NULL
       )`,
    );
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // Dev diagnostic: GET /gamelog/ping inserts a test record and returns "ok".
    if (req.method === "GET" && url.pathname.endsWith("/ping")) {
      this.ctx.storage.sql.exec(
        "INSERT INTO hands (game, ts, record) VALUES (?, ?, ?)",
        "ping", new Date().toISOString(), JSON.stringify({ game: "ping", ts: new Date().toISOString() }),
      );
      return new Response("ok — test record inserted");
    }

    // Internal: a room appends one finished-hand record (JSON string body).
    if (req.method === "POST" && url.pathname.endsWith("/append")) {
      const body = await req.text();
      let game = "unknown";
      try { game = (JSON.parse(body).game as string) ?? "unknown"; } catch { /* keep "unknown" */ }
      this.ctx.storage.sql.exec(
        "INSERT INTO hands (game, ts, record) VALUES (?, ?, ?)",
        game, new Date().toISOString(), body,
      );
      return new Response("ok");
    }

    // Public: GET /gamelog            -> all hands, JSONL
    //         GET /gamelog/<game-id>  -> just that game's hands, JSONL
    const parts = url.pathname.split("/").filter(Boolean); // ["gamelog", "<game?>"]
    const game = parts[1];
    const rows = game
      ? this.ctx.storage.sql.exec("SELECT record FROM hands WHERE game = ? ORDER BY id", game).toArray()
      : this.ctx.storage.sql.exec("SELECT record FROM hands ORDER BY id").toArray();
    const jsonl = rows.map((r) => r.record as string).join("\n");
    return new Response(jsonl, {
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
      },
    });
  }
}
