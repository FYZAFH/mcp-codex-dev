import * as fs from "node:fs";
import * as path from "node:path";
import { TrackedSession, SessionStore } from "../types/index.js";
import { resolveProjectRoot } from "../config/config.js";

type ProjectStore = {
  projectRoot: string;
  trackingDir: string;
  trackingFile: string;
  trackingTmp: string;
  sessions: Map<string, TrackedSession>;
  loaded: boolean;
  writeQueue: Promise<void>;
};

class SessionManager {
  private stores: Map<string, ProjectStore> = new Map();

  private getStore(workingDirectory?: string): ProjectStore {
    const projectRoot = resolveProjectRoot(workingDirectory);
    const existing = this.stores.get(projectRoot);
    if (existing) return existing;

    const trackingDir = path.join(projectRoot, ".mcp", "mcp-codex-dev");
    const store: ProjectStore = {
      projectRoot,
      trackingDir,
      trackingFile: path.join(trackingDir, "sessions.json"),
      trackingTmp: path.join(trackingDir, "sessions.json.tmp"),
      sessions: new Map(),
      loaded: false,
      writeQueue: Promise.resolve(),
    };
    this.stores.set(projectRoot, store);
    return store;
  }

  async load(options: { workingDirectory?: string } = {}): Promise<void> {
    const store = this.getStore(options.workingDirectory);
    if (store.loaded) return;

    try {
      if (fs.existsSync(store.trackingFile)) {
        const content = await fs.promises.readFile(store.trackingFile, "utf-8");
        const data = JSON.parse(content) as SessionStore;
        store.sessions = new Map(Object.entries(data.sessions));
      }
    } catch {
      store.sessions = new Map();
    }

    store.loaded = true;
  }

  private async save(store: ProjectStore): Promise<void> {
    // Serialize writes through a queue to prevent concurrent corruption
    store.writeQueue = store.writeQueue.then(() => this.doSave(store)).catch(() => {});
    return store.writeQueue;
  }

  private async doSave(store: ProjectStore): Promise<void> {
    await fs.promises.mkdir(store.trackingDir, { recursive: true });
    const data: SessionStore = {
      sessions: Object.fromEntries(store.sessions),
    };
    const content = JSON.stringify(data, null, 2);
    // Atomic write: write to temp file, then rename
    await fs.promises.writeFile(store.trackingTmp, content);
    await fs.promises.rename(store.trackingTmp, store.trackingFile);
  }

  async track(session: TrackedSession, options: { workingDirectory?: string } = {}): Promise<void> {
    const store = this.getStore(options.workingDirectory);
    await this.load(options);
    store.sessions.set(session.sessionId, session);
    await this.save(store);
  }

  async get(sessionId: string, options: { workingDirectory?: string } = {}): Promise<TrackedSession | undefined> {
    const store = this.getStore(options.workingDirectory);
    await this.load(options);
    return store.sessions.get(sessionId);
  }

  async updateStatus(
    sessionId: string,
    status: TrackedSession["status"],
    options: { workingDirectory?: string } = {}
  ): Promise<void> {
    const store = this.getStore(options.workingDirectory);
    await this.load(options);
    const session = store.sessions.get(sessionId);
    if (session) {
      session.status = status;
      session.lastResumedAt = new Date().toISOString();
      await this.save(store);
    }
  }

  async markResumed(sessionId: string, options: { workingDirectory?: string } = {}): Promise<void> {
    const store = this.getStore(options.workingDirectory);
    await this.load(options);
    const session = store.sessions.get(sessionId);
    if (session) {
      session.lastResumedAt = new Date().toISOString();
      await this.save(store);
    }
  }

  async link(
    writeSessionId: string,
    reviewSessionId: string,
    options: { workingDirectory?: string } = {}
  ): Promise<void> {
    const store = this.getStore(options.workingDirectory);
    await this.load(options);
    const writeSession = store.sessions.get(writeSessionId);
    const reviewSession = store.sessions.get(reviewSessionId);

    if (writeSession) {
      writeSession.linkedSessionId = reviewSessionId;
    }
    if (reviewSession) {
      reviewSession.linkedSessionId = writeSessionId;
    }

    await this.save(store);
  }

  async remove(sessionId: string, options: { workingDirectory?: string } = {}): Promise<boolean> {
    const store = this.getStore(options.workingDirectory);
    await this.load(options);
    const existed = store.sessions.delete(sessionId);
    if (existed) {
      await this.save(store);
    }
    return existed;
  }

  async removeMultiple(sessionIds: string[], options: { workingDirectory?: string } = {}): Promise<{
    removed: string[];
    notFound: string[];
  }> {
    const store = this.getStore(options.workingDirectory);
    await this.load(options);
    const removed: string[] = [];
    const notFound: string[] = [];

    for (const sessionId of sessionIds) {
      if (store.sessions.delete(sessionId)) {
        removed.push(sessionId);
      } else {
        notFound.push(sessionId);
      }
    }

    if (removed.length > 0) {
      await this.save(store);
    }

    return { removed, notFound };
  }

  async listActive(options: { workingDirectory?: string } = {}): Promise<TrackedSession[]> {
    const store = this.getStore(options.workingDirectory);
    await this.load(options);
    return Array.from(store.sessions.values()).filter(
      (s) => s.status === "active"
    );
  }

  async listAll(options: { workingDirectory?: string } = {}): Promise<TrackedSession[]> {
    const store = this.getStore(options.workingDirectory);
    await this.load(options);
    return Array.from(store.sessions.values());
  }

  async listByType(
    type: "write" | "review",
    options: { workingDirectory?: string } = {}
  ): Promise<TrackedSession[]> {
    const store = this.getStore(options.workingDirectory);
    await this.load(options);
    return Array.from(store.sessions.values()).filter((s) => s.type === type);
  }

  async cleanup(
    maxAgeHours: number = 48,
    options: { workingDirectory?: string } = {}
  ): Promise<string[]> {
    const store = this.getStore(options.workingDirectory);
    await this.load(options);
    const now = Date.now();
    const toRemove: string[] = [];

    for (const [id, session] of store.sessions) {
      const lastActivity = session.lastResumedAt || session.createdAt;
      const ageHours =
        (now - new Date(lastActivity).getTime()) / (1000 * 60 * 60);

      // Cleanup only affects our tracking file; it does NOT delete Codex CLI session directories.
      if (ageHours > maxAgeHours) {
        toRemove.push(id);
      }
    }

    for (const id of toRemove) {
      store.sessions.delete(id);
    }

    if (toRemove.length > 0) {
      await this.save(store);
    }

    return toRemove;
  }
}

export const sessionManager = new SessionManager();
