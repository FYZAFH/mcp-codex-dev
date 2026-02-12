import { z } from "zod";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
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

export const CodexTddParamsSchema = z.object({
  instruction: z
    .string()
    .describe(
      "Detailed description of the feature or bug fix to implement using TDD"
    ),
  sessionId: z
    .string()
    .uuid()
    .optional()
    .describe("Resume an existing TDD session by ID"),
  workingDirectory: z
    .string()
    .optional()
    .describe("Working directory path"),
  planReference: z
    .string()
    .optional()
    .describe("Plan file path or content summary, used as coding context"),
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
      "Test framework hint (e.g. 'jest', 'vitest', 'pytest', 'go test'). " +
        "Defaults to auto-detect from project."
    ),
});

export type CodexTddParams = z.infer<typeof CodexTddParamsSchema>;

export async function codexTdd(
  params: CodexTddParams,
  extra?: { signal?: AbortSignal }
): Promise<CodexWriteResult> {
  const config = await loadConfig({
    workingDirectory: params.workingDirectory,
  });
  const toolCfg = getToolConfig(config, "tdd");
  const executor = await CodexExecutor.create({
    workingDirectory: params.workingDirectory,
  });

  // Load and fill the TDD template
  const template = await loadTddTemplate({
    tddTemplate: config.tddTemplate,
    workingDirectory: params.workingDirectory,
  });

  // Build context section: plan reference + task position
  let contextValue = "";
  if (params.planReference) {
    contextValue += params.planReference;
  }
  if (params.taskContext) {
    if (contextValue) contextValue += "\n\n";
    contextValue += `**Current Task Position:** ${params.taskContext}`;
  }
  if (!contextValue) {
    contextValue = "(No plan reference provided)";
  }

  // Strip TEST_FRAMEWORK section from template if not provided
  let processedTemplate = template;
  if (!params.testFramework) {
    // Remove "### Test Framework\n\nUse: {TEST_FRAMEWORK}\n" section
    processedTemplate = processedTemplate.replace(
      /### Test Framework\s*\n+Use: \{TEST_FRAMEWORK\}\s*\n*/g,
      ""
    );
  }

  const fullInstruction = fillTemplate(processedTemplate, {
    INSTRUCTION: params.instruction,
    PLAN_REFERENCE: contextValue,
    ...(params.testFramework
      ? { TEST_FRAMEWORK: params.testFramework }
      : {}),
  });

  try {
    const operationId = `tdd-${crypto.randomUUID()}`;
    progressServer.startOperation(
      operationId,
      "write",
      params.instruction.slice(0, 120)
    );

    // Mark session as active before execution (for resume)
    if (params.sessionId) {
      await sessionManager.updateStatus(params.sessionId, "active", {
        workingDirectory: params.workingDirectory,
      });
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
    } else if (
      parsed.filesCreated.length > 0 ||
      parsed.filesModified.length > 0
    ) {
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
      await sessionManager.markResumed(params.sessionId, {
        workingDirectory: params.workingDirectory,
      });
      await sessionManager.updateStatus(params.sessionId, trackedStatus, {
        workingDirectory: params.workingDirectory,
      });
    } else {
      // New session
      await sessionManager.track(
        {
          sessionId,
          type: "write",
          instruction: params.instruction,
          createdAt: new Date().toISOString(),
          status: trackedStatus,
        },
        { workingDirectory: params.workingDirectory }
      );
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

// ── Template loading (mirrors codex-review.ts pattern) ──────────────

async function loadTddTemplate(options: {
  tddTemplate?: string;
  workingDirectory?: string;
}): Promise<string> {
  // Priority 1: Config override (file path or inline content)
  if (options.tddTemplate) {
    const templateOverride = options.tddTemplate;
    const candidates: string[] = [];

    if (options.workingDirectory) {
      candidates.push(
        path.resolve(options.workingDirectory, templateOverride)
      );
    }
    candidates.push(path.resolve(templateOverride));

    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) {
          return await fs.promises.readFile(candidate, "utf-8");
        }
      } catch {
        // continue
      }
    }

    // If it looks like inline template content, use it directly
    if (
      templateOverride.includes("\n") ||
      templateOverride.trimStart().startsWith("#")
    ) {
      return templateOverride;
    }

    console.error(
      `codex-dev: tddTemplate override not found: ${templateOverride}`
    );
  }

  // Priority 2: Bundled template file
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const templatePath = path.join(
    moduleDir,
    "..",
    "..",
    "templates",
    "tdd-developer.md"
  );

  try {
    if (fs.existsSync(templatePath)) {
      return await fs.promises.readFile(templatePath, "utf-8");
    }
  } catch {
    // Fall through to default
  }

  // Priority 3: Hardcoded fallback
  return DEFAULT_TDD_TEMPLATE;
}

