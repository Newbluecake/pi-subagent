# `/agent settings` TUI editor + second-based time units — implementation notes

Companion to [tui-settings-requirements.md](./tui-settings-requirements.md). Read this before
touching the settings surface.

## 1. Where seconds live (and where they do not)

The runtime is **milliseconds everywhere**. `DeadlineBudget`, `AgentSettings`, `WorkflowBudget`,
`BashJobsSettings`, every watchdog/reaper deadline and the whole RPC surface are unchanged. Seconds
exist at exactly three boundaries:

| Boundary                        | Representation                                      | Owner                     |
| ------------------------------- | --------------------------------------------------- | ------------------------- |
| settings file (`*.json`)        | `budget.idleS: 240` (integer seconds)               | `config/settings.ts`      |
| display (`list`, editor, tab)   | seconds                                             | `config/setting-specs.ts` |
| input (`set`, editor keystroke) | seconds, validated in the second domain, then ×1000 | `config/setting-specs.ts` |

`config/time-units.ts` owns the mechanical conversion: the `*Ms` ⇄ `*S` key rename, the scalar
conversions, dotted-path get/set, and the two record passes described below. It is pure — no fs, no
console — so neither pass can throw into the loader.

Consequence worth remembering: **the CLI key names are the storage names.** `/agent settings set
budget.idleS 600`, not `budget.idleMs`. Showing `600` under a key literally called `idleMs` would be
actively misleading, so the `*Ms` names are gone from every user-visible surface. `spec.path` keeps
the internal ms path.

## 2. Two record passes

```
file JSON ──migrateTimeUnitsToSeconds──► new file shape ──normalizeTimeUnits──► ms record ──► loadSettings validators
            (loadSettingsFromFile only)                    (loadSettings)
```

- `normalizeTimeUnits(raw, TIME_SETTING_MS_PATHS)` — _parse_. Rewrites each `*S` key into `*Ms`
  (×1000) so every existing field validator in `loadSettings` keeps reasoning in milliseconds. Field
  level tolerance, silent: an illegal `*S` value simply disappears and the default wins. A surviving
  legacy `*Ms` key is honoured when it is a non-negative whole second, dropped otherwise — that keeps
  direct `loadSettings(obj)` callers (and tests) working without duplicating the migration.
- `migrateTimeUnitsToSeconds(raw, TIME_SETTING_MS_PATHS)` — _migration_. Legacy → new **file** shape,
  returning `{ value, changed, converted, warnings }`. Divisible-by-1000 values are converted;
  everything else (fractional, negative, NaN, string) is dropped and reported so the user learns the
  field fell back to its default instead of being silently rounded. When both keys are present the
  new one wins and the legacy one is removed.

`loadSettingsFromFile` is the **only** migration point (it is the only place holding the raw JSON,
the path, write access and a console at once): migrate → WARN (one summary line for conversions, one
line per drop) → write the file back → parse. A failed write-back is only a WARN; the in-memory
settings are already migrated and the rewrite is retried next load. Idempotent: a second load neither
warns nor rewrites.

`TIME_SETTING_MS_PATHS` is derived from `DEFAULT_BUDGET` / `DEFAULT_WORKFLOW_BUDGET` (any key ending
in `Ms`) plus the hand-written flat paths, so **a new timeout field cannot be added without being
unit-converted**. `budget.startupRetries` is a count and is excluded by the suffix test.

## 3. One spec table, two surfaces

`config/setting-specs.ts` is the contract between the text command and the editor:

```ts
SETTING_SPECS["budget.idleS"] = {
  kind: "number",
  path: "budget.idleMs",
  time: true,
  integer: true,
  min: 0,
  live: true,
};
```

- `time: true` ⇒ the stored/displayed value is seconds while `path` holds ms. All duration specs are
  `integer: true` (no fractional seconds, requirement 2).
- `live: true` ⇒ `budget.*`, read at spawn time, so an in-place mutation applies to new runs
  immediately. Everything else is captured at activate/session build ⇒ `/reload`.
- `max` is validated in the _second_ domain, which is why `coalesceWindowS` / `ackWindowS` read
  `between 0 and 5 seconds` instead of `<= 5000`. `loadSettings` still clamps at 5 000 ms.
- `fallback` supplies the effective default for `workflow.budget.*`, which `DEFAULT_SETTINGS` leaves
  unset (`budget: {}`) but the runtime merges from `DEFAULT_WORKFLOW_BUDGET`. Those ten keys are now
  editable (they were excluded from the old flat table).

`writeSetting` / `resetSetting` are the single write path: mutate the live object with the **ms**
value, persist the **second** value under the storage key, and report `{ previous, next, effect,
persistError }`. Both surfaces only format that result differently.

## 4. Editor layering

`src/ui/settings-editor.ts` is three layers, mirroring the fleet-panel/fleet-widget split so only the
thinnest one needs a terminal:

1. `decodeSettingsEditorInput(data, mode)` — pure key decoding, **mode-aware**: `r` resets while
   browsing but types an `r` while editing, arrows never leak into the input buffer.
2. `SettingsEditorModel` — pure state machine. Navigation (wrapping ↑↓, clamped page jumps,
   home/end), boolean/enum cycling, the inline edit buffer with **live validation on every
   keystroke**, `r` reset, and persist-on-confirm. Illegal input keeps the user in the input with the
   reason visible and writes nothing. Esc leaves the input first and only closes from browse mode, so
   a mistyped value cannot take the overlay down. Rows are recomputed from the live store on every
   `snapshot()`, so `budget.*` edits are visible instantly.
3. `renderSettingsEditor` (pure, injected `colorize`) + `createSettingsEditorComponent` (≈15-line
   adapter: keys in, lines out, `done()` when the model reports `closed`).

`openSettingsEditor` wraps `ctx.ui.custom({ overlay: true })`. `canOpenSettingsEditor` is a
_synchronous_ probe (`ctx.mode === "tui" && typeof ctx.ui.custom === "function"`) so the print/rpc/json
path never even yields a microtask — that keeps `ctx.ui.notify` ordering intact for scripts and for
the command's synchronous tests. A throw from `custom()` degrades to the text listing rather than
failing the command.

Command routing (`commands/status.ts`): `/agent settings` and `/agent budget` **with no arguments**
open the editor (the latter scoped to `budget.*`); `list`, `set`, `reset` and every non-TUI mode keep
the previous text behaviour verbatim, modulo the second-valued keys.

## 5. Invariants to preserve

- The loader never throws. Every field falls back independently; migration failures WARN.
- `budget.*` mutation must stay in-place on the shared `AgentSettings` object (`index.ts` passes it by
  reference into every session stack) — do not replace `store.current`.
- Editor and `set` must reject the same values with the same reason (shared `parseSettingValue`).
- No fractional seconds anywhere in the input path.

## 6. Tests

- `tests/config/time-units.test.ts` — both record passes: nesting, non-divisible values, new/legacy
  coexistence, non-mutation, hostile shapes.
- `tests/config/settings-time-migration.test.ts` — `loadSettingsFromFile` against real temp files:
  conversion + write-back + WARN text, idempotence, drop-with-default, read-only file, malformed
  roots, path-list coverage.
- `tests/commands/status.test.ts` — text command in the second domain, plus the editor wiring
  (TUI opens the overlay, `list`/print/rpc/no-`ui.custom` fall back).
- `tests/ui/settings-editor.test.ts` — key decoding, the state machine (navigation, edit/commit/cancel,
  toggles, enum cycling, reset, persist failure), the renderer, and the component adapter.
