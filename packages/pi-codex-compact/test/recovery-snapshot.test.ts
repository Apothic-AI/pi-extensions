import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { test } from "vitest";
import { checkpointMarker } from "../src/checkpoint.js";
import { splitRecoveryContext } from "../src/recovery-snapshot.js";

const prior = "synthetic-checkpoint";
const user = (content: string, timestamp = 1): AgentMessage => ({ role: "user", content, timestamp });
const marker = user(checkpointMarker(prior));
const older = user("Earlier meaningful prefix. ".repeat(100));
const tail = user("Recent unsent tail.");
const call: AgentMessage = {
  role: "assistant",
  content: [{ type: "toolCall", id: "call-1", name: "inspect", arguments: {} }],
  provider: "openai-codex",
  api: "openai-codex-responses",
  model: "test",
  stopReason: "toolUse",
  timestamp: 2,
  usage: {
    input: 900000,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 900001,
    cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
  },
};
const result: AgentMessage = {
  role: "toolResult",
  toolCallId: "call-1",
  toolName: "inspect",
  content: [{ type: "text", text: "Exact result" }],
  isError: false,
  timestamp: 3,
};

test("cut uses occurrence indices, excludes prior-only prefix and preserves complete suffix", () => {
  const duplicate = user("identical", 4);
  const messages = [marker, older, duplicate, duplicate, tail];
  const split = splitRecoveryContext(messages, prior, 1);
  assert.equal(split.cutIndex, 4);
  assert.deepEqual(split.prefix, messages.slice(0, 4));
  assert.deepEqual(split.suffix, [tail]);
  assert.throws(() => splitRecoveryContext([marker, tail], prior, 1));
  assert.throws(() => splitRecoveryContext([marker, user(""), tail], prior, 1));
  assert.throws(() => splitRecoveryContext(messages, prior, 100000));
  assert.throws(() => splitRecoveryContext([older, tail], prior, 1));
  assert.throws(() => splitRecoveryContext([marker, older, marker, tail], prior, 1));
});

test("reject unsupported summary roles and invalid or crossed tool pairs before transport", () => {
  assert.throws(() =>
    splitRecoveryContext(
      [marker, older, { role: "compactionSummary", summary: "Unsent", timestamp: 4 }, tail],
      prior,
      1,
    ),
  );
  assert.throws(() => splitRecoveryContext([marker, older, result, tail], prior, 1));
  assert.throws(() =>
    splitRecoveryContext(
      [marker, older, { ...result, toolName: undefined } as unknown as AgentMessage, tail],
      prior,
      1,
    ),
  );
  assert.throws(() => splitRecoveryContext([marker, older, call, { ...result, toolName: "wrong" }, tail], prior, 1));
  assert.throws(() => splitRecoveryContext([marker, older, call, user("Crossed boundary"), result, tail], prior, 1));
  assert.throws(() => splitRecoveryContext([marker, older, call, tail], prior, 1));
  assert.throws(() => splitRecoveryContext([marker, older, call, result, result, tail], prior, 1));
  assert.throws(() => splitRecoveryContext([marker, older, call, result, call, result, tail], prior, 1));
  // A large tool result alone makes Pi select its preceding call, never a result.
  const largeResult = { ...result, content: [{ type: "text" as const, text: "x".repeat(200) }] };
  const split = splitRecoveryContext([marker, older, call, largeResult], prior, 10);
  assert.equal(split.cutIndex, 2);
  assert.deepEqual(split.suffix, [call, largeResult]);
});
