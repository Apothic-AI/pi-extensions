import assert from "node:assert/strict";
import { inspect } from "node:util";
import {
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type OpenAICodexResponsesOptions,
  type Provider,
  Type,
} from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { test, vi } from "vitest";
import { type CompactionFailureCode, failureFrom, formatCompactionFailure } from "../src/failure.js";
import { MAX_SSE_BYTES } from "../src/protocol.js";
import { contextForProvider, requestRemoteCompaction } from "../src/remote.js";

const model = {
  id: "gpt-5.6",
  name: "GPT-5.6",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://example.test",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 10_000,
} as Model<"openai-codex-responses">;

const usage = {
  input: 10,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 12,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function fakeProvider(
  observe: (payload: unknown, options: OpenAICodexResponsesOptions, context: Parameters<Provider["stream"]>[1]) => void,
  inputText = "current",
  consumeResponse = true,
): Provider {
  return {
    id: "openai-codex",
    name: "OpenAI Codex",
    auth: {} as Provider["auth"],
    getModels: () => [model],
    stream(_model, context, options) {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        try {
          const payload = await options?.onPayload?.(
            {
              model: model.id,
              input: [{ role: "user", content: [{ type: "input_text", text: inputText }] }],
            },
            model,
          );
          observe(payload, options as OpenAICodexResponsesOptions, context);
          const response = await options?.fetch?.("https://example.test/codex/responses", {
            method: "POST",
          });
          if (response && !response.ok) throw new Error(await response.text());
          if (consumeResponse) await response?.text();
          const message = {
            role: "assistant" as const,
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage,
            stopReason: "stop" as const,
            timestamp: Date.now(),
          };
          stream.push({ type: "start", partial: message });
          stream.push({ type: "done", reason: "stop", message });
          stream.end();
        } catch (error) {
          const message = {
            role: "assistant" as const,
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage,
            stopReason: "error" as const,
            errorMessage: error instanceof Error ? error.message : String(error),
            timestamp: Date.now(),
          };
          stream.push({ type: "error", reason: "error", error: message });
          stream.end(message);
        }
      })();
      return stream;
    },
    streamSimple() {
      throw new Error("not used");
    },
  };
}

