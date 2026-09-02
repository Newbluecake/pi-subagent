import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import {
  DEFAULT_SETTINGS,
  DEFAULT_WORKFLOW_BUDGET,
  loadSettingsFromFile,
  persistSettingOverride,
  type AgentSettings,
} from "../../src/config/settings.js";
import { SETTING_SPECS, currentOf, defaultOf, parseSettingValue, settingKeys } from "../../src/config/setting-specs.js";
import {
  SettingsEditorModel,
  createSettingsEditorComponent,
  decodeSettingsEditorInput,
  describeRow,
  renderSettingsEditor,
  themeColorize,
} from "../../src/ui/settings-editor.js";

/**
 * Requirement 1: the `/agent settings` editor. Everything below exercises the
 * two pure layers (key decoding + the state machine/renderer) — the component
 * wrapper is a 15-line adapter and is covered by the last block.
 */
function store(): {
  current: AgentSettings;
  persist: (key: string, value: unknown) => string | undefined;
  path: string;
  persisted: Array<[string, unknown]>;
  fail?: string;
} {
  const persisted: Array<[string, unknown]> = [];
  const self = {
    current: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as AgentSettings,
    path: "/tmp/pi-subagent.json",
    persisted,
    fail: undefined as string | undefined,
    persist: (key: string, value: unknown): string | undefined => {
      persisted.push([key, value]);
      return self.fail;
    },
  };
  return self;
}

function indexOfKey(key: string): number {
  return settingKeys().indexOf(key);
}
/** Drive the model to a given key without depending on the row order. */
function focus(model: SettingsEditorModel, key: string): void {
  model.apply({ type: "home" });
  const target = indexOfKey(key);
  for (let i = 0; i < target; i++) model.apply({ type: "down" });
  expect(model.snapshot().rows[model.snapshot().index]?.key).toBe(key);
}
function type(model: SettingsEditorModel, text: string): void {
  for (const ch of text) model.apply({ type: "insert", text: ch });
}

describe("decodeSettingsEditorInput", () => {
  it("maps navigation, activation and command keys in browse mode", () => {
    expect(decodeSettingsEditorInput("\u001b[A", "browse")).toEqual({ type: "up" });
    expect(decodeSettingsEditorInput("\u001bOB", "browse")).toEqual({ type: "down" });
    expect(decodeSettingsEditorInput("k", "browse")).toEqual({ type: "up" });
    expect(decodeSettingsEditorInput("j", "browse")).toEqual({ type: "down" });
    expect(decodeSettingsEditorInput("\u001b[5~", "browse")).toEqual({ type: "pageUp" });
    expect(decodeSettingsEditorInput("\u001b[6~", "browse")).toEqual({ type: "pageDown" });
    expect(decodeSettingsEditorInput("g", "browse")).toEqual({ type: "home" });
    expect(decodeSettingsEditorInput("G", "browse")).toEqual({ type: "end" });
    expect(decodeSettingsEditorInput("\r", "browse")).toEqual({ type: "activate" });
    expect(decodeSettingsEditorInput(" ", "browse")).toEqual({ type: "toggle" });
    expect(decodeSettingsEditorInput("r", "browse")).toEqual({ type: "reset" });
    expect(decodeSettingsEditorInput("\u001b", "browse")).toEqual({ type: "cancel" });
    // unknown keys are ignored, never mistaken for text while browsing
    expect(decodeSettingsEditorInput("7", "browse")).toBeUndefined();
    expect(decodeSettingsEditorInput("\u0003", "browse")).toBeUndefined();
  });

  it("decodes Kitty keyboard protocol sequences (CSI-u), not just legacy escapes", () => {
    // Terminals with the Kitty keyboard protocol deliver Esc as CSI-u, not a
    // bare \x1b — decoding by hand-rolled string equality breaks there.
    expect(decodeSettingsEditorInput("\u001b[27u", "browse")).toEqual({ type: "cancel" });
    expect(decodeSettingsEditorInput("\u001b[27u", "edit")).toEqual({ type: "cancel" });
    expect(decodeSettingsEditorInput("\u001b[13u", "edit")).toEqual({ type: "commit" });
    expect(decodeSettingsEditorInput("\u001b[1;1A", "browse")).toEqual({ type: "up" });
    expect(decodeSettingsEditorInput("\u001b[1;1B", "browse")).toEqual({ type: "down" });
  });

  it("treats printable keys as text in edit mode, keeping Esc/Enter/Backspace/Ctrl-U as commands", () => {
    expect(decodeSettingsEditorInput("7", "edit")).toEqual({ type: "insert", text: "7" });
    expect(decodeSettingsEditorInput("r", "edit")).toEqual({ type: "insert", text: "r" });
    expect(decodeSettingsEditorInput(" ", "edit")).toEqual({ type: "insert", text: " " });
    expect(decodeSettingsEditorInput("\r", "edit")).toEqual({ type: "commit" });
    expect(decodeSettingsEditorInput("\u007f", "edit")).toEqual({ type: "backspace" });
    expect(decodeSettingsEditorInput("\u0015", "edit")).toEqual({ type: "clear" });
    expect(decodeSettingsEditorInput("\u001b", "edit")).toEqual({ type: "cancel" });
    // arrow keys must not leak into the buffer as escape garbage
    expect(decodeSettingsEditorInput("\u001b[A", "edit")).toBeUndefined();
  });
});

