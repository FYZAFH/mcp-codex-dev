import { z } from "zod";
import * as crypto from "node:crypto";
import { CodexExecutor } from "../services/codex-executor.js";
import { progressServer } from "../services/progress-server.js";
import { sessionManager } from "../services/session-manager.js";
import { mapCodexLineToProgressEvent } from "../services/event-mapper.js";
import { loadConfig, getToolConfig } from "../config/config.js";
import {
  CodexWriteResult,
  CodexErrorCode,
  CodexErrorInfo,
} from "../types/index.js";

export const CodexWriteParamsSchema = z.object({
  instruction: z.string().describe("Detailed code writing instruction describing the functionality to implement"),
  sessionId: z.string().uuid().optional().describe("Optional, existing session ID for resuming"),
  workingDirectory: z.string().optional().describe("Working directory, defaults to current directory"),
  planReference: z.string().optional().describe("Plan file path or content summary"),
});

export type CodexWriteParams = z.infer<typeof CodexWriteParamsSchema>;

export async function codexWrite(
  params: CodexWriteParams,
  extra?: { signal?: AbortSignal }
): Promise<CodexWriteResult> {
  const config = await loadConfig({ workingDirectory: params.workingDirectory });
  const toolCfg = getToolConfig(config, "codex_write");
  const executor = await CodexExecutor.create({
    workingDirectory: params.workingDirectory,
  });

  // Build full instruction with plan reference if provided
  let fullInstruction = params.instruction;
  if (params.planReference) {
    fullInstruction = `## Context\n\nPlan/Requirements Reference:\n${params.planReference}\n\n## Task\n\n${params.instruction}`;
  }

  try {
    // Execute Codex
    const operationId = `write-${crypto.randomUUID()}`;
    progressServer.startOperation(operationId, "write", params.instruction.slice(0, 120));

    // Track session as active before execution
    const preSessionId = params.sessionId;
    if (preSessionId) {
      await sessionManager.updateStatus(preSessionId, "active");
    }

    let result;
    try {
      result = await executor.executeWrite(fullInstruction, {
        sessionId: params.sessionId,
        workingDirectory: params.workingDirectory,
        model: toolCfg.model,
        sandbox: toolCfg.sandbox,
        timeout: toolCfg.timeout,
        onLine: (line) => {
          const event = mapCodexLineToProgressEvent(line, operationId);
          if (event) progressServer.emit(event);
        },
        signal: extra?.signal,
      });
    } finally {
      progressServer.endOperation(operationId, result?.exitCode === 0);
    }

    // Parse output
    const parsed = executor.parseOutput(result.stdout);
    if (!params.sessionId && !parsed.sessionId) {
      throw {
        code: CodexErrorCode.CODEX_INVALID_OUTPUT,
        message:
          "Codex CLI did not emit a session_id/thread_id in --json output. Ensure Codex CLI is up to date and that --json output is enabled.",
        recoverable: false,
      } satisfies CodexErrorInfo;
    }

    // Determine status
    let status: CodexWriteResult["status"] = "completed";
    if (result.exitCode !== 0) {
      status = "error";
    } else if (parsed.filesCreated.length > 0 || parsed.filesModified.length > 0) {
      status = "needs_review";
    }

    // Track session
    const sessionId = parsed.sessionId || params.sessionId;
    if (!sessionId) {
      throw {
        code: CodexErrorCode.CODEX_INVALID_OUTPUT,
        message:
          "Missing sessionId (neither parsed from Codex output nor provided via params.sessionId).",
        recoverable: false,
      } satisfies CodexErrorInfo;
    }
    const trackedStatus = result.exitCode !== 0 ? "abandoned" : "completed";

    if (params.sessionId) {
      // Resuming existing session
      await sessionManager.markResumed(params.sessionId);
      await sessionManager.updateStatus(params.sessionId, trackedStatus);
    } else {
      // New session
      await sessionManager.track({
        sessionId,
        type: "write",
        instruction: params.instruction,
        createdAt: new Date().toISOString(),
        status: trackedStatus,
      });
    }

    return {
      success: result.exitCode === 0,
      sessionId,
      output: {
        summary: parsed.summary,
        filesModified: parsed.filesModified,
        filesCreated: parsed.filesCreated,
      },
      status,
    };
  } catch (error) {
    // Restore session status if it was set to "active" before failure
    if (params.sessionId) {
      try { await sessionManager.updateStatus(params.sessionId, "abandoned"); } catch { /* best effort */ }
    }
    const errorInfo = error as CodexErrorInfo;
    return {
      success: false,
      sessionId: params.sessionId || "",
      output: {
        summary: "",
        filesModified: [],
        filesCreated: [],
      },
      status: "error",
      error: {
        code: errorInfo.code || CodexErrorCode.UNKNOWN_ERROR,
        message: errorInfo.message || String(error),
        recoverable: errorInfo.recoverable ?? false,
        suggestion: errorInfo.suggestion,
      },
    };
  }
}
