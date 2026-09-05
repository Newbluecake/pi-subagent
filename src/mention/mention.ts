import type { ExtensionAPI, InputEvent, InputEventResult } from "@earendil-works/pi-coding-agent";
import type { SpawnRequest } from "../core/types.js";
import type { QueryService } from "../service/query-service.js";
import type { SpawnService } from "../service/spawn-service.js";
import type { MentionRegistry, MentionTarget } from "./registry.js";

export interface ParsedMention {
  readonly label: string;
  readonly message: string;
}

const terminalStatuses = new Set(["completed", "failed", "timed_out", "aborted"]);

/**
 * Parse only a complete leading `@label message` form. Registration is checked
 * separately so pi's file completion remains untouched for ordinary paths.
 */
export function parseMention(text: string, registry: MentionRegistry): ParsedMention | undefined {
  const match = /^@([^\s]+)[ \t]+([\s\S]*\S)[ \t]*$/.exec(text);
  if (!match) return undefined;
  const label = match[1];
  const message = match[2];
  if (!label || !message || !registry.resolve(label)) return undefined;
  return { label, message };
}

export type MentionRouteResult =
  | { handled: false }
  | { handled: true; action: "steer" | "resume"; runId: string }
  | { handled: true; action: "error"; error: string };

/**
 * Wrap a user @mention with a reply-channel hint: when fabric is enabled the
 * target owns a message_agent tool, so tell it to push the reply to root as a
 * progress message (rendered directly to the user) instead of relying on run
 * termination to deliver its final text.
 */
export function frameUserMentionReply(label: string, message: string): string {
  return (
    `[用户 @mention] 以下是用户通过 @${label} 直接发给你的消息。请用 message_agent 工具回复用户` +
    `（to: "root", kind: "progress"）——该回复会直接展示给用户，不需要等 run 结束；回复后你可以继续当前任务。\n\n` +
    `用户消息：\n${message}`
  );
}

export async function routeMention(
  text: string,
  deps: {
    registry: MentionRegistry;
    query: Pick<QueryService, "get" | "steer">;
    spawn: Pick<SpawnService, "spawn">;
    /** When true, wrap the user message with the message_agent reply hint (fabric on ⇒ targets own the tool). */
    fabricEnabled?: () => boolean;
    reportError?: (message: string) => void;
  },
): Promise<MentionRouteResult> {
  const parsed = parseMention(text, deps.registry);
  if (!parsed) return { handled: false };
  const target = deps.registry.resolve(parsed.label);
  if (!target) return { handled: false };
  const message = deps.fabricEnabled?.() ? frameUserMentionReply(parsed.label, parsed.message) : parsed.message;
  const snapshot = deps.query.get(target.runId);
  if (snapshot?.status === "running") {
    const result = await deps.query.steer(target.runId, message);
    if (result.ok) return { handled: true, action: "steer", runId: target.runId };
    const error = `cannot steer @${parsed.label}: ${result.detail ?? result.reason}`;
    deps.reportError?.(error);
    return { handled: true, action: "error", error };
  }
  if (snapshot && terminalStatuses.has(snapshot.status)) {
    const result = await deps.spawn.spawn({
      type: target.type,
      prompt: message,
      label: parsed.label,
      resumeFrom: target.runId,
    } satisfies SpawnRequest);
    if ("runId" in result) return { handled: true, action: "resume", runId: result.runId };
    const error = `cannot resume @${parsed.label}: ${result.error.message}`;
    deps.reportError?.(error);
    return { handled: true, action: "error", error };
  }
  const error = `cannot route @${parsed.label}: run is ${snapshot?.status ?? "unknown"} (not ready yet — retry once it is running, or after it settles)`;
  deps.reportError?.(error);
  return { handled: true, action: "error", error };
}

/** Install the direct-mode input interceptor. The host remains responsible for calling this. */
export function installMentionInput(
  pi: Pick<ExtensionAPI, "on" | "sendMessage">,
  deps: Omit<Parameters<typeof routeMention>[1], "reportError">,
): void {
  pi.on("input", async (event: InputEvent): Promise<InputEventResult> => {
    const result = await routeMention(event.text, {
      ...deps,
      reportError: (message) => {
        pi.sendMessage({
          customType: "subagent:mention-error",
          content: message,
          display: true,
          details: { source: "mention" },
        });
      },
    });
    return result.handled ? { action: "handled" } : { action: "continue" };
  });
}

export type { MentionRegistry, MentionTarget };