describe("SettingsEditorModel navigation", () => {
  it("lists every settable key in seconds, with second-valued defaults", () => {
    const rows = new SettingsEditorModel(store()).snapshot().rows;
    const byKey = new Map(rows.map((r) => [r.key, r]));
    expect(byKey.get("budget.idleS")?.value).toBe("240");
    expect(byKey.get("budget.idleS")?.def).toBe("240");
    expect(byKey.has("budget.idleMs")).toBe(false);
    expect(byKey.get("budget.startupRetries")?.value).toBe("2");
    expect(byKey.get("foregroundAutoBackgroundS")?.value).toBe("600");
    expect(byKey.get("worktree.gitTimeoutS")?.value).toBe("30");
    expect(byKey.get("worktree.gitTimeoutS")?.value).toBe("30");
    // workflow.budget.* is unset in DEFAULT_SETTINGS but shows its effective default
    expect(byKey.get("workflow.budget.gateS")?.value).toBe(String(DEFAULT_WORKFLOW_BUDGET.gateMs / 1000));
    expect(byKey.get("workflow.journalDir")?.value).toBe("(unset)");
  });

  it("wraps with ↑↓, clamps page jumps, and honours home/end", () => {
    const model = new SettingsEditorModel(store());
    const total = settingKeys().length;
    expect(model.snapshot().index).toBe(0);
    model.apply({ type: "up" });
    expect(model.snapshot().index).toBe(total - 1); // wraps backwards
    model.apply({ type: "down" });
    expect(model.snapshot().index).toBe(0); // and forwards
    model.apply({ type: "pageDown" });
    expect(model.snapshot().index).toBe(10);
    model.apply({ type: "pageUp" });
    expect(model.snapshot().index).toBe(0);
    model.apply({ type: "pageUp" }); // clamped, not wrapped
    expect(model.snapshot().index).toBe(0);
    model.apply({ type: "end" });
    expect(model.snapshot().index).toBe(total - 1);
    model.apply({ type: "home" });
    expect(model.snapshot().index).toBe(0);
  });

  it("scopes rows to budget.* for the /agent budget alias", () => {
    const snapshot = new SettingsEditorModel(store(), { budgetOnly: true }).snapshot();
    expect(snapshot.budgetOnly).toBe(true);
    expect(snapshot.rows.every((r) => r.key.startsWith("budget."))).toBe(true);
    expect(snapshot.rows.length).toBe(Object.keys(DEFAULT_BUDGET).length);
  });

  it("Esc closes from browse mode only", () => {
    const model = new SettingsEditorModel(store());
    focus(model, "budget.idleS");
    model.apply({ type: "activate" });
    model.apply({ type: "cancel" }); // leaves the input
    expect(model.snapshot().mode).toBe("browse");
    expect(model.closed).toBe(false);
    model.apply({ type: "cancel" });
    expect(model.closed).toBe(true);
  });
});

