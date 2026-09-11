import type { Component } from "@earendil-works/pi-tui";

/**
 * Collapsed body line budget for tool result cards (Agent / get_subagent_result),
 * shared by the plain-text fallback and the markdown render paths.
 */
export const COLLAPSED_BODY_LINES = 6;

/**
 * Caps a component's *rendered* output to `cap` lines, appending an overflow
 * marker line. Truncating rendered lines rather than the markdown source
 * keeps code fences and tables structurally intact — cutting the source
 * could split a fence and corrupt everything after it.
 */
export class CappedBody implements Component {
  constructor(
    readonly inner: Component,
    private readonly cap: number,
    private readonly overflowLine: (hidden: number) => string,
  ) {}
  render(width: number): string[] {
    const lines = this.inner.render(width);
    if (lines.length <= this.cap) return lines;
    return [...lines.slice(0, this.cap), this.overflowLine(lines.length - this.cap)];
  }
  invalidate(): void {
    this.inner.invalidate();
  }
}
