import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOrchestrator, type OrchestratorDeps } from "../../src/workflow/orchestrator.js";

/**
 * WC14 (workflow design §3.8.1 / §10.1): the four-layer "test hooks are
 * unreachable from production" gate self-test. Each layer is independently
 * verified; none of them uses `NODE_ENV` or any other environment variable
 * (TH4) — unreachability is a property of types, the build's file graph, and
 * one assembly-time assertion, not a runtime flag anyone could flip.
 *
 *   L1 (type layer)  — see tests/fixtures/wc14-excess-prop/: an object
 *     literal smuggling `__testHooks` onto `OrchestratorDeps` fails `tsc`.
 *   L2 (build layer) — `orchestrator.testing.ts` is excluded from
 *     `tsconfig.build.json`, so `dist/` built from it never contains it,
 *     `createOrchestratorForTest`, or the string `__testHooks` at all.
 *   L3 (assembly-time assertion) — `createOrchestrator` throws if a caller
 *     bypasses the type system with `as any` to attach `__testHooks`.
 *   L4 (CI grep) — no production entry point (`src/index.ts`,
 *     `src/tools/**`, `src/commands/**`, `src/ui/**`) references
 *     `orchestrator.testing` or `__testHooks` at all.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const fixturesDir = join(here, "..", "fixtures");

function runTsc(cwd: string, extraArgs: string[] = []): { code: number; output: string } {
  try {
    const output = execFileSync("npx", ["tsc", "--noEmit", "-p", "tsconfig.json", ...extraArgs], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, output };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

describe("WC14 ①/L1: an excess-property object literal smuggling __testHooks onto OrchestratorDeps fails tsc", () => {
  it("the fixture (a self-contained mirror of OrchestratorDeps) fails to compile", () => {
    const result = runTsc(join(fixturesDir, "wc14-excess-prop"));
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("__testHooks");
    expect(result.output).toMatch(/does not exist in type 'OrchestratorDeps'/);
  }, 30_000);
});

describe("WC14 ②/L2: orchestrator.testing.ts is excluded from the production build (dist/ physically never contains it)", () => {
  let outDir: string;
  let buildFailed = false;
  let buildOutput = "";

  beforeAll(() => {
    outDir = mkdtempSync(join(tmpdir(), "wc14-dist-"));
    try {
      execFileSync("npx", ["tsc", "-p", "tsconfig.build.json", "--outDir", outDir], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      buildFailed = true;
      const err = e as { stdout?: string; stderr?: string };
      buildOutput = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    }
  }, 60_000);

  afterAll(() => {
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  });

  it("the build succeeds", () => {
    expect(buildFailed, buildOutput).toBe(false);
  });

  it("dist/workflow/orchestrator.testing.js does not exist", () => {
    const path = join(outDir, "workflow", "orchestrator.testing.js");
    expect(() => statSync(path)).toThrow();
  });

  it("no file under dist/ contains the strings 'createOrchestratorForTest' or 'orchestrator.testing' (the L3 guard's own '__testHooks' string literal is expected and excluded from this check — see the test below)", () => {
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && (entry.name.endsWith(".js") || entry.name.endsWith(".d.ts"))) {
          const content = readFileSync(full, "utf8");
          if (content.includes("createOrchestratorForTest") || content.includes("orchestrator.testing")) {
            hits.push(full);
          }
        }
      }
    };
    walk(outDir);
    expect(hits).toEqual([]);
  });

  it("the ONE legitimate occurrence of '__testHooks' in dist/ is orchestrator.js's own L3 defensive guard, not a reachable hook surface", () => {
    const path = join(outDir, "workflow", "orchestrator.js");
    const content = readFileSync(path, "utf8");
    expect(content).toContain("__testHooks");
    expect(content).toContain("test hooks are not permitted in the production factory");
    // And nowhere else in dist/ does the string appear (it's confined to the guard, not spread through a real hook implementation).
    const otherFiles: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && full !== path && (entry.name.endsWith(".js") || entry.name.endsWith(".d.ts"))) {
          if (readFileSync(full, "utf8").includes("__testHooks")) otherFiles.push(full);
        }
      }
    };
    walk(outDir);
    expect(otherFiles).toEqual([]);
  });

  it("dist/workflow/orchestrator.js DOES exist (the exclude didn't accidentally drop the real module too)", () => {
    const path = join(outDir, "workflow", "orchestrator.js");
    expect(() => statSync(path)).not.toThrow();
  });
});

describe("WC14 ③/L3: the production factory fails fast if __testHooks is smuggled in via `as any`", () => {
  it("createOrchestrator throws a specific, greppable error message", () => {
    const deps: OrchestratorDeps = {
      clock: { now: () => 0, setTimer: () => ({ id: 0 }), clearTimer: () => {} },
      createWorkerHost: () => {
        throw new Error("not used in this test");
      },
    };
    const smuggled = { ...deps, __testHooks: { terminateS7: "hang" } } as unknown as OrchestratorDeps;
    expect(() => createOrchestrator(smuggled)).toThrow(
      "orchestrator: test hooks are not permitted in the production factory",
    );
  });

  it("the clean (non-smuggled) deps object does NOT throw — the gate is specific to the smuggled property, not overzealous", () => {
    const deps: OrchestratorDeps = {
      clock: { now: () => 0, setTimer: () => ({ id: 0 }), clearTimer: () => {} },
      createWorkerHost: () => {
        throw new Error("not used in this test");
      },
    };
    expect(() => createOrchestrator(deps)).not.toThrow();
  });
});

describe("WC14 ④/L4: no production entry point references the test-only module or its hooks", () => {
  const productionGlobs = [
    join(repoRoot, "src", "index.ts"),
    join(repoRoot, "src", "tools"),
    join(repoRoot, "src", "commands"),
    join(repoRoot, "src", "ui"),
  ];

  function collectTsFiles(path: string): string[] {
    try {
      const stat = statSync(path);
      if (stat.isFile()) return path.endsWith(".ts") ? [path] : [];
      const out: string[] = [];
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        out.push(...collectTsFiles(join(path, entry.name)));
      }
      return out;
    } catch {
      return []; // directory doesn't exist yet (e.g. src/ui/ before this milestone) — zero hits is trivially satisfied.
    }
  }

  it("zero occurrences of '__testHooks' or 'orchestrator.testing' across src/index.ts, src/tools/**, src/commands/**, src/ui/**", () => {
    const files = productionGlobs.flatMap(collectTsFiles);
    const hits: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      if (content.includes("__testHooks") || content.includes("orchestrator.testing")) hits.push(file);
    }
    expect(hits).toEqual([]);
  });

  it("this test actually scanned a non-trivial number of files (sanity check the grep isn't vacuously passing on an empty glob)", () => {
    const files = productionGlobs.flatMap(collectTsFiles);
    expect(files.length).toBeGreaterThan(3);
  });
});
