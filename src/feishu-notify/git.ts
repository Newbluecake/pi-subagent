/**
 * git 分支探测（IO 层）。
 *
 * core.ts 是纯逻辑无 IO，因此取分支的子进程调用独立在本模块，
 * 由 index.ts 调用并把结果通过 BuildCardInput.branch 传入 buildCard。
 *
 * 设计原则：best-effort。非 git 仓库、git 不可用、超时、无任何提交……
 * 一律降级为 undefined（卡片不显示分支字段），绝不抛出、绝不阻塞通知。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** git 子进程超时：超时即杀死进程并降级为不显示分支。 */
export const GIT_BRANCH_TIMEOUT_MS = 2000;

const defaultExec = promisify(execFile);

/** 可注入的 execFile(promisified) 形态，测试用 fake 替换。 */
export type GitExecFn = (
  cmd: string,
  args: string[],
  options: { cwd: string; timeout: number },
) => Promise<{ stdout: string | Buffer; stderr?: string | Buffer }>;

async function runGit(exec: GitExecFn, cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, timeout: GIT_BRANCH_TIMEOUT_MS });
  return String(stdout).trim();
}

/**
 * 取 cwd 所在 git 仓库的当前分支名；worktree 下同样正确（rev-parse 遵循 worktree HEAD）。
 *
 * 降级规则：
 * - 任何错误（非 git 仓库、git 缺失、超时）→ undefined。
 * - detached HEAD（`--abbrev-ref` 返回字面量 "HEAD"）→ 取短 SHA，返回 `<sha> (detached)`；
 *   短 SHA 也取不到（如无提交的空仓库）→ undefined。
 */
export async function getGitBranch(cwd: string, exec: GitExecFn = defaultExec): Promise<string | undefined> {
  try {
    const ref = await runGit(exec, cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (ref && ref !== "HEAD") return ref;
    // detached HEAD 或异常空输出：尝试短 SHA
    const sha = await runGit(exec, cwd, ["rev-parse", "--short", "HEAD"]);
    return sha ? `${sha} (detached)` : undefined;
  } catch {
    return undefined;
  }
}
