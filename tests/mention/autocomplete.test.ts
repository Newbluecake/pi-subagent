import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CombinedAutocompleteProvider, type AutocompleteItem } from "@earendil-works/pi-tui";
import {
  createMentionAutocompleteProvider,
  extractAtToken,
  type MentionAutocompleteEntry,
} from "../../src/mention/autocomplete.js";

/**
 * M5 matrix: the wrapper is tested against a REAL CombinedAutocompleteProvider
 * (not a mock base) over a tmp fixture, so "file completion fully preserved"
 * is verified against pi's actual @ file logic. The @ fuzzy path shells out to
 * fd (same as production interactive-mode); suites that assert file items are
 * skipped when fd is not installed.
 */
function findFd(): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    for (const name of ["fd", "fdfind"]) {
      const candidate = join(dir, name);
      if (dir && existsSync(candidate)) return name;
    }
  }
  return undefined;
}
const fd = findFd();

const options = () => ({ signal: new AbortController().signal, force: true });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-autocomplete-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "index.ts"), "export {};\n");
  await writeFile(join(root, "worker.md"), "collision with the worker label\n");
  await writeFile(join(root, "agent.md"), "agent\n");
  await writeFile(join(root, "my notes.md"), "spaces\n");
  return root;
}

function source(entries: readonly MentionAutocompleteEntry[]) {
  return { entries: () => entries };
}

const WORKER: MentionAutocompleteEntry = { label: "worker", type: "general", runId: "r1", status: "running" };
const FINISHED: MentionAutocompleteEntry = { label: "finished", type: "review", runId: "r2", status: "settled" };

describe("extractAtToken edge cases", () => {
  it("matches @, @prefix and word-boundary tokens only", () => {
    expect(extractAtToken("@", 1)).toEqual({ raw: "@", prefix: "", start: 0 });
    expect(extractAtToken("@wo", 3)).toEqual({ raw: "@wo", prefix: "wo", start: 0 });
    expect(extractAtToken("ask @wo", 7)).toEqual({ raw: "@wo", prefix: "wo", start: 4 });
    // cursor in the middle of a longer token: only the part before the cursor counts
    expect(extractAtToken("@worker", 3)).toEqual({ raw: "@wo", prefix: "wo", start: 0 });
    // not at a word boundary (foo=@src/), quoted paths, and plain text: no token
    expect(extractAtToken("foo=@src/", 9)).toBeUndefined();
    expect(extractAtToken('@"my notes', 9)).toBeUndefined();
    expect(extractAtToken("plain text", 10)).toBeUndefined();
  });
});

