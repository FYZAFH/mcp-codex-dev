import { z } from "zod";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { loadConfigWithDiagnostics, MCP_DATA_DIR } from "../config/config.js";
import { sessionManager } from "../services/session-manager.js";

export const CodexHealthParamsSchema = z.object({
  workingDirectory: z
    .string()
    .optional()
    .describe("Directory to check (defaults to process.cwd())"),
  checkGit: z
    .boolean()
    .optional()
    .default(true)
    .describe("Check Git availability and repo status"),
  ensureTrackingDir: z
    .boolean()
    .optional()
    .default(false)
    .describe("Create ~/.mcp/mcp-codex-dev if missing"),
});

export type CodexHealthParams = z.infer<typeof CodexHealthParamsSchema>;

type CommandResult = {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: string;
};

export async function codexHealth(params: CodexHealthParams): Promise<{
  ok: boolean;
  checks: Record<string, unknown>;
  suggestions: string[];
}> {
  const suggestions: string[] = [];
  const checks: Record<string, unknown> = {};

  const workingDirectory = params.workingDirectory ?? process.cwd();
  checks.node = {
    version: process.version,
    platform: process.platform,
    arch: process.arch,
  };

  // Config (effective + diagnostics)
  const { config, diagnostics } = await loadConfigWithDiagnostics({
    workingDirectory,
  });
  checks.config = {
    effective: config,
    diagnostics,
  };
  if (diagnostics.warnings.length > 0) {
    suggestions.push("Fix config warnings (see checks.config.diagnostics.warnings).");
  }

  // Filesystem / tracking
  const codexHomeDir = path.join(os.homedir(), ".codex");
  const codexCliConfigToml = path.join(codexHomeDir, "config.toml");
  const trackingDir = MCP_DATA_DIR;
  const codexSessionsDir = path.join(codexHomeDir, "sessions");

  const tracking: {
    dir: string;
    exists: boolean;
    writable?: boolean;
    error?: string;
  } = {
    dir: trackingDir,
    exists: fs.existsSync(trackingDir),
  };

  if (!tracking.exists && params.ensureTrackingDir) {
    try {
      await fs.promises.mkdir(trackingDir, { recursive: true });
      tracking.exists = true;
    } catch (error) {
      tracking.error = error instanceof Error ? error.message : String(error);
      suggestions.push(`Fix filesystem permissions for ${trackingDir}.`);
    }
  }

  if (tracking.exists) {
    try {
      await fs.promises.access(trackingDir, fs.constants.W_OK);
      tracking.writable = true;
    } catch {
      tracking.writable = false;
      suggestions.push(`Make ${trackingDir} writable (used for sessions.json).`);
    }
  } else {
    suggestions.push(
      `Tracking dir missing: ${trackingDir} (it will be created on first run).`
    );
  }

  checks.filesystem = {
    workingDirectory,
    workingDirectoryExists: fs.existsSync(workingDirectory),
    codexHomeDir,
    codexCliConfig: readCodexTomlModelHint(codexCliConfigToml),
    trackingDir: tracking,
    codexSessionsDir: {
      dir: codexSessionsDir,
      exists: fs.existsSync(codexSessionsDir),
    },
  };

  if (!fs.existsSync(workingDirectory)) {
    suggestions.push(`Set a valid workingDirectory (not found: ${workingDirectory}).`);
  }

  // Codex CLI
  const codexVersion = await runCommand("codex", ["--version"], {
    timeoutMs: 5000,
  });
  checks.codex = {
    installed: codexVersion.ok,
    version: codexVersion.stdout.trim() || undefined,
    error: codexVersion.error || (codexVersion.ok ? undefined : codexVersion.stderr.trim()),
  };
  if (!codexVersion.ok) {
    suggestions.push("Install Codex CLI (e.g. `npm install -g @openai/codex`) and ensure it is on PATH.");
  }

  // Git checks (optional)
  if (params.checkGit) {
    const gitVersion = await runCommand("git", ["--version"], {
      timeoutMs: 5000,
    });
    const git: Record<string, unknown> = {
      available: gitVersion.ok,
      version: gitVersion.stdout.trim() || undefined,
      error: gitVersion.error || (gitVersion.ok ? undefined : gitVersion.stderr.trim()),
    };

    if (gitVersion.ok && fs.existsSync(workingDirectory)) {
      const inside = await runCommand("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: workingDirectory,
        timeoutMs: 5000,
      });
      const isRepo = inside.ok && inside.stdout.trim() === "true";
      git.repo = {
        isGitRepo: isRepo,
      };
      if (isRepo) {
        const top = await runCommand("git", ["rev-parse", "--show-toplevel"], {
          cwd: workingDirectory,
          timeoutMs: 5000,
        });
        if (top.ok) {
          (git.repo as Record<string, unknown>).root = top.stdout.trim();
        }
      } else {
        suggestions.push("Run codex_review in a Git repo (or set workingDirectory to a repo root).");
      }
    } else if (!gitVersion.ok) {
      suggestions.push("Install Git and ensure it is on PATH (required for codex_review).");
    }

    checks.git = git;
  }

  // Session tracking stats
  await sessionManager.load();
  const sessions = await sessionManager.listAll();
  checks.sessions = {
    trackedCount: sessions.length,
    byStatus: {
      active: sessions.filter((s) => s.status === "active").length,
      completed: sessions.filter((s) => s.status === "completed").length,
      abandoned: sessions.filter((s) => s.status === "abandoned").length,
    },
  };

  if (config.sandbox === "danger-full-access") {
    suggestions.push(
      "Avoid sandbox.mode=danger-full-access unless absolutely necessary."
    );
  }

  const ok =
    (checks.codex as { installed: boolean }).installed &&
    (tracking.writable ?? true) &&
    fs.existsSync(workingDirectory);

  return { ok, checks, suggestions };
}

function readCodexTomlModelHint(filePath: string): {
  path: string;
  exists: boolean;
  model?: string;
  error?: string;
} {
  const result: {
    path: string;
    exists: boolean;
    model?: string;
    error?: string;
  } = {
    path: filePath,
    exists: fs.existsSync(filePath),
  };

  if (!result.exists) return result;

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const match = content.match(/^\s*model\s*=\s*["']([^"']+)["']\s*$/m);
    if (match?.[1]) {
      result.model = match[1];
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }

  return result;
}

async function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs: number }
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: true,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      resolve({
        ok: false,
        exitCode: null,
        stdout,
        stderr,
        error: `Timed out after ${options.timeoutMs}ms`,
      });
    }, options.timeoutMs);

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        exitCode: null,
        stdout,
        stderr,
        error: error.message,
      });
    });

    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        exitCode: code,
        stdout,
        stderr,
      });
    });
  });
}
