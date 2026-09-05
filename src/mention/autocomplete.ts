import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";

export type MentionAutocompleteStatus = "running" | "settled" | "other";

export interface MentionAutocompleteEntry {
  readonly label: string;
  readonly type: string;
  readonly runId: string;
  readonly status: MentionAutocompleteStatus;
}

export interface MentionAutocompleteSource {
  /** Returns only labels which are valid root-child mention targets. */
  entries(): readonly MentionAutocompleteEntry[];
}

export interface AtToken {
  readonly raw: string;
  readonly prefix: string;
  readonly start: number;
}

/** Extract the @ token immediately before the cursor, at a word boundary. */
export function extractAtToken(line: string, cursorCol: number): AtToken | undefined {
  const beforeCursor = line.slice(0, cursorCol);
  const match = beforeCursor.match(/(?:^|[ \t])(@[^\s]*)$/);
  if (!match) return undefined;
  const raw = match[1];
  if (!raw || raw.includes('"') || raw.includes("'")) return undefined;
  return { raw, prefix: raw.slice(1), start: beforeCursor.length - raw.length };
}

/** Replace only the token before the cursor, preserving text after the cursor. */
export function replaceAtToken(
  lines: string[],
  cursorLine: number,
  cursorCol: number,
  value: string,
): { lines: string[]; cursorLine: number; cursorCol: number } {
  const line = lines[cursorLine] ?? "";
  const token = extractAtToken(line, cursorCol);
  if (!token) return { lines, cursorLine, cursorCol };
  const end = cursorCol < line.length && /[ \t]/.test(line[cursorCol] ?? "") ? cursorCol + 1 : cursorCol;
  const nextLine = line.slice(0, token.start) + value + line.slice(end);
  const nextLines = [...lines];
  nextLines[cursorLine] = nextLine;
  return { lines: nextLines, cursorLine, cursorCol: token.start + value.length };
}

/** Layer mention completions over pi's slash/path provider. */
export function createMentionAutocompleteProvider(
  current: AutocompleteProvider,
  source: MentionAutocompleteSource,
): AutocompleteProvider {
  const ownItems = new WeakSet<AutocompleteItem>();
  return {
    triggerCharacters: ["@"],
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const token = extractAtToken(lines[cursorLine] ?? "", cursorCol);
      const base = await current.getSuggestions(lines, cursorLine, cursorCol, options);
      if (!token) return base;

      const agentItems = source
        .entries()
        .filter(
          (entry) =>
            /^[^\s]+$/.test(entry.label) &&
            entry.label !== "root" &&
            entry.label !== "system" &&
            entry.label.startsWith(token.prefix),
        )
        .map((entry) => {
          const state =
            entry.status === "running" ? "running" : entry.status === "settled" ? "已结束·@可resume" : "不可用";
          const item: AutocompleteItem = {
            value: `@${entry.label}`,
            label: `@${entry.label}`,
            description: `agent · ${entry.type} · ${state} · ${entry.runId}`,
          };
          ownItems.add(item);
          return item;
        });

      if (agentItems.length === 0) return base;
      return { prefix: token.raw, items: [...agentItems, ...(base?.items ?? [])] };
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      if (ownItems.has(item)) return replaceAtToken(lines, cursorLine, cursorCol, `${item.value} `);
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },
    ...(current.shouldTriggerFileCompletion
      ? {
          shouldTriggerFileCompletion: (lines: string[], cursorLine: number, cursorCol: number) =>
            current.shouldTriggerFileCompletion!(lines, cursorLine, cursorCol),
        }
      : {}),
  };
}
