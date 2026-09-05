import type { EntryRenderer } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { FabricRecord } from "../core/message.js";

export const FABRIC_ENTRY_CUSTOM_TYPE = "subagent:fabric";

/**
 * TUI renderer for fabric custom entries. The fabric outbox store is
 * append-only: every state transition of a record appends a fresh entry
 * (pending → … → delivered), and pi's interactive mode renders each appended
 * entry that has a renderer (addCustomEntryToChat). Rendering every state
 * showed the same message once per transition; only the terminal `delivered`
 * record is display-worthy, so anything else returns undefined — pi's
 * CustomEntryComponent.hasContent() is then false and the entry is skipped.
 * Context injection (sendRootContext / steer) is unaffected: it never goes
 * through this renderer.
 */
/** Resolve a sender runId to its mention label, if one is registered. */
export type FabricSenderResolver = (runId: string) => string | undefined;

function formatSender(from: string | undefined, resolveSender?: FabricSenderResolver): string {
  if (!from) return "";
  if (from === "root") return " root";
  const label = resolveSender?.(from);
  return label !== undefined ? ` @${label}` : ` ${from}`;
}

export function createFabricEntryRenderer(resolveSender?: FabricSenderResolver): EntryRenderer {
  return (entry, _options, theme) => {
    const data = entry.data as Partial<FabricRecord> | undefined;
    if (data?.state !== "delivered") return undefined;
    const text = data.payload?.text ?? "";
    const sender = formatSender(data.from, resolveSender);
    return new Text(theme.fg("muted", `[fabric ${data.kind ?? "message"}${sender}] ${text}`), 0, 0);
  };
}

export const renderFabricEntry: EntryRenderer = createFabricEntryRenderer();
