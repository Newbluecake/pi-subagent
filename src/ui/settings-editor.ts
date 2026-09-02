import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { decodeKittyPrintable, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  SETTING_SPECS,
  currentOf,
  defaultOf,
  effectOf,
  formatSettingValue,
  isOverridden,
  parseSettingValue,
  resetSetting,
  settingKeys,
  writeSetting,
  type SettingSpec,
  type SettingsStore,
} from "../config/setting-specs.js";

/**
 * `/agent settings` interactive editor (tui-settings requirement 1).
 *
 * Three layers, deliberately separated so only the thinnest one needs a
 * terminal (the same split fleet-panel/fleet-widget use):
 *
 *  1. {@link decodeSettingsEditorInput} — pure key decoding (raw escape
 *     sequences → semantic actions), mode-aware so `r` resets while browsing
 *     but types an `r` while editing.
 *  2. {@link SettingsEditorModel} — pure state machine over the shared
 *     `SETTING_SPECS` table: navigation, boolean/enum cycling, the inline
 *     edit buffer with live validation, `r` reset, and the persist-on-confirm
 *     write path (every accepted change goes straight to
 *     `persistSettingOverride` + the live `AgentSettings` object).
 *  3. {@link renderSettingsEditor} + {@link createSettingsEditorComponent} —
 *     lines out / keys in. Coloring is injected, so the renderer is testable
 *     without a TUI.
 *
 * Durations are shown and typed in **integer seconds** (`budget.idleS`); the
 * model converts to the internal milliseconds on write. See
 * `config/time-units.ts`.
 */

export type SettingsEditorMode = "browse" | "edit";

export type SettingsEditorAction =
  | { type: "up" }
  | { type: "down" }
  | { type: "pageUp" }
  | { type: "pageDown" }
  | { type: "home" }
  | { type: "end" }
  /** Enter in browse mode: toggle booleans/enums, open the input for numbers/strings. */
  | { type: "activate" }
  /** Space in browse mode: same as activate for booleans/enums, ignored otherwise. */
  | { type: "toggle" }
  | { type: "reset" }
  | { type: "cancel" }
  | { type: "commit" }
  | { type: "backspace" }
  | { type: "clear" }
  | { type: "insert"; text: string };

function isPrintable(data: string): boolean {
  return data.length > 0 && !/[\u0000-\u001f\u007f]/.test(data);
}

/** Legacy plain text, or the Kitty CSI-u decoding of it. */
function printableText(data: string): string | undefined {
  return decodeKittyPrintable(data) ?? (isPrintable(data) ? data : undefined);
}

/**
 * Decode one raw stdin chunk into an editor action, or `undefined` to ignore
 * it. All special keys go through pi-tui's `matchesKey` so legacy escape
 * sequences, Kitty CSI-u (e.g. Esc = `\x1b[27u`) and modifyOtherKeys all
 * work — hand-rolled `data === "\x1b"` checks silently break in Kitty
 * terminals. Mode-aware: while editing, printable keys (including `r`, `j`,
 * space) belong to the input buffer, and only Esc/Enter/Backspace/Ctrl-U are
 * commands.
 */
export function decodeSettingsEditorInput(data: string, mode: SettingsEditorMode): SettingsEditorAction | undefined {
  if (matchesKey(data, "escape")) return { type: "cancel" };
  if (matchesKey(data, "enter")) return mode === "edit" ? { type: "commit" } : { type: "activate" };
  if (mode === "edit") {
    if (matchesKey(data, "backspace")) return { type: "backspace" };
    if (matchesKey(data, "ctrl+u")) return { type: "clear" };
    const text = printableText(data);
    return text === undefined ? undefined : { type: "insert", text };
  }
  if (matchesKey(data, "up") || matchesKey(data, "ctrl+p")) return { type: "up" };
  if (matchesKey(data, "down") || matchesKey(data, "ctrl+n")) return { type: "down" };
  if (matchesKey(data, "pageUp")) return { type: "pageUp" };
  if (matchesKey(data, "pageDown")) return { type: "pageDown" };
  if (matchesKey(data, "home")) return { type: "home" };
  if (matchesKey(data, "end")) return { type: "end" };
  if (matchesKey(data, "space")) return { type: "toggle" };
  switch (printableText(data)) {
    case "k":
      return { type: "up" };
    case "j":
      return { type: "down" };
    case "g":
      return { type: "home" };
    case "G":
      return { type: "end" };
    case "r":
    case "R":
      return { type: "reset" };
    default:
      return undefined;
  }
}

