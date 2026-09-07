export interface BackgroundTaskStatus {
  /** Number of non-terminal subagent runs in the current session. */
  runningSubagents: number;
  /** Number of locally owned background bash jobs, or null when disabled. */
  runningBashJobs: number | null;
}

const STATUS_KEY = Symbol.for("pi-subagent:background-status");
type Provider = () => BackgroundTaskStatus;

type GlobalState = Record<symbol, unknown>;

/** Publish the current host's status provider and return an identity-safe release. */
export function publishBackgroundStatus(getStatus: Provider): () => void {
  const global = globalThis as GlobalState;
  const provider = { getStatus };
  global[STATUS_KEY] = provider;
  return () => {
    if (global[STATUS_KEY] === provider) delete global[STATUS_KEY];
  };
}

/** Read the host provider. Missing providers deliberately return undefined. */
export function readBackgroundStatus(): BackgroundTaskStatus | undefined {
  const value = (globalThis as GlobalState)[STATUS_KEY];
  if (!value || typeof value !== "object") return undefined;
  const provider = value as { getStatus?: unknown };
  return typeof provider.getStatus === "function" ? provider.getStatus() : undefined;
}
