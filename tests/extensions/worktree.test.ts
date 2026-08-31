import { describe, expect, it, vi } from "vitest";
import type { RunOutcome, SpawnRequest } from "../../src/core/types.js";
import { createWorktreeExtension, type ExecResult, type WorktreeExec } from "../../src/extensions/worktree.js";

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const outcome = (runId: string): RunOutcome => ({
  runId,
  status: "completed",
  turns: 1,
  durationMs: 1,
  diag: {} as RunOutcome["diag"],
});
const request = (runId: string): SpawnRequest => ({
  runId,
  type: "worker",
  prompt: "work",
  cwd: "/repo",
  isolation: "worktree",
});

function fakeGit(opts: { dirty?: boolean; addCode?: number; removeCode?: number } = {}) {
  const calls: Array<{ args: string[]; cwd?: string }> = [];
  const branches = new Set<string>();
  const exec: WorktreeExec = async (_cmd, args, commandOpts) => {
    calls.push({ args: [...args], cwd: commandOpts.cwd });
    if (args[0] === "rev-parse") return ok("/repo\n");
    if (args[0] === "worktree" && args[1] === "add")
      return opts.addCode ? { code: opts.addCode, stdout: "", stderr: "cannot create" } : ok();
    if (args[0] === "status") return ok(opts.dirty ? " M file.txt\n" : "");
    if (args[0] === "switch") {
      branches.add(args[2]);
      return ok();
    }
    if (args[0] === "worktree" && args[1] === "remove")
      return { code: opts.removeCode ?? 0, stdout: "", stderr: opts.removeCode ? "cannot remove" : "" };
    return ok();
  };
  return { exec, calls, branches };
}

describe("worktree extension", () => {
  it("rewrites cwd and creates a detached worktree only when explicitly requested", async () => {
    const fake = fakeGit();
    const ext = createWorktreeExtension({
      exec: fake.exec,
      settings: { enabled: true },
      worktreeRoot: "/tmp/test-worktrees",
    });
    const spec = await ext.resolveSessionSpec?.({ cwd: "/repo" }, request("r-create"));
    expect(spec?.cwd).toBe("/tmp/test-worktrees/r-create");
    expect(fake.calls.map((c) => c.args)).toContainEqual([
      "worktree",
      "add",
      "--detach",
      "/tmp/test-worktrees/r-create",
    ]);

    const untouched = await ext.resolveSessionSpec?.({ cwd: "/repo" }, { type: "worker", prompt: "work" });
    expect(untouched).toEqual({ cwd: "/repo" });
  });

  it("surfaces worktree creation failure so the adapter can return failed(config)", async () => {
    const fake = fakeGit({ addCode: 1 });
    const diagnostics: unknown[] = [];
    const ext = createWorktreeExtension({
      exec: fake.exec,
      settings: { enabled: true },
      worktreeRoot: "/tmp/test-worktrees",
      onDiagnostic: (event) => diagnostics.push(event),
    });
    await expect(ext.resolveSessionSpec?.({ cwd: "/repo" }, request("r-create-fail"))).rejects.toThrow(/cannot create/);
    expect(diagnostics[0]).toMatchObject({ runId: "r-create-fail", phase: "create" });
  });

  it("fails explicitly when isolation is requested while disabled", async () => {
    const exec = vi.fn<WorktreeExec>(async () => ok("/repo\n"));
    const ext = createWorktreeExtension({ exec });
    await expect(ext.resolveSessionSpec?.({ cwd: "/repo" }, request("r-disabled"))).rejects.toThrow(/disabled/);
    expect(exec).not.toHaveBeenCalled();
  });

  it("commits dirty worktree changes to pi-agent-runId before removing it", async () => {
    const fake = fakeGit({ dirty: true });
    const ext = createWorktreeExtension({
      exec: fake.exec,
      settings: { enabled: true },
      worktreeRoot: "/tmp/test-worktrees",
    });
    await ext.resolveSessionSpec?.({ cwd: "/repo" }, request("r-dirty"));
    await ext.beforeReap?.(outcome("r-dirty"), { cwd: "/tmp/test-worktrees/r-dirty", deadlineMs: 1000 });
    expect(fake.branches.has("pi-agent-r-dirty")).toBe(true);
    expect(fake.calls.map((c) => c.args)).toEqual([
      ["rev-parse", "--show-toplevel"],
      ["worktree", "add", "--detach", "/tmp/test-worktrees/r-dirty"],
      ["status", "--porcelain"],
      ["switch", "-c", "pi-agent-r-dirty"],
      ["add", "-A"],
      ["commit", "-m", "pi-agent r-dirty"],
      ["worktree", "remove", "--force", "/tmp/test-worktrees/r-dirty"],
    ]);
  });

  it("removes a clean worktree without creating a branch", async () => {
    const fake = fakeGit();
    const ext = createWorktreeExtension({
      exec: fake.exec,
      settings: { enabled: true },
      worktreeRoot: "/tmp/test-worktrees",
    });
    await ext.resolveSessionSpec?.({ cwd: "/repo" }, request("r-clean"));
    await ext.beforeReap?.(outcome("r-clean"), { cwd: "/tmp/test-worktrees/r-clean", deadlineMs: 1000 });
    expect(fake.branches.size).toBe(0);
    expect(fake.calls.at(-1)?.args).toEqual(["worktree", "remove", "--force", "/tmp/test-worktrees/r-clean"]);
  });

  it("reports cleanup failure without throwing or changing the run outcome", async () => {
    const fake = fakeGit({ removeCode: 1 });
    const diagnostics: unknown[] = [];
    const ext = createWorktreeExtension({
      exec: fake.exec,
      settings: { enabled: true },
      worktreeRoot: "/tmp/test-worktrees",
      onDiagnostic: (event) => diagnostics.push(event),
    });
    await ext.resolveSessionSpec?.({ cwd: "/repo" }, request("r-cleanup-fail"));
    await expect(
      ext.beforeReap?.(outcome("r-cleanup-fail"), { cwd: "/tmp/test-worktrees/r-cleanup-fail", deadlineMs: 1000 }),
    ).resolves.toBeUndefined();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      runId: "r-cleanup-fail",
      phase: "cleanup",
      message: "worktree cleanup failed",
    });
  });
});
