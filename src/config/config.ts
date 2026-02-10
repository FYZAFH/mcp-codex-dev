import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import {
  CodexDevConfig,
  ResolvedToolConfig,
  SandboxMode,
} from "../types/index.js";

// ─── Data directory ──────────────────────────────────────────────────────

/** All MCP process files (config, sessions, etc.) live here. */
export const MCP_DATA_DIR = path.join(os.homedir(), ".mcp", "mcp-codex-dev");

// ─── Diagnostics types ──────────────────────────────────────────────────

export type ConfigSourceKind = "env" | "project" | "mcp" | "codex";

export type ConfigSource = {
  kind: ConfigSourceKind;
  path: string;
  loaded: boolean;
  error?: string;
};

export type ConfigDiagnostics = {
  sources: ConfigSource[];
  warnings: string[];
  projectRoot?: string;
};

export type LoadConfigOptions = {
  workingDirectory?: string;
};

// ─── Schemas ─────────────────────────────────────────────────────────────

const PROJECT_CONFIG_PATH = path.join(".mcp", "mcp-codex-dev.config.json");

const SandboxModeSchema = z.enum([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);

const ToolConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    model: z.string().min(1).optional(),
    sandbox: SandboxModeSchema.optional(),
    timeout: z.number().int().positive().optional(),
  })
  .strip();

const ConfigSchema = z
  .object({
    model: z.string().min(1).optional(),
    sandbox: SandboxModeSchema.optional(),
    timeout: z.number().int().positive().optional(),
    sessionCleanupHours: z.number().int().positive().optional(),
    reviewTemplate: z.string().min(1).optional(),
    progressPort: z.number().int().positive().optional(),
    tools: z.record(z.string(), ToolConfigSchema).optional(),
  })
  .strip();

// ─── Cache ───────────────────────────────────────────────────────────────

const cachedByProjectRoot = new Map<
  string,
  { config: CodexDevConfig; diagnostics: ConfigDiagnostics }
>();

// ─── Public API ──────────────────────────────────────────────────────────

export async function loadConfig(
  options: LoadConfigOptions = {}
): Promise<CodexDevConfig> {
  const { config } = await loadConfigWithDiagnostics(options);
  return config;
}

export async function loadConfigWithDiagnostics(
  options: LoadConfigOptions = {}
): Promise<{
  config: CodexDevConfig;
  diagnostics: ConfigDiagnostics;
}> {
  const startDir = normalizeWorkingDirectory(options.workingDirectory);
  const projectRoot = findGitRoot(startDir) ?? startDir;
  const cached = cachedByProjectRoot.get(projectRoot);
  if (cached) {
    return cached;
  }

  const diagnostics: ConfigDiagnostics = {
    sources: [],
    warnings: [],
    projectRoot,
  };

  let config: Partial<CodexDevConfig> = {};

  // Lowest priority: Codex CLI's own config (~/.codex/config.toml) — model only
  const codexConfigPath = path.join(os.homedir(), ".codex", "config.toml");
  config = mergeCodexTomlConfig(config, codexConfigPath, diagnostics);

  // MCP user config (~/.mcp/mcp-codex-dev/config.json)
  const mcpConfigPath = path.join(MCP_DATA_DIR, "config.json");
  config = await mergeConfigFile(config, mcpConfigPath, diagnostics, "mcp");

  // Project config (<git_root>/.mcp/mcp-codex-dev.config.json)
  const projectConfigPath = path.join(projectRoot, PROJECT_CONFIG_PATH);
  config = await mergeConfigFile(
    config,
    projectConfigPath,
    diagnostics,
    "project"
  );

  // Highest priority: environment variable overrides
  config = applyEnvOverrides(config, diagnostics);

  // Validate final config (strip unknown keys)
  const parsed = ConfigSchema.safeParse(config);
  if (!parsed.success) {
    diagnostics.warnings.push(
      `Config validation failed; ignoring config. ${formatZodError(parsed.error)}`
    );
    config = {};
  } else {
    config = parsed.data;
  }

  const result = {
    config: config as CodexDevConfig,
    diagnostics,
  };
  cachedByProjectRoot.set(projectRoot, result);
  return result;
}

/**
 * Resolve per-tool config with fallback to global defaults.
 */
export function getToolConfig(
  config: CodexDevConfig,
  tool: string
): ResolvedToolConfig {
  const toolCfg = config.tools?.[tool];
  return {
    enabled: toolCfg?.enabled ?? true,
    model: toolCfg?.model ?? config.model,
    sandbox: toolCfg?.sandbox ?? config.sandbox ?? "danger-full-access",
    timeout: toolCfg?.timeout ?? config.timeout,
  };
}

/**
 * Check whether a tool is enabled (default: true).
 */
export function isToolEnabled(config: CodexDevConfig, tool: string): boolean {
  return config.tools?.[tool]?.enabled ?? true;
}

export function clearConfigCache(): void {
  cachedByProjectRoot.clear();
}

// ─── Merge helpers ───────────────────────────────────────────────────────

