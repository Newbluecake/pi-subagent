import { isHighSurrogate, SURROGATE_PAIR_LEN, type QuestionState } from "./types.js";

/** Insert text at the UTF-16 cursor offset. Text is expected to be printable. */
export function insertAtCursor(state: QuestionState, text: string): void {
  state.draftText = state.draftText.slice(0, state.cursorIndex) + text + state.draftText.slice(state.cursorIndex);
  state.cursorIndex += text.length;
}

/** Delete one code point before the cursor, including both units of a surrogate pair. */
export function deleteCharBeforeCursor(state: QuestionState): boolean {
  if (state.cursorIndex <= 0) return false;
  const deleteCount =
    state.cursorIndex >= SURROGATE_PAIR_LEN && isHighSurrogate(state.draftText, state.cursorIndex - SURROGATE_PAIR_LEN)
      ? SURROGATE_PAIR_LEN
      : 1;
  state.draftText =
    state.draftText.slice(0, state.cursorIndex - deleteCount) + state.draftText.slice(state.cursorIndex);
  state.cursorIndex -= deleteCount;
  return true;
}

export function moveCursorLeft(state: QuestionState): void {
  const candidate = state.cursorIndex - 1;
  state.cursorIndex =
    candidate > 0 && isHighSurrogate(state.draftText, candidate - 1) ? candidate - 1 : Math.max(0, candidate);
}

export function moveCursorRight(state: QuestionState): void {
  state.cursorIndex = isHighSurrogate(state.draftText, state.cursorIndex)
    ? Math.min(state.draftText.length, state.cursorIndex + SURROGATE_PAIR_LEN)
    : Math.min(state.draftText.length, state.cursorIndex + 1);
}

export function moveCursorHome(state: QuestionState): void {
  state.cursorIndex = 0;
}

export function moveCursorEnd(state: QuestionState): void {
  state.cursorIndex = state.draftText.length;
}

const ESC = "\x1b";
const BEL = "\x07";
const STRING_TERMINATOR = "\\";
const MAX_PENDING_ESCAPE = 64;

function isCsiFinal(code: number): boolean {
  return code >= 0x40 && code <= 0x7e;
}

function printableOnly(text: string): string {
  let result = "";
  for (const character of Array.from(text)) {
    const code = character.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f)) result += character;
  }
  return result;
}

/**
 * Create a stateful terminal-input sanitizer.
 *
 * Terminal input can split an escape sequence across stdin chunks. The pending
 * prefix is retained until the next call, so sequence payload never becomes
 * editable text merely because the chunk boundary happened at ESC or CSI `[`.
 */
export function createChunkSanitizer(): (data: string) => string {
  let pending = "";

  return (data: string): string => {
    if (data.length === 0 && pending.length === 0) return "";
    const input = pending + data;
    pending = "";
    let output = "";
    let i = 0;

    while (i < input.length) {
      if (input[i] !== ESC) {
        const start = i;
        while (i < input.length && input[i] !== ESC) i++;
        output += printableOnly(input.slice(start, i));
        continue;
      }

      const sequenceStart = i;
      if (i + 1 >= input.length) {
        pending = input.slice(sequenceStart);
        break;
      }

      const kind = input[i + 1]!;
      if (kind === "[") {
        let end = i + 2;
        while (end < input.length && !isCsiFinal(input.charCodeAt(end))) end++;
        if (end >= input.length) {
          pending = input.slice(sequenceStart);
          break;
        }
        i = end + 1;
        continue;
      }

      // OSC (] and the four string command families) terminate at BEL or ST.
      if (kind === "]" || kind === "P" || kind === "_" || kind === "^" || kind === "X") {
        let end = i + 2;
        let terminated = false;
        while (end < input.length) {
          const code = input.charCodeAt(end);
          if (code === 0x07 || code === 0x9c) {
            end++;
            terminated = true;
            break;
          }
          if (input[end] === ESC) {
            if (end + 1 >= input.length) break;
            if (input[end + 1] === STRING_TERMINATOR) {
              end += 2;
              terminated = true;
              break;
            }
          }
          end++;
        }
        if (!terminated) {
          pending = input.slice(sequenceStart);
          break;
        }
        i = end;
        continue;
      }

      // SS2/SS3 and character-set designators have a three-byte form.
      if (kind === "N" || kind === "O" || kind === "(" || kind === ")" || kind === "#" || kind === "%") {
        const required = kind === "(" || kind === ")" || kind === "#" || kind === "%" ? 3 : 3;
        if (i + required > input.length) {
          pending = input.slice(sequenceStart);
          break;
        }
        i += required;
        continue;
      }

      // Fe/Fp and other two-byte ESC sequences are command bytes, never text.
      i += 2;
    }

    if (pending.length > MAX_PENDING_ESCAPE) pending = "";
    return output;
  };
}
