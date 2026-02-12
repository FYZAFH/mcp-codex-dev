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

export const CodexExecParamsSchema = z.object({
  instruction: z.string().describe("Instruction for Codex CLI"),
  sessionId: z.string().uuid().optional().describe("Resume an existing session by ID"),
  workingDirectory: z.string().optional().describe("Working directory path"),
});

export type CodexExecParams = z.infer<typeof CodexExecParamsSchema>;

export async function codexExec(
  params: CodexExecParams,
  extra?: { signal?: AbortSignal }
): Promise<CodexWriteResult> {
  const config = await loadConfig({ workingDirectory: params.workingDirectory });
  const toolCfg = getToolConfig(config, "exec");
  const executor = await CodexExecutor.create({
    workingDirectory: params.workingDirectory,
  });

  try {
    const operationId = `exec-${crypto.randomUUID()}`;
    progressServer.startOperation(operationId, "write", params.instruction.slice(0, 120));

    if (params.sessionId) {
      await sessionManager.updateStatus(params.sessionId, "active", {
        workingDirectory: params.workingDirectory,
      });
    }

    let result;
    try {
      result = await executor.executeWrite(params.instruction, {
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

    const parsed = executor.parseOutput(result.stdout);
    const sessionId = parsed.sessionId || params.sessionId;
    if (!sessionId) {
      throw {
        code: CodexErrorCode.CODEX_INVALID_OUTPUT,
        message: "Codex CLI did not return a session ID.",
        recoverable: false,
      } satisfies CodexErrorInfo;
    }

    const trackedStatus = result.exitCode !== 0 ? "abandoned" : "completed";
    if (params.sessionId) {
      await sessionManager.markResumed(params.sessionId, {
        workingDirectory: params.workingDirectory,
      });
      await sessionManager.updateStatus(params.sessionId, trackedStatus, {
        workingDirectory: params.workingDirectory,
      });
    } else {
      await sessionManager.track({
        sessionId,
        type: "exec",
        instruction: params.instruction,
        createdAt: new Date().toISOString(),
        status: trackedStatus,
      }, { workingDirectory: params.workingDirectory });
    }

    let status: CodexWriteResult["status"] = "completed";
    if (result.exitCode !== 0) {
      status = "error";
    } else if (parsed.filesCreated.length > 0 || parsed.filesModified.length > 0) {
      status = "needs_review";
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
    if (params.sessionId) {
      try {
        await sessionManager.updateStatus(params.sessionId, "abandoned", {
          workingDirectory: params.workingDirectory,
        });
      } catch {
        /* best effort */
      }
    }
    const errorInfo = error as CodexErrorInfo;
    return {
      success: false,
      sessionId: params.sessionId || "",
      output: { summary: "", filesModified: [], filesCreated: [] },
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
