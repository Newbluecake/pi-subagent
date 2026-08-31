/**
 * WC14 (workflow design §3.8.1) L1 gate self-test, negative fixture: a
 * self-contained mirror of `orchestrator.ts`'s `OrchestratorDeps` shape and
 * `createOrchestrator` signature (NOT an import of the real module — same
 * isolation rationale as tests/fixtures/ff4-*, see that file's doc comment).
 *
 * `OrchestratorDeps` has no `__testHooks` field. Constructing the argument
 * to `createOrchestrator` as an *object literal* that includes `__testHooks`
 * must fail TypeScript's excess-property check. If `OrchestratorDeps` were
 * ever changed to include a `__testHooks?` field (reintroducing the R3
 * design mistake this repo deliberately avoided), this fixture would start
 * compiling cleanly — which is exactly why WC14's test asserts a non-zero
 * exit code here, not just "the file exists".
 */
interface OrchestratorDeps {
  clock: { now(): number };
  createWorkerHost(): unknown;
  emit?(channel: string, payload: unknown): void;
}

declare function createOrchestrator(deps: OrchestratorDeps): { run(req: unknown): Promise<unknown> };

const deps: OrchestratorDeps = {
  clock: { now: () => 0 },
  createWorkerHost: () => ({}),
};

// Deliberately smuggling a test hook onto the object literal passed to the
// production factory — must fail TypeScript's excess-property check.
createOrchestrator({ ...deps, __testHooks: { terminateS7: "hang" } });
