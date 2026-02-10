# mcp-codex-dev

MCP Server for integrating [Codex CLI](https://github.com/openai/codex) into Claude Code workflows with session management and real-time progress monitoring.

<img width="1896" height="952" alt="image" src="https://github.com/user-attachments/assets/f7ba637c-0aa1-478d-a7ed-cb93c34c46b3" />

## Installation

Prerequisites: [Codex CLI](https://github.com/openai/codex) installed and configured.

```bash
claude mcp add mcp-codex-dev -- npx -y mcp-codex-dev
```

Windows:
```bash
claude mcp add mcp-codex-dev -- cmd /c npx -y mcp-codex-dev
```

## Tools

| Tool | Description |
|------|-------------|
| `codex_write` | Write code via Codex CLI, supports session resume |
| `codex_review` | Code review (spec + quality in parallel), supports resume |
| `codex_health` | Environment and config diagnostics |
| `codex_session_list` | List tracked sessions |
| `codex_session_discard` | Discard sessions |

## Configuration

Create `~/.mcp/mcp-codex-dev/config.json`:

```json
{
  "model": "gpt-5.2",
  "sandbox": "danger-full-access",
  "timeout": 300000,
  "tools": {
    "codex_write": {
      "model": "gpt-5.3-codex",
      "sandbox": "danger-full-access",
      "timeout": 2000000
    },
    "codex_review": {
      "model": "gpt-5.2",
      "sandbox": "danger-full-access",
      "timeout": 3000000
    },
    "codex_health": { "enabled": false }
  }
}
```

Top-level `model` / `sandbox` / `timeout` are global defaults. The `tools` section overrides per tool (keyed by tool name). Set `"enabled": false` to disable a tool.

Per-project config can be placed at `<project>/.mcp/mcp-codex-dev.config.json`.

## Progress Server

A local HTTP server starts at `http://localhost:23120` showing real-time progress. Configurable via `progressPort`.

## License

MIT
