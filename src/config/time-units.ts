/**
 * Time-unit boundary (tui-settings requirement 2).
 *
 * The whole runtime keeps **milliseconds** internally (`DeadlineBudget`,
 * `AgentSettings`, `WorkflowBudget`, `BashJobsSettings`, every watchdog/reaper
 * deadline). Seconds exist in exactly three places, all of them boundaries:
 *
 *  1. the settings *file* — time keys are stored as `*S` holding integer seconds
 *     (`budget.idleS: 240` instead of `budget.idleMs: 240000`);
 *  2. what the user *sees* — the `/agent settings` TUI editor and the text
 *     `list` / completion descriptions;
 *  3. what the user *types* — `set` values and editor input are seconds.
 *
 * This module owns the mechanical part of that boundary: the dotted-path
 * helpers, the `*Ms` ⇄ `*S` key rename, the numeric conversion, and the two
 * record passes used by `config/settings.ts`:
 *
 *  - {@link normalizeTimeUnits} — *parse* pass: file shape (seconds) →
 *    internal shape (milliseconds). Pure, silent, field-level tolerant.
 *  - {@link migrateTimeUnitsToSeconds} — *migration* pass: legacy file shape
 *    (`*Ms`) → new file shape (`*S`), reporting what changed so the caller can
 *    WARN + write the file back.
 *
 * Everything here is pure (no fs, no console) so both passes are unit-testable
 * and neither can throw into the settings-loading path.
 */

/** Storage/display key for an internal millisecond path: `budget.idleMs` → `budget.idleS`. */
export function secondsKeyOf(msKey: string): string {
  return msKey.endsWith("Ms") ? `${msKey.slice(0, -2)}S` : msKey;
}

/** Inverse of {@link secondsKeyOf}: `budget.idleS` → `budget.idleMs`. */
export function msKeyOf(secondsKey: string): string {
  return secondsKey.endsWith("S") && !secondsKey.endsWith("Ms") ? `${secondsKey.slice(0, -1)}Ms` : secondsKey;
}

/** Seconds → milliseconds (input/editor direction). */
export function secondsToMs(seconds: number): number {
  return Math.round(seconds * 1_000);
}

/** Milliseconds → seconds for display; may be fractional if the ms value is not a whole second. */
export function msToSeconds(ms: number): number {
  return ms / 1_000;
}

/**
 * Milliseconds → integer seconds, or `undefined` when the value is not a
 * non-negative finite whole number of seconds. Used by the migration to decide
 * between "convert" and "drop with a WARN".
 */
export function msToWholeSeconds(ms: unknown): number | undefined {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return undefined;
  return ms % 1_000 === 0 ? ms / 1_000 : undefined;
}

type Rec = Record<string, unknown>;

function asRecord(value: unknown): Rec | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : undefined;
}

/** Read a dotted path out of an arbitrary value; `undefined` when any segment is missing. */
export function getPath(root: unknown, dottedKey: string): unknown {
  let node: unknown = root;
  for (const segment of dottedKey.split(".")) {
    const record = asRecord(node);
    if (!record) return undefined;
    node = record[segment];
  }
  return node;
}

/** Write a dotted path in place, creating intermediate objects; `undefined` deletes the leaf. */
export function setPath(root: Rec, dottedKey: string, value: unknown): void {
  const segments = dottedKey.split(".");
  let node = root;
  for (const segment of segments.slice(0, -1)) {
    const child = asRecord(node[segment]);
    const next: Rec = child ?? {};
    node[segment] = next;
    node = next;
  }
  const leaf = segments[segments.length - 1]!;
  if (value === undefined) delete node[leaf];
  else node[leaf] = value;
}

/**
 * Walk to the parent record of `path`, shallow-copying every record on the way
 * so the caller can mutate without touching the input object. Returns
 * `undefined` when the branch does not exist (or is not a plain object) — a
 * missing branch simply means "no override here", never an error.
 */
function copyBranch(root: Rec, segments: readonly string[]): Rec | undefined {
  let node = root;
  for (const segment of segments) {
    const child = asRecord(node[segment]);
    if (!child) return undefined;
    const copy: Rec = { ...child };
    node[segment] = copy;
    node = copy;
  }
  return node;
}

