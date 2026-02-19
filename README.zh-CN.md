# mcp-codex-dev

[English](README.md) | 中文

将 [Codex CLI](https://github.com/openai/codex) 集成到 Claude Code 工作流的 MCP Server，支持会话管理和实时进度监控。

<img width="1890" height="948" alt="image" src="https://github.com/user-attachments/assets/490a8cf6-1267-42cd-8f6f-e0a82c0dc6a3" />

## 安装

前提条件：已安装并配置 [Codex CLI](https://github.com/openai/codex)。

在 .mcp.json 文件中添加：
```json
{
  "mcpServers": {
    "mcp-codex-dev": {
      "command": "npx",
      "args": ["-y", "mcp-codex-dev"]
    }
  }
}
```

或者

```bash
claude mcp add mcp-codex-dev -- npx -y mcp-codex-dev
```

Windows 系统：

```json
{
  "mcpServers": {
    "mcp-codex-dev": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "mcp-codex-dev"]
    }
  }
}
```

或者

```powershell
claude mcp add mcp-codex-dev -- cmd /c npx -y mcp-codex-dev
```

## 工具

| 工具 | 描述 |
|------|------|
| `exec` | 无模板的纯对话，支持会话恢复 |
| `tdd` | 内置测试驱动开发提示模板的 Codex CLI, 支持恢复 |
| `review` | 代码审查（规格 + 质量并行检查），支持恢复 |
| `health` | 环境和配置诊断 |
| `session_list` | 列出当前项目下的会话 |
| `session_discard` | 丢弃指定会话或当前项目下的所有会话 |

## 配置

创建 `~/.mcp/mcp-codex-dev/config.json`：

```json
{
  "model": "gpt-5.2",
  "sandbox": "danger-full-access",
  "timeout": 300000,
  "tools": {
    "tdd": { "model": "gpt-5.3-codex", "sandbox": "danger-full-access", "timeout": 2000000},
    "review": { "model": "gpt-5.2", "sandbox": "danger-full-access", "timeout": 3000000},
    "health": { "enabled": false }
  }
}
```

顶层的 `model` / `sandbox` / `timeout` 为全局默认值。`tools` 部分可按工具名称进行单独覆盖。设置 `"enabled": false` 可禁用某个工具。

项目级配置可放置在 `<project>/.mcp/mcp-codex-dev.config.json`。

## 进度服务器

本地 HTTP 服务器启动在 `http://localhost:23120`，显示实时进度。可通过 `progressPort` 配置端口。

当多个 MCP Server 实例同时运行时，它们共享同一个进度页面：第一个实例绑定端口并提供 UI，其他实例将进度事件转发给它。

## 会话跟踪

会话跟踪元数据按项目存储在 `<project>/.mcp/mcp-codex-dev/sessions.json`（其中 `<project>` 为 Git 仓库根目录，如适用）。

Codex CLI 自身的会话文件保存在 `~/.codex/sessions/<id>/`。

## 许可证

无许可证。
