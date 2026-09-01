import { randomInt } from "node:crypto";
import type { RunId } from "./types.js";

/**
 * Short, human-transcribable run identifiers. Uniqueness is process-local:
 * the caller supplies the live in-memory indexes so a collision with a run
 * already known to this process is retried before returning the id.
 */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const RUN_ID_RE = /^r_[0-9A-HJKMNP-TV-Z]{8}$/;
const RUN_ID_ATTEMPTS = 10;

export function newRunId(exists?: (id: string) => boolean): RunId {
  for (let attempt = 0; attempt < RUN_ID_ATTEMPTS; attempt++) {
    let suffix = "";
    for (let i = 0; i < 8; i++) suffix += CROCKFORD[randomInt(CROCKFORD.length)];
    const id = `r_${suffix}`;
    if (!exists || !exists(id)) return id;
  }
  throw new Error(`unable to generate a unique run id after ${RUN_ID_ATTEMPTS} attempts`);
}

export function isRunId(s: string): boolean {
  return RUN_ID_RE.test(s);
}
