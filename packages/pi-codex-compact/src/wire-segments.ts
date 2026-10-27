import { compactionError } from "./failure.js";
import type { JsonObject } from "./protocol.js";

export interface WireSegments {
  /** Leading declaration groups remain separate and in their original order. */
  prefixEnd: number;
  /** Exclusive occurrence indices, never value-based deduplication. */
  ends: number[];
}

/** Conservative grammar used only when a request actually needs segmentation. */
export function planWireSegments(input: readonly JsonObject[]): WireSegments {
  const unsupported = () => {
    throw compactionError("segmentation_unsupported");
  };
  let prefixEnd = 0;
  while (input[prefixEnd]?.type === "additional_tools") prefixEnd++;
  const ends: number[] = [];
  const calls = new Set<string>();
  const pending = new Set<string>();
  let opaque = -1;
  for (let i = prefixEnd; i < input.length; i++) {
    const item = input[i];
    const message = item.type === undefined || item.type === "message";
    if (message) {
      if (item.role !== "user" && item.role !== "assistant") unsupported();
      if (item.role === "user") {
        if (pending.size) unsupported();
        if (i > prefixEnd) ends.push(i);
      }
    } else if (item.type === "reasoning") {
      if (pending.size) unsupported();
      const prior = input[i - 1];
      if (i > prefixEnd && (prior?.role === "assistant" || prior?.type === "function_call_output")) ends.push(i);
    } else if (item.type === "function_call") {
      if (typeof item.call_id !== "string" || !item.call_id || calls.has(item.call_id)) unsupported();
      const id = item.call_id as string;
      calls.add(id);
      pending.add(id);
    } else if (item.type === "function_call_output") {
      if (typeof item.call_id !== "string" || !pending.delete(item.call_id)) unsupported();
      if (!pending.size) ends.push(i + 1);
    } else if (item.type === "compaction") {
      if (opaque !== -1 || pending.size) unsupported();
      opaque = i;
    } else {
      unsupported();
    }
  }
  if (pending.size || prefixEnd === input.length) unsupported();
  ends.push(input.length);
  // An original opaque item and every preceding raw backup MUST be consumed
  // together. Intermediate opaque state must never coexist with the original.
  return { prefixEnd, ends: [...new Set(ends)].filter((end) => end > opaque).sort((a, b) => a - b) };
}