/** Split `a.b.cMs` into `{ container: ["a","b"], msLeaf: "cMs", secondsLeaf: "cS" }`. */
function splitTimePath(msPath: string): { container: string[]; msLeaf: string; secondsLeaf: string } {
  const segments = msPath.split(".");
  const msLeaf = segments[segments.length - 1]!;
  return { container: segments.slice(0, -1), msLeaf, secondsLeaf: secondsKeyOf(msLeaf) };
}

/**
 * Parse pass: return a copy of `raw` where every time path listed in
 * `msPaths` is expressed in **milliseconds** under its `*Ms` key, so the rest
 * of `loadSettings` can keep validating millisecond numbers unchanged.
 *
 * Field-level rules (never throws, never warns — a bad field just disappears
 * and the caller's default wins):
 *  - `*S` present → `*Ms = seconds * 1000`; the `*S` key is removed from the copy.
 *  - `*S` present *and* `*Ms` present → the new key wins (`*Ms` is overwritten).
 *  - only legacy `*Ms` present → kept when it is a non-negative whole second
 *    (identity conversion), dropped otherwise. `loadSettingsFromFile` migrates
 *    and WARNs about these; direct `loadSettings` callers stay tolerant.
 */
export function normalizeTimeUnits(raw: Rec, msPaths: readonly string[]): Rec {
  const out: Rec = { ...raw };
  for (const msPath of msPaths) {
    const { container, msLeaf, secondsLeaf } = splitTimePath(msPath);
    const node = copyBranch(out, container);
    if (!node) continue;
    if (Object.hasOwn(node, secondsLeaf)) {
      const seconds = node[secondsLeaf];
      delete node[secondsLeaf];
      if (typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0) node[msLeaf] = secondsToMs(seconds);
      else delete node[msLeaf];
      continue;
    }
    if (Object.hasOwn(node, msLeaf) && msToWholeSeconds(node[msLeaf]) === undefined) delete node[msLeaf];
  }
  return out;
}

export interface TimeUnitMigration {
  /** Migrated copy of the input, in the new (`*S`, integer seconds) storage shape. */
  value: Record<string, unknown>;
  /** True when at least one legacy `*Ms` key was rewritten or dropped (⇒ write the file back). */
  changed: boolean;
  /** `"budget.idleMs → budget.idleS (240)"` entries, for one summary WARN. */
  converted: string[];
  /** Human-readable reasons for dropped/duplicated keys, one WARN each. */
  warnings: string[];
}

/**
 * Migration pass: rewrite legacy millisecond keys in a settings *file* object
 * to the new integer-second keys.
 *
 *  - `*Ms` divisible by 1000 → `*S = ms / 1000`, legacy key removed.
 *  - `*Ms` not a non-negative whole second (fractional, negative, NaN, string,
 *    …) → legacy key removed and reported, so the field falls back to its
 *    default rather than silently rounding a value the user chose.
 *  - both `*Ms` and `*S` present → the new key wins, legacy key removed.
 *
 * Pure: the caller decides whether to WARN and whether to write `value` back.
 */
export function migrateTimeUnitsToSeconds(raw: Rec, msPaths: readonly string[]): TimeUnitMigration {
  const value: Rec = { ...raw };
  const converted: string[] = [];
  const warnings: string[] = [];
  let changed = false;
  for (const msPath of msPaths) {
    const { container, msLeaf, secondsLeaf } = splitTimePath(msPath);
    const node = copyBranch(value, container);
    if (!node || !Object.hasOwn(node, msLeaf)) continue;
    const legacy = node[msLeaf];
    const secondsPath = secondsKeyOf(msPath);
    delete node[msLeaf];
    changed = true;
    if (Object.hasOwn(node, secondsLeaf)) {
      warnings.push(`${msPath} and ${secondsPath} are both set; keeping ${secondsPath}=${String(node[secondsLeaf])}`);
      continue;
    }
    const seconds = msToWholeSeconds(legacy);
    if (seconds === undefined) {
      warnings.push(
        `${msPath}=${String(legacy)} is not a whole number of seconds; dropping it (the default will be used)`,
      );
      continue;
    }
    node[secondsLeaf] = seconds;
    converted.push(`${msPath} → ${secondsPath} (${seconds})`);
  }
  return { value, changed, converted, warnings };
}
