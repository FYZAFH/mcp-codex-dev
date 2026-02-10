import { spawn } from "node:child_process";
import {
  CodexDevConfig,
  SandboxMode,
  ExecuteOptions,
  ExecuteResult,
  ParsedCodexOutput,
  CodexErrorCode,
  CodexErrorInfo,
  CodexEvent,
  CodexThreadStartedEvent,
} from "../types/index.js";
import { loadConfig } from "../config/config.js";

export class CodexExecutor {
  private config: CodexDevConfig;

  constructor(config: CodexDevConfig) {
    this.config = config;
  }

  static async create(options: { workingDirectory?: string } = {}): Promise<CodexExecutor> {
    const config = await loadConfig({ workingDirectory: options.workingDirectory });
    return new CodexExecutor(config);
  }

  async checkCodexInstalled(): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn("codex", ["--version"], { shell: true });
      child.on("error", () => {
        reject(this.createError(CodexErrorCode.CODEX_NOT_FOUND));
      });
      child.on("exit", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(this.createError(CodexErrorCode.CODEX_NOT_FOUND));
        }
      });
    });
  }

  async executeWrite(
    instruction: string,
    options: {
      sessionId?: string;
      workingDirectory?: string;
      model?: string;
      sandbox?: SandboxMode;
      timeout?: number;
      onLine?: (line: string) => void;
      signal?: AbortSignal;
    }
  ): Promise<ExecuteResult> {
    await this.checkCodexInstalled();

    const { args, stdinContent } = this.buildWriteArgs(instruction, options);
    return this.spawnCodex(args, {
      cwd: options.workingDirectory,
      timeout: options.timeout ?? this.config.timeout,
      stdinContent,
      onLine: options.onLine,
      signal: options.signal,
    });
  }

  async executeReview(
    reviewPrompt: string,
    options: {
      sessionId?: string;
      workingDirectory?: string;
      model?: string;
      sandbox?: SandboxMode;
      timeout?: number;
      onLine?: (line: string) => void;
      signal?: AbortSignal;
    }
  ): Promise<ExecuteResult> {
    await this.checkCodexInstalled();

    const { args, stdinContent } = this.buildReviewArgs(reviewPrompt, options);
    return this.spawnCodex(args, {
      cwd: options.workingDirectory,
      timeout: options.timeout ?? this.config.timeout,
      stdinContent,
      onLine: options.onLine,
      signal: options.signal,
    });
  }

  private buildWriteArgs(
    instruction: string,
    options: {
      sessionId?: string;
      model?: string;
      sandbox?: SandboxMode;
    }
  ): { args: string[]; stdinContent: string } {
    const args: string[] = [];

    // Always use stdin to avoid shell injection with shell: true
    if (options.sessionId) {
      args.push("exec", "resume", options.sessionId, "-");
    } else {
      args.push("exec", "-");
    }

    args.push("--json");

    const model = options.model || this.config.model;
    if (model) {
      args.push("--model", model);
    }

    // --sandbox is only valid for new sessions, not resume
    if (!options.sessionId) {
      const sandboxMode = options.sandbox || this.config.sandbox || "danger-full-access";
      args.push("--sandbox", sandboxMode);
    }

    return { args, stdinContent: instruction };
  }

  private buildReviewArgs(
    reviewPrompt: string,
    options: {
      sessionId?: string;
      model?: string;
      sandbox?: SandboxMode;
    }
  ): { args: string[]; stdinContent: string } {
    const args: string[] = [];

    // Always use stdin to avoid shell injection with shell: true
    if (options.sessionId) {
      args.push("exec", "resume", options.sessionId, "-");
    } else {
      args.push("exec", "-");
    }

    args.push("--json");

    const model = options.model || this.config.model;
    if (model) {
      args.push("--model", model);
    }

    // --sandbox and -c are only valid for new sessions, not resume
    if (!options.sessionId) {
      const sandboxMode = options.sandbox || this.config.sandbox || "danger-full-access";
      args.push("--sandbox", sandboxMode);
      args.push("-c", "approval_policy=on-request");
    }

    return { args, stdinContent: reviewPrompt };
  }

  private spawnCodex(
    args: string[],
    options: ExecuteOptions & { stdinContent?: string; onLine?: (line: string) => void; signal?: AbortSignal }
  ): Promise<ExecuteResult> {
    return new Promise((resolve, reject) => {
      // If already aborted before spawning, reject immediately
      if (options.signal?.aborted) {
        reject(
          this.createError(
            CodexErrorCode.CODEX_EXECUTION_FAILED,
            "Operation was aborted before execution started"
          )
        );
        return;
      }

      // On Windows with shell: true, args with spaces need to be quoted
      const isWindows = process.platform === "win32";
      const quotedArgs = isWindows
        ? args.map((arg) => (arg.includes(" ") ? `"${arg}"` : arg))
        : args;

      const child = spawn("codex", quotedArgs, {
        cwd: options.cwd,
        shell: true,
        env: { ...process.env, ...options.env },
        stdio: options.stdinContent ? ["pipe", "pipe", "pipe"] : undefined,
      });

      // Listen for abort signal to kill the child process
      let aborted = false;
      const onAbort = () => {
        aborted = true;
        try {
          // On Windows, shell: true requires killing the process tree
          if (isWindows && child.pid) {
            spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { shell: true });
          } else {
            child.kill("SIGTERM");
          }
        } catch {
          // Process may already be dead
        }
      };
      if (options.signal) {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }

      // Write stdin content if provided (use setImmediate to ensure process is ready)
      if (options.stdinContent && child.stdin) {
        setImmediate(() => {
          child.stdin!.write(options.stdinContent);
          child.stdin!.end();
        });
      }

      let stdout = "";
      let stderr = "";
      let lineBuffer = "";

      child.stdout?.on("data", (data: Buffer) => {
        const chunk = data.toString();
        stdout += chunk;

        if (options.onLine) {
          lineBuffer += chunk;
          const parts = lineBuffer.split("\n");
          // Keep the last (possibly incomplete) part in the buffer
          lineBuffer = parts.pop()!;
          for (const line of parts) {
            if (line.trim()) {
              try {
                options.onLine(line);
              } catch {
                // Never let onLine errors break stdout collection
              }
            }
          }
        }
      });

      child.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      const timeout = options.timeout ?? this.config.timeout;
      const timer =
        typeof timeout === "number" && timeout > 0
          ? setTimeout(() => {
              try {
                if (isWindows && child.pid) {
                  spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { shell: true });
                } else {
                  child.kill("SIGTERM");
                }
              } catch {
                // Process may already be dead
              }
              reject(
                this.createError(
                  CodexErrorCode.CODEX_TIMEOUT,
                  `Execution timed out after ${timeout}ms`
                )
              );
            }, timeout)
          : null;

      child.on("exit", (code) => {
        if (timer) clearTimeout(timer);
        if (options.signal) {
          options.signal.removeEventListener("abort", onAbort);
        }
        // Flush remaining line buffer
        if (options.onLine && lineBuffer.trim()) {
          try {
            options.onLine(lineBuffer);
          } catch {
            // Never let onLine errors break result resolution
          }
        }
        if (aborted) {
          reject(
            this.createError(
              CodexErrorCode.CODEX_EXECUTION_FAILED,
              "Operation was aborted"
            )
          );
        } else {
          resolve({ stdout, stderr, exitCode: code });
        }
      });

      child.on("error", (error) => {
        if (timer) clearTimeout(timer);
        if (options.signal) {
          options.signal.removeEventListener("abort", onAbort);
        }
        reject(
          this.createError(
            CodexErrorCode.CODEX_EXECUTION_FAILED,
            error.message
          )
        );
      });
    });
  }

  parseOutput(stdout: string): ParsedCodexOutput {
    const events: CodexEvent[] = [];
    const lines = stdout.trim().split("\n");

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as CodexEvent;
        events.push(event);
      } catch {
        // Skip non-JSON lines
      }
    }

    // Extract session ID from thread.started event
    let sessionId = "";
    const threadStarted = events.find(
      (e): e is CodexThreadStartedEvent => e.type === "thread.started"
    );
    const startedId = threadStarted?.session_id ?? threadStarted?.thread_id;
    if (startedId) {
      sessionId = startedId;
    }

    // Extract file changes
    const filesCreated: string[] = [];
    const filesModified: string[] = [];

    for (const event of events) {
      if (event.type === "item.completed" || event.type === "item.created") {
        const item = event.item as {
          type?: string;
          filename?: string;
          action?: string;
          changes?: Array<{ path: string; kind: string }>;
        } | undefined;

        if (item?.type === "file_change") {
          // Handle new format: changes array with {path, kind}
          if (item.changes && Array.isArray(item.changes)) {
            for (const change of item.changes) {
              if (change.kind === "add") {
                filesCreated.push(change.path);
              } else {
                filesModified.push(change.path);
              }
            }
          }
          // Handle old format: filename + action
          else if (item.filename) {
            if (item.action === "created") {
              filesCreated.push(item.filename);
            } else if (item.action === "modified") {
              filesModified.push(item.filename);
            }
          }
        }
      }
    }

    // Extract agent messages for summary
    const agentMessages: string[] = [];
    for (const event of events) {
      if (event.type === "item.completed" || event.type === "item.created") {
        const item = event.item as {
          type?: string;
          text?: string;
          role?: string;
          content?: Array<{ type: string; text?: string }>;
        } | undefined;

        // Handle new format: agent_message with text
        if (item?.type === "agent_message" && item.text) {
          agentMessages.push(item.text);
        }
        // Handle old format: assistant role with content array
        else if (item?.role === "assistant" && item.content) {
          for (const content of item.content) {
            if (content.type === "text" && content.text) {
              agentMessages.push(content.text);
            }
          }
        }
      }
    }

    // Generate summary from last agent message or file changes
    let summary = "";
    if (agentMessages.length > 0) {
      const lastMessage = agentMessages[agentMessages.length - 1];
      summary = lastMessage.slice(0, 500);
    } else if (filesCreated.length > 0 || filesModified.length > 0) {
      const created = filesCreated.length
        ? `Created: ${filesCreated.join(", ")}`
        : "";
      const modified = filesModified.length
        ? `Modified: ${filesModified.join(", ")}`
        : "";
      summary = [created, modified].filter(Boolean).join(". ");
    }

    return {
      sessionId,
      summary,
      filesModified,
      filesCreated,
      rawEvents: events,
      agentMessages,
    };
  }

  private createError(
    code: CodexErrorCode,
    message?: string
  ): CodexErrorInfo {
    const errors: Record<CodexErrorCode, { message: string; recoverable: boolean; suggestion?: string }> = {
      [CodexErrorCode.CODEX_NOT_FOUND]: {
        message: "Codex CLI not found. Please install it first.",
        recoverable: false,
        suggestion: "Run: npm install -g @openai/codex",
      },
      [CodexErrorCode.CODEX_TIMEOUT]: {
        message: message || "Codex execution timed out",
        recoverable: true,
        suggestion: "Try increasing timeout or simplifying the instruction",
      },
      [CodexErrorCode.CODEX_EXECUTION_FAILED]: {
        message: message || "Codex execution failed",
        recoverable: true,
      },
      [CodexErrorCode.CODEX_INVALID_OUTPUT]: {
        message: message || "Failed to parse Codex output",
        recoverable: false,
      },
      [CodexErrorCode.SESSION_NOT_FOUND]: {
        message: message || "Session not found",
        recoverable: false,
      },
      [CodexErrorCode.SESSION_CORRUPTED]: {
        message: message || "Session data corrupted",
        recoverable: false,
      },
      [CodexErrorCode.CONFIG_INVALID]: {
        message: message || "Invalid configuration",
        recoverable: false,
      },
      [CodexErrorCode.GIT_SHA_NOT_FOUND]: {
        message: message || "Git SHA not found",
        recoverable: false,
      },
      [CodexErrorCode.UNKNOWN_ERROR]: {
        message: message || "Unknown error",
        recoverable: false,
      },
    };

    const errorInfo = errors[code];
    return {
      code,
      message: message || errorInfo.message,
      recoverable: errorInfo.recoverable,
      suggestion: errorInfo.suggestion,
    };
  }
}