export interface SettingsEditorRow {
  /** Storage/display key (`budget.idleS`). */
  key: string;
  spec: SettingSpec;
  /** Current value in the stored (second) domain. */
  value: string;
  /** Effective default in the stored domain. */
  def: string;
  overridden: boolean;
}

export interface SettingsEditorSnapshot {
  rows: readonly SettingsEditorRow[];
  index: number;
  mode: SettingsEditorMode;
  /** Inline input buffer; only meaningful in `edit` mode. */
  draft: string;
  /** Live validation failure (edit mode) — nothing is written while this is set. */
  error?: string;
  /** Result of the last accepted change / reset. */
  status?: string;
  closed: boolean;
  path: string;
  budgetOnly: boolean;
}

const PAGE = 10;

/**
 * Pure editor state machine. Holds no terminal state: it reads the live
 * `AgentSettings` through the store on every snapshot (so `budget.*` edits are
 * visible immediately) and writes through `writeSetting` / `resetSetting`.
 */
export class SettingsEditorModel {
  private readonly keys: string[];
  private index = 0;
  private mode: SettingsEditorMode = "browse";
  private draft = "";
  private error: string | undefined;
  private status: string | undefined;
  private closedFlag = false;

  constructor(
    private readonly store: SettingsStore,
    private readonly options: { budgetOnly?: boolean } = {},
  ) {
    this.keys = settingKeys(options.budgetOnly ?? false);
  }

  get closed(): boolean {
    return this.closedFlag;
  }

  snapshot(): SettingsEditorSnapshot {
    return {
      rows: this.keys.map((key) => {
        const spec = SETTING_SPECS[key]!;
        return {
          key,
          spec,
          value: formatSettingValue(currentOf(this.store.current, spec)),
          def: formatSettingValue(defaultOf(spec)),
          overridden: isOverridden(this.store.current, spec),
        };
      }),
      index: this.index,
      mode: this.mode,
      draft: this.draft,
      ...(this.error === undefined ? {} : { error: this.error }),
      ...(this.status === undefined ? {} : { status: this.status }),
      closed: this.closedFlag,
      path: this.store.path,
      budgetOnly: this.options.budgetOnly ?? false,
    };
  }

  handleInput(data: string): void {
    const action = decodeSettingsEditorInput(data, this.mode);
    if (action) this.apply(action);
  }

