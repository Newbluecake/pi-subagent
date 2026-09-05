import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import type { NodeRef, MessageKind } from "../core/message.js";
import type { FabricRouter, AdmissionResult } from "../fabric/router.js";
import type { MentionChannel, MentionSendResult } from "../fabric/mention.js";

export const MessageAgentParams = Type.Object({
  to: Type.String({
    description:
      'Target run id, "root" for the root session, or @label for a registered top-level agent (requires can_message: mention)',
  }),
  kind: Type.Union([Type.Literal("progress"), Type.Literal("finding"), Type.Literal("directive")]),
  text: Type.String({ description: "Message body" }),
});
export type MessageAgentParams = Static<typeof MessageAgentParams>;

export interface MessageAgentToolDeps {
  router: FabricRouter;
  /** The host owns these values; callers cannot override the sender identity. */
  from: NodeRef;
  generation: () => number | undefined;
  canMessage?: readonly ("parent" | "child" | "ancestor" | "descendant" | "sibling" | "self" | "mention")[];
  mention?: MentionChannel;
}

export function createMessageAgentTool(deps: MessageAgentToolDeps): ToolDefinition<typeof MessageAgentParams> {
  return {
    name: "message_agent",
    label: "message_agent",
    description: "Send a progress, finding, or directive message to another agent or the root session.",
    parameters: MessageAgentParams,
    async execute(_toolCallId, params) {
      const result: AdmissionResult | MentionSendResult = params.to.startsWith("@")
        ? deps.mention
          ? await deps.mention.send(params.to.slice(1), params.kind, params.text)
          : { ok: false, status: "unknown_label", label: params.to.slice(1) }
        : (() => {
            const generation = deps.generation();
            if (generation === undefined || !Number.isInteger(generation) || generation < 1)
              throw new Error(`message_agent: cannot determine generation for ${deps.from}`);
            return deps.router.admit(deps.from, {
              to: params.to as NodeRef,
              kind: params.kind as MessageKind,
              text: params.text,
              generation: generation as never,
              ...(deps.canMessage === undefined ? {} : { canMessage: deps.canMessage }),
            });
          })();
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  };
}
