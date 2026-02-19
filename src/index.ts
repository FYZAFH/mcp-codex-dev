#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { codexExec } from "./tools/codex-exec.js";
import { codexReview } from "./tools/codex-review.js";
import { codexTdd } from "./tools/codex-tdd.js";
import { codexHealth } from "./tools/codex-health.js";
import {
  codexSessionDiscard,
  codexSessionList,
} from "./tools/codex-session.js";
import { sessionManager } from "./services/session-manager.js";
import { progressServer } from "./services/progress-server.js";
import { loadConfigWithDiagnostics, isToolEnabled } from "./config/config.js";

async function main() {
  // Initialize session manager
  await sessionManager.load();

  // Load config once and surface any warnings for easier troubleshooting
  const { config, diagnostics } = await loadConfigWithDiagnostics();
  for (const warning of diagnostics.warnings) {
    console.error(`codex-dev: ${warning}`);
  }
  for (const source of diagnostics.sources) {
    if (source.error) {
      console.error(
        `codex-dev: config(${source.kind}) ${source.path}: ${source.error}`
      );
    }
  }

  // Cleanup stale tracking entries (does not delete Codex session directories)
  if (typeof config.sessionCleanupHours === "number") {
    const removed = await sessionManager.cleanup(config.sessionCleanupHours);
    if (removed.length > 0) {
      console.error(
        `codex-dev: cleaned up ${removed.length} stale session tracking entries`
      );
    }
  }

  // Start progress server (non-blocking; port conflict is non-fatal)
  await progressServer.start(config.progressPort);

  // Create MCP Server
  const server = new McpServer({
    name: "codex-dev",
    version: "1.0.0",
  });

  // ─── exec ──────────────────────────────────────────────────────────
  if (isToolEnabled(config, "exec")) {
    server.tool(
      "exec",
      "Invoke Codex CLI with a plain instruction. No template, no context wrapping — just raw execution. Supports session resume.",
      {
        instruction: z.string().describe("Instruction for Codex CLI"),
        sessionId: z
          .string()
          .optional()
          .describe("Resume an existing session by ID"),
        workingDirectory: z.string().optional().describe("Working directory path"),
      },
      async (params, extra) => {
        const result = await codexExec(params, extra);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }
    );
  }

  // ─── tdd ───────────────────────────────────────────────────────────
  if (isToolEnabled(config, "tdd")) {
    server.tool(
      "tdd",
      "Invoke Codex CLI to implement code using strict Test-Driven Development (Red-Green-Refactor). " +
        "Injects TDD methodology template that enforces writing tests before production code. " +
        "Supports session resume for iterative TDD cycles.",
      {
        instruction: z
          .string()
          .describe(
            "Detailed description of the feature or bug fix to implement using TDD"
          ),
        sessionId: z
          .string()
          .optional()
          .describe(
            "Resume an existing TDD session by ID (from previous tdd return value)"
          ),
        workingDirectory: z
          .string()
          .optional()
          .describe("Working directory path"),
        planReference: z
          .string()
          .optional()
          .describe(
            "Plan file path or content summary, used as coding context"
          ),
        taskContext: z
          .string()
          .optional()
          .describe(
            "Task position and context within the plan " +
              "(e.g. 'Task 3 of 5: Implement validation logic. Depends on Task 2 auth module.')"
          ),
        testFramework: z
          .string()
          .optional()
          .describe(
            "Test framework hint (e.g. 'jest', 'vitest', 'pytest', 'go test')"
          ),
      },
      async (params, extra) => {
        const result = await codexTdd(params, extra);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }
    );
  }

  // ─── review ────────────────────────────────────────────────────────
  if (isToolEnabled(config, "review")) {
    server.tool(
      "review",
      "Invoke Codex CLI for code review. Uses built-in code-reviewer template. " +
        "Pass git range and description info, returns structured review results. " +
        "Supports continuing previous review sessions via sessionId. " +
        "In 'full' mode, returns specSessionId and qualitySessionId separately (use with reviewType 'spec'/'quality' to resume each).",
      {
        instruction: z
          .string()
          .describe("Original task instruction (same as what was sent to tdd)"),
        whatWasImplemented: z.string().describe("Brief description of what was implemented (implementer's claim)"),
        baseSha: z.string().describe("Base commit SHA (review starting point)"),
        headSha: z
          .string()
          .optional()
          .default("HEAD")
          .describe("Target commit SHA, defaults to HEAD"),
        reviewType: z
          .enum(["spec", "quality", "full"])
          .optional()
          .default("full")
          .describe("Review type: spec (compliance only), quality (code quality only), full (both in parallel)"),
        sessionId: z
          .string()
          .optional()
          .describe("Continue an existing review session by ID (from previous review return value)"),
        workingDirectory: z.string().optional().describe("Git repository directory"),
        planReference: z
          .string()
          .optional()
          .describe("Plan file path or content summary, used as coding context"),
        taskContext: z
          .string()
          .optional()
          .describe(
            "Task position and context within the plan " +
              "(e.g. 'Task 3 of 5: Implement validation logic')"
          ),
        testFramework: z
          .string()
          .optional()
          .describe("Test framework used (e.g. 'jest', 'vitest', 'pytest', 'go test')"),
        additionalContext: z.string().optional().describe("Additional review context information"),
      },
      async (params, extra) => {
        const result = await codexReview(params, extra);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }
    );
  }

  // ─── session_discard ───────────────────────────────────────────────
  if (isToolEnabled(config, "session_discard")) {
    server.tool(
      "session_discard",
      "Discard Codex sessions. By default, refuses to discard sessions marked active unless force=true.",
      {
        sessionIds: z
          .array(z.string())
          .describe("List of session IDs to discard"),
        force: z
          .boolean()
          .optional()
          .default(false)
          .describe("Force discard"),
        workingDirectory: z
          .string()
          .optional()
          .describe("Project working directory (used to scope session tracking)"),
      },
      async (params) => {
        const result = await codexSessionDiscard(params);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }
    );
  }

  // ─── session_list ──────────────────────────────────────────────────
  if (isToolEnabled(config, "session_list")) {
    server.tool(
      "session_list",
      "List tracked Codex sessions. Can filter by type and status.",
      {
        type: z
          .enum(["write", "review", "exec", "all"])
          .optional()
          .default("all")
          .describe("Session type filter"),
        status: z
          .enum(["active", "completed", "abandoned", "all"])
          .optional()
          .default("active")
          .describe("Session status filter"),
        workingDirectory: z
          .string()
          .optional()
          .describe("Project working directory (used to scope session tracking)"),
      },
      async (params) => {
        const result = await codexSessionList(params);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }
    );
  }

  // ─── health ────────────────────────────────────────────────────────
  if (isToolEnabled(config, "health")) {
    server.tool(
      "health",
      "Run environment and configuration checks (Codex CLI, config, Git, filesystem).",
      {
        workingDirectory: z
          .string()
          .optional()
          .describe("Directory to check (defaults to server process cwd)"),
        checkGit: z
          .boolean()
          .optional()
          .default(true)
          .describe("Check Git availability and repo status"),
        ensureTrackingDir: z
          .boolean()
          .optional()
          .default(false)
          .describe("Create tracking dirs if missing (~/.mcp/mcp-codex-dev and <project>/.mcp/mcp-codex-dev)"),
      },
      async (params) => {
        const result = await codexHealth(params);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }
    );
  }

  // Start stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log to stderr (stdout is reserved for MCP protocol)
  console.error("Codex Dev MCP Server started (stdio)");
}

main().catch((error) => {
  console.error("Failed to start Codex Dev MCP Server:", error);
  process.exit(1);
});