function responseSse(content = "opaque") {
  const item = { type: "compaction", encrypted_content: content };
  const body = [
    `data: ${JSON.stringify({ type: "response.output_item.done", item })}\n\n`,
    `data: ${JSON.stringify({ type: "response.completed", response: { output: [item] } })}\n\n`,
  ].join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("uses the public provider stream with SSE, bounded retry options, and a final trigger", async () => {
  let sent: unknown;
  const provider = fakeProvider((payload, options) => {
    sent = payload;
    assert.equal(options.transport, "sse");
    assert.equal(options.cacheRetention, "none");
    assert.equal(options.timeoutMs, 300_000);
    assert.equal(options.maxRetries, 2);
  });
  const result = await requestRemoteCompaction({
    provider,
    model,
    context: { messages: [] } satisfies Context,
    apiKey: "oauth-token",
    signal: new AbortController().signal,
    fetch: async () => responseSse(),
  });
  assert.deepEqual((sent as { input: unknown[] }).input.at(-1), { type: "compaction_trigger" });
  assert.equal(result.item.encrypted_content, "opaque");
  assert.deepEqual(result.usage, usage);
  assert.equal(result.promptInput.length, 1);
});

test("a rejected or throwing wire validator stops transport and keeps public errors credential-safe", async () => {
  for (const validatePayload of [
    () => false,
    () => {
      throw new Error(credentialEcho);
    },
  ]) {
    let fetches = 0;
    await assert.rejects(
      requestRemoteCompaction({
        provider: fakeProvider(() => assert.fail("rejected payload must not leave onPayload")),
        model,
        context: { messages: [] },
        signal: new AbortController().signal,
        validatePayload,
        fetch: async () => {
          fetches += 1;
          return responseSse();
        },
      }),
      (error) => assertSafeError(error, false, "loadout_mismatch"),
    );
    assert.equal(fetches, 0);
  }
});

test("normalizes system prompt and tools before calling a Pi 0.87 provider", async () => {
  const tools = [{ name: "inspect", description: "Inspect a path", parameters: Type.Object({ path: Type.String() }) }];
  const user = { role: "user" as const, content: "inspect this", timestamp: 1 };
  let providerContext: Parameters<Provider["stream"]>[1] | undefined;
  await requestRemoteCompaction({
    provider: fakeProvider((_payload, _options, context) => {
      providerContext = context;
    }),
    model,
    context: { systemPrompt: "You inspect files.", tools, messages: [user] },
    signal: new AbortController().signal,
    fetch: async () => responseSse(),
  });
  assert.ok(providerContext);
  assert.deepEqual(providerContext.messages, [
    { role: "system", content: "You inspect files.", toolsAdded: tools, timestamp: 0 },
    user,
  ]);
  assert.equal("systemPrompt" in providerContext, false);
  assert.equal("tools" in providerContext, false);
});

test("passes the original context unchanged to older providers without a normalizer", () => {
  const context = {
    systemPrompt: "legacy prompt",
    tools: [{ name: "inspect", description: "Inspect a path", parameters: Type.Object({}) }],
    messages: [{ role: "user" as const, content: "legacy", timestamp: 1 }],
  } satisfies Context;
  assert.strictEqual(contextForProvider(context, undefined), context);
});

test("expands a previous checkpoint before requesting repeated compaction", async () => {
  const marker = "checkpoint marker";
  let sentInput: unknown[] = [];
  const provider = fakeProvider((payload) => {
    sentInput = (payload as { input: unknown[] }).input;
  }, marker);
  await requestRemoteCompaction({
    provider,
    model,
    context: { messages: [] },
    apiKey: "oauth-token",
    signal: new AbortController().signal,
    priorCheckpoint: {
      marker,
      replacementHistory: [{ type: "compaction", encrypted_content: "prior" }],
    },
    fetch: async () => responseSse("new"),
  });
  assert.equal(sentInput[0] && (sentInput[0] as { encrypted_content?: string }).encrypted_content, "prior");
  assert.deepEqual(sentInput.at(-1), { type: "compaction_trigger" });
});

test("propagates abort and malformed remote output", async () => {
  const provider = fakeProvider(() => undefined);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    requestRemoteCompaction({
      provider,
      model,
      context: { messages: [] },
      apiKey: "oauth-token",
      signal: controller.signal,
      fetch: async () => responseSse(),
    }),
    /aborted/i,
  );
  await assert.rejects(
    requestRemoteCompaction({
      provider,
      model,
      context: { messages: [] },
      apiKey: "oauth-token",
      signal: new AbortController().signal,
      fetch: async () => new Response('data: {"type":"response.completed","response":{"output":[]}}\n\n'),
    }),
    /OpenAI Codex compaction request failed/,
  );
});

for (const status of [401, 403, 429, 500, 503]) {
  test(`real Codex reports only validated HTTP ${status}, not response metadata or provider text`, async () => {
    await assert.rejects(
      realRequest(
        new AbortController().signal,
        async () => {
          const response = new Response(credentialEcho, {
            status,
            statusText: credentialEcho,
            headers: { "X-Secret": credentialEcho, "content-type": "text/event-stream" },
          });
          Object.defineProperty(response, "url", { value: `https://secret-api-key:secret-env-token@example.test/` });
          return response;
        },
        1000,
      ),
      (error) => {
        assertSafeError(error, false, "remote_http_error");
        assert.equal(failureFrom(error, "local_compaction_failed").httpStatus, status);
        return true;
      },
    );
  });
}

