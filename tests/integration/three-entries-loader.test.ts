import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import * as codingAgent from "@earendil-works/pi-coding-agent";

const packageRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const hostEntry = resolve(packageRoot, "node_modules/@earendil-works/pi-coding-agent/dist/index.js");
const loadExtensions =
  "loadExtensions" in codingAgent
    ? (codingAgent as typeof codingAgent & { loadExtensions: (paths: string[], cwd: string) => Promise<any> })
        .loadExtensions
    : (await import(pathToFileURL(resolve(dirname(hostEntry), "core/extensions/loader.js")).href)).loadExtensions;

describe("pi-subagent extension entries", () => {
  it("loads the package manifest and exposes all three extension surfaces", async () => {
    const loaded = await loadExtensions(
      [resolve(packageRoot, "index.ts"), resolve(packageRoot, "ask-user.ts"), resolve(packageRoot, "feishu-notify.ts")],
      packageRoot,
    );
    expect(loaded.errors).toEqual([]);
    expect(loaded.extensions).toHaveLength(3);
    const tools = loaded.extensions.flatMap((extension: any) => [...extension.tools.keys()]);
    expect(tools).toContain("Agent");
    expect(tools).toContain("ask_user");
  }, 30_000);
});