  apply(action: SettingsEditorAction): void {
    const key = this.keys[this.index];
    const spec = key === undefined ? undefined : SETTING_SPECS[key];
    switch (action.type) {
      case "up":
        return this.move(-1);
      case "down":
        return this.move(1);
      case "pageUp":
        return this.move(-PAGE);
      case "pageDown":
        return this.move(PAGE);
      case "home":
        this.index = 0;
        return this.clearTransient();
      case "end":
        this.index = Math.max(0, this.keys.length - 1);
        return this.clearTransient();
      case "cancel":
        // Esc leaves the inline input first, and only closes from browse mode
        // — otherwise a mistyped value would take the whole editor down.
        if (this.mode === "edit") {
          this.mode = "browse";
          this.draft = "";
          this.error = undefined;
          return;
        }
        this.closedFlag = true;
        return;
      case "reset":
        if (!key || !spec) return;
        return this.report(resetSetting(this.store, key), "reset to default");
      case "toggle":
      case "activate": {
        if (!key || !spec) return;
        if (spec.kind === "boolean") return this.cycleBoolean(key, spec);
        if (spec.kind === "enum") return this.cycleEnum(key, spec);
        if (action.type === "toggle") return; // space is a no-op on free-text fields
        this.mode = "edit";
        const current = formatSettingValue(currentOf(this.store.current, spec));
        this.draft = current === "(unset)" ? "" : current;
        this.error = undefined;
        this.status = undefined;
        return;
      }
      case "insert":
        if (this.mode !== "edit") return;
        this.draft += action.text;
        return this.validateDraft();
      case "backspace":
        if (this.mode !== "edit") return;
        this.draft = this.draft.slice(0, -1);
        return this.validateDraft();
      case "clear":
        if (this.mode !== "edit") return;
        this.draft = "";
        return this.validateDraft();
      case "commit": {
        if (this.mode !== "edit" || !key || !spec) return;
        const parsed = parseSettingValue(spec, this.draft);
        if (!parsed.ok) {
          // Invalid input: stay in the input with the reason visible, write nothing.
          this.error = parsed.error;
          return;
        }
        this.mode = "browse";
        this.draft = "";
        this.error = undefined;
        return this.report(writeSetting(this.store, key, parsed), "→");
      }
    }
  }

  private move(delta: number): void {
    if (this.mode === "edit" || this.keys.length === 0) return;
    const next = this.index + delta;
    this.index =
      delta === -1 || delta === 1 ? (next + this.keys.length) % this.keys.length : clamp(next, 0, this.keys.length - 1);
    this.clearTransient();
  }

  private clearTransient(): void {
    this.error = undefined;
    this.status = undefined;
  }

  private cycleBoolean(key: string, spec: SettingSpec): void {
    const next = currentOf(this.store.current, spec) !== true;
    this.report(writeSetting(this.store, key, { stored: next, live: next }), "→");
  }

  private cycleEnum(key: string, spec: SettingSpec): void {
    if (spec.kind !== "enum" || spec.values.length === 0) return;
    const current = formatSettingValue(currentOf(this.store.current, spec));
    const at = spec.values.indexOf(current);
    const next = spec.values[(at + 1) % spec.values.length]!;
    this.report(writeSetting(this.store, key, { stored: next, live: next }), "→");
  }

  private validateDraft(): void {
    const spec = SETTING_SPECS[this.keys[this.index] ?? ""];
    if (!spec) return;
    const parsed = parseSettingValue(spec, this.draft);
    this.error = parsed.ok ? undefined : parsed.error;
  }

