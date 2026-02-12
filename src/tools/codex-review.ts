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
  CodexReviewResult,
  CodexErrorCode,
  CodexErrorInfo,
  ResolvedToolConfig,
} from "../types/index.js";

export const CodexReviewParamsSchema = z.object({
  instruction: z
    .string()
    .describe(
      "Original task instruction (same as what was sent to tdd)"
    ),
  whatWasImplemented: z.string().describe("Brief description of what was implemented (implementer's claim)"),
  baseSha: z.string().describe("Base commit SHA"),
  headSha: z.string().optional().default("HEAD").describe("Target commit SHA"),
  reviewType: z
    .enum(["spec", "quality", "full"])
    .optional()
    .default("full")
    .describe("Review type: spec (compliance only), quality (code quality only), full (both in parallel)"),
  sessionId: z.string().uuid().optional().describe("Optional, existing review session ID for continuing review"),
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
        "(e.g. 'Task 3 of 5: Implement validation logic. Depends on Task 2 auth module.')"
    ),
  testFramework: z
    .string()
    .optional()
    .describe("Test framework used (e.g. 'jest', 'vitest', 'pytest', 'go test')"),
  additionalContext: z.string().optional().describe("Additional review context"),
});

export type CodexReviewParams = z.infer<typeof CodexReviewParamsSchema>;

export async function codexReview(
  params: CodexReviewParams,
  extra?: { signal?: AbortSignal }
): Promise<CodexReviewResult> {
  const executor = await CodexExecutor.create({
    workingDirectory: params.workingDirectory,
  });
  const config = await loadConfig({ workingDirectory: params.workingDirectory });
  const toolCfg = getToolConfig(config, "review");

  const reviewType = params.reviewType || "full";

  try {
    // For session resumption, run single review (can't parallel-resume)
    if (params.sessionId) {
      const resumeType = reviewType === "spec" ? "spec" : "quality";
      return await runSingleReview(executor, config, toolCfg, params, resumeType, extra?.signal);
    }

    if (reviewType === "spec") {
      return await runSingleReview(executor, config, toolCfg, params, "spec", extra?.signal);
    }

    if (reviewType === "quality") {
      return await runSingleReview(executor, config, toolCfg, params, "quality", extra?.signal);
    }

    // "full" mode: run spec + quality in parallel
    return await runFullReview(executor, config, toolCfg, params, extra?.signal);
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
      review: "",
      error: {
        code: errorInfo.code || CodexErrorCode.UNKNOWN_ERROR,
        message: errorInfo.message || String(error),
        recoverable: errorInfo.recoverable ?? false,
        suggestion: errorInfo.suggestion,
      },
    };
  }
}

// ── Full parallel review ──────────────────────────────────────────────

async function runFullReview(
  executor: CodexExecutor,
  config: { reviewTemplate?: string; specReviewTemplate?: string },
  toolCfg: ResolvedToolConfig,
  params: CodexReviewParams,
  signal?: AbortSignal
): Promise<CodexReviewResult> {
  const specPrompt = await buildSpecPrompt(config, params);
  const qualityPrompt = await buildQualityPrompt(config, params);

  const specOpId = `review-spec-${crypto.randomUUID()}`;
  const qualityOpId = `review-quality-${crypto.randomUUID()}`;

  progressServer.startOperation(specOpId, "review", `[spec] ${params.whatWasImplemented.slice(0, 100)}`);
  progressServer.startOperation(qualityOpId, "review", `[quality] ${params.whatWasImplemented.slice(0, 100)}`);

  // Run both reviews in parallel
  const [specResult, qualityResult] = await Promise.all([
    executeAndParse(executor, specPrompt, specOpId, params, toolCfg, signal),
    executeAndParse(executor, qualityPrompt, qualityOpId, params, toolCfg, signal),
  ]);

  // Track sessions (update from active → final status)
  const sessionIds: string[] = [];
  for (const r of [specResult, qualityResult]) {
    if (r.sessionId) {
      sessionIds.push(r.sessionId);
      await sessionManager.track({
        sessionId: r.sessionId,
        type: "review",
        baseSha: params.baseSha,
        headSha: params.headSha || "HEAD",
        createdAt: new Date().toISOString(),
        status: r.exitCode === 0 ? "completed" : "abandoned",
      }, { workingDirectory: params.workingDirectory });
    }
  }

  // Link the two sessions together
  if (sessionIds.length === 2) {
    await sessionManager.link(sessionIds[0], sessionIds[1], {
      workingDirectory: params.workingDirectory,
    });
  }

  const success = specResult.exitCode === 0 && qualityResult.exitCode === 0;

  // Merge reviews
  const review = [
    "## Spec Compliance Review\n",
    specResult.review || "(no output)",
    "\n\n---\n\n## Code Quality Review\n",
    qualityResult.review || "(no output)",
  ].join("\n");

  return {
    success,
    sessionId: "",
    specSessionId: specResult.sessionId || undefined,
    qualitySessionId: qualityResult.sessionId || undefined,
    review,
  };
}

