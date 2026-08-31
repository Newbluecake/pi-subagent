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

export async function routeMention(
  text: string,
  deps: {
    registry: MentionRegistry;
    query: Pick<QueryService, "get" | "steer">;
    spawn: Pick<SpawnService, "spawn">;
    reportError?: (message: string) => void;
  },
): Promise<MentionRouteResult> {
  const parsed = parseMention(text, deps.registry);
  if (!parsed) return { handled: false };
  const target = deps.registry.resolve(parsed.label);
  if (!target) return { handled: false };
  const snapshot = deps.query.get(target.runId);
  if (snapshot?.status === "running") {
    const result = await deps.query.steer(target.runId, parsed.message);
    if (result.ok) return { handled: true, action: "steer", runId: target.runId };
    const error = `cannot steer @${parsed.label}: ${result.detail ?? result.reason}`;
    deps.reportError?.(error);
    return { handled: true, action: "error", error };
  }
  if (snapshot && terminalStatuses.has(snapshot.status)) {
    const result = await deps.spawn.spawn({
      type: target.type,
      prompt: parsed.message,
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
