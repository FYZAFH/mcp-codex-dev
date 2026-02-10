#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { codexWrite } from "./tools/codex-write.js";
import { codexReview } from "./tools/codex-review.js";
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

  // ─── codex_write ──────────────────────────────────────────────────────
  if (isToolEnabled(config, "write")) {
    server.tool(
      "codex_write",
      "Invoke Codex CLI to write code. Supports creating new sessions and resuming existing sessions. " +
        "For new sessions, pass instruction; for resuming, pass sessionId + instruction (revision feedback). " +
        "Returns sessionId for subsequent resumption.",
      {
        instruction: z.string().describe("Detailed code writing instruction"),
        sessionId: z
          .string()
          .optional()
          .describe("Resume an existing session by ID (from previous codex_write return value)"),
        workingDirectory: z.string().optional().describe("Working directory path"),
        planReference: z
          .string()
          .optional()
          .describe("Plan file path or content summary, used as coding context"),
      },
      async (params, extra) => {
        const result = await codexWrite(params, extra);
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

  // ─── codex_review ─────────────────────────────────────────────────────
  if (isToolEnabled(config, "review")) {
    server.tool(
      "codex_review",
      "Invoke Codex CLI for code review. Uses built-in code-reviewer template. " +
        "Pass git range and description info, returns structured review results. " +
        "Supports continuing previous review sessions via sessionId. " +
        "In 'full' mode, returns specSessionId and qualitySessionId separately (use with reviewType 'spec'/'quality' to resume each).",
      {
        whatWasImplemented: z.string().describe("Brief description of what was implemented"),
        planOrRequirements: z.string().describe("Original plan or requirements description"),
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
          .describe("Continue an existing review session by ID (from previous codex_review return value)"),
        workingDirectory: z.string().optional().describe("Git repository directory"),
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

  // ─── codex_session_discard ────────────────────────────────────────────
  if (isToolEnabled(config, "session_discard")) {
    server.tool(
      "codex_session_discard",
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

  // ─── codex_session_list ───────────────────────────────────────────────
  if (isToolEnabled(config, "session_list")) {
    server.tool(
      "codex_session_list",
      "List tracked Codex sessions. Can filter by type and status.",
      {
        type: z
          .enum(["write", "review", "all"])
          .optional()
          .default("all")
          .describe("Session type filter"),
        status: z
          .enum(["active", "completed", "abandoned", "all"])
          .optional()
          .default("active")
          .describe("Session status filter"),
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

  // codex_health
  if (isToolEnabled(config, "health")) {
    server.tool(
      "codex_health",
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
          .describe("Create ~/.mcp/mcp-codex-dev if missing"),
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
