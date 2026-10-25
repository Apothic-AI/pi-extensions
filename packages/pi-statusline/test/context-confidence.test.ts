import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { CONTEXT_CONFIDENCE_ENTRY, ContextConfidence } from "../src/context-confidence.js";

const model = { provider: "provider-a", api: "openai-responses", id: "model-a" } as const;
let nextTimestamp = 0;
function assistant(overrides: Record<string, unknown> = {}): AgentMessage {
  return {
    role: "assistant",
    provider: model.provider,
    api: model.api,
    model: model.id,
    timestamp: ++nextTimestamp,
    stopReason: "stop",
    usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0 },
    ...overrides,
  } as AgentMessage;
}
function entry(message: AgentMessage): SessionEntry {
  return { type: "message", message } as SessionEntry;
}
function partial(timestamp: number, overrides: Record<string, unknown> = {}): AgentMessage {
  return {
    role: "assistant",
    provider: model.provider,
    api: model.api,
    model: model.id,
    timestamp,
    content: [],
    stopReason: "stop",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...overrides,
  } as AgentMessage;
}
function complete(state: ContextConfidence, message = assistant()) {
  state.start(
    message.role === "assistant"
      ? partial(message.timestamp, { provider: message.provider, api: message.api, model: message.model })
      : message,
  );
  state.finish({ ...message });
}

