import { describe, expect, it, vi } from "vitest";

import { GIT_BRANCH_TIMEOUT_MS, getGitBranch, type GitExecFn } from "../../src/feishu-notify/git.js";

/** 构造可编程的 fake exec：按 args 序列返回 stdout 或抛错 */
function fakeExec(routes: Record<string, string | Error>): GitExecFn & { calls: string[][] } {
  const calls: string[][] = [];
  const fn = (async (_cmd: string, args: string[]) => {
    calls.push(args);
    const key = args.join(" ");
    const v = routes[key];
    if (v instanceof Error) throw v;
    if (v === undefined) throw new Error(`unexpected git args: ${key}`);
    return { stdout: v };
  }) as GitExecFn & { calls: string[][] };
  fn.calls = calls;
  return fn;
}

describe("getGitBranch", () => {
  it("returns the current branch name on a normal repo", async () => {
    const exec = fakeExec({ "rev-parse --abbrev-ref HEAD": "feat/notify-cwd-branch\n" });
    await expect(getGitBranch("/repo", exec)).resolves.toBe("feat/notify-cwd-branch");
  });

  it("passes cwd and a bounded timeout to git", async () => {
    const exec = vi.fn(async () => ({ stdout: "main\n" })) as unknown as GitExecFn;
    await getGitBranch("/some/dir", exec);
    expect(exec).toHaveBeenCalledWith(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      expect.objectContaining({ cwd: "/some/dir", timeout: GIT_BRANCH_TIMEOUT_MS }),
    );
  });

  it("detached HEAD -> falls back to short SHA marked as detached", async () => {
    const exec = fakeExec({
      "rev-parse --abbrev-ref HEAD": "HEAD\n",
      "rev-parse --short HEAD": "a1b2c3d\n",
    });
    await expect(getGitBranch("/repo", exec)).resolves.toBe("a1b2c3d (detached)");
    expect(exec.calls).toEqual([
      ["rev-parse", "--abbrev-ref", "HEAD"],
      ["rev-parse", "--short", "HEAD"],
    ]);
  });

  it("detached HEAD with no commits (short SHA fails) -> undefined", async () => {
    const exec = fakeExec({
      "rev-parse --abbrev-ref HEAD": "HEAD\n",
      "rev-parse --short HEAD": new Error("fatal: Needed a single revision"),
    });
    await expect(getGitBranch("/repo", exec)).resolves.toBeUndefined();
  });

  // 负面对照 ①：非 git 仓库
  it("non-git directory -> undefined, never throws", async () => {
    const exec = fakeExec({
      "rev-parse --abbrev-ref HEAD": new Error("fatal: not a git repository"),
    });
    await expect(getGitBranch("/not/a/repo", exec)).resolves.toBeUndefined();
  });

  // 负面对照 ②：git 子进程超时/被杀
  it("git timeout -> undefined, never throws", async () => {
    const exec = fakeExec({
      "rev-parse --abbrev-ref HEAD": Object.assign(new Error("killed"), { killed: true, signal: "SIGTERM" }),
    });
    await expect(getGitBranch("/slow/repo", exec)).resolves.toBeUndefined();
  });

  it("empty abbrev-ref output -> tries short SHA, undefined if that is empty too", async () => {
    const exec = fakeExec({
      "rev-parse --abbrev-ref HEAD": "\n",
      "rev-parse --short HEAD": "\n",
    });
    await expect(getGitBranch("/repo", exec)).resolves.toBeUndefined();
  });

  it("trims trailing whitespace/newlines from branch name", async () => {
    const exec = fakeExec({ "rev-parse --abbrev-ref HEAD": "  main \n" });
    await expect(getGitBranch("/repo", exec)).resolves.toBe("main");
  });
});
