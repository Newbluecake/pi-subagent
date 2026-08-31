/**
 * M3.1 (workflow design §2.2/§2.5/§5.2, DET1–DET7): the embedded worker-thread
 * scaffold. This module only *builds a string* — the string is executed
 * inside a `node:worker_threads` `Worker` via `{ eval: true }` (RW10: no
 * runtime file scanning, no external file dependency, survives
 * `tsc`/bundling unchanged).
 *
 * Two trust boundaries inside that one worker thread:
 *   1. The scaffold itself (this file's output) — trusted, host-authored. It
 *      may `require("node:vm")`, `require("node:worker_threads")`, use
 *      `Atomics`/`SharedArrayBuffer` for the heartbeat, etc.
 *   2. The user script — untrusted. It only ever runs inside a `vm.Context`
 *      built by the scaffold, with a whitelisted global surface (DET1) and
 *      `codeGeneration: { strings: false, wasm: false }` (blocks
 *      `eval`/`new Function`/wasm — WC07).
 *
 * Protocol over the dedicated `MessagePort` (see lifecycle.ts for why a
 * private `MessageChannel` is used instead of the Worker's implicit default
 * channel — §2.3.1 S5 / WC09):
 *   host -> worker : { kind: "cancel", reason: string }
 *                  | { kind: "host_ack", id, ok, value } | { ..., ok:false, error } | { ..., ok:false, cancelled:true, cause } (§3.3/§3.5, M3.2)
 *                  | { kind: "host_settle", callId, ok, value } | { ..., ok:false, error } (HR3, M3.2)
 *   worker -> host : { kind: "meta_error", message: string }
 *                  | { kind: "log", line: string }
 *                  | { kind: "script_returned", result: unknown }
 *                  | { kind: "script_threw", message: string, stack?: string }
 *                  | { kind: "host_call", id, op: "agent"|"gate", args } (§3.3/§3.5, M3.2)
 * Everything the scaffold needs to start (script source, slice timeout,
 * heartbeat period, the heartbeat `SharedArrayBuffer`, the port itself) is
 * passed once via `workerData` at construction — there is no separate "boot"
 * round-trip message (M3.1 doesn't need one; re-configuring a live worker is
 * out of scope, WK4).
 */

/**
 * Returns the worker-thread scaffold source, as CommonJS text suitable for
 * `new Worker(source, { eval: true, workerData, transferList })`.
 */
export function buildWorkerSource(): string {
  return WORKER_SOURCE;
}