describe("SettingsEditorModel editing (seconds in, milliseconds live, seconds persisted)", () => {
  it("edits a duration: enter → type → commit writes ms live and s to the file", () => {
    const s = store();
    const model = new SettingsEditorModel(s);
    focus(model, "budget.idleS");
    model.apply({ type: "activate" });
    expect(model.snapshot().mode).toBe("edit");
    expect(model.snapshot().draft).toBe("240"); // prefilled with the current seconds
    model.apply({ type: "clear" });
    type(model, "600");
    expect(model.snapshot().error).toBeUndefined();
    model.apply({ type: "commit" });
    expect(model.snapshot().mode).toBe("browse");
    expect(s.current.budget.idleMs).toBe(600_000);
    expect(s.persisted).toEqual([["budget.idleS", 600]]);
    expect(model.snapshot().status).toContain("budget.idleS: 240s → 600s");
    expect(model.snapshot().status).toContain("applies to new runs immediately");
  });

  it("validates live while typing and refuses to write an illegal value", () => {
    const s = store();
    const model = new SettingsEditorModel(s);
    focus(model, "budget.idleS");
    model.apply({ type: "activate" });
    model.apply({ type: "clear" });
    type(model, "1.5");
    expect(model.snapshot().error).toBe("expected an integer >= 0 seconds");
    model.apply({ type: "commit" });
    // Invalid input rejected: still editing, nothing persisted, live object untouched
    expect(model.snapshot().mode).toBe("edit");
    expect(model.snapshot().error).toBe("expected an integer >= 0 seconds");
    expect(s.persisted).toEqual([]);
    expect(s.current.budget.idleMs).toBe(DEFAULT_BUDGET.idleMs);
    // backspacing back to a legal value clears the error
    model.apply({ type: "backspace" });
    model.apply({ type: "backspace" });
    expect(model.snapshot().error).toBeUndefined();
    model.apply({ type: "commit" });
    expect(s.current.budget.idleMs).toBe(1_000);
  });

  it("enforces the 5-second ceiling on the coalescing windows", () => {
    const s = store();
    const model = new SettingsEditorModel(s);
    focus(model, "coalesceWindowS");
    model.apply({ type: "activate" });
    model.apply({ type: "clear" });
    type(model, "6");
    expect(model.snapshot().error).toBe("expected an integer between 0 and 5 seconds");
    model.apply({ type: "backspace" });
    type(model, "5");
    model.apply({ type: "commit" });
    expect(s.current.coalesceWindowMs).toBe(5_000);
    expect(s.persisted).toEqual([["coalesceWindowS", 5]]);
  });

  it("discards the draft on Esc without writing", () => {
    const s = store();
    const model = new SettingsEditorModel(s);
    focus(model, "budget.totalS");
    model.apply({ type: "activate" });
    model.apply({ type: "clear" });
    type(model, "42");
    model.apply({ type: "cancel" });
    expect(model.snapshot().mode).toBe("browse");
    expect(model.snapshot().draft).toBe("");
    expect(s.persisted).toEqual([]);
    expect(s.current.budget.totalMs).toBe(DEFAULT_BUDGET.totalMs);
  });

  it("toggles booleans with enter and space, persisting each flip", () => {
    const s = store();
    const model = new SettingsEditorModel(s);
    focus(model, "fleetWidget");
    model.apply({ type: "activate" });
    expect(s.current.fleetWidget).toBe(false);
    expect(s.persisted).toEqual([["fleetWidget", false]]);
    model.apply({ type: "toggle" });
    expect(s.current.fleetWidget).toBe(true);
    expect(model.snapshot().status).toContain("takes effect after /reload");
    expect(model.snapshot().mode).toBe("browse"); // never enters the text input
  });

  it("cycles enums with enter, wrapping around the value list", () => {
    const s = store();
    const model = new SettingsEditorModel(s);
    focus(model, "workflow.replayScope");
    model.apply({ type: "activate" });
    expect(s.current.workflow.replayScope).toBe("content");
    model.apply({ type: "activate" });
    expect(s.current.workflow.replayScope).toBe("chain");
    expect(s.persisted).toEqual([
      ["workflow.replayScope", "content"],
      ["workflow.replayScope", "chain"],
    ]);
  });

  it("space is a no-op on free-text fields (only enter opens the input)", () => {
    const s = store();
    const model = new SettingsEditorModel(s);
    focus(model, "workflow.journalDir");
    model.apply({ type: "toggle" });
    expect(model.snapshot().mode).toBe("browse");
    expect(s.persisted).toEqual([]);
    model.apply({ type: "activate" });
    expect(model.snapshot().mode).toBe("edit");
    type(model, "/tmp/j");
    model.apply({ type: "commit" });
    expect(s.current.workflow.journalDir).toBe("/tmp/j");
  });

  it("`r` resets the focused key to its default and removes the override", () => {
    const s = store();
    s.current.budget.idleMs = 900_000;
    const model = new SettingsEditorModel(s);
    focus(model, "budget.idleS");
    expect(model.snapshot().rows[model.snapshot().index]?.overridden).toBe(true);
    model.apply({ type: "reset" });
    expect(s.current.budget.idleMs).toBe(DEFAULT_BUDGET.idleMs);
    expect(s.persisted).toEqual([["budget.idleS", undefined]]);
    expect(model.snapshot().status).toContain("budget.idleS reset to default 240s");
    expect(model.snapshot().rows[model.snapshot().index]?.overridden).toBe(false);
  });

  it("resets a workflow.budget.* key back to its effective default", () => {
    const s = store();
    const model = new SettingsEditorModel(s);
    focus(model, "workflow.budget.gateS");
    model.apply({ type: "activate" });
    model.apply({ type: "clear" });
    type(model, "60");
    model.apply({ type: "commit" });
    expect(s.current.workflow.budget.gateMs).toBe(60_000);
    model.apply({ type: "reset" });
    expect(s.current.workflow.budget.gateMs).toBeUndefined();
    expect(model.snapshot().rows[model.snapshot().index]?.value).toBe(String(DEFAULT_WORKFLOW_BUDGET.gateMs / 1000));
  });

  it("surfaces a persist failure while keeping the in-memory change", () => {
    const s = store();
    s.fail = "disk full";
    const model = new SettingsEditorModel(s);
    focus(model, "budget.idleS");
    model.apply({ type: "activate" });
    model.apply({ type: "clear" });
    type(model, "5");
    model.apply({ type: "commit" });
    expect(s.current.budget.idleMs).toBe(5_000);
    expect(model.snapshot().error).toBe("disk full");
    expect(model.snapshot().status).toContain("persist failed: disk full");
  });

  it("clears the transient status/error when the cursor moves", () => {
    const model = new SettingsEditorModel(store());
    focus(model, "fleetWidget");
    model.apply({ type: "activate" });
    expect(model.snapshot().status).toBeDefined();
    model.apply({ type: "down" });
    expect(model.snapshot().status).toBeUndefined();
    expect(model.snapshot().error).toBeUndefined();
  });

  it("ignores navigation while the inline input is open", () => {
    const model = new SettingsEditorModel(store());
    focus(model, "budget.idleS");
    const index = model.snapshot().index;
    model.apply({ type: "activate" });
    model.apply({ type: "down" });
    model.apply({ type: "up" });
    expect(model.snapshot().index).toBe(index);
    expect(model.snapshot().mode).toBe("edit");
  });

  it("routes raw key sequences through handleInput end-to-end", () => {
    const s = store();
    const model = new SettingsEditorModel(s);
    // walk down to fleetWidget with real arrow keys, then toggle with space
    for (let i = 0; i < indexOfKey("fleetWidget"); i++) model.handleInput("\u001b[B");
    model.handleInput(" ");
    expect(s.current.fleetWidget).toBe(false);
    model.handleInput("\u001b");
    expect(model.closed).toBe(true);
  });
});

