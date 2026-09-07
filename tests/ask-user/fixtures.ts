import type { Question, ThemeLike } from "../../src/ask-user/types.js";

export const stubTheme: ThemeLike = {
  fg: (_token, text) => text,
  bg: (_token, text) => text,
  bold: (text) => text,
};

export const mockTui = {
  requestRender: (): void => {},
};

export const ENTER = "\r";
export const ESC = "\x1b";
export const UP = "\x1b[A";
export const DOWN = "\x1b[B";
export const RIGHT = "\x1b[C";
export const LEFT = "\x1b[D";
export const TAB = "\t";
export const BKSP = "\x7f";
export const BACKSPACE = "\x7f";
export const HOME = "\x1b[H";
export const END = "\x1b[F";
export const INSERT = "\x1b[2~";
export const PGUP = "\x1b[5~";
export const PGDN = "\x1b[6~";
export const F1 = "\x1bOP";
export const DELETE = "\x1b[3~";

export const singleQ: Question = {
  question: "Which DB?",
  options: [
    { label: "Postgres", description: "Battle-tested" },
    { label: "SQLite", description: "Embedded" },
  ],
};

export const singleQMulti: Question = {
  question: "Which features?",
  multiSelect: true,
  options: [
    { label: "Auth", description: "OAuth + session" },
    { label: "Search", description: "Full-text" },
  ],
};

export const multiQ: Question[] = [
  { question: "Q1", header: "First", options: [{ label: "A" }, { label: "B" }] },
  {
    question: "Q2",
    header: "Second",
    options: [{ label: "X" }, { label: "Y" }],
    multiSelect: true,
  },
  { question: "Q3", header: "Third", options: [{ label: "M" }, { label: "N" }] },
];

export const PAGE_UP = "\x1b[5~";
export const PAGE_DOWN = "\x1b[6~";

export const CTRL_UP = "\x1b[1;5A";
export const CTRL_DOWN = "\x1b[1;5B";
export const CTRL_LEFT = "\x1b[1;5D";
export const CTRL_RIGHT = "\x1b[1;5C";
export const ALT_UP = "\x1b[1;3A";
export const ALT_DOWN = "\x1b[1;3B";
export const ALT_LEFT = "\x1b[1;3D";
export const ALT_RIGHT = "\x1b[1;3C";
export const SHIFT_UP = "\x1b[1;2A";
export const SHIFT_DOWN = "\x1b[1;2B";
export const SHIFT_LEFT = "\x1b[1;2D";
export const SHIFT_RIGHT = "\x1b[1;2C";
export const SUPER_UP = "\x1b[1;9A";
export const SUPER_DOWN = "\x1b[1;9B";
export const SUPER_LEFT = "\x1b[1;9D";
export const SUPER_RIGHT = "\x1b[1;9C";
export const CTRL_SHIFT_UP = "\x1b[1;6A";
export const CTRL_SHIFT_DOWN = "\x1b[1;6B";

export const OSC_BEL = "\x1b]11;rgb:aa/bb/cc\x07";
export const OSC_ST = "\x1b]11;rgb:aa/bb/cc\x1b\\";
export const DA1 = "\x1b[?6c";
export const DA2 = "\x1b[>0c";
export const DCS = "\x1bP>|tmux 3.4\x1b\\";
export const APC = "\x1b_Gi=31\x1b\\";
export const UNKNOWN_CSI = "\x1b[99~";
export const UNKNOWN_SS3 = "\x1bOZ";