async function mergeConfigFile(
  config: Partial<CodexDevConfig>,
  filePath: string,
  diagnostics: ConfigDiagnostics,
  kind: "mcp" | "project"
): Promise<Partial<CodexDevConfig>> {
  try {
    if (!fs.existsSync(filePath)) {
      diagnostics.sources.push({ kind, path: filePath, loaded: false });
      return config;
    }

    const content = await fs.promises.readFile(filePath, "utf-8");
    const raw = JSON.parse(content) as unknown;
    const parsed = ConfigSchema.safeParse(raw);
    if (!parsed.success) {
      diagnostics.sources.push({
        kind,
        path: filePath,
        loaded: false,
        error: `Invalid config shape. ${formatZodError(parsed.error)}`,
      });
      return config;
    }

    const fileConfig = parsed.data as Partial<CodexDevConfig>;
    diagnostics.sources.push({ kind, path: filePath, loaded: true });

    // Deep merge: top-level fields + tools section
    const merged: Partial<CodexDevConfig> = {
      ...config,
      ...fileConfig,
    };

    // Merge tools section (file overrides config per-tool, not replaces entire tools)
    if (config.tools || fileConfig.tools) {
      merged.tools = {
        ...config.tools,
        ...fileConfig.tools,
      };
    }

    return merged;
  } catch (error) {
    diagnostics.sources.push({
      kind,
      path: filePath,
      loaded: false,
      error: error instanceof Error ? error.message : String(error),
    });
    return config;
  }
}

function mergeCodexTomlConfig(
  config: Partial<CodexDevConfig>,
  filePath: string,
  diagnostics: ConfigDiagnostics
): Partial<CodexDevConfig> {
  try {
    if (!fs.existsSync(filePath)) {
      diagnostics.sources.push({
        kind: "codex",
        path: filePath,
        loaded: false,
      });
      return config;
    }

    const content = fs.readFileSync(filePath, "utf-8");
    diagnostics.sources.push({ kind: "codex", path: filePath, loaded: true });

    const model = matchTomlString(content, "model");

    return {
      ...config,
      ...(model ? { model } : {}),
    };
  } catch (error) {
    diagnostics.sources.push({
      kind: "codex",
      path: filePath,
      loaded: false,
      error: error instanceof Error ? error.message : String(error),
    });
    return config;
  }
}

function applyEnvOverrides(
  config: Partial<CodexDevConfig>,
  diagnostics: ConfigDiagnostics
): Partial<CodexDevConfig> {
  const result: Partial<CodexDevConfig> = { ...config };
  let used = false;

  if (process.env.CODEX_DEV_MODEL) {
    result.model = process.env.CODEX_DEV_MODEL;
    used = true;
  }

  if (process.env.CODEX_DEV_REVIEW_MODEL) {
    // Map to tools.codex_review.model
    result.tools = {
      ...result.tools,
      codex_review: {
        ...result.tools?.codex_review,
        model: process.env.CODEX_DEV_REVIEW_MODEL,
      },
    };
    used = true;
  }

  if (process.env.CODEX_DEV_TIMEOUT) {
    const timeout = parseInt(process.env.CODEX_DEV_TIMEOUT, 10);
    if (!isNaN(timeout) && timeout > 0) {
      result.timeout = timeout;
      used = true;
    } else {
      diagnostics.warnings.push(
        `Ignoring invalid CODEX_DEV_TIMEOUT: ${process.env.CODEX_DEV_TIMEOUT}`
      );
    }
  }

  if (process.env.CODEX_DEV_SANDBOX_MODE) {
    const mode = process.env.CODEX_DEV_SANDBOX_MODE;
    if (
      mode === "read-only" ||
      mode === "workspace-write" ||
      mode === "danger-full-access"
    ) {
      result.sandbox = mode as SandboxMode;
      used = true;
    } else {
      diagnostics.warnings.push(
        `Ignoring invalid CODEX_DEV_SANDBOX_MODE: ${mode}`
      );
    }
  }

  if (used) {
    diagnostics.sources.push({ kind: "env", path: "<env>", loaded: true });
  }

  return result;
}

// ─── Utilities ───────────────────────────────────────────────────────────

function normalizeWorkingDirectory(workingDirectory?: string): string {
  return path.resolve(workingDirectory ?? process.cwd());
}

function findGitRoot(startDir: string): string | null {
  let current = startDir;
  while (true) {
    const gitPath = path.join(current, ".git");
    if (fs.existsSync(gitPath)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function matchTomlString(content: string, key: string): string | undefined {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `^\\s*${escapedKey}\\s*=\\s*["']([^"']+)["']\\s*$`,
    "m"
  );
  return re.exec(content)?.[1];
}

function formatZodError(error: z.ZodError): string {
  const firstIssue = error.issues[0];
  if (!firstIssue) return "Unknown validation error.";
  const where = firstIssue.path.length ? firstIssue.path.join(".") : "(root)";
  return `${where}: ${firstIssue.message}`;
}