for (const body of [
  "invalid SSE",
  'data: {"type":"response.completed","response":{"output":[]}}\n\n',
  'data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":""}}\n\n',
]) {
  test(`successful HTTP with malformed/unsupported SSE is not an HTTP failure: ${body.slice(0, 25)}`, async () => {
    await assert.rejects(
      realRequest(new AbortController().signal, async () => new Response(body), 1000),
      (error) => {
        assertSafeError(error, false, "remote_response_invalid");
        assert.equal(failureFrom(error, "local_compaction_failed").httpStatus, undefined);
        return true;
      },
    );
  });
}

test("a successful response without an SSE body is unsupported, even if the provider emits an error", async () => {
  await assert.rejects(
    realRequest(new AbortController().signal, async () => new Response(null, { status: 204 }), 1000),
    (error) => assertSafeError(error, false, "remote_response_invalid"),
  );
});

test("a provider-swallowed local payload rejection survives as a safe local reason without transport", async () => {
  let requests = 0;
  await assert.rejects(
    requestRemoteCompaction({
      provider: fakeProvider(() => assert.fail("rejected payload cannot escape onPayload")),
      model,
      context: { messages: [] },
      signal: new AbortController().signal,
      priorCheckpoint: { marker: credentialEcho, replacementHistory: [] },
      fetch: async () => {
        requests++;
        return responseSse();
      },
    }),
    (error) => assertSafeError(error, false, "payload_rejected"),
  );
  assert.equal(requests, 0);
});

test("a final successful retry with malformed SSE does not reuse an earlier HTTP failure status", async () => {
  let attempts = 0;
  const original = fakeProvider(() => undefined);
  const provider: Provider = {
    ...original,
    stream(requestModel, context, options) {
      return original.stream(requestModel, context, {
        ...options,
        fetch: async (input, init) => {
          const first = await options?.fetch?.(input, init);
          await first?.text();
          const second = await options?.fetch?.(input, init);
          assert.ok(second);
          return second;
        },
      });
    },
  };
  await assert.rejects(
    requestRemoteCompaction({
      provider,
      model,
      context: { messages: [] },
      signal: new AbortController().signal,
      fetch: async () =>
        ++attempts === 1 ? new Response(credentialEcho, { status: 429 }) : new Response("invalid SSE"),
    }),
    (error) => {
      assertSafeError(error, false, "remote_response_invalid");
      assert.equal(failureFrom(error, "local_compaction_failed").httpStatus, undefined);
      return true;
    },
  );
  assert.equal(attempts, 2, "only the fixture provider initiates its existing retry");
});

test("retired ownership remains cancellation rather than a provider error", async () => {
  let current = true;
  await assert.rejects(
    requestRemoteCompaction({
      provider: fakeProvider(() => {
        current = false;
      }),
      model,
      context: { messages: [] },
      signal: new AbortController().signal,
      isCurrent: () => current,
      fetch: async () => assert.fail("a retired operation cannot dispatch"),
    }),
    (error) => assertSafeError(error, true),
  );
});

for (const stage of [
  "initial",
  "onPayload",
  "fetch",
  "inner catch",
  "outer catch",
  "getter",
  "later getter",
] as const) {
  test(`hostile ownership callback at ${stage} cannot escape the public privacy boundary`, async () => {
    let calls = 0;
    let reads = 0;
    const raw = Object.defineProperties(new Error(credentialEcho), {
      message: {
        get: () => {
          reads++;
          return credentialEcho;
        },
      },
      cause: {
        get: () => {
          reads++;
          return credentials;
        },
      },
    });
    const threshold = stage === "initial" ? 1 : stage === "onPayload" ? 2 : 3;
    const isCurrent = () => {
      calls++;
      if (calls >= threshold) throw raw;
      return true;
    };
    const original = fakeProvider(() => {
      if (stage === "inner catch") throw new Error(credentialEcho);
    });
    const provider =
      stage === "outer catch"
        ? {
            ...original,
            stream() {
              throw new Error(credentialEcho);
            },
          }
        : original;
    const request = {
      provider,
      model,
      context: { messages: [] },
      signal: new AbortController().signal,
      isCurrent,
      requestTimeoutMs: 250,
      fetch: async () => responseSse(),
    };
    if (stage === "getter" || stage === "later getter") {
      let getterCalls = 0;
      Object.defineProperty(request, "isCurrent", {
        get: () => {
          getterCalls++;
          if (stage === "getter" || getterCalls === 2) throw raw;
          return isCurrent;
        },
      });
    }
    await assert.rejects(requestRemoteCompaction(request), (error) => assertSafeError(error, true));
    assert.equal(reads, 0, "ownership faults must not inspect error messages or causes");
  });
}

