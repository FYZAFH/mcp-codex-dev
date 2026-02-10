import { ProgressEvent, CodexEvent } from "../types/index.js";

/**
 * Parse a single JSONL line from Codex CLI output and map it to a ProgressEvent.
 * Returns null if the line isn't a recognized event or isn't valid JSON.
 */
export function mapCodexLineToProgressEvent(
  line: string,
  operationId: string
): ProgressEvent | null {
  let event: CodexEvent;
  try {
    event = JSON.parse(line) as CodexEvent;
  } catch {
    return null;
  }

  const timestamp = new Date().toISOString();

  // thread.started → start
  if (event.type === "thread.started") {
    const sid =
      (event as { session_id?: string }).session_id ??
      (event as { thread_id?: string }).thread_id ??
      "";
    return { timestamp, operationId, type: "start", content: sid };
  }

  // item.completed with various sub-types
  if (event.type === "item.completed" || event.type === "item.created") {
    const item = event.item as Record<string, unknown> | undefined;
    if (!item) return null;

    const itemType = item.type as string | undefined;

    // reasoning
    if (itemType === "reasoning") {
      const text =
        (item.text as string) ??
        ((item.content as Array<{ text?: string }> | undefined)?.[0]?.text ?? "");
      return {
        timestamp,
        operationId,
        type: "reasoning",
        content: text,
      };
    }

    // command_execution (started)
    if (itemType === "command_execution") {
      const cmd = (item.command as string) ?? JSON.stringify(item);
      const exitCode = item.exit_code as number | undefined;
      if (exitCode !== undefined) {
        // completed — command_result
        const output = (item.output as string) ?? "";
        return {
          timestamp,
          operationId,
          type: "command_result",
          content: `exit ${exitCode}` + (output ? `: ${output}` : ""),
        };
      }
      return { timestamp, operationId, type: "command", content: cmd };
    }

    // file_change
    if (itemType === "file_change") {
      const changes = item.changes as Array<{ path: string; kind: string }> | undefined;
      if (changes && Array.isArray(changes)) {
        const summary = changes.map((c) => `${c.kind}: ${c.path}`).join(", ");
        return { timestamp, operationId, type: "file_change", content: summary };
      }
      const filename = (item.filename as string) ?? "";
      const action = (item.action as string) ?? "change";
      return {
        timestamp,
        operationId,
        type: "file_change",
        content: `${action}: ${filename}`,
      };
    }

    // agent_message
    if (itemType === "agent_message") {
      const text = (item.text as string) ?? "";
      return {
        timestamp,
        operationId,
        type: "message",
        content: text,
      };
    }

    // old format: assistant role with content array
    if ((item.role as string) === "assistant") {
      const content = item.content as Array<{ type: string; text?: string }> | undefined;
      if (content && content.length > 0) {
        const text = content.map((c) => c.text ?? "").join(" ");
        return {
          timestamp,
          operationId,
          type: "message",
          content: text,
        };
      }
    }
  }

  // item.started — command
  if (event.type === "item.started") {
    const item = event.item as Record<string, unknown> | undefined;
    if (item?.type === "command_execution") {
      const cmd = (item.command as string) ?? "";
      return { timestamp, operationId, type: "command", content: cmd };
    }
  }

  // turn.completed → end with token usage
  if (event.type === "turn.completed") {
    const usage = (event as { usage?: Record<string, unknown> }).usage;
    const content = usage ? JSON.stringify(usage) : "turn completed";
    return { timestamp, operationId, type: "end", content };
  }

  return null;
}
