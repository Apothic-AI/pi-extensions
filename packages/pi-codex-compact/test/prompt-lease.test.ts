import assert from "node:assert/strict";
import { getCurrentSystemPrompt, type Model } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { type ExtensionContext, type SessionBeforeCompactEvent, SessionManager } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createCheckpointDetails, fallbackSummary } from "../src/checkpoint.js";
import { createCodexCompactExtension } from "../src/codex-compact.js";
import { type CodexCompactSettingsRuntime, DEFAULT_CODEX_COMPACT_SETTINGS } from "../src/settings.js";
import { createMockContext, createMockPi } from "./support.js";

const canonical = "Synthetic canonical instructions";
const effective = "Synthetic request-local instructions";
const model: Model<"openai-codex-responses"> = {
  id: "offline-model",
  name: "Offline",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100000,
  maxTokens: 1000,
};
const apiKey = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic" } })).toString("base64")}.x`;

for (const seam of ["stable", "consent", "auth", "body"] as const) {
  test(`divergent operation pins canonical and effective text across ${seam} (same checkpoint IDs)`, async () => {
    const manager = SessionManager.inMemory();
    manager.appendMessage({ role: "system", content: canonical, timestamp: 1 });
    manager.appendMessage({ role: "user", content: "Synthetic older task", timestamp: 2 });
    const kept = { role: "user" as const, content: "Synthetic kept task", timestamp: 3 };
    const keptId = manager.appendMessage(kept);
    const details = createCheckpointDetails({
      modelId: model.id,
      replacementHistory: [{ type: "compaction", encrypted_content: "synthetic-old-opaque" }],
      keptMessages: [kept],
    });
    const checkpointId = manager.appendCompaction(fallbackSummary(details.checkpointId), keptId, 100, details);
    const latestId = manager.appendMessage({ role: "user", content: "Synthetic latest task", timestamp: 4 });
    const ids = manager.getBranch().map((entry) => entry.id);
    const checkpoint = manager.getBranch().find((entry) => entry.id === checkpointId);
    assert.ok(checkpoint?.type === "compaction" && checkpoint.systemMessage);
    assert.equal(checkpoint.systemMessage.content, canonical);
    // Intentionally retain the SDK's references, as native lifecycle callers may.
    const transcript = manager.buildSessionContext().messages;
    assert.ok(transcript.includes(checkpoint.systemMessage));
    const heldMutation = async () => {
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      checkpoint.systemMessage.content = effective;
      assert.equal(getCurrentSystemPrompt(transcript), effective, "old transcript aliases the mutated checkpoint");
      assert.equal(getCurrentSystemPrompt(manager.buildSessionContext().messages), effective);
      assert.deepEqual(
        manager.getBranch().map((entry) => entry.id),
        ids,
      );
      assert.equal(manager.getLeafId(), latestId);
    };
    let authCalls = 0;
    let requests = 0;
    const mock = createMockPi();
    const { ctx: rawCtx } = createMockContext({
      model,
      mode: seam === "consent" ? "tui" : "rpc",
      hasUI: true,
      sessionManager: manager,
      getSystemPrompt: () => effective,
      confirm: async () => {
        assert.equal(seam, "consent");
        await heldMutation();
        return true;
      },
      modelRegistry: {
        getProvider: () => openaiCodexProvider(),
        getApiKeyAndHeaders: async () => {
          authCalls++;
          if (seam === "auth") await heldMutation();
          return { ok: true, apiKey };
        },
      },
    });
    const ctx = rawCtx as ExtensionContext;
    const state = {
      kind: "loaded" as const,
      path: "/unused/synthetic-settings.json",
      document: {},
      settings: { ...DEFAULT_CODEX_COMPACT_SETTINGS, allowCanonicalHistory: seam !== "consent", maxRetries: 0 },
    };
    const settingsRuntime: CodexCompactSettingsRuntime = {
      get: () => structuredClone(state),
      reload: async () => structuredClone(state),
      update: async () => assert.fail("must not write settings"),
      flush: async () => {},
    };
    createCodexCompactExtension({
      settingsRuntime,
      fetch: async () => {
        requests++;
        const item = { type: "compaction", encrypted_content: "synthetic-new-opaque" };
        const bytes = new TextEncoder().encode(
          `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [item] } })}\n\n`,
        );
        return new Response(
          new ReadableStream({
            async start(controller) {
              if (seam === "body") await heldMutation();
              controller.enqueue(bytes);
              controller.close();
            },
          }),
        );
      },
    })(mock.pi);
    await mock.events.get("context")?.[0]({ messages: transcript }, ctx);
    await mock.events.get("before_provider_request")?.[0]({ payload: { instructions: effective, tools: [] } }, ctx);
    const input: SessionBeforeCompactEvent = {
      type: "session_before_compact",
      branchEntries: manager.getBranch(),
      preparation: {
        firstKeptEntryId: latestId,
        messagesToSummarize: [],
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore: 100,
        fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        settings: { enabled: true, reserveTokens: 10, keepRecentTokens: 10 },
      },
      reason: "manual",
      willRetry: false,
      signal: new AbortController().signal,
    };
    const result = await mock.events.get("session_before_compact")?.[0](input, ctx);
    if (seam === "stable") {
      assert.ok(
        result && typeof result === "object" && "compaction" in result,
        "positive control must reach remote success",
      );
    } else {
      assert.deepEqual(
        result,
        { cancel: true },
        "must not publish an opaque result generated for a different canonical head",
      );
    }
    assert.equal(authCalls, seam === "consent" ? 0 : 1);
    assert.equal(requests, seam === "body" || seam === "stable" ? 1 : 0);
    assert.deepEqual(
      manager.getBranch().map((entry) => entry.id),
      ids,
    );
    assert.equal(manager.getBranch().filter((entry) => entry.type === "compaction").length, 1);
  });
}
