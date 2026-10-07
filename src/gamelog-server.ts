// gamelog-server.ts — a single Durable Object that serializes finished-hand
// records from every room into one append-only feed and serves it as JSONL.
// One named instance ("singleton") handles all rooms, so appends never race.
//
// Writes arrive only over the binding (rooms call append() via RPC; the worker
// forwards validated offline hands the same way). Its HTTP side is read-only.
import { DurableObject } from "cloudflare:workers";

// Rows per SELECT when serving the feed, so a read never materializes the
// whole table at once (HLJ records run to tens of KB each).
const PAGE_ROWS = 200;
// Cap on an explicit ?limit= page.
const MAX_LIMIT = 1000;

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

  // Internal (RPC over the binding): append one finished-hand record (JSON text).
  async append(record: string): Promise<void> {
    let game = "unknown";
    try {
      const g = JSON.parse(record)?.game;
      if (typeof g === "string") game = g;
    } catch { /* keep "unknown" */ }
    this.ctx.storage.sql.exec(
      "INSERT INTO hands (game, ts, record) VALUES (?, ?, ?)",
      game, new Date().toISOString(), record,
    );
  }

  // Public: GET /gamelog            -> all hands, JSONL
  //         GET /gamelog/<game-id>  -> just that game's hands, JSONL
  // Optional ?after=<id>&limit=<n> returns one page of up to n hands with id >
  // after; when the page is full, x-gamelog-next carries the id to continue from.
  async fetch(req: Request): Promise<Response> {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
    }
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean); // ["gamelog", "<game?>"]
    const game = parts[1] ?? null;
    const headers: Record<string, string> = {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    };
    if (req.method === "HEAD") return new Response(null, { headers });
    let after = Math.max(0, Math.floor(Number(url.searchParams.get("after")) || 0));

    const limitParam = url.searchParams.get("limit");
    if (limitParam !== null) {
      const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(Number(limitParam)) || MAX_LIMIT));
      const rows = this.page(game, after, limit);
      if (rows.length === limit) headers["x-gamelog-next"] = String(rows[rows.length - 1].id);
      return new Response(rows.map((r) => r.record).join("\n"), { headers });
    }

    // The whole feed, streamed a page at a time (same bytes as one big join).
    const encoder = new TextEncoder();
    let first = true;
    const body = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        const rows = this.page(game, after, PAGE_ROWS);
        if (rows.length) {
          after = rows[rows.length - 1].id;
          controller.enqueue(encoder.encode((first ? "" : "\n") + rows.map((r) => r.record).join("\n")));
          first = false;
        }
        if (rows.length < PAGE_ROWS) controller.close();
      },
    });
    return new Response(body, { headers });
  }

  private page(game: string | null, after: number, limit: number): { id: number; record: string }[] {
    const cursor = game
      ? this.ctx.storage.sql.exec("SELECT id, record FROM hands WHERE game = ? AND id > ? ORDER BY id LIMIT ?", game, after, limit)
      : this.ctx.storage.sql.exec("SELECT id, record FROM hands WHERE id > ? ORDER BY id LIMIT ?", after, limit);
    return cursor.toArray().map((r) => ({ id: r.id as number, record: r.record as string }));
  }
}
