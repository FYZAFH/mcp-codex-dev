# Codex Dev MCP Server

MCP Server for integrating Codex CLI into Claude Code workflows with stateful session management. On the basis of using Codex, a small session management module has been added (via the `codex_session_discard` and `codex_session_list` tools), and a visualization interface for Codex monitoring has been added (because Codex is really too slow, and without progress monitoring, it's often thought to have crashed).
<img width="1896" height="952" alt="image" src="https://github.com/user-attachments/assets/f7ba637c-0aa1-478d-a7ed-cb93c34c46b3" />

## Features

- **codex_write** - Call Codex CLI to write code, supports session resume
- **codex_review** - Call Codex CLI to review code (spec compliance + code quality, parallel or individual)
- **codex_health** - Environment + config checks ("doctor")
- **codex_session_discard** - Discard Codex sessions (with optional `force`)
- **codex_session_list** - List tracked sessions (filter by type/status)

## Workflow

```
Claude Code (Orchestrator)
    |-> 1. codex_write(instruction)
    |   <- returns sessionId: "abc123"
    |-> 2. codex_review(whatWasImplemented, planOrRequirements, baseSha)
    |   <- returns specSessionId, qualitySessionId, merged review
    |-> 3. codex_write(sessionId: "abc123", instruction: "fix review issues...")
    |   <- resumes session, applies fixes
    |-> 4. codex_review(sessionId: "def456", reviewType: "spec")
    |   <- resumes spec review
    |-> 5. codex_session_discard(sessionIds: ["abc123", "def456"])
        <- cleanup
```

## Installation

```bash
cd mcp/codex-dev
npm install
npm run build
```

## Configuration

### Project-level (.mcp.json)

```json
{
  "mcpServers": {
    "codex-dev": {
      "command": "node",
      "args": ["mcp/codex-dev/dist/index.js"]
    }
  }
}
```

### Config precedence (highest -> lowest)

1. Environment variables (`CODEX_DEV_*`)
2. Project config (`<git_root>/.mcp/mcp-codex-dev.config.json`)
3. MCP user config (`~/.mcp/mcp-codex-dev/config.json`)
4. Codex CLI config (`~/.codex/config.toml`) - model only

### Config format

All config files use the same JSON format. Top-level fields are global defaults; per-tool overrides go in the `tools` section.

```json
{
  "model": "gpt-5.2",
  "sandbox": "danger-full-access",
  "timeout": 300000,
  "sessionCleanupHours": 48,
  "reviewTemplate": "path/to/template.md",
  "progressPort": 23120,
  "tools": {
    "write": {
      "model": "gpt-5.3-codex",
      "sandbox": "workspace-write",
      "timeout": 300000
    },
    "review": {
      "model": "gpt-5.2",
      "sandbox": "read-only",
      "timeout": 600000
    },
    "session_discard": { "enabled": true },
    "session_list": { "enabled": true },
    "health": { "enabled": true }
  }
}
```

**Global defaults:**

| Field | Type | Description |
|-------|------|-------------|
| `model` | string | Default model for Codex CLI |
| `sandbox` | string | Default sandbox mode: `read-only`, `workspace-write`, or `danger-full-access` (default) |
| `timeout` | number | Default timeout in ms (no timeout if unset) |
| `sessionCleanupHours` | number | Auto-cleanup sessions older than N hours |
| `reviewTemplate` | string | Path to custom review template |
| `progressPort` | number | Progress server port (default: 23120) |

**Per-tool overrides (`tools.write` / `tools.review`):**

| Field | Type | Description |
|-------|------|-------------|
| `enabled` | boolean | Enable/disable the tool (default: true) |
| `model` | string | Override model for this tool |
| `sandbox` | string | Override sandbox mode for this tool |
| `timeout` | number | Override timeout for this tool |

**Tool toggles (`tools.session_discard` / `tools.session_list` / `tools.health`):**

| Field | Type | Description |
|-------|------|-------------|
| `enabled` | boolean | Enable/disable the tool (default: true) |

### MCP user config (~/.mcp/mcp-codex-dev/config.json)

Minimal example:

```json
{
  "timeout": 300000,
  "sandbox": "workspace-write"
}
```

Per-tool example:

```json
{
  "model": "gpt-5.2",
  "tools": {
    "review": {
      "model": "gpt-5.2",
      "sandbox": "read-only"
    }
  }
}
```

### Project config (<git_root>/.mcp/mcp-codex-dev.config.json)

Per-repository config, lives alongside other MCP configs in `.mcp/`:

```json
{
  "timeout": 300000,
  "sandbox": "workspace-write"
}
```

### Environment Variables

| Variable | Maps to |
|----------|---------|
| `CODEX_DEV_MODEL` | `model` (global) |
| `CODEX_DEV_REVIEW_MODEL` | `tools.review.model` |
| `CODEX_DEV_TIMEOUT` | `timeout` (global) |
| `CODEX_DEV_SANDBOX_MODE` | `sandbox` (global) |

## Tool Reference

### codex_write

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| instruction | string | Yes | Code writing instruction |
| sessionId | string (UUID) | | Resume existing session |
| workingDirectory | string | | Working directory |
| planReference | string | | Plan file reference |

### codex_review

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| whatWasImplemented | string | Yes | Description of implementation |
| planOrRequirements | string | Yes | Original plan/requirements |
| baseSha | string | Yes | Base commit SHA |
| headSha | string | | Target SHA (default: HEAD) |
| reviewType | "spec" \| "quality" \| "full" | | Review mode (default: "full") |
| sessionId | string (UUID) | | Resume existing review |
| workingDirectory | string | | Git repo directory |
| additionalContext | string | | Extra context |

In "full" mode, returns `specSessionId` and `qualitySessionId` separately. Use with `reviewType: "spec"` or `"quality"` to resume each individually.

### codex_session_discard

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| sessionIds | string[] | Yes | Session IDs to discard |
| force | boolean | | Discard even if session is marked active |

### codex_session_list

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| type | "write" \| "review" \| "all" | | Filter by type |
| status | "active" \| "completed" \| "abandoned" \| "all" | | Filter by status |

### codex_health

Run environment and configuration checks (Codex CLI, config, Git, filesystem).

## Progress Server

When enabled, a local HTTP+SSE server starts at `http://localhost:<progressPort>` (default: 23120) to show real-time operation progress in the browser. Configure via `progressPort` in config.

## Data Directory

All MCP process files are stored in `~/.mcp/mcp-codex-dev/`:

- `config.json` - User config
- `sessions.json` - Session tracking

Codex CLI session files are stored separately in `~/.codex/sessions/<session_id>/`.
