import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import {
  getCurrentSystemMessage,
  InMemoryCredentialStore,
  type Model,
  normalizeContext,
  type Provider,
} from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import {
  type AgentSession,
  convertToLlm,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionContext,
  getLastAssistantUsage,
  initTheme,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { checkpointMarker, parseCheckpointDetails, projectCheckpointContext } from "../src/checkpoint.js";
import { createCodexCompactExtension } from "../src/codex-compact.js";
import { type JsonObject, rewriteCheckpointMarker } from "../src/protocol.js";
import { resetHistoricalUsage, splitRecoveryContext } from "../src/recovery-snapshot.js";
import { type CodexCompactSettingsRuntime, DEFAULT_CODEX_COMPACT_SETTINGS } from "../src/settings.js";
import { createCustomSelectorHarness, createMockContext } from "./support.js";

const model: Model<"openai-codex-responses"> = {
  id: "gpt-5.6",
  name: "Offline recovery",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://offline-model.test",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100000,
  maxTokens: 1000,
};
const apiKey = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline" } })).toString("base64")}.x`;
function sse(compact: boolean): Response {
  const item = compact
    ? { type: "compaction", encrypted_content: "accepted-opaque" }
    : { type: "message", id: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] };
  const events = compact
    ? [{ type: "response.output_item.done", output_index: 0, item }]
    : [
        { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
        {
          type: "response.content_part.added",
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: "" },
        },
        { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Done." },
        { type: "response.output_item.done", output_index: 0, item },
      ];
  return new Response(
    [
      ...events,
      {
        type: "response.completed",
        response: {
          status: "completed",
          output: [item],
          usage: { input_tokens: 17, output_tokens: 4, total_tokens: 21 },
        },
      },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}
function canonical(manager: SessionManager) {
  const transcript = manager.buildSessionContext().messages;
  const details = parseCheckpointDetails(
    manager
      .getBranch()
      .filter((entry) => entry.type === "compaction")
      .at(-1)?.details,
  );
  assert.ok(details);
  const projected = projectCheckpointContext(transcript, details, "full");
  assert.ok(projected);
  const head = getCurrentSystemMessage(transcript);
  assert.ok(head);
  return [head, ...projected.filter((message) => message.role !== "system")];
}
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "pi-recovery-sdk-"));
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected live fetch"));
  vi.spyOn(globalThis, "WebSocket").mockImplementation(() => {
    throw new Error("Unexpected live WebSocket");
  });
  const requests: Array<{ payload: JsonObject; url: string }> = [];
  let oversized = false;
  let confirm = async () => true;
  let onFetch = () => {};
  let authHook = async () => {};
  let authCount = 0;
  let confirmations = 0;
  let progress: ReturnType<typeof createCustomSelectorHarness> | undefined;
  let hold: ((signal?: AbortSignal | null) => Promise<Response>) | undefined;
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const body = init?.body;
    assert.ok(typeof body === "string" || body instanceof Uint8Array);
    const payload = JSON.parse(
      typeof body === "string" ? body : zstdDecompressSync(body).toString("utf8"),
    ) as JsonObject;
    requests.push({ payload, url: String(url) });
    onFetch();
    if (hold) return hold(init?.signal);
    const compact = payload.input.some((item: JsonObject) => item.type === "compaction_trigger");
    if (compact && oversized)
      return new Response(
        `data: ${JSON.stringify({ type: "response.failed", response: { error: { code: "context_window_exceeded" } } })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    return sse(compact);
  };
  const credentials = new InMemoryCredentialStore();
  const runtime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    modelsStorePath: join(directory, "models.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const actual = openaiCodexProvider();
  const streamOptions: Array<{ maxRetries?: number; transport?: string }> = [];
  const provider: Provider = {
    ...actual,
    getModels: () => [model],
    auth: {
      apiKey: {
        name: "Offline",
        resolve: async () => {
          authCount++;
          await authHook();
          return { auth: { apiKey, baseUrl: "https://resolved-offline.test/backend-api/codex" } };
        },
      },
    },
    stream: (m, c, o) => {
      streamOptions.push({ maxRetries: o?.maxRetries, transport: o?.transport });
      return actual.stream(m, c, { ...o, transport: "sse", fetch: o?.fetch ?? fetch });
    },
    streamSimple: (m, c, o) => actual.streamSimple(m, c, { ...o, transport: "sse", fetch: o?.fetch ?? fetch }),
  };
  runtime.registerNativeProvider(provider);
  const extensionSettings: CodexCompactSettingsRuntime = {
    get: () => ({
      kind: "missing",
      path: join(directory, "extension-settings.json"),
      document: {},
      settings: { ...DEFAULT_CODEX_COMPACT_SETTINGS, allowCanonicalHistory: true },
    }),
    reload: async () => extensionSettings.get(),
    update: async () => {
      throw new Error("Recovery must not write settings");
    },
    flush: async () => {},
  };
  const settingsManager = SettingsManager.inMemory({
    defaultTools: ["read"],
    compaction: { enabled: false, keepRecentTokens: 6 },
    retry: { enabled: false },
    cacheWarming: "off",
  });
  const source = SessionManager.create(directory, directory);
  const sessions: AgentSession[] = [];
  initTheme("dark");
  const mock = createMockContext({
    mode: "tui",
    confirm: () => {
      confirmations++;
      return confirm();
    },
    custom: async (factory: unknown) => {
      const harness = createCustomSelectorHarness(factory);
      try {
        if (harness.isPiTuiKitScreen) {
          harness.handleInput("tui.select.down");
          harness.handleInput("tui.select.confirm");
        } else progress = harness;
        return await harness.resultPromise;
      } finally {
        harness.dispose();
      }
    },
  });
  const open = async (manager: SessionManager) => {
    const loader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: directory,
      settingsManager,
      noExtensions: true,
      noContextFiles: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      systemPrompt: "Synthetic recovery envelope",
      extensionFactories: [createCodexCompactExtension({ settingsRuntime: extensionSettings, fetch })],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const { session } = await createAgentSession({
      cwd: directory,
      agentDir: directory,
      model,
      thinkingLevel: "off",
      modelRuntime: runtime,
      resourceLoader: loader,
      settingsManager,
      sessionManager: manager,
    });
    await session.bindExtensions({ mode: "tui", uiContext: (mock.ctx as ExtensionContext).ui });
    sessions.push(session);
    return session;
  };
  const session = await open(source);
  await session.prompt(`Initial old prefix ${"older content ".repeat(1000)}`);
  await session.prompt("Initial recent turn");
  await session.compact();
  settingsManager.applyOverrides({ compaction: { enabled: false, keepRecentTokens: 2000 } });
  source.appendCustomEntry("synthetic-control-must-not-copy", { armed: true });
  source.appendMessage({
    role: "user",
    content: `Meaningful new prefix ${"prefix content ".repeat(2000)}`,
    timestamp: 10,
  });
  source.appendMessage({
    role: "user",
    content: [
      { type: "text", text: `TAIL_USER_CANARY ${"tail ".repeat(2000)}` },
      { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
    ],
    timestamp: 11,
  });
  const usage = {
    input: 900000,
    output: 4,
    cacheRead: 100,
    cacheWrite: 10,
    totalTokens: 900114,
    cost: { input: 9, output: 1, cacheRead: 1, cacheWrite: 1, total: 12 },
  };
  source.appendMessage({
    role: "assistant",
    content: [
      {
        type: "thinking",
        thinking: "TAIL_THINK_CANARY",
        thinkingSignature: JSON.stringify({
          type: "reasoning",
          id: "rs_tail",
          encrypted_content: "TAIL_SIGNATURE_CANARY",
          summary: [{ type: "summary_text", text: "TAIL_THINK_CANARY" }],
        }),
      },
      { type: "toolCall", id: "call_tail|fc_tail", name: "read", arguments: { path: "TAIL_ARGUMENT_CANARY" } },
    ],
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason: "toolUse",
    timestamp: 12,
    usage,
  });
  source.appendMessage({
    role: "toolResult",
    toolCallId: "call_tail|fc_tail",
    toolName: "read",
    content: [{ type: "text", text: "TAIL_RESULT_CANARY" }],
    timestamp: 13,
    isError: false,
    usage,
  });
  source.appendCustomMessageEntry("synthetic-content", "TAIL_CUSTOM_CANARY", false);
  await session.prompt("Establish unchanged loadout evidence");
  return {
    directory,
    session,
    source,
    settingsManager,
    extensionSettings,
    requests,
    open,
    oversized: (value: boolean) => {
      oversized = value;
    },
    confirm: (fn: typeof confirm) => {
      confirm = fn;
    },
    onFetch: (fn: typeof onFetch) => {
      onFetch = fn;
    },
    authHook: (fn: typeof authHook) => {
      authHook = fn;
    },
    hold: (fn: typeof hold) => {
      hold = fn;
    },
    authCount: () => authCount,
    confirmations: () => confirmations,
    cancelProgress: () => {
      assert.ok(progress);
      progress.handleInput("tui.select.cancel");
    },
    credentials,
    ui: (mock.ctx as ExtensionContext).ui,
    streamOptions,
    notifications: mock.notifications,
    cleanup: () => {
      for (const item of sessions) item.dispose();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("actual SDK full oversized → explicit prefix accepted → fresh reopen/fork/exact wire → later full compaction", async () => {
  const f = await fixture();
  try {
    f.oversized(true);
    const sourceFile = f.source.getSessionFile();
    assert.ok(sourceFile);
    const sourceHash = hash(sourceFile);
    const backup = join(f.directory, "synthetic-backup.txt");
    copyFileSync(sourceFile, backup);
    const settings = JSON.stringify(f.settingsManager.getSettings());
    const extensionSettings = JSON.stringify(f.extensionSettings.get());
    const creds = await f.credentials.list();
    const requests = f.requests.length;
    await assert.rejects(f.session.compact(), /cancel/i);
    assert.equal(f.requests.length, requests + 1, JSON.stringify(f.notifications));
    assert.match(JSON.stringify(f.notifications), /remote_context_window_exceeded/);
    assert.equal(hash(sourceFile), sourceHash);
    const projected = canonical(f.source);
    const prior = parseCheckpointDetails(
      f.source
        .getBranch()
        .filter((entry) => entry.type === "compaction")
        .at(-1)?.details,
    );
    assert.ok(prior);
    const split = splitRecoveryContext(projected.slice(1), prior.checkpointId, 2000);
    assert.ok(split.prefix.length > 1 && split.suffix.length > 1);
    const beforeFiles = new Set(readdirSync(f.directory));
    f.oversized(false);
    await f.session.prompt("/codex-compact");
    const recovery = f.requests.at(-1)?.payload;
    assert.ok(recovery);
    assert.equal(f.requests.length, requests + 2, "one prefix request only; no automatic ordinary follow-up");
    assert.deepEqual(f.streamOptions.at(-1), { maxRetries: 0, transport: "sse" });
    assert.doesNotMatch(JSON.stringify(recovery), /TAIL_.*CANARY/);
    assert.match(JSON.stringify(recovery), /Meaningful new prefix/);
    assert.deepEqual(recovery.tools, f.requests.at(-2)?.payload.tools);
    assert.deepEqual(recovery.instructions, f.requests.at(-2)?.payload.instructions);
    assert.equal(recovery.input.filter((item: JsonObject) => item.type === "compaction_trigger").length, 1);
    assert.equal(f.requests.at(-1)?.url, "https://resolved-offline.test/backend-api/codex/responses");
    const outputs = readdirSync(f.directory).filter((file) => !beforeFiles.has(file) && file.endsWith(".jsonl"));
    assert.equal(outputs.length, 1, JSON.stringify(f.notifications));
    const exported = SessionManager.open(join(f.directory, outputs[0]));
    const replay = canonical(exported);
    assert.deepEqual(replay.slice(2), JSON.parse(JSON.stringify(split.suffix.map(resetHistoricalUsage))));
    assert.equal(
      exported.getEntries().some((entry) => entry.type === "custom"),
      false,
    );
    assert.notEqual(exported.getSessionId(), f.source.getSessionId());
    assert.equal(exported.getHeader()?.parentSession, undefined);
    assert.equal(
      getLastAssistantUsage(exported.getBranch())?.totalTokens ?? 0,
      0,
      "zero historical native usage baseline",
    );
    const recoveryCheckpoint = exported.getEntries().find((entry) => entry.type === "compaction");
    assert.equal(recoveryCheckpoint?.type === "compaction" && recoveryCheckpoint.usage?.totalTokens, 21);
    const exportedDetails = parseCheckpointDetails(
      recoveryCheckpoint?.type === "compaction" && recoveryCheckpoint.details,
    );
    assert.ok(exportedDetails);
    assert.deepEqual(exportedDetails.keptMessageFingerprints, []);
    // Actual serializer proof: zeroing historical accounting changes neither
    // model-visible input, tool IDs/signatures/media nor the system/tool envelope.
    const capture = async (messages: Parameters<typeof convertToLlm>[0]) => {
      let payload: unknown;
      for await (const _event of openaiCodexProvider().stream(
        model,
        normalizeContext({ messages: convertToLlm(messages) }),
        {
          apiKey,
          transport: "sse",
          maxRetries: 0,
          fetch: async () => {
            throw new Error("Offline serializer must abort before transport");
          },
          onPayload: (value) => {
            payload = rewriteCheckpointMarker(
              value,
              checkpointMarker(exportedDetails.checkpointId),
              exportedDetails.replacementHistory,
            );
            throw new DOMException("Offline payload capture", "AbortError");
          },
        },
      )) {
        /* drain the provider's handled abort */
      }
      assert.ok(payload);
      return payload as JsonObject;
    };
    assert.deepEqual(await capture([replay[0], replay[1], ...split.suffix]), await capture(replay));
    assert.equal(hash(sourceFile), sourceHash);
    assert.equal(JSON.stringify(f.settingsManager.getSettings()), settings);
    assert.equal(JSON.stringify(f.extensionSettings.get()), extensionSettings);
    assert.deepEqual(await f.credentials.list(), creds);
    assert.equal(f.source.getSessionFile(), sourceFile, "command never switches source");
    const next = await f.open(exported);
    assert.ok(
      (next.getContextUsage()?.tokens ?? 0) < 100000,
      "copied 900k usage cannot become the native context baseline",
    );
    await next.prompt("Explicit test continuation");
    const ordinary = f.requests.at(-1)?.payload;
    assert.ok(ordinary);
    for (const canary of [
      "TAIL_USER_CANARY",
      "TAIL_ARGUMENT_CANARY",
      "TAIL_RESULT_CANARY",
      "TAIL_CUSTOM_CANARY",
      "TAIL_SIGNATURE_CANARY",
    ]) {
      assert.equal(JSON.stringify(ordinary).split(canary).length - 1, 1, canary);
    }
    assert.equal(ordinary.input.filter((item: JsonObject) => item.type === "compaction").length, 1);
    const full = await next.compact();
    assert.ok(parseCheckpointDetails(full.details));
    assert.equal(f.requests.at(-1)?.payload.input.filter((item: JsonObject) => item.type === "compaction").length, 1);
    assert.match(JSON.stringify(f.requests.at(-1)?.payload), /TAIL_RESULT_CANARY/);
    const exportedFile = exported.getSessionFile();
    assert.ok(exportedFile);
    const fork = SessionManager.forkFrom(exportedFile, f.directory, f.directory);
    assert.deepEqual(fork.buildSessionContext(), exported.buildSessionContext());
    assert.equal(hash(sourceFile), sourceHash);
    assert.equal(hash(backup), sourceHash);
    assert.ok(
      f.source
        .getEntries()
        .some(
          (entry) =>
            entry.type === "message" && entry.message.role === "assistant" && entry.message.usage.input === 900000,
        ),
      "original accounting remains untouched",
    );
    assert.match(JSON.stringify(f.notifications), /NEW session/);
  } finally {
    f.cleanup();
  }
});

for (const drift of [
  "decline",
  "branch",
  "model",
  "loadout",
  "settings",
  "pending",
  "session",
  "tree",
  "reload",
] as const) {
  test(`SDK explicit confirmation ${drift}: no recovery credentials, request, or export`, async () => {
    const f = await fixture();
    try {
      const requests = f.requests.length;
      const auth = f.authCount();
      const files = readdirSync(f.directory);
      const confirmations = f.confirmations();
      f.confirm(async () => {
        if (drift === "branch") f.source.appendCustomEntry("unknown-state", {});
        if (drift === "session") f.source.newSession();
        if (drift === "tree") await f.session.navigateTree(f.source.getBranch()[0].id, { summarize: false });
        if (drift === "reload") await f.session.reload();
        if (drift === "model") {
          await f.session.setModel({ ...model, id: "different-model" });
          // setModel itself resolves provider auth; recovery must not add another.
        }
        if (drift === "loadout") f.session.setActiveToolsByName([]);
        if (drift === "settings") f.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
        if (drift === "pending") await f.session.followUp("Queued work must fence recovery");
        return drift !== "decline";
      });
      await f.session.prompt("/codex-compact");
      assert.equal(f.confirmations(), confirmations + 1);
      assert.equal(f.requests.length, requests);
      assert.equal(f.authCount(), auth + (drift === "model" ? 1 : 0));
      assert.deepEqual(readdirSync(f.directory), files);
    } finally {
      f.cleanup();
    }
  });
}

test("SDK completed export survives a throwing late notification", async () => {
  const f = await fixture();
  try {
    const sourceFile = f.source.getSessionFile();
    assert.ok(sourceFile);
    const before = hash(sourceFile);
    const files = new Set(readdirSync(f.directory));
    vi.spyOn(f.ui, "notify").mockImplementation(() => {
      throw new Error("Synthetic UI failure");
    });
    await f.session.prompt("/codex-compact");
    const outputs = readdirSync(f.directory).filter((file) => !files.has(file) && file.endsWith(".jsonl"));
    assert.equal(outputs.length, 1);
    assert.ok(SessionManager.open(join(f.directory, outputs[0])).getSessionId());
    assert.equal(hash(sourceFile), before);
  } finally {
    f.cleanup();
  }
});

test("SDK explicit rescue never retries even a retryable HTTP failure", async () => {
  const f = await fixture();
  try {
    const requests = f.requests.length;
    const files = readdirSync(f.directory);
    f.hold(async () => new Response("synthetic offline failure", { status: 500 }));
    await f.session.prompt("/codex-compact");
    assert.equal(f.requests.length, requests + 1);
    assert.deepEqual(f.streamOptions.at(-1), { maxRetries: 0, transport: "sse" });
    assert.deepEqual(readdirSync(f.directory), files);
    assert.match(JSON.stringify(f.notifications), /remote_http_error; HTTP 500/);
  } finally {
    f.cleanup();
  }
});

test("SDK auth-time branch divergence discards continuation before transport", async () => {
  const f = await fixture();
  try {
    const requests = f.requests.length;
    const files = readdirSync(f.directory);
    f.authHook(async () => {
      f.source.appendCustomEntry("changed-during-auth", {});
    });
    await f.session.prompt("/codex-compact");
    assert.equal(f.requests.length, requests);
    assert.deepEqual(readdirSync(f.directory), files);
  } finally {
    f.cleanup();
  }
});

for (const phase of ["auth", "body"] as const) {
  test(`SDK recovery Escape during ${phase} cancels owned work without export or stale notification`, async () => {
    const f = await fixture();
    try {
      const sourceFile = f.source.getSessionFile();
      assert.ok(sourceFile);
      const sourceHash = hash(sourceFile);
      const requests = f.requests.length;
      const files = readdirSync(f.directory);
      const notifications = f.notifications.length;
      const started = Promise.withResolvers<void>();
      const late = Promise.withResolvers<void>();
      if (phase === "auth")
        f.authHook(async () => {
          started.resolve();
          await late.promise;
        });
      else {
        f.onFetch(() => started.resolve());
        f.hold(
          async (signal) =>
            new Response(
              new ReadableStream({
                start(controller) {
                  signal?.addEventListener(
                    "abort",
                    () => controller.error(new DOMException("Synthetic cancellation", "AbortError")),
                    { once: true },
                  );
                },
              }),
              { headers: { "content-type": "text/event-stream" } },
            ),
        );
      }
      const command = f.session.prompt("/codex-compact");
      await started.promise;
      f.cancelProgress();
      await command;
      late.resolve();
      assert.equal(f.requests.length, requests + (phase === "body" ? 1 : 0));
      assert.deepEqual(readdirSync(f.directory), files);
      assert.equal(hash(sourceFile), sourceHash);
      assert.equal(f.notifications.length, notifications);
    } finally {
      f.cleanup();
    }
  });
}

test("SDK overlapping recovery commands share one cancellable idle owner", async () => {
  const f = await fixture();
  try {
    const files = readdirSync(f.directory);
    const started = Promise.withResolvers<void>();
    f.onFetch(() => started.resolve());
    f.hold(
      async (signal) =>
        new Response(
          new ReadableStream({
            start(controller) {
              signal?.addEventListener(
                "abort",
                () => controller.error(new DOMException("Synthetic cancellation", "AbortError")),
                { once: true },
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const first = f.session.prompt("/codex-compact");
    await started.promise;
    const requests = f.requests.length;
    const auth = f.authCount();
    const confirmations = f.confirmations();
    await f.session.prompt("/codex-compact");
    assert.equal(f.requests.length, requests);
    assert.equal(f.authCount(), auth);
    assert.equal(f.confirmations(), confirmations);
    assert.match(JSON.stringify(f.notifications), /other recovery export/);
    f.cancelProgress();
    await first;
    assert.deepEqual(readdirSync(f.directory), files);
  } finally {
    f.cleanup();
  }
});

test("SDK response-time lineage drift cannot export accepted opaque result", async () => {
  const f = await fixture();
  try {
    const requests = f.requests.length;
    const files = readdirSync(f.directory);
    f.onFetch(() => f.source.appendCustomEntry("changed-during-response", {}));
    await f.session.prompt("/codex-compact");
    assert.equal(f.requests.length, requests + 1, JSON.stringify(f.notifications));
    assert.deepEqual(readdirSync(f.directory), files);
  } finally {
    f.cleanup();
  }
});
