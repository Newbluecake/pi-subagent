import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { createWorktreeExtension } from "../../src/extensions/worktree.js";
import type { RunOutcome, SessionSpec, SpawnRequest } from "../../src/core/types.js";

const execFileAsync = promisify(execFile);
const realExec = async (cmd: string, args: readonly string[], opts: { cwd?: string; timeout?: number }) => {
  try {
    const r = await execFileAsync(cmd, [...args], { cwd: opts.cwd, timeout: opts.timeout });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? String(e) };
  }
};

const dirs: string[] = [];
async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-subagent-git-"));
  dirs.push(dir);
  await realExec("git", ["init", "-q"], { cwd: dir });
  await realExec("git", ["config", "user.email", "t@t"], { cwd: dir });
  await realExec("git", ["config", "user.name", "t"], { cwd: dir });
  await writeFile(join(dir, "a.txt"), "1");
  await realExec("git", ["add", "-A"], { cwd: dir });
  await realExec("git", ["commit", "-qm", "init"], { cwd: dir });
  return dir;
}
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

// spec.cwd MUST point at the repo under test — without it the extension
// resolves process.cwd() and would operate on this project's own checkout
// (learned the hard way: a failing assertion + a stray pi-agent branch).
const spec = (repo: string): SessionSpec =>
  ({ runId: "r-git", type: "worker", prompt: "p", cwd: repo }) as unknown as SessionSpec;
const req = (runId: string): SpawnRequest => ({ type: "worker", prompt: "p", runId, isolation: "worktree" });
const outcome = (runId: string): RunOutcome =>
  ({ runId, status: "completed", diag: {}, turns: 0, durationMs: 1 }) as unknown as RunOutcome;

describe("X1 worktree against real git", () => {
  it("creates a real worktree, commits changes to a pi-agent branch, and removes the worktree", async () => {
    const repo = await makeRepo();
    const wtRoot = join(repo, ".wt");
    const ext = createWorktreeExtension({ exec: realExec, settings: { enabled: true }, worktreeRoot: wtRoot });

    const rewritten = await ext.resolveSessionSpec!(spec(repo), req("r-git"));
    expect(rewritten.cwd).toContain(".wt");
    // the worktree is a real git checkout
    const inside = await realExec("git", ["rev-parse", "--is-inside-work-tree"], { cwd: rewritten.cwd });
    expect(inside.stdout.trim()).toBe("true");

    // simulate the subagent making a change inside the worktree
    await writeFile(join(rewritten.cwd!, "made-by-agent.txt"), "hello");
    await ext.beforeReap!(outcome("r-git"), { cwd: rewritten.cwd!, deadlineMs: 10_000 });

    // branch with the change exists in the main repo
    const branches = await realExec("git", ["branch", "--list", "pi-agent-r-git"], { cwd: repo });
    expect(branches.stdout.trim()).toContain("pi-agent-r-git");
    const files = await realExec("git", ["show", "--name-only", "--format=", "pi-agent-r-git"], { cwd: repo });
    expect(files.stdout).toContain("made-by-agent.txt");
    // worktree is gone
    const list = await realExec("git", ["worktree", "list", "--porcelain"], { cwd: repo });
    expect(list.stdout).not.toContain(".wt");
  });

  it("removes the worktree without creating a branch when nothing changed", async () => {
    const repo = await makeRepo();
    const wtRoot = join(repo, ".wt2");
    const ext = createWorktreeExtension({ exec: realExec, settings: { enabled: true }, worktreeRoot: wtRoot });
    const rewritten = await ext.resolveSessionSpec!(spec(repo), req("r-clean"));
    await ext.beforeReap!(outcome("r-clean"), { cwd: rewritten.cwd!, deadlineMs: 10_000 });
    const branches = await realExec("git", ["branch", "--list", "pi-agent-r-clean"], { cwd: repo });
    expect(branches.stdout.trim()).toBe("");
    const list = await realExec("git", ["worktree", "list", "--porcelain"], { cwd: repo });
    expect(list.stdout).not.toContain(".wt2");
  });
});
