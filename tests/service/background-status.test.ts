import { afterEach, describe, expect, it } from "vitest";
import { publishBackgroundStatus, readBackgroundStatus } from "../../src/service/background-status.js";

describe("background status provider", () => {
  afterEach(() => {
    // Each test owns its provider and releases it below; this protects the suite
    // if an assertion fails before the normal release path is reached.
    const current = readBackgroundStatus();
    if (current) {
      publishBackgroundStatus(() => current)();
    }
  });

  it("publishes and identity-releases the provider", () => {
    const release = publishBackgroundStatus(() => ({ runningSubagents: 2, runningBashJobs: 1 }));
    expect(readBackgroundStatus()).toEqual({ runningSubagents: 2, runningBashJobs: 1 });
    release();
    expect(readBackgroundStatus()).toBeUndefined();
  });

  it("does not let an older release delete a replacement provider", () => {
    const releaseOld = publishBackgroundStatus(() => ({ runningSubagents: 1, runningBashJobs: null }));
    publishBackgroundStatus(() => ({ runningSubagents: 0, runningBashJobs: null }));
    releaseOld();
    expect(readBackgroundStatus()).toEqual({ runningSubagents: 0, runningBashJobs: null });
  });

  it("returns undefined when no host provider exists", () => {
    expect(readBackgroundStatus()).toBeUndefined();
  });
});
