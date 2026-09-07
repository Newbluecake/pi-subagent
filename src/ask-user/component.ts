import { type Component, matchesKey, parseKey, truncateToWidth } from "@earendil-works/pi-tui";
import {
  deleteCharBeforeCursor,
  insertAtCursor,
  moveCursorEnd,
  moveCursorHome,
  moveCursorLeft,
  moveCursorRight,
  createChunkSanitizer,
} from "./editor-ops.js";
import { allOptions, renderQuestionView } from "./question-view.js";
import { buildResult, getAnswerText, renderButtonBar, renderSubmitView } from "./submit-view.js";
import {
  createQuestionState,
  HEADER_MAX_CHARS,
  type Question,
  type QuestionState,
  type Result,
  type ThemeLike,
} from "./types.js";

export interface TUILike {
  requestRender(): void;
}

const BORDER_OVERHEAD = 2;

type SubmitFocus = "submit" | "cancel";

export class AskUserComponent implements Component {
  private readonly questions: Question[];
  private readonly theme: ThemeLike;
  private readonly tui: TUILike;
  private readonly done: (result: Result | null) => void;
  private readonly states: QuestionState[];
  private activeTab = 0;
  private submitTabFocus: SubmitFocus = "submit";
  private pendingCancel = false;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;
  private _resolved = false;
  private sanitizer = createChunkSanitizer();
  private readonly onActivity: (() => void) | undefined;

  constructor(
    questions: Question[],
    tui: TUILike,
    theme: ThemeLike,
    done: (result: Result | null) => void,
    options: { onActivity?: (() => void) | undefined } = {},
  ) {
    this.questions = questions;
    this.tui = tui;
    this.theme = theme;
    this.done = done;
    this.onActivity = options.onActivity;
    this.states = questions.map(() => createQuestionState());
  }

  private get isSingle(): boolean {
    return this.questions.length === 1;
  }

