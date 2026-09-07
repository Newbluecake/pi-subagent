import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
  isHighSurrogate,
  OTHER_LABEL,
  type Question,
  type QuestionState,
  SPLIT_PANE_LEFT_MIN,
  SPLIT_PANE_MIN_WIDTH,
  SPLIT_PANE_RIGHT_MIN,
  SPLIT_PANE_SEPARATOR,
  SURROGATE_PAIR_LEN,
  type ThemeLike,
} from "./types.js";

const SPLIT_PANE_LEFT_RATIO = 0.42;
const DESCRIPTION_INDENT_MULTI = 10;
const DESCRIPTION_INDENT_SINGLE = 8;
const PREVIEW_MIN_WIDTH = 10;
const PREVIEW_MIN_LINES = 8;
const QUESTION_TEXT_MARGIN = 2;
const MAX_EDITOR_LINES = 5;

export interface DisplayOption {
  label: string;
  description?: string;
  isOther?: boolean;
}

export interface RenderContext {
  question: Question;
  state: QuestionState;
  theme: ThemeLike;
  width: number;
  isSingle: boolean;
}

export function allOptions(q: Question): DisplayOption[] {
  return [...q.options, { label: OTHER_LABEL, isOther: true }];
}

export function getSplitPaneWidths(width: number): { left: number; right: number } | null {
  if (width < SPLIT_PANE_MIN_WIDTH) return null;
  const available = width - SPLIT_PANE_SEPARATOR.length;
  if (available < SPLIT_PANE_LEFT_MIN + SPLIT_PANE_RIGHT_MIN) return null;
  const preferredLeft = Math.floor(available * SPLIT_PANE_LEFT_RATIO);
  const left = Math.max(SPLIT_PANE_LEFT_MIN, Math.min(preferredLeft, available - SPLIT_PANE_RIGHT_MIN));
  const right = available - left;
  return right >= SPLIT_PANE_RIGHT_MIN ? { left, right } : null;
}

function renderCursorText(text: string, cursorPos: number): string {
  const before = text.slice(0, cursorPos);
  const charLen = isHighSurrogate(text, cursorPos) ? SURROGATE_PAIR_LEN : 1;
  const current = text.slice(cursorPos, cursorPos + charLen) || " ";
  return `${before}\x1b[7m${current}\x1b[27m${text.slice(cursorPos + charLen)}`;
}

function addWrappedInput(
  push: (line: string) => void,
  lead: string,
  content: string,
  availWidth: number,
  maxLines: number,
): void {
  const avail = Math.max(1, availWidth);
  const indent = " ".repeat(visibleWidth(lead));
  if (content === "") {
    push(lead);
    return;
  }
  let wrapped = wrapTextWithAnsi(content, avail);
  if (wrapped.length > maxLines) {
    wrapped = wrapped.slice(0, maxLines);
    const last = wrapped.length - 1;
    wrapped[last] = truncateToWidth(wrapped[last]!, Math.max(1, avail - 1), "…");
  }
  wrapped.forEach((line, index) => push(index === 0 ? `${lead}${line}` : `${indent}${line}`));
}

function buildOptionLines(ctx: RenderContext, hideDescriptions: boolean): string[] {
  const { question: q, state, theme: t, width } = ctx;
  const options = allOptions(q);
  const lines: string[] = [];
  const add = (line: string): void => {
    lines.push(truncateToWidth(line, width));
  };

  for (let i = 0; i < options.length; i++) {
    const option = options[i]!;
    const activeCursor = state.mode === "freeform" ? state.savedOptionsCursorIndex : state.cursorIndex;
    const focused = i === activeCursor;
    const prefix = focused ? t.fg("accent", ">") : " ";

    if (option.isOther) {
      if (state.mode === "freeform") {
        const marker = q.multiSelect ? t.fg("dim", "[ ]") : " ";
        const lead = `${prefix} ${marker} `;
        const styled = `${t.fg("muted", `${i + 1}. `)}${t.fg("text", renderCursorText(state.draftText, state.cursorIndex))}`;
        addWrappedInput(add, lead, styled, width - visibleWidth(lead), MAX_EDITOR_LINES);
      } else {
        const hasFreeText = state.freeTextValue !== null;
        const marker = q.multiSelect
          ? hasFreeText
            ? t.fg("success", "[✓]")
            : t.fg("dim", "[ ]")
          : hasFreeText
            ? t.fg("success", "✓")
            : " ";
        const labelColor = focused ? "accent" : "text";
        add(`${prefix} ${marker} ${t.fg(labelColor, `${i + 1}. ${option.label}`)}`);
        if (hasFreeText) {
          const markerWidth = visibleWidth(marker);
          const lead = " ".repeat(visibleWidth(prefix) + 1 + markerWidth + 1 + `${i + 1}.`.length + 1);
          addWrappedInput(
            add,
            lead,
            t.fg("dim", `"${state.freeTextValue ?? ""}"`),
            width - visibleWidth(lead),
            MAX_EDITOR_LINES,
          );
        }
      }
      continue;
    }

    if (q.multiSelect) {
      const checked = state.selectedIndices.has(i);
      const box = checked ? t.fg("accent", "[✓]") : t.fg("dim", "[ ]");
      add(`${prefix} ${box} ${t.fg(focused ? "accent" : "text", `${i + 1}. ${option.label}`)}`);
      if (option.description && !hideDescriptions) {
        wrapTextWithAnsi(t.fg("muted", option.description), width - DESCRIPTION_INDENT_MULTI).forEach((line) => {
          add(`          ${line}`);
        });
      }
    } else {
      const check = state.selectedIndex === i ? t.fg("success", "✓") : " ";
      add(`${prefix} ${check} ${t.fg(focused ? "accent" : "text", `${i + 1}. ${option.label}`)}`);
      if (option.description && !hideDescriptions) {
        wrapTextWithAnsi(t.fg("muted", option.description), width - DESCRIPTION_INDENT_SINGLE).forEach((line) => {
          add(`        ${line}`);
        });
      }
    }
  }
  return lines;
}