// ── Single review (spec or quality) ───────────────────────────────────

async function runSingleReview(
  executor: CodexExecutor,
  config: { reviewTemplate?: string; specReviewTemplate?: string },
  toolCfg: ResolvedToolConfig,
  params: CodexReviewParams,
  type: "spec" | "quality",
  signal?: AbortSignal
): Promise<CodexReviewResult> {
  const prompt =
    type === "spec"
      ? await buildSpecPrompt(config, params)
      : await buildQualityPrompt(config, params);

  const operationId = `review-${type}-${crypto.randomUUID()}`;
  progressServer.startOperation(operationId, "review", `[${type}] ${params.whatWasImplemented.slice(0, 100)}`);

  // Mark session as active before execution (for resume)
  if (params.sessionId) {
    await sessionManager.updateStatus(params.sessionId, "active", {
      workingDirectory: params.workingDirectory,
    });
  }

  const parsed = await executeAndParse(executor, prompt, operationId, params, toolCfg, signal);

  // Track session
  const sessionId = parsed.sessionId || params.sessionId;
  if (!sessionId) {
    throw {
      code: CodexErrorCode.CODEX_INVALID_OUTPUT,
      message: "Missing sessionId (neither parsed from Codex output nor provided via params.sessionId).",
      recoverable: false,
    } satisfies CodexErrorInfo;
  }

  if (params.sessionId) {
    await sessionManager.markResumed(params.sessionId, {
      workingDirectory: params.workingDirectory,
    });
    await sessionManager.updateStatus(
      params.sessionId,
      parsed.exitCode === 0 ? "completed" : "abandoned",
      { workingDirectory: params.workingDirectory }
    );
  } else {
    await sessionManager.track({
      sessionId,
      type: "review",
      baseSha: params.baseSha,
      headSha: params.headSha || "HEAD",
      createdAt: new Date().toISOString(),
      status: parsed.exitCode === 0 ? "completed" : "abandoned",
    }, { workingDirectory: params.workingDirectory });
  }

  return {
    success: parsed.exitCode === 0,
    sessionId,
    review: parsed.review,
  };
}

// ── Execute + parse helper ────────────────────────────────────────────

interface ParsedReviewResult {
  sessionId: string;
  exitCode: number | null;
  review: string;
}

async function executeAndParse(
  executor: CodexExecutor,
  prompt: string,
  operationId: string,
  params: CodexReviewParams,
  toolCfg: ResolvedToolConfig,
  signal?: AbortSignal
): Promise<ParsedReviewResult> {
  let result;
  try {
    result = await executor.executeReview(prompt, {
      sessionId: params.sessionId,
      workingDirectory: params.workingDirectory,
      model: toolCfg.model,
      sandbox: toolCfg.sandbox,
      timeout: toolCfg.timeout,
      onLine: (line) => {
        const event = mapCodexLineToProgressEvent(line, operationId);
        if (event) progressServer.emit(event);
      },
      signal,
    });
  } finally {
    progressServer.endOperation(operationId, result?.exitCode === 0);
  }

  const parsed = executor.parseOutput(result.stdout);
  if (!params.sessionId && !parsed.sessionId) {
    throw {
      code: CodexErrorCode.CODEX_INVALID_OUTPUT,
      message:
        "Codex CLI did not emit a session_id/thread_id in --json output. Ensure Codex CLI is up to date and that --json output is enabled.",
      recoverable: false,
    } satisfies CodexErrorInfo;
  }

  return {
    sessionId: parsed.sessionId || params.sessionId || "",
    exitCode: result.exitCode,
    review: parsed.agentMessages.join("\n\n"),
  };
}

