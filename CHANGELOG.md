# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/Newbluecake/pi-subagent/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Newbluecake/pi-subagent/releases/tag/v0.1.0