test("failure and cancelled compaction latch uncertainty until a fresh same-route response", () => {
  const state = new ContextConfidence();
  state.rebuild([], model);
  assert.equal(state.unknown, false, "no evidence preserves the host's public API behavior");
  state.finish(assistant({ stopReason: "error", errorMessage: "opaque failure" }));
  assert.equal(state.unknown, true);
  state.invalidate(); // session_compact_failed, including cancellation
  for (const message of [
    { role: "custom", content: "queued notification" },
    { role: "toolResult", usage: { input: 100 } },
    assistant({ stopReason: "error", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    assistant({ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    assistant({ usage: { input: Number.NaN, output: 1, cacheRead: 0, cacheWrite: 0 } }),
    assistant({ usage: { input: Number.POSITIVE_INFINITY, output: 1, cacheRead: 0, cacheWrite: 0 } }),
    assistant({ usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: Number.NaN } }),
    assistant({ usage: { input: -1, output: 1, cacheRead: 0, cacheWrite: 0 } }),
    assistant({ usage: undefined }),
    assistant({ stopReason: "aborted" }),
  ]) {
    complete(state, message as AgentMessage);
    assert.equal(state.unknown, true);
  }
  complete(state);
  assert.equal(state.unknown, false);
});

test("rebuild uses ordered raw branch evidence, including attempts omitted from model projection", () => {
  const state = new ContextConfidence();
  const success = entry(assistant());
  const failure = entry(assistant({ stopReason: "error" }));
  const compact = { type: "compaction" } as SessionEntry;
  const warm = { type: "usage", usage: { input: 100 } } as unknown as SessionEntry;
  // The active raw branch still contains failure, independently of model projection.
  state.rebuild([success, failure, warm], model);
  assert.equal(state.unknown, true);
  state.rebuild([success], model); // another active branch, not all getEntries()
  assert.equal(state.unknown, false);
  state.rebuild([success, failure, entry(assistant())], model);
  assert.equal(state.unknown, false);
  state.rebuild([success, failure, entry(assistant()), compact, warm], model);
  assert.equal(state.unknown, true, "later compaction supersedes earlier successful usage");
  state.rebuild([compact, entry(assistant())], model);
  assert.equal(state.unknown, false);
  const initialModel = { type: "model_change", provider: model.provider, modelId: model.id } as SessionEntry;
  state.rebuild(
    [initialModel, entry(assistant({ usage: undefined, provider: undefined, api: undefined, model: undefined }))],
    model,
  );
  assert.equal(state.unknown, false, "incomplete legacy fixtures are not evidence of failure");
  const changedModel = { type: "model_change", provider: model.provider, modelId: "model-b" } as SessionEntry;
  state.rebuild([success, changedModel, initialModel], model);
  assert.equal(state.unknown, true, "historical model switches cannot reuse old route trust");
});

test("model/provider/API changes cannot reuse or import another route's trust", () => {
  for (const alternate of [
    { ...model, id: "model-b" },
    { ...model, provider: "provider-b" },
    { ...model, api: "anthropic-messages" },
  ]) {
    const state = new ContextConfidence();
    state.rebuild([entry(assistant())], model);
    state.selectModel(alternate);
    assert.equal(state.unknown, true);
    complete(state, assistant());
    assert.equal(state.unknown, true);
    complete(state, assistant({ provider: alternate.provider, api: alternate.api, model: alternate.id }));
    assert.equal(state.unknown, false);
    state.selectModel(model);
    assert.equal(state.unknown, true, "switching back also requires fresh usage");
    state.rebuild([entry(assistant({ provider: alternate.provider, api: alternate.api, model: alternate.id }))], model);
    assert.equal(state.unknown, true, "restoring must not borrow another route's usage");
  }
});

test("timestamp-only partial starts match response-ID finishes copied by agent-core", () => {
  for (const api of ["openai-codex-responses", "openai-responses", "anthropic-messages"]) {
    const state = new ContextConfidence();
    state.rebuild([], { ...model, api });
    state.invalidate();
    const start = partial(123, { api });
    state.start({ ...start });
    // The provider assigns responseId only after its initial start event.
    const finish = assistant({ timestamp: 123, api, responseId: "later-response-id" });
    state.finish({ ...finish });
    assert.equal(state.unknown, false, api);
    state.invalidate();
    state.finish({ ...finish });
    assert.equal(state.unknown, true, "duplicate finish has no active admission");
  }
});

test("each admitted stream is a new occurrence even when timestamps and IDs collide", () => {
  for (const timestamp of [123, undefined]) {
    const state = new ContextConfidence();
    state.rebuild([], model);
    const success = assistant({ timestamp, responseId: "reused" });
    const failure = assistant({ timestamp, responseId: "reused", stopReason: "error" });
    if (timestamp === undefined) {
      // Without a usable timestamp, only the exact admitted object can match.
      state.start(success);
      state.finish(success);
    } else {
      complete(state, success);
    }
    assert.equal(state.unknown, false);
    complete(state, failure);
    assert.equal(state.unknown, true, "same-timestamp success then error must invalidate");
    if (timestamp === undefined) {
      state.start(success);
      state.finish(success);
    } else {
      complete(state, success);
    }
    assert.equal(state.unknown, false, "same-timestamp error then new success may recover");
    state.finish({ ...failure });
    assert.equal(state.unknown, true, "failure without start is never deduplicated");
    state.finish({ ...success });
    assert.equal(state.unknown, true, "success without start cannot undo that failure");
  }
});

test("only a validated own unknown record participates in ordered branch replay", () => {
  const state = new ContextConfidence();
  const success = entry(assistant());
  const record = (data: unknown, customType = CONTEXT_CONFIDENCE_ENTRY) =>
    ({ type: "custom", customType, data }) as SessionEntry;
  const unknown = record({ version: 1, state: "unknown" });
  state.rebuild([success, unknown], model);
  assert.equal(state.unknown, true);
  state.rebuild([success, unknown, entry(assistant({ api: "anthropic-messages" }))], model);
  assert.equal(state.unknown, true, "another route's later usage cannot recover");
  state.rebuild([success, unknown, entry(assistant())], model);
  assert.equal(state.unknown, false, "only qualifying usage later in this branch supersedes the marker");
  state.rebuild([success, record({ version: 1, state: "unknown" }, "other-extension")], model);
  assert.equal(state.unknown, false, "never read another extension's schema");
  for (const data of [
    undefined,
    null,
    [],
    { version: 2, state: "unknown" },
    { version: 1, state: "known" },
    { state: "unknown" },
    { version: 1, state: "unknown", error: "must not be adopted" },
    { version: 1, state: "unknown", [Symbol("extra")]: true },
    Object.create({ version: 1, state: "unknown" }),
    Object.defineProperty({ state: "unknown" }, "version", {
      get() {
        throw new Error("record accessors must not run");
      },
    }),
  ]) {
    state.rebuild([success, record(data)], model);
    assert.equal(state.unknown, false, "malformed records are ignored");
  }
});

test("compaction, tree rebuild and model change reject old or duplicate completions", () => {
  const state = new ContextConfidence();
  state.rebuild([], model);
  const old = assistant();
  complete(state, old);
  state.invalidate();
  state.finish({ ...old });
  assert.equal(state.unknown, true, "replaying old usage without a new start cannot repair confidence");
  const pending = assistant();
  state.start(pending);
  state.invalidate();
  state.finish(pending);
  assert.equal(state.unknown, true, "pre-compaction in-flight response is not fresh evidence");
  state.start(assistant());
  state.rebuild([entry(assistant({ stopReason: "aborted" }))], model);
  state.finish(assistant());
  assert.equal(state.unknown, true, "unadmitted completion cannot restore a rebuilt owner");
  const staleRoute = assistant();
  state.start(staleRoute);
  state.selectModel({ ...model, id: "model-b" });
  state.selectModel(model);
  state.finish(staleRoute);
  assert.equal(state.unknown, true);
  complete(state);
  assert.equal(state.unknown, false);
});