for (const invalid of ["empty finalized item", "byte cap", "deep unsupported item"] as const) {
  test(`fatal SSE inspection (${invalid}) cancels an open source before the owned deadline`, async () => {
    let cancellations = 0;
    await assert.rejects(
      realRequest(
        new AbortController().signal,
        async () =>
          new Response(
            new ReadableStream({
              start(source) {
                source.enqueue(
                  invalid === "byte cap"
                    ? new Uint8Array(MAX_SSE_BYTES + 1)
                    : new TextEncoder().encode(
                        invalid === "deep unsupported item"
                          ? `data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"opaque","extra":${"[".repeat(20_000)}0${"]".repeat(20_000)}}}\n\n`
                          : 'data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":""}}\n\n',
                      ),
                );
              },
              cancel() {
                cancellations++;
              },
            }),
          ),
        250,
      ),
      (error) => assertSafeError(error, false, "remote_response_invalid"),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(cancellations, 1);
  }, 2000);
}

for (const type of ["error", "response.failed"] as const) {
  test(`terminal provider SSE ${type} cancels an open successful HTTP source promptly`, async () => {
    let cancellations = 0;
    await assert.rejects(
      realRequest(
        new AbortController().signal,
        async () =>
          new Response(
            new ReadableStream({
              start(source) {
                source.enqueue(
                  new TextEncoder().encode(
                    `data: ${JSON.stringify({ type, message: credentialEcho, response: { error: { message: credentialEcho } } })}\n\n`,
                  ),
                );
              },
              cancel() {
                cancellations++;
              },
            }),
          ),
        250,
      ),
      (error) => assertSafeError(error, false, "remote_provider_error"),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(cancellations, 1);
  }, 2000);
}

for (const outcome of ["provider error", "stalled iterator close", "caller abort", "retired owner"] as const) {
  test(`terminal provider error with an unfinished HTTP 200 inspection: ${outcome}`, async () => {
    const caller = new AbortController();
    const cancelled = Promise.withResolvers<void>();
    const closing = Promise.withResolvers<void>();
    const setTimer = vi.spyOn(globalThis, "setTimeout");
    const clearTimer = vi.spyOn(globalThis, "clearTimeout");
    let current = true;
    let cancellations = 0;
    let fetchSignal: AbortSignal | undefined;
    const original = fakeProvider(() => undefined);
    const provider: Provider = {
      ...original,
      stream(requestModel, context, options) {
        const stream = original.stream(requestModel, context, {
          ...options,
          fetch: async (input, init) => {
            const response = await options?.fetch?.(input, init);
            // A provider can cancel only its own tee branch and fail without
            // any terminal SSE frame or EOF reaching the inspector.
            void response?.body?.cancel().catch(() => undefined);
            throw new Error(credentialEcho, { cause: credentials });
          },
        });
        if (outcome === "stalled iterator close") {
          const iterator = stream[Symbol.asyncIterator]();
          stream[Symbol.asyncIterator] = () => ({
            next: () => iterator.next(),
            return: async () => {
              closing.resolve();
              return new Promise(() => {});
            },
          });
        }
        return stream;
      },
    };
    try {
      await assert.rejects(
        requestRemoteCompaction({
          provider,
          model,
          context: { messages: [] },
          ...credentials,
          signal: caller.signal,
          isCurrent: () => current,
          requestTimeoutMs: 300_000,
          fetch: async (_input, init) => {
            fetchSignal = init?.signal ?? undefined;
            fetchSignal?.addEventListener(
              "abort",
              () => {
                if (outcome === "caller abort") caller.abort(new Error(credentialEcho));
                if (outcome === "retired owner") current = false;
              },
              { once: true },
            );
            return new Response(
              new ReadableStream({
                start(source) {
                  source.enqueue(new TextEncoder().encode(": keepalive\n\n"));
                },
                cancel() {
                  cancellations++;
                  cancelled.resolve();
                },
              }),
              { status: 200 },
            );
          },
        }),
        (error) =>
          assertSafeError(error, outcome === "caller abort" || outcome === "retired owner", "remote_provider_error"),
      );
      await cancelled.promise;
      if (outcome === "stalled iterator close") await closing.promise;
      assert.equal(cancellations, 1, "owned abort cancels the source and both tee consumers");
      assert.equal(fetchSignal?.aborted, true);
      const deadline = setTimer.mock.calls.findIndex(([, delay]) => delay === 300_000);
      assert.ok(deadline >= 0);
      assert.ok(clearTimer.mock.calls.some(([timer]) => timer === setTimer.mock.results[deadline]?.value));
    } finally {
      caller.abort();
      setTimer.mockRestore();
      clearTimer.mockRestore();
    }
  }, 2000);
}

test("external cancellation still wins over an inspection-triggered internal abort", async () => {
  const caller = new AbortController();
  let cancellations = 0;
  await assert.rejects(
    realRequest(
      caller.signal,
      async () =>
        new Response(
          new ReadableStream({
            start(source) {
              source.enqueue(
                new TextEncoder().encode(
                  'data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":""}}\n\n',
                ),
              );
            },
            cancel() {
              cancellations++;
              caller.abort(new Error(credentialEcho, { cause: credentials }));
            },
          }),
        ),
      1000,
    ),
    (error) => assertSafeError(error, true),
  );
  assert.equal(cancellations, 1);
});

for (const outcome of ["AbortError", "successful retry", "exhausted retries"] as const) {
  test(`real Codex preserves existing retry decisions: ${outcome}`, async () => {
    let attempts = 0;
    const pending = realRequest(
      new AbortController().signal,
      async () => {
        attempts++;
        if (outcome === "AbortError") throw new DOMException(credentialEcho, "AbortError");
        if (outcome === "successful retry" && attempts > 1) return responseSse();
        return new Response(credentialEcho, { status: 503 });
      },
      10_000,
      2,
    );
    if (outcome === "successful retry") {
      assert.equal((await pending).item.encrypted_content, "opaque");
    } else {
      await assert.rejects(pending, (error) =>
        assertSafeError(error, false, outcome === "AbortError" ? "remote_transport_error" : "remote_http_error"),
      );
    }
    assert.equal(attempts, outcome === "AbortError" ? 1 : outcome === "successful retry" ? 2 : 3);
  }, 12_000);
}

const codexApiKey = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } })).toString("base64")}.x`;

function realRequest(signal: AbortSignal, fetch: typeof globalThis.fetch, requestTimeoutMs = 50, maxRetries = 0) {
  return requestRemoteCompaction({
    provider: openaiCodexProvider(),
    model,
    context: { messages: [{ role: "user", content: "Task", timestamp: 1 }] },
    apiKey: codexApiKey,
    signal,
    fetch,
    requestTimeoutMs,
    maxRetries,
  });
}

test("real Codex and inspector finish at response.completed without EOF and cancel the source", async () => {
  const controller = new AbortController();
  let cancellations = 0;
  let resolveCancelled!: () => void;
  const cancelled = new Promise<void>((resolve) => {
    resolveCancelled = resolve;
  });
  const item = { type: "compaction", encrypted_content: "opaque" };
  const result = await realRequest(
    controller.signal,
    async () =>
      new Response(
        new ReadableStream({
          start(source) {
            source.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ type: "response.output_item.done", item })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [item] } })}\n\n`,
              ),
            );
            // The server never closes; both tee consumers must initiate cancellation.
          },
          cancel() {
            cancellations += 1;
            resolveCancelled();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
    1000,
  );
  assert.deepEqual(result.item, item);
  await cancelled;
  assert.equal(cancellations, 1);
  assert.equal(controller.signal.aborted, false);
}, 2000);

