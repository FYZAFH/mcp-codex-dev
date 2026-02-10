// ─── Codex CLI Event Types (from --json output) ─────────────────────────

export interface CodexEvent {
  type: string;
  [key: string]: unknown;
}

export interface CodexThreadStartedEvent extends CodexEvent {
  type: "thread.started";
  session_id?: string;
  thread_id?: string;
}

export interface CodexItemEvent extends CodexEvent {
  type: string; // "item.created", "item.completed", etc.
  item?: {
    type: string;
    role?: string;
    content?: Array<{ type: string; text?: string }>;
  };
}

export interface CodexFileChangeEvent extends CodexEvent {
  type: "item.created";
  item?: {
    type: "file_change";
    filename?: string;
    action?: "created" | "modified" | "deleted";
  };
}

// ─── Session Types ──────────────────────────────────────────────────────

export interface TrackedSession {
  sessionId: string;
  type: "write" | "review";
  instruction?: string;
  baseSha?: string;
  headSha?: string;
  createdAt: string;
  lastResumedAt?: string;
  linkedSessionId?: string;
  status: "active" | "completed" | "abandoned";
}

export interface SessionStore {
  sessions: Record<string, TrackedSession>;
}

// ─── Progress Event Types ───────────────────────────────────────────────

export interface ProgressEvent {
  timestamp: string;
  operationId: string;
  type:
    | "start"
    | "reasoning"
    | "command"
    | "command_result"
    | "file_change"
    | "message"
    | "end"
    | "error";
  content: string;
}

// ─── Config Types ───────────────────────────────────────────────────────

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface ToolConfig {
  enabled?: boolean;
  model?: string;
  sandbox?: SandboxMode;
  timeout?: number;
}

export interface CodexDevConfig {
  // Global defaults
  model?: string;
  sandbox?: SandboxMode;
  timeout?: number;

  // Non-tool-specific settings
  sessionCleanupHours?: number;
  reviewTemplate?: string;
  progressPort?: number;

  // Per-tool overrides (keyed by tool name, e.g. "codex_write", "codex_review")
  tools?: Record<string, ToolConfig>;
}

export interface ResolvedToolConfig {
  enabled: boolean;
  model?: string;
  sandbox: SandboxMode;
  timeout?: number;
}

// ─── Codex Executor Types ───────────────────────────────────────────────

export interface ExecuteOptions {
  cwd?: string;
  timeout?: number;
  env?: Record<string, string>;
}

export interface ExecuteResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface ParsedCodexOutput {
  sessionId: string;
  summary: string;
  filesModified: string[];
  filesCreated: string[];
  rawEvents: CodexEvent[];
  agentMessages: string[];
}

// ─── Tool Return Types ──────────────────────────────────────────────────

export interface CodexWriteResult {
  success: boolean;
  sessionId: string;
  output: {
    summary: string;
    filesModified: string[];
    filesCreated: string[];
  };
  status: "completed" | "needs_review" | "error";
  error?: CodexErrorInfo;
}

export interface CodexReviewResult {
  success: boolean;
  sessionId: string;
  specSessionId?: string;
  qualitySessionId?: string;
  review: string;
  error?: CodexErrorInfo;
}

export interface CodexSessionDiscardResult {
  success: boolean;
  discarded: string[];
  failed: Array<{ sessionId: string; reason: string }>;
}

// ─── Error Types ────────────────────────────────────────────────────────

export enum CodexErrorCode {
  CODEX_NOT_FOUND = "CODEX_NOT_FOUND",
  CODEX_EXECUTION_FAILED = "CODEX_EXECUTION_FAILED",
  CODEX_TIMEOUT = "CODEX_TIMEOUT",
  CODEX_INVALID_OUTPUT = "CODEX_INVALID_OUTPUT",
  SESSION_NOT_FOUND = "SESSION_NOT_FOUND",
  SESSION_CORRUPTED = "SESSION_CORRUPTED",
  CONFIG_INVALID = "CONFIG_INVALID",
  GIT_SHA_NOT_FOUND = "GIT_SHA_NOT_FOUND",
  UNKNOWN_ERROR = "UNKNOWN_ERROR",
}

export interface CodexErrorInfo {
  code: CodexErrorCode;
  message: string;
  recoverable: boolean;
  suggestion?: string;
}
