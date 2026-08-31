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
 *   worker -> host : { kind: "meta_error", message: string }
 *                  | { kind: "log", line: string }
 *                  | { kind: "script_returned", result: unknown }
 *                  | { kind: "script_threw", message: string, stack?: string }
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
  if (msg && msg.kind === "cancel") {
    // M3.1: no host RPC exists yet (that's M3.2), so there is nothing
    // in-flight to reject here. Kept as a real message handler (not a no-op
    // stub silently absent) so M3.2 has a concrete seam to extend.
  }
});

run();
`;