  private report(result: ReturnType<typeof writeSetting>, arrow: string): void {
    const unit = SETTING_SPECS[result.key]?.time ? "s" : "";
    const change =
      arrow === "→"
        ? `${result.key}: ${result.previous}${unit} → ${result.next}${unit}`
        : `${result.key} ${arrow} ${result.next}${unit}`;
    this.status =
      `${change} · ${result.effect}` +
      (result.persistError === undefined ? "" : ` · persist failed: ${result.persistError}`);
    this.error = result.persistError === undefined ? undefined : result.persistError;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export type SettingsEditorTone =
  "title" | "muted" | "cursor" | "key" | "keySelected" | "value" | "valueSelected" | "error" | "ok";
export type SettingsEditorColorize = (tone: SettingsEditorTone, text: string) => string;

const PLAIN: SettingsEditorColorize = (_tone, text) => text;

export interface SettingsEditorRenderOptions {
  width: number;
  /** Rows shown at once (the list scrolls around the cursor). Default 12. */
  maxVisible?: number;
  colorize?: SettingsEditorColorize;
}

/**
 * Pure renderer: snapshot → lines. Header (file path + unit/effect legend),
 * a scrolling key/value list with `›` cursor and `(default …)` markers for
 * overridden rows, then the inline input / validation error / status line and
 * the key legend.
 */
export function renderSettingsEditor(snapshot: SettingsEditorSnapshot, options: SettingsEditorRenderOptions): string[] {
  const color = options.colorize ?? PLAIN;
  const width = Math.max(24, options.width);
  const maxVisible = Math.max(3, options.maxVisible ?? 12);
  // The content lives inside a rounded border: "│ " + content + " │".
  const inner = width - 4;
  // Truncate AND pad to the full inner width: pi-tui's compositor only
  // fills the columns our lines actually cover, so short lines would let the
  // chat scrollback behind the overlay bleed through. Padding every line
  // (plus the border box below) is what makes the overlay opaque.
  const fit = (line: string): string => {
    const cut = truncateToWidth(line, inner);
    return cut + " ".repeat(Math.max(0, inner - visibleWidth(cut)));
  };
  const lines: string[] = [
    fit(color("title", `${snapshot.budgetOnly ? "Run budget" : "Extension settings"} — ${snapshot.path}`)),
    fit(color("muted", "Durations in seconds · budget.* affects new runs now · other keys need /reload")),
  ];
  const rows = snapshot.rows;
  if (rows.length === 0) {
    lines.push(fit(color("muted", "  (no settings available)")));
    return lines;
  }
  const start = clamp(snapshot.index - Math.floor(maxVisible / 2), 0, Math.max(0, rows.length - maxVisible));
  const end = Math.min(start + maxVisible, rows.length);
  const keyWidth = Math.min(32, Math.max(...rows.map((r) => visibleWidth(r.key))));
  for (let i = start; i < end; i++) {
    const row = rows[i]!;
    const selected = i === snapshot.index;
    const label = row.key.padEnd(keyWidth);
    const editing = selected && snapshot.mode === "edit";
    const unit = row.spec.time ? "s" : "";
    const value = editing ? `${snapshot.draft}▌` : `${row.value}${unit}`;
    const suffix = !editing && row.overridden ? color("muted", ` (default ${row.def}${unit})`) : "";
    const description = !editing && row.spec.description ? "  " + color("muted", row.spec.description) : "";
    lines.push(
      fit(
        (selected ? color("cursor", "› ") : "  ") +
          color(selected ? "keySelected" : "key", label) +
          "  " +
          color(selected ? "valueSelected" : "value", value) +
          suffix +
          description,
      ),
    );
  }
  if (start > 0 || end < rows.length) lines.push(fit(color("muted", `  (${snapshot.index + 1}/${rows.length})`)));
  const selectedRow = rows[snapshot.index];
  if (selectedRow) lines.push(fit(color("muted", `  ${describeRow(selectedRow)}`)));
  if (snapshot.error) lines.push(fit(color("error", `  ✗ ${snapshot.error}`)));
  else if (snapshot.status) lines.push(fit(color("ok", `  ✓ ${snapshot.status}`)));
  lines.push(
    fit(
      color(
        "muted",
        snapshot.mode === "edit"
          ? "  type a value · enter save · esc cancel edit · ctrl+u clear"
          : "  ↑↓ move · enter edit/toggle · space toggle · r reset · esc close",
      ),
    ),
  );
  // Wrap the content in a rounded border with one cell of padding, so the
  // settings area reads as a self-contained panel.
  const border = (text: string): string => color("muted", text);
  const top = border("╭" + "─".repeat(width - 2) + "╮");
  const bottom = border("╰" + "─".repeat(width - 2) + "╯");
  const empty = border("│") + " ".repeat(width - 2) + border("│");
  const boxed = lines.map((line) => border("│") + " " + line + " " + border("│"));
  return [top, empty, ...boxed, empty, bottom];
}

/** One-line help for the selected row: type, bounds, default and effect. */
export function describeRow(row: SettingsEditorRow): string {
  const spec = row.spec;
  const parts: string[] = [];
  if (spec.kind === "number") {
    const bound = spec.max === undefined ? `>= ${spec.min ?? 0}` : `${spec.min ?? 0}..${spec.max}`;
    parts.push(`${spec.time ? "seconds" : spec.integer ? "integer" : "number"} ${bound}`);
  } else if (spec.kind === "enum") parts.push(spec.values.join(" | "));
  else parts.push(spec.kind);
  parts.push(`default ${row.def}`);
  if (spec.hint) parts.push(spec.hint);
  parts.push(effectOf(spec));
  return parts.join(" · ");
}

/**
 * Bind the model + renderer to a pi TUI component. Kept as thin as possible:
 * every key goes to the model, every frame comes from the renderer, and the
 * component closes itself (via `done`) as soon as the model reports `closed`.
 */
export function createSettingsEditorComponent(deps: {
  model: SettingsEditorModel;
  colorize?: SettingsEditorColorize;
  done: () => void;
  requestRender?: () => void;
  maxVisible?: number;
}): Component {
  return {
    render(width: number): string[] {
      return renderSettingsEditor(deps.model.snapshot(), {
        width,
        ...(deps.colorize === undefined ? {} : { colorize: deps.colorize }),
        ...(deps.maxVisible === undefined ? {} : { maxVisible: deps.maxVisible }),
      });
    },
    handleInput(data: string): void {
      deps.model.handleInput(data);
      if (deps.model.closed) deps.done();
      else deps.requestRender?.();
    },
    invalidate(): void {
      /* no cached state */
    },
  };
}

/** Minimal theme surface used by the editor (satisfied by pi's `Theme`). */
export interface SettingsEditorTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

/** Map the editor tones onto a pi theme. Falls back to plain text without a theme. */
export function themeColorize(theme: SettingsEditorTheme | undefined): SettingsEditorColorize {
  if (!theme) return PLAIN;
  return (tone, text) => {
    try {
      switch (tone) {
        case "title":
          return theme.bold(theme.fg("accent", text));
        case "muted":
          return theme.fg("dim", text);
        case "cursor":
          return theme.fg("accent", text);
        case "keySelected":
          return theme.bold(theme.fg("accent", text));
        case "key":
          return theme.fg("text", text);
        case "valueSelected":
          return theme.fg("text", text);
        case "value":
          return theme.fg("muted", text);
        case "error":
          return theme.fg("error", text);
        case "ok":
          return theme.fg("success", text);
      }
    } catch {
      return text; // a theme missing a color must never break the overlay
    }
  };
}

/**
 * Synchronous capability probe, kept separate from {@link openSettingsEditor}
 * so callers can stay on their synchronous path (and keep `notify` ordering)
 * when the overlay is not available at all.
 */
export function canOpenSettingsEditor(ctx: ExtensionCommandContext): boolean {
  return ctx.mode === "tui" && typeof ctx.ui.custom === "function";
}

/**
 * Open the editor as a focused overlay. Returns false when the host cannot
 * show custom components (print/rpc/json modes, or an older pi without
 * `ui.custom`) so the caller can fall back to the text listing instead of
 * failing — `/agent settings` must stay usable in scripts.
 */
export async function openSettingsEditor(
  ctx: ExtensionCommandContext,
  store: SettingsStore,
  options: { budgetOnly?: boolean } = {},
): Promise<boolean> {
  if (!canOpenSettingsEditor(ctx)) return false;
  const model = new SettingsEditorModel(store, options);
  try {
    await ctx.ui.custom<void>(
      (tui: TUI, theme, _keybindings, done: (result: void) => void) =>
        createSettingsEditorComponent({
          model,
          colorize: themeColorize(theme as unknown as SettingsEditorTheme),
          done: () => done(),
          requestRender: () => tui.requestRender(),
        }),
      { overlay: true, overlayOptions: { width: "80%", minWidth: 48, maxHeight: "80%", anchor: "center" } },
    );
    return true;
  } catch (error) {
    console.warn(
      `[pi-subagent] settings editor unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}