describe.skipIf(!fd)("mention autocomplete over real CombinedAutocompleteProvider", () => {
  it("① @: agent items first, base file items fully preserved afterwards", async () => {
    const root = await fixture();
    const base = new CombinedAutocompleteProvider([], root, fd);
    const provider = createMentionAutocompleteProvider(base, source([WORKER, FINISHED]));

    const baseResult = await base.getSuggestions(["@"], 0, 1, options());
    const result = await provider.getSuggestions(["@"], 0, 1, options());
    expect(baseResult, "fixture base must produce file items").not.toBeNull();
    expect(result!.items.slice(0, 2).map((i) => i.value)).toEqual(["@worker", "@finished"]);
    // ⑨ status markers in the description
    expect(result!.items[0]!.description).toContain("running");
    expect(result!.items[1]!.description).toContain("已结束·@可resume");
    // every base file item survives, in order, after the agent group
    expect(result!.items.slice(2)).toEqual(baseResult!.items);
  });

  it("② @prefix filters labels by prefix", async () => {
    const root = await fixture();
    const base = new CombinedAutocompleteProvider([], root, fd);
    const provider = createMentionAutocompleteProvider(base, source([WORKER, FINISHED]));
    const result = await provider.getSuggestions(["@wo"], 0, 3, options());
    expect(result!.items[0]).toMatchObject({ value: "@worker", label: "@worker" });
    expect(result!.items.some((i) => i.value === "@finished")).toBe(false);
    expect(result!.prefix).toBe("@wo");
  });

  it("③ @src/: no agent label matches a path prefix, file items pass through untouched", async () => {
    const root = await fixture();
    const base = new CombinedAutocompleteProvider([], root, fd);
    const provider = createMentionAutocompleteProvider(base, source([WORKER]));
    const baseResult = await base.getSuggestions(["@src/"], 0, 5, options());
    const result = await provider.getSuggestions(["@src/"], 0, 5, options());
    expect(result).toEqual(baseResult); // byte-identical passthrough, no agent items injected
    expect(result!.items.map((i) => i.value)).toContain("@src/index.ts");
    expect(result!.items.some((i) => i.value === "@worker")).toBe(false);
  });

  it('④ @"带空格路径" quoted file completion is unchanged', async () => {
    const root = await fixture();
    const base = new CombinedAutocompleteProvider([], root, fd);
    const provider = createMentionAutocompleteProvider(base, source([WORKER]));
    const line = '@"my n';
    const baseResult = await base.getSuggestions([line], 0, line.length, options());
    const result = await provider.getSuggestions([line], 0, line.length, options());
    expect(result).toEqual(baseResult);
    expect(result!.items.map((i) => i.value)).toContain('@"my notes.md"');
  });

  it("⑤ foo=@src/ (non-word-boundary @) is a pure passthrough", async () => {
    const root = await fixture();
    const base = new CombinedAutocompleteProvider([], root, fd);
    const provider = createMentionAutocompleteProvider(base, source([WORKER]));
    const line = "foo=@src/";
    const baseResult = await base.getSuggestions([line], 0, line.length, options());
    const result = await provider.getSuggestions([line], 0, line.length, options());
    expect(result).toEqual(baseResult);
    expect(result!.items.length).toBeGreaterThan(0);
  });

  it("⑥ label/file name collision: both groups listed, agent first, file selection delegates to base", async () => {
    const root = await fixture();
    const base = new CombinedAutocompleteProvider([], root, fd);
    const provider = createMentionAutocompleteProvider(base, source([WORKER]));
    const result = await provider.getSuggestions(["@wo"], 0, 3, options());
    expect(result!.items[0]).toMatchObject({ value: "@worker" }); // agent group on top
    const fileItem = result!.items.find((i) => i.value === "@worker.md");
    expect(fileItem, "same-named file item stays listed").toBeDefined();
    // selecting the FILE item must use base semantics (@worker.md, not the agent's @worker handle)
    const applied = provider.applyCompletion(["@wo"], 0, 3, fileItem as AutocompleteItem, result!.prefix);
    expect(applied.lines[0]).toBe("@worker.md ");
  });

  it("⑦ own item completion inserts `@label ` (trailing space, parseMention-compatible) and keeps suffix", async () => {
    const root = await fixture();
    const base = new CombinedAutocompleteProvider([], root, fd);
    const provider = createMentionAutocompleteProvider(base, source([WORKER]));
    const result = await provider.getSuggestions(["say @wo now"], 0, 7, options());
    const item = result!.items.find((candidate) => candidate.value === "@worker")!;
    const applied = provider.applyCompletion(["say @wo now"], 0, 7, item, result!.prefix);
    expect(applied).toEqual({ lines: ["say @worker now"], cursorLine: 0, cursorCol: 12 });
    expect(applied.lines[0]).toMatch(/^say @worker /); // matches parseMention's ^@(\S+)[ \t]+
  });

  it("⑦b agent completion at end of line appends the trailing space", async () => {
    const root = await fixture();
    const base = new CombinedAutocompleteProvider([], root, fd);
    const provider = createMentionAutocompleteProvider(base, source([WORKER]));
    const result = await provider.getSuggestions(["@wo"], 0, 3, options());
    const item = result!.items.find((candidate) => candidate.value === "@worker")!;
    expect(provider.applyCompletion(["@wo"], 0, 3, item, result!.prefix)).toEqual({
      lines: ["@worker "],
      cursorLine: 0,
      cursorCol: 8,
    });
  });

  it("⑩ no @token: result is the base result object itself (byte-identical)", async () => {
    const root = await fixture();
    const base = new CombinedAutocompleteProvider([], root, fd);
    const provider = createMentionAutocompleteProvider(base, source([WORKER]));
    const baseResult = await base.getSuggestions(["plain"], 0, 5, options());
    const result = await provider.getSuggestions(["plain"], 0, 5, options());
    expect(result).toEqual(baseResult);
  });

  it("reserved labels root/system never appear as agent items", async () => {
    const root = await fixture();
    const base = new CombinedAutocompleteProvider([], root, fd);
    const provider = createMentionAutocompleteProvider(
      base,
      source([
        { label: "root", type: "general", runId: "r9", status: "running" },
        { label: "system", type: "general", runId: "r10", status: "running" },
      ]),
    );
    const result = await provider.getSuggestions(["@"], 0, 1, options());
    expect(result?.items.some((i) => i.value === "@root" || i.value === "@system") ?? false).toBe(false);
  });
});