test("the extension deadline also bounds an injected fetch that ignores abort entirely", async () => {
  let fetchSignal: AbortSignal | undefined;
  const started = Date.now();
  await assert.rejects(
    realRequest(new AbortController().signal, async (_input, init) => {
      fetchSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    }),
    (error) => assertSafeError(error, false, "remote_timeout"),
  );
  assert.ok(Date.now() - started < 1000);
  assert.equal(fetchSignal?.aborted, true);
}, 2000);

for (const status of [200, 400]) {
  test(`the extension deadline cancels a stalled real Codex HTTP ${status} body`, async () => {
    let cancellations = 0;
    let fetchSignal: AbortSignal | undefined;
    const started = Date.now();
    await assert.rejects(
      realRequest(new AbortController().signal, async (_input, init) => {
        fetchSignal = init?.signal ?? undefined;
        return new Response(
          new ReadableStream({
            cancel() {
              cancellations += 1;
            },
          }),
          { status },
        );
      }),
      (error) => assertSafeError(error, false, "remote_timeout"),
    );
    assert.ok(Date.now() - started < 1000);
    assert.equal(fetchSignal?.aborted, true);
    // pipeTo settles cancellation independently of the public deadline race.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(cancellations, 1);
  }, 2000);
}

test("external abort cancels an injected stalled body and clears deadline/listener ownership", async () => {
  const controller = new AbortController();
  const addListener = vi.spyOn(controller.signal, "addEventListener");
  const removeListener = vi.spyOn(controller.signal, "removeEventListener");
  const setTimer = vi.spyOn(globalThis, "setTimeout");
  const clearTimer = vi.spyOn(globalThis, "clearTimeout");
  let cancellations = 0;
  let resolveFetched!: () => void;
  const fetched = new Promise<void>((resolve) => {
    resolveFetched = resolve;
  });
  try {
    const pending = realRequest(
      controller.signal,
      async () => {
        resolveFetched();
        return new Response(
          new ReadableStream({
            cancel() {
              cancellations += 1;
            },
          }),
        );
      },
      1000,
    );
    const deadline = setTimer.mock.results[0]?.value;
    await fetched;
    controller.abort(new Error(credentialEcho));
    await assert.rejects(pending, (error) => assertSafeError(error, true));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(cancellations, 1);
    assert.ok(clearTimer.mock.calls.some(([timer]) => timer === deadline));
    const abortListener = addListener.mock.calls.find(([type]) => type === "abort")?.[1];
    assert.ok(abortListener);
    assert.ok(removeListener.mock.calls.some(([type, listener]) => type === "abort" && listener === abortListener));
  } finally {
    addListener.mockRestore();
    removeListener.mockRestore();
    setTimer.mockRestore();
    clearTimer.mockRestore();
  }
}, 2000);

