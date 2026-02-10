import * as http from "node:http";
import { ProgressEvent } from "../types/index.js";
import { getProgressPageHtml } from "../ui/progress-page.js";

const DEFAULT_PORT = 23120;

/**
 * Singleton HTTP + SSE server for streaming Codex progress events to a browser.
 */
class ProgressServer {
  private server: http.Server | null = null;
  private clients: Set<http.ServerResponse> = new Set();
  private port = DEFAULT_PORT;

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
          console.error(
            `codex-dev: progress port ${this.port} in use, progress server disabled`
          );
          this.server = null;
          resolve(); // non-fatal — don't block MCP startup
        } else {
          reject(err);
        }
      });

      this.server!.listen(this.port, "127.0.0.1", () => {
        console.error(
          `codex-dev: progress server listening on http://localhost:${this.port}`
        );
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
  }

  /**
   * Push a progress event to all connected SSE clients.
   */
  emit(event: ProgressEvent): void {
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

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  }
}

/** Singleton instance */
export const progressServer = new ProgressServer();
