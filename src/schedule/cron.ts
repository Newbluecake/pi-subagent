import type { Millis } from "../core/types.js";

type Field = ReadonlySet<number>;
const ranges = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
] as const;

function parseField(value: string, index: number): { values: Field; wildcard: boolean } {
  const bounds = ranges[index];
  if (!bounds) throw new Error(`invalid cron field index ${index}`);
  const [min, max] = bounds;
  const values = new Set<number>();
  let wildcard = false;
  for (const item of value.split(",")) {
    if (!item) throw new Error(`invalid cron field ${value}`);
    const base = item.split("/")[0];
    const stepText = item.split("/")[1];
    if (!base) throw new Error(`invalid cron value ${item}`);
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`invalid cron step ${item}`);
    if (base === "*") {
      wildcard = true;
      for (let n = min; n <= max; n += step) values.add(n);
      continue;
    }
    const parts = base.split("-");
    const valueText = parts[0];
    if (!valueText) throw new Error(`invalid cron value ${item}`);
    const start = Number(valueText);
    const endText = parts.length === 2 ? parts[1] : valueText;
    if (!endText) throw new Error(`invalid cron value ${item}`);
    const end = Number(endText);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end)
      throw new Error(`invalid cron value ${item}`);
    for (let n = start; n <= end; n += step) values.add(n);
  }
  return { values, wildcard };
}

export interface ParsedCron {
  readonly fields: readonly [Field, Field, Field, Field, Field];
  readonly dayOfMonthWildcard: boolean;
  readonly dayOfWeekWildcard: boolean;
}

export function parseCron(expression: string): ParsedCron {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("cron must contain five fields: minute hour day month weekday");
  const parsed = parts.map((part, index) => parseField(part, index));
  const fields = parsed.map((field) => field.values);
  const minute = fields[0];
  const hour = fields[1];
  const day = fields[2];
  const month = fields[3];
  const weekday = fields[4];
  if (!minute || !hour || !day || !month || !weekday) throw new Error("cron must contain five fields");
  const domField = parsed[2];
  const dowField = parsed[4];
  if (!domField || !dowField) throw new Error("cron must contain five fields");
  return {
    fields: [minute, hour, day, month, weekday],
    dayOfMonthWildcard: domField.wildcard,
    dayOfWeekWildcard: dowField.wildcard,
  };
}

function matches(date: Date, cron: ParsedCron): boolean {
  const [minute, hour, day, month, weekday] = cron.fields;
  if (!minute.has(date.getMinutes()) || !hour.has(date.getHours()) || !month.has(date.getMonth() + 1)) return false;
  const dom = day.has(date.getDate());
  const dow = weekday.has(date.getDay());
  return cron.dayOfMonthWildcard || cron.dayOfWeekWildcard ? dom && dow : dom || dow;
}

/** Return the first local-time minute strictly after `afterMs`, or undefined after one year. */
export function nextCronOccurrence(expression: string | ParsedCron, afterMs: Millis): Millis | undefined {
  const cron = typeof expression === "string" ? parseCron(expression) : expression;
  const start = new Date(afterMs);
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);
  for (let i = 0; i <= 366 * 24 * 60; i++) {
    if (matches(start, cron)) return start.getTime();
    start.setMinutes(start.getMinutes() + 1);
  }
  return undefined;
}
