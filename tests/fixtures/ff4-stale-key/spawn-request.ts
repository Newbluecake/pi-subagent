/**
 * WC13 ③ (workflow design §4.4.1.1): negative fixture for Gate B
 * (`_AssertNoStaleKeys`). Self-contained mirror (not an import of the real
 * module), like `ff4-unclassified/`.
 *
 * `NOT_THREADED` lists a key, `"legacyOwnerHint"`, that does not exist on
 * `SpawnRequest` (e.g. left over after a rename). This must fail
 * `tsc --noEmit` at `_assertNoStaleKeys` (Gate B) — every field is otherwise
 * correctly classified, so Gate A alone would not catch this.
 */
interface SpawnRequest {
  runId?: string;
  type: string;
  prompt: string;
  label?: string;
  cwd?: string;
  modelOverride?: { provider: string; id: string };
  budgetOverride?: Partial<{ totalMs: number }>;
  slotless?: boolean;
  parentRunId?: string;
  isolation?: "worktree";
  signal?: AbortSignal;
  resumeFrom?: string;
  schema?: unknown;
  deadlineAt?: number;
}

const THREADED = ["signal", "slotless", "resumeFrom", "parentRunId", "deadlineAt"] as const;
const NOT_THREADED = [
  "runId",
  "type",
  "prompt",
  "label",
  "cwd",
  "modelOverride",
  "budgetOverride",
  "isolation",
  "schema",
  // Deliberately stale below — this key was renamed/removed from SpawnRequest.
  "legacyOwnerHint",
] as const;

type ClassifiedKeys = (typeof THREADED)[number] | (typeof NOT_THREADED)[number];

type _AssertAllClassified = Exclude<keyof SpawnRequest, ClassifiedKeys> extends never ? true : never;
const _assertAllClassified: _AssertAllClassified = true;

type _AssertNoStaleKeys = Exclude<ClassifiedKeys, keyof SpawnRequest> extends never ? true : never;
const _assertNoStaleKeys: _AssertNoStaleKeys = true;

void _assertAllClassified;
void _assertNoStaleKeys;
