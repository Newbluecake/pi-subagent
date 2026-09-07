import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import * as codingAgent from "@earendil-works/pi-coding-agent";

const packageRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

// 0.84.4 exposes the loader from its internal extensions index but omits it
// from the package root. Prefer a host root export when available; the fallback
// still imports the real loader implementation from the resolved host package.
const hostEntry = resolve(packageRoot, "node_modules/@earendil-works/pi-coding-agent/dist/index.js");
const loadExtensions =
  "loadExtensions" in codingAgent
    ? (codingAgent as typeof codingAgent & { loadExtensions: (paths: string[], cwd: string) => Promise<any> })
        .loadExtensions
    : (await import(pathToFileURL(resolve(dirname(hostEntry), "core/extensions/loader.js")).href)).loadExtensions;

describe("Pi host loader integration", () => {
  test("loads and registers ask_user", { timeout: 30_000 }, async () => {
    const loaded = await loadExtensions([resolve(packageRoot, "ask-user.ts")], packageRoot);
    expect(loaded.errors).toEqual([]);
    expect(loaded.extensions).toHaveLength(1);
    const tool = loaded.extensions[0]?.tools.get("ask_user");
    expect(tool).toBeDefined();
    expect(tool?.definition.parameters).toBeDefined();
  });
});
