import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SpawnRequest } from "../core/types.js";

export type ScheduleDefinition =
  { kind: "cron"; expression: string } | { kind: "interval"; intervalMs: number } | { kind: "once"; at: string };

export interface ScheduleTask {
  id: string;
  schedule: ScheduleDefinition;
  request: Omit<SpawnRequest, "runId">;
  nextAt?: number | undefined;
}

export interface ScheduleStore {
  load(): Promise<ScheduleTask[]>;
  save(tasks: readonly ScheduleTask[]): Promise<void>;
}

export function defaultSchedulePath(): string {
  return join(homedir(), ".pi", "agent", "pi-subagent-schedules.json");
}

export function createScheduleStore(path: string = defaultSchedulePath()): ScheduleStore {
  let writes = Promise.resolve();
  return {
    async load() {
      try {
        const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
        if (!Array.isArray(parsed)) throw new Error("schedule store must be an array");
        return parsed as ScheduleTask[];
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
        if (code !== "ENOENT") console.warn(`[pi-subagent] failed to load schedule store ${path}: ${String(error)}`);
        return [];
      }
    },
    async save(tasks) {
      const snapshot = JSON.stringify(tasks, null, 2) + "\n";
      writes = writes.then(async () => {
        await mkdir(dirname(path), { recursive: true });
        const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
        try {
          await writeFile(temp, snapshot, { encoding: "utf8", mode: 0o600 });
          await rename(temp, path);
        } finally {
          await unlink(temp).catch(() => undefined);
        }
      });
      return writes;
    },
  };
}