const credentials = {
  apiKey: "secret-api-key",
  headers: { Authorization: "Bearer secret-header-token", "X-Provider-Token": "secret-provider-token" },
  env: { CODEX_SECRET: "secret-env-token" },
};
const secrets = [credentials.apiKey, ...Object.values(credentials.headers), ...Object.values(credentials.env)];
const credentialEcho = JSON.stringify(credentials);

function assertSafeError(error: unknown, aborted = false, expectedCode?: CompactionFailureCode): boolean {
  assert.ok(error instanceof Error);
  assert.equal(error.name, aborted ? "AbortError" : "Error");
  const failure = failureFrom(error, "local_compaction_failed");
  if (!aborted) {
    assert.notEqual(failure.code, "local_compaction_failed", "only locally issued diagnostics may cross the boundary");
    if (expectedCode) assert.equal(failure.code, expectedCode);
  }
  assert.equal(
    error.message,
    aborted ? "Compaction aborted" : `OpenAI Codex compaction request failed ${formatCompactionFailure(failure)}`,
  );
  assert.equal("cause" in error, false);
  const serialized = [
    String(error),
    error.stack,
    JSON.stringify(error, Object.getOwnPropertyNames(error)),
    inspect(error),
  ].join("\n");
  for (const secret of secrets) assert.equal(serialized.includes(secret), false);
  return true;
}