describe("renderSettingsEditor", () => {
  it("renders a header, the cursor row, defaults markers and the browse legend", () => {
    const s = store();
    s.current.budget.idleMs = 600_000;
    const model = new SettingsEditorModel(s);
    focus(model, "budget.idleS");
    const text = renderSettingsEditor(model.snapshot(), { width: 100, maxVisible: 6 }).join("\n");
    expect(text).toContain("Extension settings — /tmp/pi-subagent.json");
    expect(text).toContain("Durations in seconds");
    expect(text).toMatch(/›\s+budget\.idleS\s+600s\s+\(default 240s\)/);
    expect(text).toContain("↑↓ move · enter edit/toggle · space toggle · r reset · esc close");
    expect(text).toContain(`(${model.snapshot().index + 1}/${model.snapshot().rows.length})`);
  });

  it("renders the inline input with a caret and the edit legend, then the validation error", () => {
    const model = new SettingsEditorModel(store());
    focus(model, "budget.idleS");
    model.apply({ type: "activate" });
    model.apply({ type: "clear" });
    type(model, "abc");
    const text = renderSettingsEditor(model.snapshot(), { width: 100 }).join("\n");
    expect(text).toContain("abc▌");
    expect(text).toContain("✗ expected an integer >= 0 seconds");
    expect(text).toContain("type a value · enter save · esc cancel edit · ctrl+u clear");
  });

  it("shows the accepted change on the status line", () => {
    const model = new SettingsEditorModel(store());
    focus(model, "fleetWidget");
    model.apply({ type: "activate" });
    const text = renderSettingsEditor(model.snapshot(), { width: 100 }).join("\n");
    expect(text).toContain("✓ fleetWidget: true → false");
  });

  it("titles the budget-scoped editor differently and never exceeds the width", () => {
    const model = new SettingsEditorModel(store(), { budgetOnly: true });
    const lines = renderSettingsEditor(model.snapshot(), { width: 40, maxVisible: 4 });
    expect(lines[2]).toContain("Run budget"); // lines[0..1] are the border top + padding row
    expect(lines[0]).toContain("╭");
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
  });

  it("pads every line to the full width so the overlay is opaque (no background bleed-through)", () => {
    const model = new SettingsEditorModel(store());
    for (const width of [40, 100]) {
      const lines = renderSettingsEditor(model.snapshot(), { width, maxVisible: 6 });
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(visibleWidth(line)).toBe(width);
    }
  });

  it("shows each row's description and the seconds unit on duration values", () => {
    const model = new SettingsEditorModel(store());
    focus(model, "concurrencyLimit");
    const text = renderSettingsEditor(model.snapshot(), { width: 120, maxVisible: 20 }).join("\n");
    expect(text).toContain("Max silence between session events");
    expect(text).toMatch(/budget\.idleS\s+240s/);
    // non-time values carry no unit
    expect(text).toMatch(/concurrencyLimit\s+6\s/);
    expect(text).not.toContain("6s ");
  });

  it("keeps the cursor row visible when it scrolls past the window", () => {
    const model = new SettingsEditorModel(store());
    model.apply({ type: "end" });
    const snapshot = model.snapshot();
    const text = renderSettingsEditor(snapshot, { width: 120, maxVisible: 5 }).join("\n");
    expect(text).toContain(snapshot.rows[snapshot.index]!.key);
  });

  it("describes the selected row's type, bounds, default and effect", () => {
    const rows = new SettingsEditorModel(store()).snapshot().rows;
    const byKey = new Map(rows.map((r) => [r.key, r]));
    expect(describeRow(byKey.get("budget.idleS")!)).toBe(
      "seconds >= 0 · default 240 · applies to new runs immediately",
    );
    expect(describeRow(byKey.get("coalesceWindowS")!)).toBe(
      "seconds 0..5 · default 0 · 0 disables coalescing; max 5s · takes effect after /reload",
    );
    expect(describeRow(byKey.get("workflow.replayScope")!)).toBe(
      "chain | content · default chain · takes effect after /reload",
    );
    expect(describeRow(byKey.get("workflow.journalDir")!)).toBe(
      "string · default (unset) · takes effect after /reload",
    );
  });

  it("applies theme tones when a theme is supplied, and stays plain without one", () => {
    const model = new SettingsEditorModel(store());
    const theme = { fg: (c: string, t: string) => `<${c}>${t}</${c}>`, bold: (t: string) => `*${t}*` };
    const colored = renderSettingsEditor(model.snapshot(), { width: 100, colorize: themeColorize(theme) }).join("\n");
    expect(colored).toContain("<accent>");
    expect(colored).toContain("<dim>");
    const plain = renderSettingsEditor(model.snapshot(), { width: 100, colorize: themeColorize(undefined) }).join("\n");
    expect(plain).not.toContain("<accent>");
    // a theme that throws on an unknown color must not break the overlay
    const hostile = {
      fg: (): string => {
        throw new Error("no such color");
      },
      bold: (t: string) => t,
    };
    expect(() =>
      renderSettingsEditor(model.snapshot(), { width: 100, colorize: themeColorize(hostile) }),
    ).not.toThrow();
  });
});

