import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateTokens, findCutPoint, SessionManager } from "@earendil-works/pi-coding-agent";
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

/** Deliberately stricter than provider repair: no invented/missing/duplicate results. */
export function assertClosedToolPairs(messages: readonly RecoveryMessage[], seen = new Set<string>()): void {
  const pending = new Map<string, string>();
  for (const message of messages) {
    if (!supported(message)) throw new Error("Unsupported recovery role");
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
      if (typeof part.id !== "string" || !part.id || typeof part.name !== "string" || !part.name || seen.has(part.id))
        throw new Error("Recovery tool call is ambiguous");
      seen.add(part.id);
      pending.set(part.id, part.name);
    }
  }
  if (pending.size) throw new Error("Recovery crosses an open tool-call boundary");
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
  if (!prefix.slice(markers[0] + 1).some((message) => estimateTokens(message) > 0)) {
    throw new Error("Recovery prefix contains no new model-visible content");
  }
  const seen = new Set<string>();
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
