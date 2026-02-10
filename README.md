# mcp-codex-dev

MCP Server for integrating [Codex CLI](https://github.com/openai/codex) into Claude Code workflows with session management and real-time progress monitoring.

<img width="1890" height="948" alt="image" src="https://github.com/user-attachments/assets/490a8cf6-1267-42cd-8f6f-e0a82c0dc6a3" />


## Installation

Prerequisites: [Codex CLI](https://github.com/openai/codex) installed and configured.

In .mcp.json file
```
{
  "mcpServers": {
    "mcp-codex-dev": {
      "command": "npx",
      "args": ["-y", "mcp-codex-dev"]
    }
  }
}
```

or

```bash
claude mcp add mcp-codex-dev -- npx -y mcp-codex-dev 
```

## Tools

| Tool | Description |
|------|-------------|
|`codex_exec`|Clean dialogue without templates, supports session resume|
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
