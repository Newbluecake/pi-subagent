# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-09-02

### Added

- **Caller-ack notification suppression (delivery v2 P3)** — foreground callers can acknowledge completed outcomes to suppress undelivered notifications; the `ackWindowMs` hold window is disabled by default and fails open on persistence or cancellation errors.
- **`abort_subagent` tool** — stop a running subagent by run id, unique prefix, or Agent label; terminal runs return an idempotent already-finished result.
- **Foreground auto-backgrounding** — foreground Agent calls now return after 10 minutes by default when the run is still active; the run is not stopped and can be collected with `get_subagent_result`.
- **Fuzzy model hints** (parity with upstream @tintinweb/pi-subagents) — agent
  frontmatter `model:` and the Agent tool's `model` param now accept a bare model
  id (`kimi-k3`) or a case-insensitive substring alias (`sonnet`, `haiku`) in
  addition to a strict `provider/id`, resolved against pi's available models at
  spawn admission (`src/config/model-hint.ts`; matching tiers: strict pair →
  exact id → id prefix → id substring → display-name substring, candidate order
  breaks ties). Unresolvable hints are rejected with a self-correcting config
  error before any state write — never silently downgraded to the parent/default
  model. Pinned models are shown in the injected "Available subagent types"
  prompt section, and `modelHint` participates in the agent-type config hash so
  editing a hint correctly misses workflow journal replays.

### Fixed

- **Extension shows as "pi-subagent/index.js" in pi's resource list** — pi names
  package extension items after the entry file's location
  (`<parentDir>/<fileName>`), so the old `./dist/index.js` entry displayed as
  "dist/index.js". The `pi.extensions` entry now points at a thin package-root
  `index.js` re-export; the compiled implementation still lives in `dist/`.

- **Sub-phase deadline enforcement is real now** — the `EventWatchdog` was constructed with
  `getState`/`dispatch` no-op stubs ("M1 documented limitation"), so `idleMs`, `firstEventMs`,
  `toolMs`, etc. were computed and armed but never fired; only the runner's total-budget
  `setTimeout` race actually terminated a wedged run. A slow-but-trickling provider stream
  therefore hung the run until `totalMs`. The watchdog is now late-bound to the live runner
  (`getRunState` + new `fireDeadline`, which folds `deadline_fired` into the state machine
  and cancels the run's CancelHandle so the prompt guard unblocks immediately).
- **`retry_backoff` blind spot** — `dueAtFor` had no branch for it and `deadline_fired` was
  explicitly ignored there, so a wedged pi auto-retry could keep a run alive forever.
  Now backed by `idleDueAt` (covers the current backoff delay + slack).
- **`model_turn` idle semantics** — the old `phaseEnteredAt + idleMs` rule would have
  false-killed legitimately long thinking turns once enforcement was on. Now the idle
  deadline is silence-based (`lastEventAt + idleMs`), plus a new per-turn hard cap
  `modelTurnMs` (default 15 min) so a trickling turn still dies bounded.
- **Timeout outcomes no longer misreported as `aborted`** — cancelling the prompt guard
  after a watchdog deadline now yields `timed_out` with the original `timeoutReason`
  (e.g. `idle`), not `aborted`/`"total"`.
- **`prompt_dispatch` phase actually entered** — the runner never dispatched it, so a hung
  `prompt()` sat in `extension_bind` and would have reported a misleading bind timeout.
- New budget field: `modelTurnMs` (default `900_000`, `0` disables).

## [0.1.0] - 2026-09-01

First public release: anti-hang subagent extension for pi — drop-in replacement for
`@tintinweb/pi-subagents` core (`Agent` / `get_subagent_result` / `steer_subagent`).

### Features

- **Core**: pure run state machine with per-phase deadline budget (`d295ade`)
- **Runtime/service**: slot pool, session driver, runner, watchdog, escalating reaper, spawn/query services, notifier outbox (`6421dbd`)
- **Tools**: `Agent`, `get_subagent_result`, `steer_subagent` + `/agent status` command (`049e7a0`)
- **Presentation**: live execution visibility — model/label/tool-trail in diagnostics, streaming foreground tool card, agent-tree widget above the editor, completion notifications (`d713afb`)
- **Agent tree**: workflow group headers, theme colors, human-friendly phase labels, live activity line (thinking stream + tool trail with args preview on its own row) (`e287942`, `2d25b32`, `46c9cf7`, `d51f07a`)
- **Tools**: subagent spend flows into pi's session cost totals; real-time 1Hz usage broadcast (`a477efe`, `0450568`)
- **Delivery**: human-first notification head — `Subagent "label" (#shortId) status` (`65f2dab`)
- **Index**: inject registered agent types into the system prompt via `before_agent_start` (`735143b`)
- **Tools**: `renderCall` for the Agent tool card — task label, type, background/resume/isolation markers (`9c5f830`)
- **Workflow**: sandboxed `SubagentWorkflow` engine — worker + VM isolation, two-phase host-call protocol, script API (`agent`/`parallel`/`pipeline`/`phase`), abort propagation, journal & replay (`edbdd91`…`745e831`)
- **M2**: worktree isolation, resume, nested delegation (X3), structured output (X10), dynamic tool scope (X11), usage accumulation (`0c04d6b`, `6afc6de`, `5ba2a41`)
- **M3**: scheduler (X5), `@mention` steering (X6), RPC wiring (X8) (`b8baa40`)
- **Config**: built-in `general-purpose` and `Plan` agent types; user settings from `~/.pi/agent/pi-subagent.json` (`91deff8`, `6bc4cef`)

### Bug Fixes

- **state-machine**: keep `tool_exec` until the LAST parallel tool settles — the tree's tool-vs-model distinction was wrong mid-parallel-calls (`535e717`)
- **presentation**: model always shown as `provider/id` — the bare id is ambiguous across providers (`f2cfd9c`)
- **index**: release the globalThis host claim on `session_shutdown` so pi `/reload` re-activation works; child sessions stay inert (`04ac9b5`, `d4ff8b6`, `a82b5f1`)
- **runtime**: map pi `Usage.cost.total` to `costUsd` — raw pass-through NaN-poisoned the accumulator (`0ccbb37`)
- **query/delivery**: in-flight runs visible in registry; no duplicate notifications on restart (`e6ca57b`)
- **driver**: resolve model overrides via ModelRegistry + surface turn errors (`7df9307`)
- **resume**: release both resume lock keys — P1 lock leak (`4b2189a`)

### Documentation

- README — features, agent tree anatomy, anti-hang architecture, configuration (`58aa4ed`)

Stats: 30 feat, 12 fix, 1 refactor, 1 docs, 3 chore/test · 970+ tests (state-machine transition matrix, seeded property invariants, widget rendering)

[Unreleased]: https://github.com/Newbluecake/pi-subagent/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Newbluecake/pi-subagent/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Newbluecake/pi-subagent/releases/tag/v0.1.0
