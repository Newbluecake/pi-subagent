# pi-subagent

**中文** | [English](README.md)

Anti-hang subagent extension for [pi](https://github.com/earendil-works/pi) — a drop-in replacement for `@tintinweb/pi-subagents` core (`Agent` / `get_subagent_result` / `steer_subagent`), rebuilt around an explicit run state machine so a stuck subagent is always **visible, diagnosable, and terminally bounded** — never silently hanging.

## Why

Subagent runs fail in ways a naive "spawn + await" wrapper cannot see: the model API stalls mid-turn, a tool call never returns, a session refuses to die on abort. pi-subagent treats every run as a state machine with per-phase deadlines, a watchdog that fires them, and an escalation ladder that physically reclaims resources — while streaming all of it to a live **agent tree** above your editor.

## Features

- **`Agent` tool** — spawn bounded subagent runs: `description`, `prompt`, `subagent_type`, optional `model` override (strict `provider/id` or a fuzzy hint like `sonnet` / `kimi-k3`, resolved against pi's available models), `run_in_background`, `resume` (continue a finished session), `isolation: "worktree"` (git worktree per run), `timeout_ms`, and `schema` (structured, schema-validated output).
- **`get_subagent_result`** — non-blocking poll by default; `wait: true` + `wait_ms` for bounded blocking.
- **`steer_subagent`** — send a follow-up instruction into a running subagent.
- **`abort_subagent`** — stop a running subagent, including one auto-backgrounded from a foreground call; terminal runs are handled idempotently.
- **Foreground auto-backgrounding** — after `foregroundAutoBackgroundS` (default 10 minutes), a foreground Agent call returns early while the run keeps running; collect it later with `get_subagent_result`.
- **bash auto-backgrounding** — overrides pi's built-in `bash` tool: a command that outlives `bashJobs.autoBackgroundS` (default 120s) returns early with a `job_id` while **the process keeps running** with its output captured to a log, and a completion notice arrives when it exits; manage it with `bash_job` (status / wait / kill / list) — and the log is a plain file you can read/tail/grep directly. POSIX only — see below.
- **`SubagentWorkflow`** — sandboxed JS orchestration (`agent()` / `parallel()` / `pipeline()` / `phase()`) with its own wall-clock budget and optional replay journal. Disabled by default (`workflow.enabled`).
- **Scheduled tasks** — cron / interval / once schedules that spawn subagent runs when due (see "Scheduled tasks" below).
- **Agent tree widget** — always-on, pinned above the editor while runs are active (see below).
- **`@mention` steering** — `@<label> <message>` in the editor steers a running subagent, or resumes a finished one.
- **Cost accounting** — per-run usage flows into pi's session totals; `/agent costs` shows the breakdown. Background usage is attached on the first terminal result read.
- **Agent types** — `.md` definitions discovered from `.pi/agents/`, `.agents/agents/`, `~/.pi/agent/agents/`; injected into the system prompt so the model knows the valid `subagent_type` values. Frontmatter `model:` accepts a strict `provider/id` or a fuzzy hint (e.g. `sonnet`).

## The agent tree

```
● 4 active Agents · $0.92
  后端实现 surface 截断 #6b7201c9 general-purpose cloudrouter-response/gpt-5.6-sol 🔧工具 3m32s $0.91
  TaskUpdate→edit✗→read→edit×3 ▸edit src/core/quota-bucket.ts
  ↳ 并行检索候选实现 #c3d4e5f6 explore 🔧工具 48s
    bash ▸grep monthlyQuota
  前端联调 #d4e5f607 · ♻重试2/3 1m15s
  修订方案:月额度纳入调度 #81ab2a94 Plan droid-completion/kimi-k3 🧠思考 6s $0.0021
  » 调度模块需要支持月额度,我倾向于在 quota-bucket 里加一个 monthly 窗口,然后
✓ 单元测试补齐 #0718293a test completed 40s $0.11
```

- Header: bullet colored by the worst highlight, active count, live spend, `+N more` overflow.
- One main row per run: label, `#id`, type, `provider/id` model, human-friendly phase (`🧠思考` / `🔧工具` / `♻重试2/3` / `⏸排队` / `🗜压缩` / `⏹停止中`), elapsed, cost. Nested runs indent under their parent (`↳`); in-flight workflows render as `⚙` group headers.
- A second **activity line** when the run is mid-tool or mid-thought: the recent tool trail (`bash×3→read`) with the in-flight `▸tool` + args preview highlighted, or a one-line `»` tail of the model's streaming text. Tool-call vs model-request state is always accurate, including parallel tool calls.
- Highlights: `!` yellow = idle past half the idle budget (suspiciously quiet); `✗` red = stopping or past the total deadline. Just-finished runs linger dimmed for a few seconds.

## Commands

| Command                 | What it shows                                                                 |
| ----------------------- | ----------------------------------------------------------------------------- |
| `/agent status`         | Diagnostics for every non-terminal run: phase, last event, idle time, orphans |
| `/agent status <runId>` | One run's full tool timeline                                                  |
| `/agent costs`          | Per-run spend, cost-descending                                                |

## bash auto-backgrounding

When enabled (on by default, POSIX only) the extension overrides pi's built-in `bash` tool by name. Short commands are **byte-for-byte identical** to the built-in: the foreground path delegates to pi's own bash implementation, so output accumulation, truncation, the temp-file footer and `Command exited with code N` are produced by pi's code, not a lookalike. Only commands that outlive the threshold behave differently — the call returns early with a `job_id`, the process keeps running in its own process group, stdout/stderr are merged into a log file, and when it exits a `bash-job:notification` message is injected with the output tail (triggering a fresh turn). The command's own `timeout` parameter keeps its meaning: it still kills the process tree when it expires, background or not.

The `bash` tool takes one extra parameter, `run_in_background: true` — background it immediately instead of waiting out the threshold.

The `bash_job` tool manages those jobs (`job_id` accepts a unique prefix):

| Action   | What it does                                                                                                          |
| -------- | --------------------------------------------------------------------------------------------------------------------- |
| `status` | State summary (running/terminal, elapsed, pid, log size) **plus the log tail** (last 20 lines / 2KB) and the log path |
| `wait`   | Bounded block (default 30s, hard cap 120s); returns the current status on timeout                                     |
| `kill`   | Terminate the whole process group (SIGTERM → grace → SIGKILL); idempotent, with pid-reuse guards                      |
| `list`   | Known jobs (id · state · command preview · age); backgrounded jobs only                                               |

**There is deliberately no `output` action.** The log is an ordinary file at
`~/.pi/agent/bash-jobs/<job>.log`, and reading it with the `read` tool or with `tail`/`grep`/`awk` is strictly more
capable than any parameter set a tool could offer (grep a large log instead of reading it whole). The tail in
`status` is only a "what is it doing / how did it end" snapshot; anything full or targeted goes straight to the file.

Settings (durations are whole seconds, like everywhere else):

| Key                          | Default                         | Meaning                                                                                                            |
| ---------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `bashJobs.autoBackgroundS`   | `120`                           | Background a foreground bash call after this; `0` turns the whole feature off (no override registered at all)      |
| `bashJobs.maxLogBytes`       | `10485760`                      | Per-job log cap; once hit the log stops growing and is flagged truncated — **the process keeps running**           |
| `bashJobs.maxBackgroundJobs` | `8`                             | Concurrent background jobs; when full the threshold keeps waiting in the foreground and an explicit request errors |
| `bashJobs.retentionS`        | `86400`                         | How long terminal job records/logs are kept; expired files go in the root cleanup sweep (below); `<=0` disables it |
| `bashJobs.shutdownPolicy`    | `"keep"`                        | Running jobs on a real `quit`: `keep` or `kill`. reload/new/resume/fork always keep them                           |
| `bashJobs.dir`               | `~/.pi/agent/bash-jobs`         | Job/log root, partitioned below by `<sessionId>` (**breaking**, JSON file only)                                    |
| `bashJobs.shellPath`         | `$SHELL` (whitelisted) → `bash` | Shell used for job commands; `$SHELL` is honoured only when its basename ∈ {bash, zsh, sh} (**JSON file only**)    |

Behaviour notes:

- **Not overridden on win32**: no process-group semantics there, so the built-in `bash` is left alone and neither `bash` nor `bash_job` is registered.
- **Same-name override conflicts**: in pi the first registration of a tool name wins. If another extension also overrides `bash` and registers first, this feature is simply inert (it never breaks the other one); to disable the override deliberately, set `bashJobs.autoBackgroundS` to `0`.
- **Directory cleanup**: the sweep runs once at session start and then, at most **once per 10 minutes**, whenever a new bash job is created (**no timer is ever armed** — a session left open for days still cleans up). One sweep handles four things: expired terminal jobs (JSON + log); `.json` files that cannot be read at all (illegal name / corrupt JSON / failed schema check), aged by **file mtime** and deleted together with a same-named `.log`; orphan `.log` files with no `.json` beside them (same mtime rule, and never while that job is still tracked in memory); and `.tmp` debris from an interrupted atomic write (fixed 1-hour TTL). Safety boundary: **only the `.json` / `.log` / `.tmp` suffixes are ever touched** — anything else you put in that directory is left alone; a **non-terminal record is never pruned**; and whenever a file's mtime cannot be compared against the clock (e.g. it lies in the future), the file is kept. Every non-record deletion is WARNed.
- **Logs and sensitive output**: job records and logs live in `~/.pi/agent/bash-jobs/<sessionId>/` (files mode 0600, directories mode 0700, same threat model as pi's session files). This is visibility isolation, not an OS security boundary: the same user can still read another session's directory. Secrets printed by a command **land on disk** until `retentionS` prunes them — redirect sensitive output.
- **Self-contained logs**: when a job reaches a terminal state, one footer line is appended to its log —
  `[pi-subagent] job b_XXXXXXXX completed (exit 0) after 2m30s` (no exit code is invented for killed / timed-out /
  exit-code-lost jobs). `tail -3 <log>` therefore answers "how did this end?" without a tool call. The line is written
  exactly once, counts towards the log's byte total, and is appended even when the log already hit `maxLogBytes` — the
  conclusion must not be swallowed by a capacity policy, so the file may end up slightly over the cap.
- **Adoption across restarts**: still-running jobs are re-adopted by the next session and still get their completion notice; in-process reload/new/fork transfers the live handle, while cold starts adopt owner-dead orphans. A job whose pid ownership cannot be verified (possible pid reuse) is only marked, never killed — `kill` refuses it explicitly.
- Like every non-`budget.*` setting, changes here take effect after `/reload`.

## Scheduled tasks

At session start, scheduled tasks are loaded from `~/.pi/agent/pi-subagent-schedules.json`; when one comes due, a subagent run is spawned through the normal slot queue (with the same anti-hang supervision). The file is a JSON array of entries like:

```json
[
  {
    "id": "nightly-review",
    "schedule": { "kind": "cron", "expression": "0 3 * * *" },
    "request": {
      "type": "general",
      "prompt": "Review last night's commits and report risks",
      "label": "nightly-review"
    }
  }
]
```

- `schedule.kind`: `"cron"` (five fields: minute hour day-of-month month day-of-week, with `*` `,` `-` `/` support) / `"interval"` (`intervalMs` milliseconds) / `"once"` (`at` as an ISO timestamp, fires once)
- `request` mirrors the `Agent` tool's spawn parameters (minus `runId`): `type` and `prompt` are required; `label`, `modelOverride`, `budgetOverride`, `isolation`, etc. are optional
- A task whose window passed while no session was running is **not** caught up — it is simply re-armed for the next occurrence; `once` tasks are removed after firing
- Edit the file, then `/reload` (or start a new session) for changes to take effect

## Anti-hang architecture

Every run is a pure state machine (`src/core/state-machine.ts`) driven by session events:

```
queue_wait → resolve_config → session_create → extension_bind
  → prompt_dispatch → model_turn ⇄ tool_exec (⇄ retry_backoff, compaction)
  → settled        (timeout/stop: → abort_grace → reap → settled)
```

1. **Signal**: every session event (text delta, tool start/end/update, retry, compaction) refreshes `lastEventAt`. Idle = `now - lastEventAt` — a streaming model or a heartbeating tool is never "stuck".
2. **Deadlines**: each phase arms a timer (`dueAtFor`) — startup 30s, first event 120s, model turn idle 240s, single tool 600s, compaction 300s, total 30min (all configurable). `EventWatchdog` ticks 1Hz and dispatches `deadline_fired`.
3. **Escalation**: timeout in a running phase → `cancel_signal` + `soft_steer` ("wrap up now", the agent gets to finish gracefully) → 10s abort grace → forced abort. If that fails, `EscalatingReaper` climbs L0 cancel → L1 steer → L2 requestAbort → L3 dispose (kill process handles) → anything unkillable is registered as an **orphan** instead of being forgotten.

Retries get their own backoff phase and don't trip the idle timer; parallel tool calls keep the run in `tool_exec` until the _last_ sibling settles.

## Configuration

User settings: `~/.pi/agent/pi-subagent.json` (missing/malformed → defaults, never throws).

`/agent settings` opens an **interactive settings editor** (overlay: ↑↓ to move, Enter to edit/toggle, Space to flip booleans, `r` to reset to the default, Esc to close; every accepted change is persisted immediately). The text forms stay available for scripting: `/agent settings list` / `set <key> <value>` / `reset <key>`, plus `/agent budget` as a `budget.*`-scoped alias.

**Every duration is configured in whole seconds** (keys end in `S`). Legacy millisecond keys (`*Ms`) are migrated on first load: values divisible by 1000 are converted, written back and WARNed about; anything else is dropped in favour of the default (the loader never throws).

```jsonc
{
  "concurrencyLimit": 6,
  "fleetWidget": true, // the agent tree above the editor
  "maxNestedDepth": 2, // subagent spawning subagents
  "foregroundAutoBackgroundS": 600, // foreground auto-background threshold; 0 disables
  "worktree": { "enabled": false },
  "workflow": { "enabled": false },
  "budget": {
    "idleS": 240, // model-turn silence before timeout
    "toolS": 600, // single tool call cap
    "totalS": 1800, // whole-run cap
    // … queueWaitS, startupS, bindS, firstEventS, compactionS,
    //   abortGraceS, steerS, reapS, startupRetries, retrySlackS
  },
}
```

## Installation

pi loads TypeScript source directly (via jiti) — no build step required:

```sh
pi install git:github.com/Newbluecake/pi-subagent
# Update later with:
pi update --extension git:github.com/Newbluecake/pi-subagent
```

Alternatively download the zip from [GitHub Releases](https://github.com/Newbluecake/pi-subagent/releases) (prebuilt `dist/` included), unzip, and `pi install ./pi-subagent` (local-path install; not covered by `pi update`).

## Development

```sh
npm install
npm run build        # tsc → dist/
npm test             # vitest: 1500+ tests — state-machine transition matrix,
                     # seeded property invariants, widget rendering, …
npm run typecheck
npm run format
```

Versioned pre-commit hook (prettier on staged files):

```sh
git config core.hooksPath .githooks
```

Layout: `core/` pure state machine + deadlines (no I/O) · `runtime/` watchdog, session driver, reaper · `service/` spawn/query/registry · `tools/` the eight LLM-facing tools · `ui/` agent-tree view-model + widget (pure, unit-tested) · `workflow/` sandboxed orchestrator · `adapters/` pi-facing glue.

## License

MIT
