import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { sessionManager } from "../services/session-manager.js";
import { CodexSessionDiscardResult } from "../types/index.js";

export const CodexSessionDiscardParamsSchema = z.object({
  sessionIds: z.array(z.string()).describe("List of session IDs to discard"),
  force: z.boolean().optional().default(false).describe("Force discard, ignore warnings"),
});

export type CodexSessionDiscardParams = z.infer<
  typeof CodexSessionDiscardParamsSchema
>;

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function codexSessionDiscard(
  params: CodexSessionDiscardParams
): Promise<CodexSessionDiscardResult> {
  const result: CodexSessionDiscardResult = {
    success: true,
    discarded: [],
    failed: [],
  };

  for (const sessionId of params.sessionIds) {
    try {
      // Validate sessionId format to prevent path traversal
      if (!SESSION_ID_RE.test(sessionId)) {
        result.failed.push({
          sessionId,
          reason: "Invalid session ID format (expected UUID).",
        });
        result.success = false;
        continue;
      }
      const tracked = await sessionManager.get(sessionId);
      if (tracked?.status === "active" && !params.force) {
        result.failed.push({
          sessionId,
          reason:
            "Session is still marked as active. Pass force=true to discard anyway.",
        });
        result.success = false;
        continue;
      }

      // Try to delete Codex session files
      const codexSessionPath = path.join(
        os.homedir(),
        ".codex",
        "sessions",
        sessionId
      );

      if (fs.existsSync(codexSessionPath)) {
        await fs.promises.rm(codexSessionPath, {
          recursive: true,
          force: params.force,
        });
      }

      // Remove from our tracking
      await sessionManager.remove(sessionId);

      result.discarded.push(sessionId);
    } catch (error) {
      result.failed.push({
        sessionId,
        reason: error instanceof Error ? error.message : String(error),
      });
      result.success = false;
    }
  }

  return result;
}

export const CodexSessionListParamsSchema = z.object({
  type: z.enum(["write", "review", "exec", "all"]).optional().default("all"),
  status: z
    .enum(["active", "completed", "abandoned", "all"])
    .optional()
    .default("active"),
});

export type CodexSessionListParams = z.infer<typeof CodexSessionListParamsSchema>;

export async function codexSessionList(
  params: CodexSessionListParams
): Promise<{
  sessions: Array<{
    sessionId: string;
    type: "write" | "review" | "exec";
    createdAt: string;
    status: string;
  }>;
}> {
  let sessions = await sessionManager.listAll();

  if (params.type !== "all") {
    sessions = sessions.filter((s) => s.type === params.type);
  }

  if (params.status !== "all") {
    sessions = sessions.filter((s) => s.status === params.status);
  }

  return {
    sessions: sessions.map((s) => ({
      sessionId: s.sessionId,
      type: s.type,
      createdAt: s.createdAt,
      status: s.status,
    })),
  };
}
