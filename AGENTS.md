# AGENTS.md

Guidance for AI coding agents working in this repository.

## What this is

`pi-subagent` — an anti-hang subagent extension for [pi](https://github.com/earendil-works/pi)
(the `@earendil-works/pi-coding-agent` CLI). It is a drop-in replacement for the core of
`@tintinweb/pi-subagents`: it provides the `Agent` / `get_subagent_result` / `steer_subagent` /
`abort_subagent` tools, the `SubagentWorkflow` orchestration tool, the `/agent` command, a live
fleet widget (agent tree), a notification delivery subsystem, and a cron scheduler.

The whole point of the project is **zero-hang guarantees**: every run has layered deadlines
(watchdog sub-phase budgets + total budget), an escalating reaper for orphans, and persistent,
acknowledgeable delivery of results. Preserve these invariants when editing.

## Commands

```sh
npm install          # dev setup (Node >= 22, enforced by engines + CI)
npm run build        # tsc -p tsconfig.build.json → dist/
npm test             # vitest run — 1190+ tests; must stay green
npm run typecheck    # tsc --noEmit (strict; see tsconfig flags)
npm run format       # prettier --write .
npm run format:check # CI gate
```

CI (`.github/workflows/ci.yml`) runs format:check → typecheck → test → build on Node 22.
Run all four locally before pushing. `fs.globSync` is used, so Node < 22 is unsupported.

## Repository layout

- `index.ts` — package-root entry **for pi** (the `pi.extensions` manifest target). pi loads
  extensions through jiti (runtime TypeScript), so git installs need no build step. Thin
  re-export of `./src/index.js` (jiti maps the `.js` suffix to the `.ts` file). Keep it thin.
- `index.js` — companion entry for plain Node consumers, re-exporting `./dist/index.js`
  (package.json `main`/`exports`). Not used by pi.
- `src/index.ts` — **assembly only** (invariant I7): register tools/commands/hooks once per
  `activate()`, own the HOST_KEY host-claim guard, rebuild the session stack on every
  `session_start`. No logic lives here.
- `src/stack.ts` — the per-session stack builder (`buildSessionStack`): constructs
  stores/services/watchdog/reaper/scheduler/widget from `ExtensionContext`. The previous
  session's pieces are disposed at the top of the next build (no stack dispose hook).
- `src/core/` — pure domain: state machine, deadline budgets, ids, types. No pi imports.
- `src/runtime/` — runner, session driver, watchdog, reaper, slot pool (concurrency), dynamic
  tool scoping.
- `src/service/` — spawn/query services, run registry, target resolution (exact → prefix → label).
- `src/config/` — agent-type registry (Markdown frontmatter), fuzzy model hints, settings file.
- `src/schedule/` — cron parser, scheduler, persisted schedule store.
- `src/delivery/` — notification outbox: staged → finalize → batched → delivered → consumed,
  with caller-ack suppression and a coalescer for hold-window merges.
- `src/workflow/` — `SubagentWorkflow` engine: orchestrator, journal/replay, runaway detection.
- `src/adapters/` — pi-facing shims (compat probing, outbox store, run log).
- `src/tools/`, `src/commands/`, `src/ui/`, `src/mention/`, `src/rpc/`, `src/extensions/` —
  tool surfaces, `/agent` command, fleet widget, `@label` mentions, RPC, extension points
  (worktree isolation).
- `tests/` — mirrors `src/` plus `integration/` and `fixtures/`.
- `docs/dev/` — per-feature design docs (auto-background, delivery v2, ...); read the matching
  one before changing that subsystem.
- `scripts/release/package.sh` — stage 9 of the git-release flow (zip + sha256 + notes).

## Conventions

- **TypeScript strict**: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noImplicitOverride` are on. ESM (`module: NodeNext`) — relative imports need the `.js`
  suffix (`import { x } from "./foo.js"`).
- **Prettier** formats everything; a versioned pre-commit hook does it automatically —
  enable once with `git config core.hooksPath .githooks`.
- **Conventional Commits** (`feat|fix|docs|refactor|perf|test|chore|ci(scope): ...`); the
  CHANGELOG is generated from them.
- Tool parameters use `@sinclair/typebox` schemas (the only runtime dependency).
- Peer dependencies on `@earendil-works/pi-ai` / `pi-coding-agent` / `pi-tui` are pinned to
  `>=0.84.0 <0.86.0`; bump deliberately and re-check `src/adapters/pi-compat.ts`.

## pi-extension specifics (easy to get wrong)

- pi loads this package straight from TypeScript source (`index.ts` → `src/`) via jiti —
  that is what makes `pi install git:...` work despite `dist/` being gitignored (pi's git
  install runs no build). `dist/` is still built in CI and published to npm for the Node
  `main`/`exports` entry, but pi never reads it. The pi peers are `peerDependenciesMeta`
  optional (pi aliases them to its own bundled modules at load time) and duplicated in
  `devDependencies` for local typecheck/tests.
- The extension re-activates on pi's `/reload` in the same process without busting Node's
  module cache. Never keep mutable state at module scope; rebuild per `activate()` (see the
  `HOST_KEY` globalThis guard and its identity-checked release in `src/index.ts`).
- Child subagent sessions re-import this extension; they must stay inert (host-claim guard).
- Ref'd timers wedge `pi -p` (print mode) — `unref()` any interval/timeout you add.

## Testing expectations

Vitest. Suites include a state-machine transition matrix and seeded property invariants —
when you change the run state machine (`src/core/state-machine.ts`) or delivery lifecycle,
update the matrix/property tests in lockstep. Integration tests live in `tests/integration/`.

## Releasing

Versions follow semver; releases are cut from `master` with annotated tags whose message is
the version's CHANGELOG section, then `scripts/release/package.sh <version>` produces the
zip assets and `gh release create` publishes them. Do not hand-edit released CHANGELOG
sections.