function fillTemplate(
  template: string,
  values: Record<string, string>
): string {
  let result = template;
  for (const [key, value] of Object.entries(values)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, "g"), () => value);
  }
  return result;
}

// ── Hardcoded fallback template ─────────────────────────────────────

const DEFAULT_TDD_TEMPLATE = `# TDD Developer Agent

You are a developer who strictly follows Test-Driven Development.
Below are your methodology rules, followed by the specific task to implement.

## The Iron Law

\`\`\`
NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST
\`\`\`

Wrote code before the test? Delete it. Start over. No exceptions.

## Red-Green-Refactor Cycle

For EACH piece of functionality:

### 1. RED — Write Failing Test
Write ONE minimal test showing what should happen.
- Tests one behavior
- Clear name describing the expected behavior
- Uses real code, not mocks (mock only when unavoidable)

### 2. VERIFY RED — Run Tests (MANDATORY)
Run the test. Confirm:
- Test fails (not errors)
- Failure message matches expectation
- Fails because feature is missing, not typos

### 3. GREEN — Write Minimal Code
Write the simplest code that makes the test pass. Nothing more.
Do NOT add features the test doesn't require.

### 4. VERIFY GREEN — Run ALL Tests (MANDATORY)
Run full test suite. Confirm:
- New test passes
- ALL existing tests still pass
- No errors or warnings

### 5. REFACTOR — Clean Up (Only After Green)
Remove duplication, improve names, extract helpers.
Keep ALL tests green. Do NOT add new behavior.

### 6. REPEAT
Next failing test for the next behavior.

## Anti-Patterns to AVOID

1. Testing mock behavior instead of real code
2. Test-only methods in production classes
3. Mocking without understanding dependencies
4. Incomplete mocks hiding structural assumptions
5. Tests as afterthought

## Red Flags — STOP and Start Over

- Wrote production code before writing a test
- Test passes immediately on first run
- Can't explain why the test failed
- Rationalizing "just this once"

## Bug Fix Process

1. Write failing test reproducing the bug
2. Verify it fails
3. Fix with minimal code
4. Verify all tests pass

## Verification Checklist (Before Completing)

- [ ] Every new function/method has a test written BEFORE implementation
- [ ] Watched each test fail before implementing
- [ ] Each test failed for the expected reason
- [ ] Wrote minimal code to pass each test
- [ ] ALL tests pass
- [ ] Test output is clean
- [ ] Tests use real code (mocks only when unavoidable)
- [ ] Edge cases and error paths are covered

## Process Summary

\`\`\`
For each behavior:
  1. Write ONE failing test
  2. RUN tests → confirm FAIL (RED)
  3. Write MINIMAL production code
  4. RUN tests → confirm ALL PASS (GREEN)
  5. Refactor (keep green)
  6. Goto 1
\`\`\`

---

## Now Apply the Above to Your Task

Use the TDD methodology above to implement the following.

### Task

{INSTRUCTION}

### Context

{PLAN_REFERENCE}

### Test Framework

Use: {TEST_FRAMEWORK}

### After Implementation: Commit and Self-Review

Once all tests pass and you've completed the TDD cycle:

#### 1. Commit your work

Stage and commit with a clear message describing what was implemented.

#### 2. Self-review before reporting back

Review your own work with fresh eyes:

- **Completeness:** Did I fully implement everything the task specifies? Did I miss any requirements or edge cases?
- **Quality:** Are names clear and accurate? Is the code clean and maintainable?
- **Discipline:** Did I avoid overbuilding (YAGNI)? Did I only build what was requested? Did I follow existing patterns in the codebase?
- **Testing:** Do tests verify real behavior (not mock behavior)? Did I follow TDD? Are tests comprehensive?

If you find issues during self-review, fix them now before reporting.

#### 3. Report

When done, report: what you implemented, what you tested and test results, files changed, and any self-review findings.
`;
