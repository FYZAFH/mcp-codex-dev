import * as http from "node:http";
import { ProgressEvent } from "../types/index.js";
import { getProgressPageHtml } from "../ui/progress-page.js";

const DEFAULT_PORT = 23120;
const MAX_INGEST_BYTES = 1_000_000;
const PROGRESS_SERVER_ID = "mcp-codex-dev-progress";

/**
 * Singleton HTTP + SSE server for streaming Codex progress events to a browser.
 */
class ProgressServer {
  private server: http.Server | null = null;
  private clients: Set<http.ServerResponse> = new Set();
  private port = DEFAULT_PORT;
  private mode: "server" | "client" | "disabled" = "disabled";

  // client-mode state (when another instance already owns the port)
  private ingestQueue: ProgressEvent[] = [];
  private ingestInFlight: Promise<void> = Promise.resolve();
  private ingestRetryTimer: NodeJS.Timeout | null = null;

  /**
   * Start the HTTP server. Binds to loopback (127.0.0.1) only.
   */
  async start(port?: number): Promise<void> {
    if (this.server) return;
    this.port = port ?? DEFAULT_PORT;

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res);
    });

    return new Promise<void>((resolve, reject) => {
      this.server!.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          // Another MCP instance is already serving the progress UI. Become a client and forward events.
          console.error(`codex-dev: progress port ${this.port} in use; forwarding events to existing server`);
          this.server = null;
          this.mode = "client";
          resolve(); // non-fatal — don't block MCP startup
        } else {
          reject(err);
        }
      });

      this.server!.listen(this.port, "127.0.0.1", () => {
        console.error(
          `codex-dev: progress server listening on http://localhost:${this.port}`
        );
        this.mode = "server";
        resolve();
      });
    });
  }

  /**
   * Stop the HTTP server and disconnect all SSE clients.
   */
  stop(): void {
    for (const res of this.clients) {
      try { res.end(); } catch { /* ignore */ }
    }
    this.clients.clear();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    this.mode = "disabled";

    if (this.ingestRetryTimer) {
      clearTimeout(this.ingestRetryTimer);
      this.ingestRetryTimer = null;
    }
    this.ingestQueue = [];
  }

  /**
   * Push a progress event to all connected SSE clients.
   */
  emit(event: ProgressEvent): void {
    if (this.mode === "server") {
      this.emitToSseClients(event);
      return;
    }

    if (this.mode === "client") {
      this.enqueueIngest(event);
      return;
    }
  }

  /**
   * Convenience: emit a "start" event for an operation.
   */
  startOperation(
    operationId: string,
    type: "write" | "review",
    description: string
  ): void {
    this.emit({
      timestamp: new Date().toISOString(),
      operationId,
      type: "start",
      content: `[${type}] ${description}`,
    });
  }

  /**
   * Convenience: emit an "end" event for an operation.
   */
  endOperation(operationId: string, success: boolean): void {
    this.emit({
      timestamp: new Date().toISOString(),
      operationId,
      type: "end",
      content: success ? "completed" : "failed",
    });
  }

  // ── internal ────────────────────────────────────────────────────────

  private emitToSseClients(event: ProgressEvent): void {
    const data = JSON.stringify(event);
    const dead: http.ServerResponse[] = [];
    for (const client of this.clients) {
      try {
        if (client.writableEnded || client.destroyed) {
          dead.push(client);
        } else {
          client.write(`event: progress\ndata: ${data}\n\n`);
        }
      } catch {
        dead.push(client);
      }
    }
    for (const client of dead) {
      this.clients.delete(client);
    }
  }

  private enqueueIngest(event: ProgressEvent): void {
    // Keep a bounded queue so we don't grow unbounded if the server is temporarily unavailable.
    this.ingestQueue.push(event);
    if (this.ingestQueue.length > 2000) {
      this.ingestQueue.splice(0, this.ingestQueue.length - 2000);
    }

    // Serialize flush attempts.
    this.ingestInFlight = this.ingestInFlight
      .then(() => this.flushIngestQueue())
      .catch(() => {});
  }

  private async flushIngestQueue(): Promise<void> {
    if (this.ingestRetryTimer) return;
    while (this.ingestQueue.length > 0) {
      const next = this.ingestQueue[0]!;
      const ok = await this.postIngest(next);
      if (!ok) {
        // Back off a bit before retrying.
        this.ingestRetryTimer = setTimeout(() => {
          this.ingestRetryTimer = null;
          void this.flushIngestQueue();
        }, 500);
        return;
      }
      this.ingestQueue.shift();
    }
  }

  private postIngest(event: ProgressEvent): Promise<boolean> {
    return new Promise((resolve) => {
      const body = JSON.stringify(event);
      const req = http.request(
        {
          method: "POST",
          host: "127.0.0.1",
          port: this.port,
          path: "/ingest",
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (res) => {
          // Drain response to allow socket reuse.
          res.resume();
          resolve(res.statusCode === 204 || res.statusCode === 200);
        }
      );

      req.on("error", () => resolve(false));
      req.end(body);
    });
  }

  private handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): void {
    const pathname = (req.url ?? "/").split("?")[0];

    if (pathname === "/" || pathname === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(getProgressPageHtml());
      return;
    }

    if (pathname === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(":ok\n\n");
      this.clients.add(res);

      req.on("close", () => {
        this.clients.delete(res);
      });
      return;
    }

    if (pathname === "/health") {
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Codex-Dev-Progress": "1",
      });
      res.end(JSON.stringify({ ok: true, name: PROGRESS_SERVER_ID, port: this.port }));
      return;
    }

    if (pathname === "/ingest") {
      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "text/plain" });
        res.end("Method Not Allowed");
        return;
      }

      let body = "";
      let seenBytes = 0;
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => {
        seenBytes += Buffer.byteLength(chunk);
        if (seenBytes > MAX_INGEST_BYTES) {
          res.writeHead(413, { "Content-Type": "text/plain" });
          res.end("Payload Too Large");
          try { req.destroy(); } catch { /* ignore */ }
          return;
        }
        body += chunk;
      });

      req.on("end", () => {
        try {
          const parsed = JSON.parse(body) as unknown;
          if (!isProgressEvent(parsed)) {
            res.writeHead(400, { "Content-Type": "text/plain" });
            res.end("Invalid ProgressEvent");
            return;
          }

          this.emitToSseClients(parsed);
          res.writeHead(204);
          res.end();
        } catch {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("Invalid JSON");
        }
      });

      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  }
}

function isProgressEvent(value: unknown): value is ProgressEvent {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.timestamp === "string" &&
    typeof v.operationId === "string" &&
    typeof v.type === "string" &&
    typeof v.content === "string"
  );
}

/** Singleton instance */
export const progressServer = new ProgressServer();
