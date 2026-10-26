import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { convertToLlm, findCutPoint, SessionManager } from "@earendil-works/pi-coding-agent";
import { checkpointMarker } from "./checkpoint.js";

export type RecoveryMessage = Parameters<SessionManager["appendMessage"]>[0];
export interface RecoverySplit {
  /** Index in the exact non-system canonical occurrence array, not a value lookup. */
  cutIndex: number;
  prefix: RecoveryMessage[];
  suffix: RecoveryMessage[];
}

function supported(message: AgentMessage): message is RecoveryMessage {
  return ["user", "assistant", "toolResult", "custom", "bashExecution"].includes(message.role);
}

/** Conservative lower bound, without invoking a provider or previewing a request. */
function hasProviderContent(messages: readonly RecoveryMessage[]): boolean {
  return convertToLlm([...messages]).some((message) => {
    if (message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted"))
      return false;
    if (typeof message.content === "string") return message.content.length > 0;
    return message.content.some((part) => {
      if (part.type === "text") return part.text.length > 0;
      if (part.type === "image") return part.data.length > 0;
      if (part.type === "toolCall") return part.id.length > 0 && part.name.length > 0;
      // Thinking/signatures remain intact in the selected messages, but alone
      // cannot prove visibility: same-model unsigned reasoning and cross-model
      // redacted/empty signed reasoning can both disappear in native conversion.
      return false;
    });
  });
}

interface ToolPairBookkeeping {
  raw: Set<string>;
  effective: Set<string>;
}
const bookkeeping = (): ToolPairBookkeeping => ({ raw: new Set(), effective: new Set() });

// Conservative validation ONLY: Responses uses the sanitized first component
// as call_id even for historical foreign calls. Never change persisted IDs.
function codexCallKey(id: string): string {
  return id
    .split("|")[0]
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 64)
    .replace(/_+$/, "");
}
function checkPairs(messages: readonly AgentMessage[], seen: Set<string>, effective = false): void {
  const pending = new Map<string, string>();
  for (const message of messages) {
    if (message.role === "toolResult") {
      if (
        typeof message.toolCallId !== "string" ||
        !message.toolCallId ||
        typeof message.toolName !== "string" ||
        !message.toolName ||
        !pending.has(message.toolCallId) ||
        pending.get(message.toolCallId) !== message.toolName
      ) {
        throw new Error("Recovery tool result has no unambiguous preceding call");
      }
      pending.delete(message.toolCallId);
      continue;
    }
    if (pending.size) throw new Error("Recovery has an incomplete tool-call group");
    if (message.role !== "assistant") continue;
    for (const part of message.content) {
      if (part.type !== "toolCall") continue;
      const key = typeof part.id === "string" ? (effective ? codexCallKey(part.id) : part.id) : "";
      if (!key || typeof part.name !== "string" || !part.name || seen.has(key))
        throw new Error("Recovery tool call is ambiguous");
      seen.add(key);
      pending.set(part.id, part.name);
    }
  }
  if (pending.size) throw new Error("Recovery crosses an open tool-call boundary");
}

/** Raw AND provider-effective closure; provider repair must never invent a pair. */
export function assertClosedToolPairs(messages: readonly RecoveryMessage[], seen = bookkeeping()): void {
  if (!messages.every(supported)) throw new Error("Unsupported recovery role");
  checkPairs(messages, seen.raw);
  checkPairs(
    convertToLlm([...messages]).filter(
      (message) => message.role !== "assistant" || (message.stopReason !== "error" && message.stopReason !== "aborted"),
    ),
    seen.effective,
    true,
  );
}

/**
 * Recovery-specific canonical selection, NOT private native preparation. Every
 * temporary entry corresponds directly to one canonical occurrence at that index.
 * The source graph and its entry IDs are never used as a writable session.
 */
export function splitRecoveryContext(
  conversation: readonly AgentMessage[],
  priorCheckpointId: string,
  keepRecentTokens: number,
): RecoverySplit {
  if (!Number.isSafeInteger(keepRecentTokens) || keepRecentTokens <= 0) throw new Error("Invalid recovery budget");
  if (!conversation.every(supported)) throw new Error("Unsupported recovery role");
  const messages = structuredClone(conversation);
  const marker = checkpointMarker(priorCheckpointId);
  const markers = messages.flatMap((message, index) =>
    message.role === "user" &&
    (message.content === marker ||
      (Array.isArray(message.content) &&
        message.content.length === 1 &&
        message.content[0].type === "text" &&
        message.content[0].text === marker))
      ? [index]
      : [],
  );
  if (markers.length !== 1) throw new Error("Recovery requires exactly one prior marker");
  const view = SessionManager.inMemory();
  for (const message of messages) view.appendMessage(message);
  const cutIndex = findCutPoint(view.getBranch(), 0, messages.length, keepRecentTokens).firstKeptEntryIndex;
  // A prior marker alone is not new prefix content. Never silently move a cut
  // or recursively shrink it if public selection cannot produce a safe split.
  if (!Number.isInteger(cutIndex) || cutIndex <= markers[0] + 1 || cutIndex >= messages.length) {
    throw new Error("Recovery has no meaningful strictly smaller prefix");
  }
  const prefix = messages.slice(0, cutIndex);
  const suffix = messages.slice(cutIndex);
  if (!hasProviderContent(prefix.slice(markers[0] + 1)) || !hasProviderContent(suffix)) {
    throw new Error("Recovery needs proven provider-visible new prefix and removed suffix content");
  }
  const seen = bookkeeping();
  assertClosedToolPairs(prefix, seen);
  assertClosedToolPairs(suffix, seen);
  return { cutIndex, prefix, suffix };
}

/** Historical billing stays in the source; model-visible fields stay intact. */
export function resetHistoricalUsage(message: RecoveryMessage): RecoveryMessage {
  const copy = structuredClone(message);
  if (copy.role === "assistant" || copy.role === "toolResult") {
    if (copy.role === "assistant" || copy.usage !== undefined) {
      copy.usage = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
    }
  }
  return copy;
}
