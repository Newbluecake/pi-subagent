import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Clock } from "../core/clock.js";
import type { Millis } from "../core/types.js";
import { isJobId } from "./ids.js";
import type { ProcessPort } from "./process.js";
import { isTerminalJobStatus, parseJobRecord, type JobRecord } from "./types.js";
import type { BashJobManager, LocalJobHandoff } from "./manager.js";

const SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;
const UUIDV7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TMP_RE = /^b_.+\.tmp$/;
const TMP_RETENTION_MS = 3_600_000;

/** Disk contract: changing this function changes the on-disk session layout. */
export function sanitizeSessionDirName(sessionId: string): string {
  if (!sessionId || !SESSION_ID_RE.test(sessionId)) return "_unscoped";
  if (UUIDV7_RE.test(sessionId)) return sessionId;
  const lower = sessionId
    .toLowerCase()
    .replace(/[^a-z0-9]+$/g, "")
    .slice(0, 48);
  return `${lower || "session"}-${createHash("sha256").update(sessionId).digest("hex").slice(0, 8)}`;
}

export interface SessionDirOptions {
  rootDir: string;
  selfDirName?: string;
  skipDirNames?: readonly string[];
  retentionMs: Millis;
  clock: Clock;
  processPort: ProcessPort;
  hostPid?: number;
  sessionId?: string;
  warn?: (message: string) => void;
  isRoot?: boolean;
}