for (const failure of [
  "HTTP error event",
  "synchronous provider throw",
  "fetch rejection",
  "iterator rejection",
  "malformed SSE",
  "SSE error",
  "inspection rejection",
] as const) {
  test(`hides credential echoes from ${failure}`, async () => {
    let provider = fakeProvider(() => undefined, "current", failure !== "inspection rejection");
    let fetch: typeof globalThis.fetch = async () => responseSse();
    const rawError = () => new Error(credentialEcho, { cause: credentials });
    switch (failure) {
      case "HTTP error event":
        fetch = async () => new Response(credentialEcho, { status: 400 });
        break;
      case "synchronous provider throw":
        provider = {
          ...provider,
          stream() {
            throw rawError();
          },
        };
        break;
      case "fetch rejection":
        fetch = async () => {
          throw rawError();
        };
        break;
      case "iterator rejection":
        provider = {
          ...provider,
          stream() {
            const stream = createAssistantMessageEventStream();
            stream[Symbol.asyncIterator] = () => ({
              async next() {
                throw rawError();
              },
            });
            return stream;
          },
        };
        break;
      case "malformed SSE":
        fetch = async () => new Response(`data: ${credentialEcho} invalid-json\n\n`);
        break;
      case "SSE error":
        fetch = async () => new Response(`data: ${JSON.stringify({ type: "error", message: credentialEcho })}\n\n`);
        break;
      case "inspection rejection":
        fetch = async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(rawError());
              },
            }),
          );
        break;
    }
    await assert.rejects(
      requestRemoteCompaction({
        provider,
        model,
        context: { messages: [] },
        ...credentials,
        signal: new AbortController().signal,
        fetch,
      }),
      (error) => {
        const expected = {
          "HTTP error event": "remote_http_error",
          "synchronous provider throw": "remote_provider_error",
          "fetch rejection": "remote_transport_error",
          "iterator rejection": "remote_provider_error",
          "malformed SSE": "remote_response_invalid",
          "SSE error": "remote_provider_error",
          "inspection rejection": "remote_transport_error",
        } as const;
        assertSafeError(error, false, expected[failure]);
        assert.equal(
          failureFrom(error, "local_compaction_failed").httpStatus,
          failure === "HTTP error event" ? 400 : undefined,
        );
        return true;
      },
    );
  });
}

for (const failure of ["provider", "fetch", "inspection"] as const) {
  test(`preserves cancellation without leaking ${failure} errors or abort reasons`, async () => {
    const controller = new AbortController();
    const fail = () => {
      controller.abort(new Error(credentialEcho));
      throw new Error(credentialEcho, { cause: credentials });
    };
    const provider =
      failure === "provider"
        ? { ...fakeProvider(() => undefined), stream: fail }
        : fakeProvider(() => undefined, "current", failure !== "inspection");
    await assert.rejects(
      requestRemoteCompaction({
        provider,
        model,
        context: { messages: [] },
        ...credentials,
        signal: controller.signal,
        fetch:
          failure === "inspection" ? async () => new Response(new ReadableStream({ pull: fail })) : async () => fail(),
      }),
      (error) => assertSafeError(error, true),
    );
  });
}
