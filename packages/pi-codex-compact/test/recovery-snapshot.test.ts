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

for (const stopReason of ["error", "aborted"] as const) {
  test(`invisible ${stopReason} partial cannot prove removed suffix or new prefix`, () => {
    const partial = { ...call, content: [{ type: "text" as const, text: "nonempty partial" }], stopReason };
    assert.throws(() => splitRecoveryContext([marker, user("prefix"), partial], prior, 1));
    assert.throws(() => splitRecoveryContext([marker, partial, tail], prior, 1));
  });
}

for (const stopReason of ["error", "aborted"] as const) {
  for (const half of ["prefix", "suffix"] as const) {
    test(`raw closed ${stopReason} call/result in ${half} is an effective orphan`, () => {
      const failed = { ...call, stopReason };
      const messages =
        half === "prefix"
          ? [marker, older, failed, result, tail]
          : [
              marker,
              older,
              user("Suffix boundary"),
              failed,
              { ...result, content: [{ type: "text" as const, text: "result".repeat(2000) }] },
            ];
      assert.throws(() => splitRecoveryContext(messages, prior, 1), /tool result/);
    });
  }
}

for (const [first, second] of [
  ["duplicate|fc_one", "duplicate|fc_two"],
  ["punct.uation|one", "punct_uation|two"],
  [`${"a".repeat(64)}x|one`, `${"a".repeat(64)}y|two`],
  ["trailing_|one", "trailing|two"],
  ["___|empty", "valid|other"],
] as const) {
  for (const acrossHalves of [false, true]) {
    test(`effective Codex call IDs reject ${first}/${second} (across halves=${acrossHalves})`, () => {
      const pair = (id: string, large = false) => [
        {
          ...call,
          provider: "historical-foreign",
          content: [{ type: "toolCall" as const, id, name: "inspect", arguments: {} }],
        },
        {
          ...result,
          toolCallId: id,
          content: [{ type: "text" as const, text: large ? "result".repeat(2000) : "Exact result" }],
        },
      ];
      const messages = acrossHalves
        ? [marker, older, ...pair(first), user("Suffix boundary"), ...pair(second, true)]
        : [marker, older, ...pair(first), ...pair(second), tail];
      const original = structuredClone(messages);
      assert.throws(() => splitRecoveryContext(messages, prior, 1), /ambiguous/);
      assert.deepEqual(messages, original, "validation keys never rewrite selected IDs");
    });
  }
}

const excludedBash: AgentMessage = {
  role: "bashExecution",
  command: "synthetic",
  output: "nonempty output",
  exitCode: 0,
  cancelled: false,
  truncated: false,
  excludeFromContext: true,
  timestamp: 3,
};
test("excluded bash cannot prove new prefix or removed suffix", () => {
  assert.throws(() => splitRecoveryContext([marker, excludedBash, tail], prior, 1));
  assert.throws(() => splitRecoveryContext([marker, older, excludedBash], prior, 1));
});

test("reasoning alone is not visibility proof; supported media/tool/signature content is not rewritten", () => {
  const reasoning = {
    ...call,
    stopReason: "stop" as const,
    model: "historical-B",
    content: [
      {
        type: "thinking" as const,
        thinking: "",
        redacted: true,
        thinkingSignature: JSON.stringify({ type: "reasoning", encrypted_content: "opaque-reasoning" }),
      },
    ],
  };
  assert.throws(() => splitRecoveryContext([marker, reasoning, tail], prior, 1));
  assert.throws(() => splitRecoveryContext([marker, older, reasoning], prior, 1));
  const image: AgentMessage = {
    role: "user",
    content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
    timestamp: 1,
  };
  const signedCall = { ...call, content: [...reasoning.content, ...call.content] };
  const split = splitRecoveryContext([marker, older, signedCall, result, image], prior, 1);
  assert.deepEqual(split.prefix, [marker, older, signedCall, result]);
  assert.deepEqual(split.suffix, [image]);
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