// ── Prompt builders ───────────────────────────────────────────────────

function buildTaskSection(params: CodexReviewParams): string {
  let section = params.instruction;

  if (params.planReference) {
    section += `\n\n### Context\n\n${params.planReference}`;
  }

  if (params.taskContext) {
    section += `\n\n### Task Position\n\n${params.taskContext}`;
  }

  if (params.testFramework) {
    section += `\n\n### Test Framework\n\nUse: ${params.testFramework}`;
  }

  return section;
}

async function buildSpecPrompt(
  config: { specReviewTemplate?: string },
  params: CodexReviewParams
): Promise<string> {
  const template = await loadSpecReviewTemplate({
    specReviewTemplate: config.specReviewTemplate,
    workingDirectory: params.workingDirectory,
  });

  const base = fillTemplate(template, {
    TASK_SECTION: buildTaskSection(params),
    WHAT_WAS_IMPLEMENTED: params.whatWasImplemented,
    BASE_SHA: params.baseSha,
    HEAD_SHA: params.headSha || "HEAD",
  });

  return params.additionalContext
    ? `${base}\n\n## Additional Context\n\n${params.additionalContext}`
    : base;
}

async function buildQualityPrompt(
  config: { reviewTemplate?: string; workingDirectory?: string },
  params: CodexReviewParams
): Promise<string> {
  const template = await loadReviewTemplate({
    reviewTemplate: config.reviewTemplate,
    workingDirectory: params.workingDirectory,
  });

  const base = fillTemplate(template, {
    TASK_SECTION: buildTaskSection(params),
    WHAT_WAS_IMPLEMENTED: params.whatWasImplemented,
    BASE_SHA: params.baseSha,
    HEAD_SHA: params.headSha || "HEAD",
  });

  return params.additionalContext
    ? `${base}\n\n## Additional Context\n\n${params.additionalContext}`
    : base;
}

// ── Template loading ──────────────────────────────────────────────────