function warning(options: SessionDirOptions, message: string): void {
  (options.warn ?? ((text: string) => console.warn(`[pi-subagent] ${text}`)))(message);
}
function code(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : undefined;
}
async function fileAge(path: string, now: Millis): Promise<Millis | undefined> {
  try {
    const age = now - (await stat(path)).mtimeMs;
    return Number.isFinite(age) && age >= 0 ? age : undefined;
  } catch {
    return undefined;
  }
}
async function unlinkQuiet(path: string, options: SessionDirOptions): Promise<boolean> {
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if (code(error) !== "ENOENT") warning(options, `failed to remove bash job file ${path}: ${String(error)}`);
    return false;
  }
}
async function writeAtomic(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${process.pid}.${Date.now()}.session.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}
async function readRecord(path: string, options: SessionDirOptions): Promise<JobRecord | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    const result = parseJobRecord(parsed);
    if (!result.ok) return undefined;
    return result.record;
  } catch (error) {
    if (code(error) !== "ENOENT") warning(options, `failed to read bash job record ${path}: ${String(error)}`);
    return undefined;
  }
}
async function names(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function moveRecordFiles(
  fromDir: string,
  toDir: string,
  record: JobRecord,
  options: SessionDirOptions,
  patch: Partial<JobRecord> = {},
): Promise<boolean> {
  const json = join(toDir, `${record.jobId}.json`);
  try {
    await stat(json);
    const existing = await readRecord(json, options);
    warning(
      options,
      `bash job migration target exists; keeping both records for ${record.jobId}: ` +
        `source ${record.createdAt}/${record.command}; ` +
        `target ${existing ? `${existing.createdAt}/${existing.command}` : "unreadable"}`,
    );
    return false;
  } catch (error) {
    if (code(error) !== "ENOENT") return false;
  }
  await mkdir(toDir, { recursive: true, mode: 0o700 });
  await writeFile(join(toDir, "session-id"), `${patch.sessionId ?? record.sessionId}\n`, {
    encoding: "utf8",
    mode: 0o600,
  }).catch(() => undefined);
  const sourceLog = join(fromDir, `${record.jobId}.log`);
  try {
    await rename(sourceLog, join(toDir, `${record.jobId}.log`));
  } catch (error) {
    if (code(error) !== "ENOENT") warning(options, `failed to move bash job log ${sourceLog}: ${String(error)}`);
    return false;
  }
  await writeAtomic(json, { ...record, ...patch, logPath: join(toDir, `${record.jobId}.log`) });
  await unlink(join(fromDir, `${record.jobId}.json`)).catch((error) => {
    if (code(error) !== "ENOENT") warning(options, String(error));
  });
  return true;
}

export async function migrateFlatRecords(
  options: SessionDirOptions,
  onlyDirName?: string,
  skipDirNames?: readonly string[],
): Promise<void> {
  const root = options.rootDir;
  for (const name of await names(root)) {
    if (!name.endsWith(".json") || !isJobId(name.slice(0, -5))) continue;
    const record = await readRecord(join(root, name), options);
    if (!record) continue;
    if (record.hostPid > 0 && options.processPort.probePid(record.hostPid)) continue;
    const targetName = sanitizeSessionDirName(record.sessionId);
    if (onlyDirName !== undefined && targetName !== onlyDirName) continue;
    if (skipDirNames?.includes(targetName)) continue;
    await moveRecordFiles(root, join(root, targetName), record, options);
  }
}

export async function adoptOrphans(options: SessionDirOptions, excludeDirNames: readonly string[] = []): Promise<void> {
  const self = options.selfDirName ?? "_unscoped";
  for (const dirent of await readdir(options.rootDir, { withFileTypes: true }).catch(() => [])) {
    if (!dirent.isDirectory() || dirent.name === self || excludeDirNames.includes(dirent.name)) continue;
    if (dirent.name !== "_unscoped" && !isSessionDirName(dirent.name)) continue;
    for (const name of await names(join(options.rootDir, dirent.name))) {
      if (!name.endsWith(".json") || !isJobId(name.slice(0, -5))) continue;
      const fromDir = join(options.rootDir, dirent.name);
      const record = await readRecord(join(fromDir, name), options);
      if (!record || isTerminalJobStatus(record.status)) continue;
      if (record.hostPid > 0 && options.processPort.probePid(record.hostPid)) continue;
      await moveRecordFiles(fromDir, join(options.rootDir, self), record, options, {
        sessionId: options.sessionId ?? record.sessionId,
      });
    }
  }
}

export async function sweepJobFiles(dir: string, options: SessionDirOptions): Promise<void> {
  const entries = await names(dir);
  const present = new Set(entries);
  const now = options.clock.now();
  for (const name of entries) {
    const path = join(dir, name);
    if (TMP_RE.test(name)) {
      const age = await fileAge(path, now);
      if (age !== undefined && age >= TMP_RETENTION_MS) await unlinkQuiet(path, options);
      continue;
    }
    if (options.retentionMs <= 0) continue;
    if (name.endsWith(".json") && (isJobId(name.slice(0, -5)) || (options.isRoot === true && name.startsWith("b_")))) {
      const record = isJobId(name.slice(0, -5)) ? await readRecord(path, options) : undefined;
      if (!record) {
        const age = await fileAge(path, now);
        if (age !== undefined && age >= options.retentionMs) {
          await unlinkQuiet(path, options);
          await unlinkQuiet(join(dir, `${name.slice(0, -5)}.log`), options);
        }
      } else if (
        isTerminalJobStatus(record.status) &&
        now - (record.endedAt ?? record.createdAt) >= options.retentionMs
      ) {
        await unlinkQuiet(path, options);
        await unlinkQuiet(join(dir, `${record.jobId}.log`), options);
      }
    } else if (name.endsWith(".log") && isJobId(name.slice(0, -4)) && !present.has(`${name.slice(0, -4)}.json`)) {
      const age = await fileAge(path, now);
      if (age !== undefined && age >= options.retentionMs) await unlinkQuiet(path, options);
    }
  }
}

export async function gcSessionDir(dir: string, options: SessionDirOptions, rmdirSelf = true): Promise<void> {
  await sweepJobFiles(dir, options);
  if (!rmdirSelf) return;
  let left = await names(dir);
  if (left.length === 1 && left[0] === "session-id") {
    await unlinkQuiet(join(dir, "session-id"), options);
    left = await names(dir);
  }
  if (left.length === 0)
    await rmdir(dir).catch((error) => {
      if (code(error) !== "ENOENT" && code(error) !== "ENOTEMPTY") warning(options, String(error));
    });
}

export async function reconcileRootDir(options: SessionDirOptions): Promise<void> {
  await migrateFlatRecords(options, undefined, options.skipDirNames);
  await sweepJobFiles(options.rootDir, { ...options, isRoot: true });
  for (const dirent of await readdir(options.rootDir, { withFileTypes: true }).catch(() => [])) {
    if (!dirent.isDirectory() || dirent.name === options.selfDirName) continue;
    if (dirent.name !== "_unscoped" && !isSessionDirName(dirent.name)) continue;
    await gcSessionDir(join(options.rootDir, dirent.name), options, dirent.name !== "_unscoped");
  }
}

export async function handoffInProcess(
  previous: BashJobManager,
  current: BashJobManager,
  options: SessionDirOptions,
): Promise<void> {
  const handoffs = previous.exportLocalJobs();
  const preparedHandoffs: LocalJobHandoff[] = [];
  for (const handoff of handoffs) {
    const sessionId = options.sessionId ?? handoff.record.sessionId;
    const record =
      previous.dir !== current.dir
        ? { ...handoff.record, sessionId, logPath: join(current.dir, `${handoff.jobId}.log`) }
        : handoff.record;
    if (previous.dir !== current.dir) {
      await moveRecordFiles(previous.dir, current.dir, handoff.record, options, { sessionId });
    }
    preparedHandoffs.push({ ...handoff, record });
  }
  current.adoptLocalJobs(preparedHandoffs);
  if (previous.dir !== current.dir) {
    const handedIds = new Set(handoffs.map((handoff) => handoff.jobId));
    for (const record of previous.list()) {
      if (handedIds.has(record.jobId)) continue;
      if (
        record.hostPid > 0 &&
        record.hostPid !== (options.hostPid ?? process.pid) &&
        options.processPort.probePid(record.hostPid)
      ) {
        continue;
      }
      if (
        (!isTerminalJobStatus(record.status) && !previous.hasOpenLocalHandle(record.jobId)) ||
        (record.backgroundedAt !== undefined && record.notifiedAt === undefined)
      ) {
        await moveRecordFiles(previous.dir, current.dir, record, options, {
          sessionId: options.sessionId ?? record.sessionId,
        });
      }
    }
  }
  await previous.drain();
}

export async function sweepHandoffRemnants(
  dir: string,
  activeJobIds: ReadonlySet<string>,
  options: SessionDirOptions,
): Promise<void> {
  for (const name of await names(dir)) {
    const id = name.endsWith(".json") ? name.slice(0, -5) : name.endsWith(".log") ? name.slice(0, -4) : "";
    if (isJobId(id) && activeJobIds.has(id)) await unlinkQuiet(join(dir, name), options);
  }
}

function isSessionDirName(name: string): boolean {
  return UUIDV7_RE.test(name) || /^[a-z0-9._-]+-[0-9a-f]{8}$/.test(name);
}

export { moveRecordFiles };
