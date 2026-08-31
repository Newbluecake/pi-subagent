/**
 * WC13 ② (workflow design §4.4.1.1): negative fixture for Gate A
 * (`_AssertAllClassified`). This is a self-contained mirror of
 * `src/service/request-threading.ts`'s classification pattern — NOT an
 * import of the real module — so this fixture's `tsc --noEmit` failure
 * signal is isolated from the rest of the repo's compile state.
 *
 * `__probe` is deliberately added to `SpawnRequest` but NOT added to either
 * `THREADED` or `NOT_THREADED`. This must fail `tsc --noEmit` at
 * `_assertAllClassified` (Gate A). If someone "fixes" the real gate by
 * reverting to the R3 `Required<Pick<...>>` form, this fixture must go back
 * to compiling cleanly — which is exactly why the WC13 test asserts a
 * non-zero exit code here, not just "the file exists".
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
  /** Deliberately unclassified below — this is the bug under test. */
  __probe?: string;
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
] as const;

type ClassifiedKeys = (typeof THREADED)[number] | (typeof NOT_THREADED)[number];

type _AssertAllClassified = Exclude<keyof SpawnRequest, ClassifiedKeys> extends never ? true : never;
const _assertAllClassified: _AssertAllClassified = true;

type _AssertNoStaleKeys = Exclude<ClassifiedKeys, keyof SpawnRequest> extends never ? true : never;
const _assertNoStaleKeys: _AssertNoStaleKeys = true;

void _assertAllClassified;
void _assertNoStaleKeys;