async function loadReviewTemplate(options: {
  reviewTemplate?: string;
  workingDirectory?: string;
}): Promise<string> {
  if (options.reviewTemplate) {
    const templateOverride = options.reviewTemplate;
    const candidates: string[] = [];

    if (options.workingDirectory) {
      candidates.push(path.resolve(options.workingDirectory, templateOverride));
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

    if (templateOverride.includes("\n") || templateOverride.trimStart().startsWith("#")) {
      return templateOverride;
    }

    console.error(
      `codex-dev: reviewTemplate override not found: ${templateOverride}`
    );
  }

  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const templatePath = path.join(moduleDir, "..", "..", "templates", "code-reviewer.md");

  try {
    if (fs.existsSync(templatePath)) {
      return await fs.promises.readFile(templatePath, "utf-8");
    }
  } catch {
    // Fall through to default
  }

  return DEFAULT_QUALITY_TEMPLATE;
}

async function loadSpecReviewTemplate(options: {
  specReviewTemplate?: string;
  workingDirectory?: string;
}): Promise<string> {
  if (options.specReviewTemplate) {
    const templateOverride = options.specReviewTemplate;
    const candidates: string[] = [];

    if (options.workingDirectory) {
      candidates.push(path.resolve(options.workingDirectory, templateOverride));
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

    if (templateOverride.includes("\n") || templateOverride.trimStart().startsWith("#")) {
      return templateOverride;
    }

    console.error(
      `codex-dev: specReviewTemplate override not found: ${templateOverride}`
    );
  }

  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const templatePath = path.join(moduleDir, "..", "..", "templates", "spec-reviewer.md");

  try {
    if (fs.existsSync(templatePath)) {
      return await fs.promises.readFile(templatePath, "utf-8");
    }
  } catch {
    // Fall through to default
  }

  return DEFAULT_SPEC_TEMPLATE;
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

// ── Templates ─────────────────────────────────────────────────────────

const DEFAULT_SPEC_TEMPLATE = `# Spec Compliance Review

You are reviewing whether an implementation matches its specification.

## Original Task (What Was Requested)

{TASK_SECTION}

## Implementer's Claim (What They Say Was Done)

{WHAT_WAS_IMPLEMENTED}

## Git Range to Review

**Base:** {BASE_SHA}
**Head:** {HEAD_SHA}

\`\`\`bash
git diff --stat {BASE_SHA}..{HEAD_SHA}
git diff {BASE_SHA}..{HEAD_SHA}
\`\`\`

## CRITICAL: Do Not Trust Claims

Verify everything independently by reading the actual code.

**DO NOT:**
- Take claims at face value about what was implemented
- Trust claims about completeness
- Accept interpretations of requirements without verifying

**DO:**
- Read the actual code
- Compare actual implementation to requirements line by line
- Check for missing pieces
- Look for extra features not requested

## Your Job

Compare the **Original Task** against the **actual code** (not the claim). Verify:

**Missing requirements:**
- Was everything that was requested actually implemented?
- Are there requirements that were skipped or missed?
- Was something claimed to work but not actually implemented?

**Extra/unneeded work:**
- Was anything built that wasn't requested?
- Was anything over-engineered or unnecessarily added?
- Were "nice to haves" added that weren't in spec?

**Misunderstandings:**
- Were requirements interpreted differently than intended?
- Was the wrong problem solved?
- Was the right feature implemented the wrong way?

## Output Format

Report your findings:
- ✅ **Spec compliant** — if everything matches after code inspection
- ❌ **Issues found** — list specifically what's missing, extra, or wrong, with file:line references

For each issue:
- File:line reference
- What's wrong (missing / extra / misunderstood)
- What was expected vs what was implemented
`;

const DEFAULT_QUALITY_TEMPLATE = `# Code Quality Review

You are reviewing code changes for production readiness.

## Original Task (What Was Requested)

{TASK_SECTION}

## Implementer's Claim (What They Say Was Done)

{WHAT_WAS_IMPLEMENTED}

## Git Range to Review

**Base:** {BASE_SHA}
**Head:** {HEAD_SHA}

\`\`\`bash
git diff --stat {BASE_SHA}..{HEAD_SHA}
git diff {BASE_SHA}..{HEAD_SHA}
\`\`\`

## Review Checklist

**Code Quality:**
- Clean separation of concerns?
- Proper error handling?
- Type safety (if applicable)?
- DRY principle followed?
- Edge cases handled?

**Architecture:**
- Sound design decisions?
- Scalability considerations?
- Performance implications?
- Security concerns?

**Testing:**
- Tests actually test logic (not mocks)?
- Edge cases covered?
- Integration tests where needed?
- All tests passing?

**Requirements:**
- All plan requirements met?
- Implementation matches spec?
- No scope creep?
- Breaking changes documented?

**Production Readiness:**
- Migration strategy (if schema changes)?
- Backward compatibility considered?
- Documentation complete?
- No obvious bugs?

## Output Format

### Strengths
[What's well done? Be specific.]

### Issues

#### Critical (Must Fix)
[Bugs, security issues, data loss risks, broken functionality]

#### Important (Should Fix)
[Architecture problems, missing features, poor error handling, test gaps]

#### Minor (Nice to Have)
[Code style, optimization opportunities, documentation improvements]

**For each issue:**
- File:line reference
- What's wrong
- Why it matters
- How to fix (if not obvious)

### Recommendations
[Improvements for code quality, architecture, or process]

### Assessment

**Ready to merge?** [Yes/No/With fixes]

**Reasoning:** [Technical assessment in 1-2 sentences]
`;