  private allConfirmed(): boolean {
    return this.questions.every((question, index) => getAnswerText(question, this.states[index]!) !== null);
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  private rerender(): void {
    this.invalidate();
    this.tui.requestRender();
  }

  render(width: number): string[] {
    if (this.cachedWidth === width && this.cachedLines !== undefined) return this.cachedLines;
    const innerWidth = Math.max(0, width - BORDER_OVERHEAD);
    const inner: string[] = [];
    const add = (line: string): void => {
      inner.push(line);
    };
    const t = this.theme;

    if (!this.isSingle) {
      this.renderTabBar(innerWidth, add);
      inner.push("");
    }

    if (this.pendingCancel) {
      add(t.fg("warning", t.bold(" Cancel all questions?")));
      inner.push("");
      add(t.fg("text", " Your answers will be discarded."));
      inner.push("");
      add(t.fg("dim", " Esc confirm cancel · any other key to stay"));
    } else if (!this.isSingle && this.activeTab === this.questions.length) {
      renderSubmitView(this.questions, this.states, t, innerWidth, this.submitTabFocus).forEach((line) => add(line));
    } else {
      const question = this.questions[this.activeTab]!;
      renderQuestionView({
        question,
        state: this.states[this.activeTab]!,
        theme: t,
        width: innerWidth,
        isSingle: this.isSingle,
      }).forEach((line) => add(line));
    }

    if (!this.isSingle && this.activeTab < this.questions.length && !this.pendingCancel) {
      inner.push("");
      add(renderButtonBar(t, this.allConfirmed(), null));
    }

    const lines: string[] = [t.fg("dim", `┌${"─".repeat(innerWidth)}┐`)];
    for (const line of inner) {
      const padded = truncateToWidth(line, innerWidth, "", true);
      lines.push(`${t.fg("dim", "│")}${padded}${t.fg("dim", "│")}`);
    }
    lines.push(t.fg("dim", `└${"─".repeat(innerWidth)}┘`));
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  private renderTabBar(innerWidth: number, add: (line: string) => void): void {
    const t = this.theme;
    const parts = [" "];
    this.questions.forEach((question, index) => {
      const state = this.states[index]!;
      const header = question.header?.slice(0, HEADER_MAX_CHARS) ?? "";
      if (index === this.activeTab) parts.push(t.bg("selectedBg", t.fg("text", ` ${header} `)));
      else if (getAnswerText(question, state) !== null) parts.push(t.fg("success", ` ✓${header} `));
      else parts.push(t.fg("muted", ` □${header} `));
      parts.push(t.fg("dim", "│"));
    });
    const submitLabel = " ✓ Submit ";
    parts.push(
      this.activeTab === this.questions.length
        ? t.bg("selectedBg", t.fg("text", submitLabel))
        : this.allConfirmed()
          ? t.fg("success", submitLabel)
          : t.fg("dim", submitLabel),
    );
    add(truncateToWidth(parts.join(""), innerWidth));
  }

  handleInput(data: string): void {
    if (this._resolved) return;
    this.onActivity?.();
    if (this.pendingCancel) {
      if (matchesKey(data, "escape")) this.cancel();
      else {
        this.pendingCancel = false;
        this.rerender();
      }
      return;
    }
    if (!this.isSingle && this.activeTab === this.questions.length) {
      this.handleSubmitTabInput(data);
      return;
    }
    const state = this.states[this.activeTab]!;
    const question = this.questions[this.activeTab]!;
    if (state.mode === "freeform") this.handleEditorInput(data, state, question);
    else this.handleOptionsInput(data, state, question);
  }

  private handleOptionsInput(data: string, state: QuestionState, question: Question): void {
    if (matchesKey(data, "escape")) {
      this.escBackOrConfirm();
      return;
    }
    if (!this.isSingle && matchesKey(data, "right")) {
      this.gotoTab(Math.min(this.activeTab + 1, this.questions.length));
      return;
    }
    if (!this.isSingle && matchesKey(data, "left")) {
      this.gotoTab(Math.max(this.activeTab - 1, 0));
      return;
    }
    if (matchesKey(data, "up")) {
      state.cursorIndex = Math.max(0, state.cursorIndex - 1);
      this.rerender();
      return;
    }
    if (matchesKey(data, "down")) {
      state.cursorIndex = Math.min(allOptions(question).length - 1, state.cursorIndex + 1);
      this.rerender();
      return;
    }

    const onOther = state.cursorIndex === allOptions(question).length - 1;
    if (onOther && matchesKey(data, "enter")) {
      state.savedOptionsCursorIndex = state.cursorIndex;
      state.mode = "freeform";
      state.draftText = state.freeTextValue ?? state.freeDraft ?? "";
      state.cursorIndex = state.draftText.length;
      this.sanitizer = createChunkSanitizer();
      this.rerender();
      return;
    }
    if (onOther) return;

    if (question.multiSelect) {
      if (matchesKey(data, "space")) this.toggleIndex(state, state.cursorIndex);
      else if (matchesKey(data, "enter")) {
        state.selectedIndices.add(state.cursorIndex);
        this.afterConfirm(state);
      }
    } else if (matchesKey(data, "enter")) {
      state.selectedIndex = state.cursorIndex;
      state.freeTextValue = null;
      state.freeDraft = null;
      this.afterConfirm(state);
    }
  }

  private handleSubmitTabInput(data: string): void {
    if (matchesKey(data, "left")) {
      this.gotoTab(this.questions.length - 1);
      return;
    }
    if (matchesKey(data, "right")) {
      this.gotoTab(0);
      return;
    }
    if (matchesKey(data, "escape")) {
      this.activeTab = this.questions.length - 1;
      this.rerender();
      return;
    }
    if (matchesKey(data, "tab")) {
      this.submitTabFocus = this.submitTabFocus === "submit" ? "cancel" : "submit";
      this.rerender();
      return;
    }
    if (matchesKey(data, "enter")) {
      if (this.submitTabFocus === "submit" && this.allConfirmed()) this.submit();
      else if (this.submitTabFocus === "cancel") this.cancel();
    }
  }

  private handleEditorInput(data: string, state: QuestionState, question: Question): void {
    const keyId = parseKey(data);
    if (keyId !== undefined) {
      this.handleEditorKey(keyId, data, state, question);
      return;
    }
    const clean = this.sanitizer(data);
    if (clean !== "") {
      insertAtCursor(state, clean);
      this.rerender();
    }
  }

  private handleEditorKey(keyId: string, data: string, state: QuestionState, question: Question): void {
    if (matchesKey(data, "escape")) {
      state.freeDraft = state.draftText || null;
      state.mode = "options";
      state.draftText = "";
      state.cursorIndex = state.savedOptionsCursorIndex;
      this.sanitizer = createChunkSanitizer();
      this.rerender();
      return;
    }
    if (matchesKey(data, "enter")) {
      const text = state.draftText.trim();
      state.cursorIndex = state.savedOptionsCursorIndex;
      state.mode = "options";
      state.draftText = "";
      this.sanitizer = createChunkSanitizer();
      if (text !== "") {
        state.freeTextValue = text;
        // Other answers replace a single selection, but coexist with multi-select selections.
        state.selectedIndex = null;
        state.freeDraft = null;
        this.afterConfirm(state);
      } else {
        state.freeTextValue = null;
        if (question.multiSelect ? state.selectedIndices.size === 0 : state.selectedIndex === null)
          state.confirmed = false;
        this.rerender();
      }
      return;
    }
    if (matchesKey(data, "backspace")) {
      if (deleteCharBeforeCursor(state)) this.rerender();
      return;
    }
    if (matchesKey(data, "left")) {
      moveCursorLeft(state);
      this.rerender();
      return;
    }
    if (matchesKey(data, "right")) {
      moveCursorRight(state);
      this.rerender();
      return;
    }
    if (matchesKey(data, "home")) {
      moveCursorHome(state);
      this.rerender();
      return;
    }
    if (matchesKey(data, "end")) {
      moveCursorEnd(state);
      this.rerender();
      return;
    }
    if (matchesKey(data, "space")) {
      insertAtCursor(state, " ");
      this.rerender();
      return;
    }
    // Any other parseKey result is a recognized special/modifier key and is intentionally ignored.
    if (keyId.length === 1 && keyId >= " " && keyId <= "~") {
      insertAtCursor(state, keyId);
      this.rerender();
    }
  }

  private toggleIndex(state: QuestionState, index: number): void {
    if (state.selectedIndices.has(index)) state.selectedIndices.delete(index);
    else state.selectedIndices.add(index);
    if (state.selectedIndices.size === 0 && state.freeTextValue === null) state.confirmed = false;
    this.rerender();
  }

  private autoConfirmIfAnswered(): void {
    const state = this.states[this.activeTab];
    const question = this.questions[this.activeTab];
    if (!state || !question || state.confirmed) return;
    if (getAnswerText(question, { ...state, confirmed: true }) !== null) state.confirmed = true;
  }

  private gotoTab(target: number): void {
    this.autoConfirmIfAnswered();
    this.activeTab = target;
    this.rerender();
  }

  private escBackOrConfirm(): void {
    if (this.activeTab > 0) {
      this.activeTab--;
      this.rerender();
    } else {
      this.pendingCancel = true;
      this.rerender();
    }
  }

  private afterConfirm(state: QuestionState): void {
    state.confirmed = true;
    this.advance();
  }

  private advance(): void {
    if (this.isSingle) {
      this.submit();
      return;
    }
    this.activeTab = this.activeTab < this.questions.length - 1 ? this.activeTab + 1 : this.questions.length;
    this.rerender();
  }

  private submit(): void {
    if (this._resolved || !this.allConfirmed()) return;
    this._resolved = true;
    this.done(buildResult(this.questions, this.states));
  }

  public cancel(): void {
    if (this._resolved) return;
    this._resolved = true;
    this.done(null);
  }
}
