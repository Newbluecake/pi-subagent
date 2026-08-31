import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { SessionSpec, SpawnRequest, SubagentExtensionPoints, RunOutcome } from "../core/types.js";
import { DEFAULT_WORKTREE_SETTINGS, type WorktreeSettings } from "./worktree-settings.js";

export interface ExecOptions {
  cwd?: string;
  timeout?: number;
  signal?: AbortSignal;
}
export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type WorktreeExec = (cmd: string, args: readonly string[], opts: ExecOptions) => Promise<ExecResult>;
export type WorktreeDiagnostic = (event: {
  runId: string;
  phase: "create" | "cleanup";
  message: string;
  error?: unknown;
}) => void;

export interface WorktreeExtensionOptions {
  exec: WorktreeExec;
  settings?: Partial<WorktreeSettings>;
  worktreeRoot?: string;
  onDiagnostic?: WorktreeDiagnostic;
}

interface WorktreeRecord {
  path: string;
  repo: string;
  branch: string;
}

function commandError(command: string, result: ExecResult): Error {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
  return new Error(`${command} failed: ${detail}`);
}
function safeRunId(runId: string): string {
  const value = runId.replace(/[^a-zA-Z0-9._-]/g, "-");
  return value || "run";
}
function isClean(result: ExecResult): boolean {
  return result.code === 0 && result.stdout.trim() === "";
}

/**
 * Git worktree isolation extension. It deliberately throws from H2 when an
 * explicitly requested worktree cannot be provided; the adapter translates
 * that failure to failed(config), rather than falling back to the checkout.
 */
export function createWorktreeExtension(options: WorktreeExtensionOptions): SubagentExtensionPoints {
  const settings = { ...DEFAULT_WORKTREE_SETTINGS, ...options.settings };
  const records = new Map<string, WorktreeRecord>();
  const root = resolve(options.worktreeRoot ?? join(tmpdir(), "pi-subagent-worktrees"));
  const git = (args: readonly string[], cwd: string, timeout: number) => options.exec("git", args, { cwd, timeout });

  return {
    async resolveSessionSpec(spec: SessionSpec, request: SpawnRequest): Promise<SessionSpec> {
      if (request.isolation !== "worktree") return spec;
      if (!settings.enabled) throw new Error("worktree isolation is requested but disabled");
      const cwd = resolve(spec.cwd ?? request.cwd ?? process.cwd());
      const repoResult = await git(["rev-parse", "--show-toplevel"], cwd, settings.gitTimeoutMs);
      if (repoResult.code !== 0) throw commandError("git rev-parse --show-toplevel", repoResult);
      const repo = repoResult.stdout.trim();
      if (!repo) throw new Error("git rev-parse --show-toplevel returned an empty repository path");
      const runId = requestRunId(request);
      const path = join(root, safeRunId(runId));
      const branch = `pi-agent-${safeRunId(runId)}`;
      await mkdir(root, { recursive: true });
      const add = await git(["worktree", "add", "--detach", path], repo, settings.gitTimeoutMs);
      if (add.code !== 0) {
        options.onDiagnostic?.({
          runId: requestRunId(request),
          phase: "create",
          message: "worktree creation failed",
          error: commandError("git worktree add", add),
        });
        throw commandError("git worktree add", add);
      }
      records.set(requestRunId(request), { path, repo, branch });
      return { ...spec, cwd: path };
    },

    async beforeReap(outcome: RunOutcome, ctx: { cwd: string; deadlineMs: number }): Promise<void> {
      const record = records.get(outcome.runId);
      if (!record) return;
      try {
        const status = await git(["status", "--porcelain"], record.path, ctx.deadlineMs);
        if (status.code !== 0) throw commandError("git status --porcelain", status);
        if (!isClean(status)) {
          const checkout = await git(["switch", "-c", record.branch], record.path, ctx.deadlineMs);
          if (checkout.code !== 0) throw commandError("git switch -c", checkout);
          const add = await git(["add", "-A"], record.path, ctx.deadlineMs);
          if (add.code !== 0) throw commandError("git add -A", add);
          const commit = await git(["commit", "-m", `pi-agent ${outcome.runId}`], record.path, ctx.deadlineMs);
          if (commit.code !== 0) throw commandError("git commit", commit);
        }
      } catch (error) {
        options.onDiagnostic?.({
          runId: outcome.runId,
          phase: "cleanup",
          message: "worktree changes could not be committed",
          error,
        });
      } finally {
        try {
          const remove = await git(["worktree", "remove", "--force", record.path], record.repo, ctx.deadlineMs);
          if (remove.code !== 0) throw commandError("git worktree remove", remove);
        } catch (error) {
          options.onDiagnostic?.({ runId: outcome.runId, phase: "cleanup", message: "worktree cleanup failed", error });
        } finally {
          records.delete(outcome.runId);
        }
      }
    },
  };
}

function requestRunId(request: SpawnRequest): string {
  return request.runId ?? request.label ?? `${request.type}-run`;
}

export const createWorktreeExtensionPoints = createWorktreeExtension;

/** Pi host adapter: builds the extension from pi's exec (index.ts stays wiring-only, D7). */
export function createPiWorktreeExtension(
  pi: { exec(cmd: string, args: string[], opts?: { cwd?: string; timeout?: number }): Promise<ExecResult> },
  settings: WorktreeSettings,
): SubagentExtensionPoints {
  return createWorktreeExtension({
    settings,
    exec: (cmd, args, opts) =>
      pi.exec(cmd, [...args], {
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(opts.timeout ? { timeout: opts.timeout } : {}),
      }),
  });
}
