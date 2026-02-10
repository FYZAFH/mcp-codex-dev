import * as fs from "node:fs";
import * as path from "node:path";
import { TrackedSession, SessionStore } from "../types/index.js";
import { MCP_DATA_DIR } from "../config/config.js";

const TRACKING_DIR = MCP_DATA_DIR;
const TRACKING_FILE = path.join(TRACKING_DIR, "sessions.json");
const TRACKING_TMP = path.join(TRACKING_DIR, "sessions.json.tmp");

class SessionManager {
  private sessions: Map<string, TrackedSession> = new Map();
  private loaded = false;
  private writeQueue: Promise<void> = Promise.resolve();

  async load(): Promise<void> {
    if (this.loaded) return;

    try {
      if (fs.existsSync(TRACKING_FILE)) {
        const content = await fs.promises.readFile(TRACKING_FILE, "utf-8");
        const data = JSON.parse(content) as SessionStore;
        this.sessions = new Map(Object.entries(data.sessions));
      }
    } catch {
      this.sessions = new Map();
    }

    this.loaded = true;
  }

  private async save(): Promise<void> {
    // Serialize writes through a queue to prevent concurrent corruption
    this.writeQueue = this.writeQueue.then(() => this.doSave()).catch(() => {});
    return this.writeQueue;
  }

  private async doSave(): Promise<void> {
    await fs.promises.mkdir(TRACKING_DIR, { recursive: true });
    const data: SessionStore = {
      sessions: Object.fromEntries(this.sessions),
    };
    const content = JSON.stringify(data, null, 2);
    // Atomic write: write to temp file, then rename
    await fs.promises.writeFile(TRACKING_TMP, content);
    await fs.promises.rename(TRACKING_TMP, TRACKING_FILE);
  }

  async track(session: TrackedSession): Promise<void> {
    await this.load();
    this.sessions.set(session.sessionId, session);
    await this.save();
  }

  async get(sessionId: string): Promise<TrackedSession | undefined> {
    await this.load();
    return this.sessions.get(sessionId);
  }

  async updateStatus(
    sessionId: string,
    status: TrackedSession["status"]
  ): Promise<void> {
    await this.load();
    const session = this.sessions.get(sessionId);
    if (session) {
      session.status = status;
      session.lastResumedAt = new Date().toISOString();
      await this.save();
    }
  }

  async markResumed(sessionId: string): Promise<void> {
    await this.load();
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastResumedAt = new Date().toISOString();
      await this.save();
    }
  }

  async link(writeSessionId: string, reviewSessionId: string): Promise<void> {
    await this.load();
    const writeSession = this.sessions.get(writeSessionId);
    const reviewSession = this.sessions.get(reviewSessionId);

    if (writeSession) {
      writeSession.linkedSessionId = reviewSessionId;
    }
    if (reviewSession) {
      reviewSession.linkedSessionId = writeSessionId;
    }

    await this.save();
  }

  async remove(sessionId: string): Promise<boolean> {
    await this.load();
    const existed = this.sessions.delete(sessionId);
    if (existed) {
      await this.save();
    }
    return existed;
  }

  async removeMultiple(sessionIds: string[]): Promise<{
    removed: string[];
    notFound: string[];
  }> {
    await this.load();
    const removed: string[] = [];
    const notFound: string[] = [];

    for (const sessionId of sessionIds) {
      if (this.sessions.delete(sessionId)) {
        removed.push(sessionId);
      } else {
        notFound.push(sessionId);
      }
    }

    if (removed.length > 0) {
      await this.save();
    }

    return { removed, notFound };
  }

  async listActive(): Promise<TrackedSession[]> {
    await this.load();
    return Array.from(this.sessions.values()).filter(
      (s) => s.status === "active"
    );
  }

  async listAll(): Promise<TrackedSession[]> {
    await this.load();
    return Array.from(this.sessions.values());
  }

  async listByType(type: "write" | "review"): Promise<TrackedSession[]> {
    await this.load();
    return Array.from(this.sessions.values()).filter((s) => s.type === type);
  }

  async cleanup(maxAgeHours: number = 48): Promise<string[]> {
    await this.load();
    const now = Date.now();
    const toRemove: string[] = [];

    for (const [id, session] of this.sessions) {
      const lastActivity = session.lastResumedAt || session.createdAt;
      const ageHours =
        (now - new Date(lastActivity).getTime()) / (1000 * 60 * 60);

      // Cleanup only affects our tracking file; it does NOT delete Codex CLI session directories.
      if (ageHours > maxAgeHours) {
        toRemove.push(id);
      }
    }

    for (const id of toRemove) {
      this.sessions.delete(id);
    }

    if (toRemove.length > 0) {
      await this.save();
    }

    return toRemove;
  }
}

export const sessionManager = new SessionManager();