describe("createSettingsEditorComponent", () => {
  it("renders through the model, requests a redraw per key, and calls done on close", () => {
    const model = new SettingsEditorModel(store());
    let renders = 0;
    let done = 0;
    const component = createSettingsEditorComponent({
      model,
      done: () => done++,
      requestRender: () => renders++,
      maxVisible: 5,
    });
    expect(component.render(80).join("\n")).toContain("Extension settings");
    component.handleInput?.("\u001b[B");
    expect(renders).toBe(1);
    expect(done).toBe(0);
    component.handleInput?.("\u001b");
    expect(done).toBe(1);
    expect(renders).toBe(1); // no redraw requested after the overlay is dismissed
    expect(() => component.invalidate()).not.toThrow();
  });
});

/**
 * End-to-end unit round trip: keystrokes → live ms object → real settings
 * file in seconds → `loadSettingsFromFile` → the same ms values. This is the
 * contract acceptance criterion 3 asks for ("settings 文件中时间字段为 `*S`
 * 整数秒") without needing a terminal.
 */
describe("editor → settings file round trip", () => {
  it("persists integer seconds that reload to the edited milliseconds", () => {
    const path = join(mkdtempSync(join(tmpdir(), "pi-subagent-editor-")), "pi-subagent.json");
    const current = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as AgentSettings;
    const model = new SettingsEditorModel({
      current,
      path,
      persist: (key, value) => persistSettingOverride(key, value, path),
    });

    focus(model, "budget.idleS");
    model.handleInput("\r"); // open the inline input
    model.handleInput("\u0015"); // ctrl+u
    for (const ch of "600") model.handleInput(ch);
    model.handleInput("\r"); // commit
    focus(model, "worktree.enabled");
    model.handleInput(" "); // toggle
    focus(model, "worktree.gitTimeoutS");
    model.handleInput("\r");
    model.handleInput("\u0015");
    for (const ch of "45") model.handleInput(ch);
    model.handleInput("\r");
    model.handleInput("\u001b"); // Esc closes
    expect(model.closed).toBe(true);

    // the file holds *seconds* under the *S keys, nothing in milliseconds
    const raw = readFileSync(path, "utf8");
    expect(JSON.parse(raw)).toEqual({
      budget: { idleS: 600 },
      worktree: { enabled: true, gitTimeoutS: 45 },
    });
    expect(raw).not.toContain("Ms");

    // and reloading yields the milliseconds the runtime expects
    const reloaded = loadSettingsFromFile(path);
    expect(reloaded.budget.idleMs).toBe(600_000);
    expect(reloaded.worktree).toEqual({ enabled: true, gitTimeoutMs: 45_000 });
    // the live object edited in place matches the reloaded file
    expect(current.budget.idleMs).toBe(reloaded.budget.idleMs);
    expect(current.worktree.gitTimeoutMs).toBe(reloaded.worktree.gitTimeoutMs);
  });
});

/**
 * The shared spec table is the contract between the text command and the
 * editor: same keys, same validation, same seconds↔ms conversion.
 */
describe("setting-specs table", () => {
  it("keys every duration in the seconds domain and points at the ms path", () => {
    for (const key of settingKeys()) {
      const spec = SETTING_SPECS[key]!;
      expect(key.endsWith("Ms")).toBe(false);
      if (spec.time) {
        expect(key.endsWith("S")).toBe(true);
        expect(spec.path.endsWith("Ms")).toBe(true);
        expect(spec.integer).toBe(true);
      }
    }
  });

  it("converts on parse and reads back through currentOf/defaultOf", () => {
    const spec = SETTING_SPECS["budget.idleS"]!;
    expect(parseSettingValue(spec, "600")).toEqual({ ok: true, stored: 600, live: 600_000 });
    expect(parseSettingValue(spec, " 600 ")).toEqual({ ok: true, stored: 600, live: 600_000 });
    expect(parseSettingValue(spec, "")).toEqual({ ok: false, error: "expected an integer >= 0 seconds" });
    expect(defaultOf(spec)).toBe(240);
    const current = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as AgentSettings;
    current.budget.idleMs = 90_000;
    expect(currentOf(current, spec)).toBe(90);
  });
});
