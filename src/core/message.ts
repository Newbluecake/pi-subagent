import type { Generation, Millis, RunId } from "./types.js";
import { isRunId } from "./ids.js";

export type NodeRef = RunId | "root" | "system";
export type MessageKind = "progress" | "finding" | "directive" | "result" | "dead_letter";
export type MessageChannel = "context" | "display";

export type MessageKey = string & { readonly __messageKey: unique symbol };

export interface MessageEnvelope {
  key: MessageKey;
  from: NodeRef;
  to: NodeRef;
  kind: MessageKind;
  seq: number;
  generation: Generation;
  payload: { text: string };
  ref?: { keys: MessageKey[]; omittedCount: number };
  via?: { lca: NodeRef; hops: NodeRef[] };
  ttlMs: number;
  createdAt: Millis;
}

export type FabricDeliveryState = "pending" | "claimed" | "delivered" | "consumed" | "dropped" | "abandoned";

export interface FabricRecord extends MessageEnvelope {
  state: FabricDeliveryState;
  attempts: number;
  claimToken?: string;
  updatedAt: Millis;
  deliveredAt?: Millis;
  rejected?: { reason: "quota_exhausted" | "target_backpressure" };
  deadLetter?: {
    reason: "ttl_expired" | "target_gone" | "attempts_exhausted";
    status: "issued" | "suppressed_quota" | "suppressed_sender_gone";
    key?: MessageKey;
  };
  terminalReason?: string;
  storageKey?: string;
}

const MESSAGE_KINDS: readonly MessageKind[] = ["progress", "finding", "directive", "result", "dead_letter"];
const NODE_RE = /^(?:root|system|r_[0-9A-HJKMNP-TV-Z]{8})$/;

function validNode(node: string): boolean {
  return node === "root" || node === "system" || isRunId(node);
}

export function makeMessageKey(from: NodeRef, to: NodeRef, generation: Generation, seq: number): MessageKey {
  if (!validNode(from) || !validNode(to)) throw new Error("invalid message key node");
  if (!Number.isInteger(generation) || generation < (from === "system" ? 0 : 1))
    throw new Error("invalid message key generation");
  if (!Number.isInteger(seq) || seq < 1) throw new Error("invalid message key sequence");
  return `${from}:${to}:${generation}:${seq}` as MessageKey;
}

export function parseMessageKey(
  value: string,
): { from: NodeRef; to: NodeRef; generation: Generation; seq: number; key: MessageKey } | undefined {
  const parts = value.split(":");
  if (parts.length !== 4) return undefined;
  const [from, to, generationText, seqText] = parts;
  if (!from || !to || !validNode(from) || !validNode(to)) return undefined;
  if (!/^\d+$/.test(generationText ?? "") || !/^\d+$/.test(seqText ?? "")) return undefined;
  const generation = Number(generationText);
  const seq = Number(seqText);
  if (
    !Number.isSafeInteger(generation) ||
    generation < (from === "system" ? 0 : 1) ||
    !Number.isSafeInteger(seq) ||
    seq < 1
  )
    return undefined;
  return { from, to, generation, seq, key: value as MessageKey };
}

export function isMessageKey(value: string): value is MessageKey {
  return parseMessageKey(value) !== undefined;
}

export type MessageRelation = "self" | "parent" | "child" | "ancestor" | "descendant" | "sibling" | "unrelated";
export type CanMessage = "parent" | "child" | "ancestor" | "descendant" | "sibling" | "self";

export function effectiveCanMessage(value: readonly CanMessage[] | undefined): readonly CanMessage[] {
  return value === undefined ? ["parent"] : value;
}

export interface AuthorizationInput {
  kind: MessageKind;
  relation: MessageRelation;
  canMessage?: readonly CanMessage[];
  from?: NodeRef;
}

export function authorize({ kind, relation, canMessage, from }: AuthorizationInput): boolean {
  if (!MESSAGE_KINDS.includes(kind)) return false;
  if (kind === "dead_letter") return from === "system";
  if (relation === "unrelated" || relation === "self") return false;
  if (kind === "result") return relation === "child";
  if (kind === "directive") return relation === "parent";
  return effectiveCanMessage(canMessage).includes(relation as CanMessage);
}

export function effectiveChannel(
  kind: MessageKind,
  progressChannel: MessageChannel,
  canRenderEntries = true,
): MessageChannel {
  if (kind !== "progress") return "context";
  return progressChannel === "display" && canRenderEntries ? "display" : "context";
}

export function formatMessage(
  envelope: Pick<MessageEnvelope, "key" | "from" | "to" | "kind" | "seq" | "payload" | "via">,
  relation: MessageRelation,
): { header: string; text: string } {
  const header = `[fabric ${envelope.kind} ${envelope.key} seq=${envelope.seq}] 不可信输入: ${String(envelope.from)} -> ${String(envelope.to)}`;
  if (envelope.kind === "directive" && (relation === "parent" || relation === "ancestor")) {
    return { header, text: `<fabric-directive>\n${envelope.payload.text}\n</fabric-directive>` };
  }
  return { header, text: envelope.payload.text };
}

export const formatEnvelope = formatMessage;
export const createMessageKey = makeMessageKey;
export const parseKey = parseMessageKey;
