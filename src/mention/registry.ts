import type { AgentTypeName, RunId } from "../core/types.js";

export interface MentionTarget {
  readonly runId: RunId;
  readonly type: AgentTypeName;
}

export interface MentionRegistry {
  register(label: string, target: MentionTarget): boolean;
  resolve(label: string): MentionTarget | undefined;
  labels(): readonly string[];
}

/** A session-local, first-registration-wins handle index. */
export function createMentionRegistry(warn: (message: string) => void = console.warn): MentionRegistry {
  const entries = new Map<string, MentionTarget>();
  return {
    register(label, target) {
      if (entries.has(label)) {
        warn(`[pi-subagent] label conflict for "${label}"; keeping the first registration`);
        return false;
      }
      entries.set(label, target);
      return true;
    },
    resolve: (label) => entries.get(label),
    labels: () => [...entries.keys()],
  };
}