function buildPreviewLines(ctx: RenderContext, maxLines: number): string[] {
  const { question: q, state, theme: t, width } = ctx;
  const option = allOptions(q)[state.cursorIndex];
  if (!option) return [t.fg("dim", "—")];
  let text = option.isOther ? `${option.label}: enter a custom answer not listed above.` : option.label;
  if (!option.isOther && option.description?.trim()) text += `\n\n${option.description}`;
  const wrapped = wrapTextWithAnsi(t.fg("muted", text), Math.max(PREVIEW_MIN_WIDTH, width));
  const lines = wrapped.slice(0, maxLines);
  if (wrapped.length > maxLines) lines.push(t.fg("dim", "…"));
  return lines;
}

function buildSplitPane(ctx: RenderContext, split: { left: number; right: number }): string[] {
  const { theme: t, width } = ctx;
  const leftLines = buildOptionLines({ ...ctx, width: split.left }, true);
  const rightLines = buildPreviewLines({ ...ctx, width: split.right }, Math.max(leftLines.length, PREVIEW_MIN_LINES));
  const rows = Math.max(leftLines.length, rightLines.length);
  const lines: string[] = [];
  for (let i = 0; i < rows; i++) {
    const left = truncateToWidth(leftLines[i] ?? "", split.left, "", true);
    const right = truncateToWidth(rightLines[i] ?? "", split.right);
    lines.push(truncateToWidth(`${left}${t.fg("dim", SPLIT_PANE_SEPARATOR)}${right}`, width));
  }
  return lines;
}

const EDITOR_HINT = " ←/→ Home/End move · Backspace deletes · Enter submit · Esc back";

export function renderQuestionView(ctx: RenderContext): string[] {
  const { question: q, state, theme: t, width, isSingle } = ctx;
  const lines: string[] = [];
  const add = (line: string): void => {
    lines.push(truncateToWidth(line, width));
  };
  const divider = (): void => {
    add(t.fg("dim", "─".repeat(Math.max(0, width))));
  };

  wrapTextWithAnsi(t.fg("text", ` ${q.question}`), width - QUESTION_TEXT_MARGIN).forEach((line) => add(line));
  if (q.context?.trim()) {
    divider();
    wrapTextWithAnsi(t.fg("muted", q.context), width - QUESTION_TEXT_MARGIN).forEach((line) => add(line));
  }

  const split = getSplitPaneWidths(width);
  if (state.mode !== "freeform") divider();
  if (state.mode === "freeform") {
    add("");
    buildOptionLines(ctx, false).forEach(add);
    add("");
    add(t.fg("dim", EDITOR_HINT));
    return lines;
  }

  if (split) buildSplitPane(ctx, split).forEach((line) => add(line));
  else buildOptionLines(ctx, false).forEach((line) => add(line));
  add("");
  const onOther = state.cursorIndex === allOptions(q).length - 1;
  const tabHint = isSingle ? "" : " · ←/→ switch tabs";
  const action = onOther ? "Enter open editor" : q.multiSelect ? "Space toggle · Enter confirm" : "Enter select";
  add(t.fg("dim", ` ↑↓ navigate · ${action}${tabHint} · Esc back`));
  return lines;
}
