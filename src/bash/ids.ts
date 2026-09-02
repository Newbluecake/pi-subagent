import { randomInt } from "node:crypto";
import type { JobId } from "./types.js";

/**
 * Short, human-transcribable bash job identifiers — same alphabet, length and
 * collision-retry contract as `src/core/ids.ts`, with a `b_` prefix so that
 * job ids and run ids (`r_`) can never be confused by the model, by
 * `bash_job`'s prefix resolution, or by `/agent status <prefix>`.
 */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const JOB_ID_RE = /^b_[0-9A-HJKMNP-TV-Z]{8}$/;
const JOB_ID_ATTEMPTS = 10;

export function newJobId(exists?: (id: string) => boolean): JobId {
  for (let attempt = 0; attempt < JOB_ID_ATTEMPTS; attempt++) {
    let suffix = "";
    for (let i = 0; i < 8; i++) suffix += CROCKFORD[randomInt(CROCKFORD.length)];
    const id = `b_${suffix}`;
    if (!exists || !exists(id)) return id;
  }
  throw new Error(`unable to generate a unique bash job id after ${JOB_ID_ATTEMPTS} attempts`);
}

export function isJobId(s: string): boolean {
  return JOB_ID_RE.test(s);
}