const WORKER_SOURCE = String.raw`
"use strict";
const vm = require("node:vm");
const { workerData } = require("node:worker_threads");

const commPort = workerData.commPort;
const heartbeatSab = workerData.heartbeatSab || null;
const heartbeatMs = workerData.heartbeatMs || 0;
const scriptSliceMs = workerData.scriptSliceMs;
const scriptSource = workerData.scriptSource;
const hostCallMs = workerData.hostCallMs || 60000;
const gateMs = workerData.gateMs || 600000;
const maxBatchItems = workerData.maxBatchItems || 1024;

// M3.2 (§3.3/§3.5): the worker-side half of the call/ack/settle protocol.
// This lives in the *trusted scaffold* scope (outside vm), same as \`send\`
// and the heartbeat timer above — the functions built from these tables are
// what gets installed onto the sandbox (buildSandbox below), but their
// closures execute with the scaffold's real \`setTimeout\`/\`Map\`/\`Promise\`,
// never inside vm.
let hostCallSeq = 0;
const pendingCalls = new Map(); // id -> { resolve, reject, timer }
const pendingSettles = new Map(); // callId -> { resolve, reject, timer }
// M3.3 robustness fix (found while adding real-worker end-to-end host_call
// coverage, same protocol-robustness class as the M3.2 kind-tagging Blocker):
// a host_settle push can in principle race ahead of its own host_ack (e.g. a
// ChildSpawner double that resolves admission+settle on the very same
// microtask turn, or in the limit an implausibly fast real child) — without
// this buffer such a settle silently drops ("already timed out" is *not*
// what happened; \`waitForSettle\` simply hadn't registered a listener for
// this callId yet), and the script's \`await agent()\` then hangs until
// HR1's own timeout. Buffering (bounded, self-expiring) makes delivery order
// on the wire irrelevant to correctness, matching HR1's "never lose or hang
// on an in-order message" intent.
const bufferedSettles = new Map(); // callId -> { ok, value, error }
const BUFFERED_SETTLE_TTL_MS = 5000;

/** HR1: every \`callHost()\` races its own client-side deadline; a host that never acks still lets the script's \`await\` resolve (by rejecting). */
function callHost(op, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const id = String(++hostCallSeq);
    const timer = setTimeout(() => {
      pendingCalls.delete(id);
      reject(new Error("host call '" + op + "' timed out after " + timeoutMs + "ms (HR1)"));
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    pendingCalls.set(id, { resolve, reject, timer });
    send({ kind: "host_call", id: id, op: op, args: args });
  });
}

const SETTLE_GRACE_MS = 5000;

/** HR3: \`agent()\`'s ack only confirms admission (\`{ callId, deadlineAt }\`); the actual child result arrives later via a \`host_settle\` push, awaited here as a second, independently-bounded stage. */
function waitForSettle(callId, deadlineAt) {
  return new Promise((resolve, reject) => {
    const buffered = bufferedSettles.get(callId);
    if (buffered) {
      bufferedSettles.delete(callId);
      resolve(buffered);
      return;
    }
    const boundMs = Math.max(0, (typeof deadlineAt === "number" ? deadlineAt - Date.now() : hostCallMs)) + SETTLE_GRACE_MS;
    const timer = setTimeout(() => {
      pendingSettles.delete(callId);
      reject(new Error("agent() child did not settle before its deadline (HR1)"));
    }, boundMs);
    if (typeof timer.unref === "function") timer.unref();
    pendingSettles.set(callId, { resolve, reject, timer });
  });
}

function agent(prompt, opts) {
  if (typeof prompt !== "string") return Promise.reject(new TypeError("agent(prompt, opts?): prompt must be a string"));
  return callHost("agent", { prompt: prompt, opts: opts || null }, hostCallMs).then(function (ack) {
    return waitForSettle(ack.callId, ack.deadlineAt);
  }).then(function (outcome) {
    // §5.2/§5.3: a terminal *failure* of the child (or being withheld/aborted
    // by the host) resolves to 'null' — same, deliberately-unresolvable-from-
    // "skipped", semantics as the upstream plugin. Admission-time failures
    // (unknown type, budget exhausted, HR1/HR2 timeout) reject instead — see
    // the rejection path above and §5.3's "narrowed" agentType row.
    if (!outcome.ok) return null;
    return outcome.value;
  });
}

function gate(cmd, opts) {
  if (typeof cmd !== "string") return Promise.reject(new TypeError("gate(cmd, opts?): cmd must be a string"));
  return callHost("gate", { cmd: cmd, cwd: opts && opts.cwd }, gateMs).then(function (ack) {
    // M3.3 fix (found alongside the real-worker e2e test): \`callHost\`'s
    // \`host_ack\` dispatch already unwraps the envelope down to \`msg.value\`
    // (see the \`commPort.on("message", ...)\` handler below) — for \`gate\`
    // that value *is* the exec result object itself (\`{ ok, code, stdout,
    // stderr }\`, see host.ts's \`handleGate\`), not a second envelope with its
    // own \`.value\`. Returning \`ack.value\` here (the pre-fix code) was
    // always \`undefined\` — the script got back nothing on a successful
    // gate() call. \`ack.ok\` still correctly reflects the exec's own success.
    if (!ack.ok) {
      var e = new Error("gate() command failed");
      throw e;
    }
    return ack;
  });
}

/** §5.2: parallel(thunks) — barrier over a thunk array; a thunk that throws (sync or async) resolves that slot to null without failing its siblings. */
function parallel(thunks) {
  if (!Array.isArray(thunks)) throw new TypeError("parallel(thunks) expects an array of zero-arg functions");
  if (thunks.length > maxBatchItems) throw new Error("parallel(): " + thunks.length + " items exceeds maxBatchItems (" + maxBatchItems + ")");
  return Promise.all(
    thunks.map(function (thunk) {
      return Promise.resolve()
        .then(function () {
          return thunk();
        })
        .catch(function () {
          return null;
        });
    }),
  );
}

/** §5.2: pipeline(items, ...stages) — no barrier between stages; a stage throwing skips the remaining stages for that item only, settling it to null. */
function pipeline(items) {
  if (!Array.isArray(items)) throw new TypeError("pipeline(items, ...stages) expects items to be an array");
  if (items.length > maxBatchItems) throw new Error("pipeline(): " + items.length + " items exceeds maxBatchItems (" + maxBatchItems + ")");
  var stages = Array.prototype.slice.call(arguments, 1);
  return Promise.all(
    items.map(function (item, index) {
      return stages
        .reduce(function (chain, stage) {
          return chain.then(function (state) {
            if (state.skipped) return state;
            return Promise.resolve()
              .then(function () {
                return stage(state.value, item, index);
              })
              .then(function (v) {
                return { skipped: false, value: v };
              })
              .catch(function () {
                return { skipped: true, value: null };
              });
          });
        }, Promise.resolve({ skipped: false, value: undefined }))
        .then(function (s) {
          return s.value;
        });
    }),
  );
}

let heartbeatTimer = null;

function send(msg) {
  try {
    commPort.postMessage(msg);
  } catch (_err) {
    // S5/WC09: the host may have closed its end of the port already (it does
    // so unconditionally as step S5 of terminate()); a send racing that close
    // is expected and must never crash the worker thread.
  }
}

function serializeError(e) {
  if (e instanceof Error) return { message: e.message, stack: e.stack };
  return { message: String(e) };
}

function safeResult(value) {
  // structured-clone is applied by postMessage itself; pre-flighting it here
  // turns an unclonable return value (function, symbol, ...) into a reported
  // script_threw instead of an uncaught internal postMessage exception.
  try {
    // eslint-disable-next-line no-undef
    JSON.stringify(value);
    return { ok: true, value };
  } catch (_err) {
    return { ok: true, value: String(value) };
  }
}

function startHeartbeat() {
  if (!heartbeatSab || !heartbeatMs) return;
  const view = new Int32Array(heartbeatSab);
  let seq = 0;
  heartbeatTimer = setInterval(() => {
    seq += 1;
    Atomics.store(view, 0, seq);
  }, heartbeatMs);
  if (typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();
}

/**
 * DET (§2.5): extract the "export const meta = { ... };" object literal by
 * bracket-matching (not a full parser — sufficient for the flat object shape
 * §5.1/§5.2 require), then evaluate *only that literal* in a throwaway vm
 * context with a 100ms timeout, matching the upstream plugin's approach this
 * design deliberately keeps (§5.1: "正则筛 + 空 vm context 100ms 上界求值").
 */
function extractMeta(source) {
  const declRe = /(?:export\s+)?const\s+meta\s*=\s*/;
  const m = declRe.exec(source);
  if (!m) return { ok: false, message: "script must declare \`export const meta = { name, description }\`" };
  let i = m.index + m[0].length;
  while (i < source.length && source[i] !== "{") {
    if (!/\s/.test(source[i])) {
      return { ok: false, message: "meta must be an object literal" };
    }
    i += 1;
  }
  if (i >= source.length) return { ok: false, message: "malformed meta literal (no opening brace)" };
  const start = i;
  let depth = 0;
  let end = -1;
  for (; i < source.length; i += 1) {
    const c = source[i];
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return { ok: false, message: "unterminated meta literal" };
  const literal = source.slice(start, end + 1);
  let value;
  try {
    value = vm.runInNewContext("(" + literal + ")", Object.create(null), {
      timeout: 100,
      codeGeneration: { strings: false, wasm: false },
    });
  } catch (err) {
    return { ok: false, message: "failed to evaluate meta literal: " + serializeError(err).message };
  }
  if (!value || typeof value !== "object" || typeof value.name !== "string" || typeof value.description !== "string") {
    return { ok: false, message: "meta must be an object literal with string \`name\` and \`description\`" };
  }
  return { ok: true, meta: value, before: source.slice(0, m.index), after: source.slice(end + 1) };
}

/** DET2/DET3: Date/Math.random are disabled, not frozen — a script that calls them must find out immediately, not silently drift. */
function buildSandbox(meta) {
  const sandbox = Object.create(null);
  sandbox.meta = Object.freeze(meta);
  sandbox.log = function log(message) {
    send({ kind: "log", line: typeof message === "string" ? message : JSON.stringify(message) });
  };
  // M3.2 (§5.2): agent()/gate()/parallel()/pipeline() are installed as plain
  // scaffold-scope functions (defined above, outside vm) — calling them from
  // sandboxed script code runs their *body* in the scaffold's trusted realm
  // (closures keep the realm they were defined in), the same trust boundary
  // \`log\` above already relies on.
  sandbox.agent = agent;
  sandbox.gate = gate;
  sandbox.parallel = parallel;
  sandbox.pipeline = pipeline;
  function DisabledDate() {
    throw new Error("Date is disabled inside workflow scripts (non-deterministic; would break replay). See DET2.");
  }
  DisabledDate.now = function () {
    throw new Error("Date.now() is disabled inside workflow scripts (non-deterministic; would break replay). See DET2.");
  };
  sandbox.Date = DisabledDate;
  sandbox.Math = new Proxy(Math, {
    get(target, prop) {
      if (prop === "random") {
        return function () {
          throw new Error("Math.random() is disabled inside workflow scripts (non-deterministic; would break replay). See DET3.");
        };
      }
      return target[prop];
    },
  });
  // DET1/DET4/DET5: explicit denylist on top of codeGeneration:false — vm's
  // fresh global object already lacks require/process/module by construction,
  // but Atomics/SharedArrayBuffer/WebAssembly/Worker/fetch/Buffer/timers are
  // standard V8/Node globals that would otherwise be inherited.
  const denied = [
    "require",
    "process",
    "module",
    "Atomics",
    "SharedArrayBuffer",
    "WebAssembly",
    "Worker",
    "MessageChannel",
    "MessagePort",
    "fetch",
    "Buffer",
    "setTimeout",
    "setInterval",
    "setImmediate",
    "queueMicrotask",
  ];
  for (const key of denied) sandbox[key] = undefined;
  return sandbox;
}

function run() {
  startHeartbeat();
  const parsed = extractMeta(scriptSource);
  if (!parsed.ok) {
    send({ kind: "meta_error", message: parsed.message });
    return;
  }
  const sandbox = buildSandbox(parsed.meta);
  let ctx;
  try {
    ctx = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  } catch (err) {
    send({ kind: "script_threw", message: serializeError(err).message, stack: serializeError(err).stack });
    return;
  }
  // The meta declaration is re-declared as a plain (non-export) const inside
  // the async wrapper so "export" (invalid outside an ES module) never
  // reaches vm.Script; the sandbox's own frozen \`meta\` global is what
  // scripts are expected to read (M3.4 will formalize the full script API).
  const body = parsed.before.replace(/export\s+const\s+meta\s*=/, "const meta =") + parsed.after;
  const wrapped = "(async () => {\n" + body + "\n})()";
  let resultPromise;
  try {
    resultPromise = vm.runInContext(wrapped, ctx, {
      timeout: scriptSliceMs,
      breakOnSigint: true,
      displayErrors: true,
    });
  } catch (err) {
    const info = serializeError(err);
    send({ kind: "script_threw", message: info.message, stack: info.stack });
    return;
  }
  Promise.resolve(resultPromise).then(
    (value) => {
      const safe = safeResult(value);
      send({ kind: "script_returned", result: safe.value });
    },
    (err) => {
      const info = serializeError(err);
      send({ kind: "script_threw", message: info.message, stack: info.stack });
    },
  );
}

commPort.on("message", (msg) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.kind === "cancel") {
    // HR6: reject every worker-side pending call/settle wait immediately —
    // the workflow is stopping, so nothing still "in flight" from this
    // worker's perspective can ever be honored.
    for (const [id, p] of pendingCalls) {
      clearTimeout(p.timer);
      p.reject(new Error("host call cancelled: " + (msg.reason || "workflow stopping")));
    }
    pendingCalls.clear();
    for (const [callId, p] of pendingSettles) {
      clearTimeout(p.timer);
      p.reject(new Error("agent() cancelled: " + (msg.reason || "workflow stopping")));
    }
    pendingSettles.clear();
    return;
  }
  if (msg.kind === "host_ack") {
    const pending = pendingCalls.get(msg.id);
    if (!pending) return; // HR1: already timed out and rejected client-side — a late ack is dropped, not an error.
    pendingCalls.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.ok) pending.resolve(msg.value);
    else if (msg.cancelled) pending.reject(Object.assign(new Error("WorkflowCancelled: " + msg.cause), { cancelled: true }));
    else pending.reject(new Error((msg.error && msg.error.message) || ("host call '" + msg.id + "' failed")));
    return;
  }
  if (msg.kind === "host_settle") {
    const pending = pendingSettles.get(msg.callId);
    if (!pending) {
      // Either genuinely already timed out client-side (dropped, not an
      // error), or this settle raced ahead of its own ack — buffer it
      // briefly so a \`waitForSettle()\` that registers moments later still
      // picks it up instead of hanging until HR1's own timeout.
      bufferedSettles.set(msg.callId, { ok: !!msg.ok, value: msg.value, error: msg.error });
      const cleanup = setTimeout(() => bufferedSettles.delete(msg.callId), BUFFERED_SETTLE_TTL_MS);
      if (typeof cleanup.unref === "function") cleanup.unref();
      return;
    }
    pendingSettles.delete(msg.callId);
    clearTimeout(pending.timer);
    pending.resolve({ ok: !!msg.ok, value: msg.value, error: msg.error });
    return;
  }
});

run();
`;
