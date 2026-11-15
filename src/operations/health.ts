import { createServer, type Server } from "node:http";
import type { Db } from "../db/index.js";
export class Health {
  private lastSuccess: number | undefined;
  constructor(private readonly clock: () => Date) {}
  mark(): void {
    this.lastSuccess = +this.clock();
  }
  async status(db: Db): Promise<number> {
    if (
      this.lastSuccess === undefined ||
      +this.clock() - this.lastSuccess >= 120000
    )
      return 503;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        db.query("SELECT 1"),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("Health timeout")), 1000);
        }),
      ]);
      return 200;
    } catch {
      return 503;
    } finally {
      clearTimeout(timer);
    }
  }
  listen(db: Db, port: number): Server {
    const server = createServer((req, res) => {
      void (async () => {
        if (req.method !== "GET" || req.url !== "/healthz") {
          res.writeHead(404).end();
          return;
        }
        const status = await this.status(db);
        res
          .writeHead(status, { "Content-Type": "text/plain" })
          .end(status === 200 ? "ok\n" : "unhealthy\n");
      })();
    });
    server.listen(port, "0.0.0.0");
    return server;
  }
}
