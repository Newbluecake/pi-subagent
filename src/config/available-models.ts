export interface AvailableModelEntry {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
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
    'The `model` parameter of set_model / Agent accepts any of these `provider/id` values (fuzzy hints like "sonnet" also resolve against this list):',
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
