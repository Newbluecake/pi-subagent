export interface AvailableModelEntry {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
}

/** Minimal structural surface shared by pi's ModelRegistry and test fakes. */
export interface ModelRegistryLike {
  getAvailable(): readonly AvailableModelEntry[];
}

/** pi's `ExtensionContext.scopedModels` element (ScopedModel) — only the ref matters here. */
export interface ScopedModelLike {
  model: AvailableModelEntry;
}

/** Copy just the prompt-entry fields, dropping everything else pi's Model carries. */
function pickEntry(model: AvailableModelEntry): AvailableModelEntry {
  return {
    provider: model.provider,
    id: model.id,
    ...(model.name === undefined ? {} : { name: model.name }),
    ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
    ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
  };
}

/**
 * Session-scoped models (`--models` / `enabledModels`). Preferred prompt source:
 * it is the set the user actually cycles through, so it stays short enough to
 * list in full instead of being truncated away by MAX_PROMPT_MODELS. Empty when
 * no scoping is configured (pi's documented contract).
 */
export function readScopedModels(scoped: readonly ScopedModelLike[] | undefined): AvailableModelEntry[] {
  if (!scoped || scoped.length === 0) return [];
  return scoped.flatMap((entry) => (entry?.model ? [pickEntry(entry.model)] : []));
}

/**
 * Copy a registry snapshot into prompt-entry shape. Kept synchronous and
 * fail-open: before_agent_start is a prompt-decoration path, so a registry
 * hiccup must degrade to "no models section" rather than break the turn.
 */
export function availableModelsFromRegistry(registry: ModelRegistryLike | undefined): AvailableModelEntry[] {
  if (!registry || typeof registry.getAvailable !== "function") return [];
  try {
    return registry.getAvailable().map(pickEntry);
  } catch {
    return [];
  }
}

const MAX_PROMPT_MODELS = 30;

function formatContextWindow(contextWindow: number): string {
  if (contextWindow >= 1_000_000) return `${contextWindow / 1_000_000}M`;
  if (contextWindow >= 1_000) return `${contextWindow / 1_000}k`;
  return String(contextWindow);
}

export function formatAvailableModelsForPrompt(models: readonly AvailableModelEntry[]): string {
  const seen = new Set<string>();
  const unique: AvailableModelEntry[] = [];
  for (const model of models) {
    const ref = `${model.provider}/${model.id}`;
    if (seen.has(ref)) continue;
    seen.add(ref);
    unique.push(model);
  }
  if (unique.length === 0) return "";

  const visible = unique.slice(0, MAX_PROMPT_MODELS);
  const lines = visible.map((model) => {
    const ref = `${model.provider}/${model.id}`;
    const name = model.name ? ` — ${model.name}` : "";
    const annotations = [
      model.contextWindow === undefined ? undefined : `ctx ${formatContextWindow(model.contextWindow)}`,
      model.reasoning === true ? "reasoning" : undefined,
    ].filter((annotation): annotation is string => annotation !== undefined);
    return `- ${ref}${name}${annotations.length > 0 ? ` (${annotations.join(", ")})` : ""}`;
  });
  const remaining = unique.length - visible.length;
  if (remaining > 0) lines.push(`- ... and ${remaining} more`);

  return [
    "## Available models (pi-subagent)",
    "`set_model` and `Agent` require the FULL `provider/id` exactly as written below — the provider prefix is " +
      "mandatory and a bare model id may be rejected. Copy one of these values verbatim:",
    ...lines,
  ].join("\n");
}

export function appendAvailableModelsToSystemPrompt(
  systemPrompt: string,
  models: readonly AvailableModelEntry[],
): string {
  const section = formatAvailableModelsForPrompt(models);
  return section ? `${systemPrompt}\n\n${section}` : systemPrompt;
}
