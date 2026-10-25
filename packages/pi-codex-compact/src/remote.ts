import type { Context, Model, Provider, ProviderHeaders, Usage } from "@earendil-works/pi-ai";
import * as piAi from "@earendil-works/pi-ai";
import {
  type CompactionFailure,
  compactionAbortError,
  compactionError,
  compactionFailure,
  failureFrom,
} from "./failure.js";
import {
  CodexCompactionProtocolError,
  CodexCompactionProviderError,
  type CollectedCompaction,
  collectCompactionSse,
  type JsonObject,
  prepareRemoteCompactionPayload,
} from "./protocol.js";

interface PriorCheckpointPayload {
  marker: string;
  replacementHistory: readonly unknown[];
}

export interface RemoteCompactionRequest {
  provider: Provider;
  model: Model<"openai-codex-responses">;
  context: Context;
  apiKey?: string;
  headers?: ProviderHeaders;
  env?: Record<string, string>;
  signal: AbortSignal;
  priorCheckpoint?: PriorCheckpointPayload;
  validatePayload?: (payload: unknown) => boolean;
  isCurrent?: () => boolean;
  requestTimeoutMs?: number;
  maxRetries?: number;
  fetch?: typeof globalThis.fetch;
}

export interface RemoteCompactionResponse {
  item: JsonObject;
  promptInput: JsonObject[];
  usage: Usage;
}

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

// Pi 0.87 requires a normalized transcript at the provider boundary; 0.84/0.85
// have no normalizeContext export and still accept the original Context there.
type ProviderContext = Parameters<Provider["stream"]>[1];
type ContextNormalizer = (context: Context) => ProviderContext;
const piAiCompat = piAi as typeof piAi & { normalizeContext?: ContextNormalizer };

export function contextForProvider(context: Context, normalize: ContextNormalizer | undefined): ProviderContext {
  if (!normalize) return context as ProviderContext;
  // The session transcript already carries the current prompt and tool loadout.
  // Adding the legacy shorthand here would replay the prompt twice and could
  // restore tools that a later system message removed.
  const canonical = context.messages.some((message) => message.role === "system")
    ? { messages: context.messages }
    : context;
  return normalize(canonical);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The built-in Codex parser splits frames on LF/LF. Normalize only its tee
// branch, byte-wise (including a CR/LF split across chunks), without decoding
// UTF-8 or changing bare CRs. The inspector must count the original wire bytes.
function providerSseBody(stream: ReadableStream<Uint8Array>, signal: AbortSignal): ReadableStream<Uint8Array> {
  let pendingCr = false;
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const output = new Uint8Array(chunk.byteLength + 1);
        let length = 0;
        for (const byte of chunk) {
          if (pendingCr) {
            if (byte !== 10) output[length++] = 13;
            pendingCr = false;
          }
          if (byte === 13) pendingCr = true;
          else output[length++] = byte;
        }
        if (length > 0) controller.enqueue(output.subarray(0, length));
      },
      flush(controller) {
        if (pendingCr) controller.enqueue(new Uint8Array([13]));
      },
    }),
    { signal },
  );
}

export async function requestRemoteCompaction(request: RemoteCompactionRequest): Promise<RemoteCompactionResponse> {
  const controller = new AbortController();
  const onRequestAbort = () => controller.abort();
  let onOperationAbort = () => {};
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let ownershipLost = false;
  let fatalFailure: CompactionFailure | undefined;
  // Treat even a throwing callback/getter as lost ownership. Latch it so a
  // subsequent callback cannot bless an operation whose ownership was uncertain.
  const isCurrent = () => {
    if (ownershipLost) return false;
    try {
      ownershipLost = request.isCurrent?.() === false;
    } catch {
      ownershipLost = true;
    }
    return !ownershipLost;
  };
  const onFatalFailure = (failure: CompactionFailure) => {
    if (controller.signal.aborted) return;
    fatalFailure = failure;
    controller.abort();
  };
  try {
    if (request.signal.aborted || !isCurrent()) throw compactionAbortError();
    request.signal.addEventListener("abort", onRequestAbort, { once: true });
    const interrupted = new Promise<never>((_resolve, reject) => {
      onOperationAbort = () => reject(compactionAbortError());
      controller.signal.addEventListener("abort", onOperationAbort, { once: true });
    });
    // Provider timeouts can stop at response headers. Own the deadline through
    // body inspection and provider completion, even for an injected transport.
    timeout = setTimeout(
      () => {
        timedOut = true;
        controller.abort();
      },
      request.requestTimeoutMs ?? 5 * 60 * 1000,
    );
    return await Promise.race([
      performRemoteCompaction(request, controller.signal, isCurrent, onFatalFailure),
      interrupted,
    ]);
  } catch (error) {
    // Reconstruct only our closed diagnostic, never a provider error/cause.
    // Caller cancellation and retired ownership take precedence over deadlines.
    if (request.signal.aborted || !isCurrent()) throw compactionAbortError();
    const failure =
      fatalFailure ?? (timedOut ? compactionFailure("remote_timeout") : failureFrom(error, "remote_provider_error"));
    throw compactionError(failure.code, failure.httpStatus);
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener("abort", onRequestAbort);
    controller.signal.removeEventListener("abort", onOperationAbort);
    controller.abort();
  }
}

async function performRemoteCompaction(
  request: RemoteCompactionRequest,
  operationSignal: AbortSignal,
  isCurrent: () => boolean,
  onFatalFailure: (failure: CompactionFailure) => void,
): Promise<RemoteCompactionResponse> {
  if (operationSignal.aborted) throw compactionAbortError();
  let sentInput: JsonObject[] | undefined;
  let localRejection: CompactionFailure | undefined;
  let transportFailure: CompactionFailure | undefined;
  const inspections: Promise<{ ok: true; value: CollectedCompaction } | { ok: false; failure: CompactionFailure }>[] =
    [];
  const baseFetch = request.fetch ?? globalThis.fetch;
  const inspectedFetch: typeof globalThis.fetch = async (input, init) => {
    if (operationSignal.aborted || !isCurrent()) throw compactionAbortError();
    const signal = init?.signal ? AbortSignal.any([operationSignal, init.signal]) : operationSignal;
    let response: Response;
    try {
      response = await baseFetch(input, { ...init, signal });
    } catch (error) {
      transportFailure = compactionFailure("remote_transport_error");
      // Preserve the provider's existing retry decisions (notably AbortError).
      // This exception is internal only; the public boundary reconstructs a
      // fixed diagnostic and never attaches the raw error as a cause.
      throw error;
    }
    // Only numeric Response.status crosses the diagnostic boundary. A later
    // successful retry must not be labelled with a previous attempt's status.
    transportFailure = response.ok ? undefined : compactionFailure("remote_http_error", response.status);
    if (signal.aborted) {
      void response.body?.cancel().catch(() => undefined);
      throw compactionAbortError();
    }
    if (!response.body) {
      if (response.ok) transportFailure = compactionFailure("remote_response_invalid");
      return response;
    }
    // Abort the body independently of fetch: injected fetch implementations
    // need not honor signals, and a native fetch may only time out headers.
    const bridge = new TransformStream<Uint8Array, Uint8Array>();
    void response.body.pipeTo(bridge.writable, { signal }).catch(() => undefined);
    let providerBody = bridge.readable;
    if (response.ok) {
      const [providerBranch, inspectionBody] = providerBody.tee();
      providerBody = providerSseBody(providerBranch, signal);
      const inspection = collectCompactionSse(inspectionBody, { signal: operationSignal }).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => {
          const failure = failureFrom(
            error,
            error instanceof CodexCompactionProviderError
              ? "remote_provider_error"
              : error instanceof CodexCompactionProtocolError
                ? "remote_response_invalid"
                : "remote_transport_error",
          );
          // Fatal inspection must not wait for provider completion/EOF. Abort
          // both tee consumers and retain this reason over the ensuing abort.
          onFatalFailure(failure);
          return { ok: false as const, failure };
        },
      );
      inspections.push(inspection);
    }
    const headers = new Headers(response.headers);
    // Normalization can shorten a successful SSE body. Do not advertise the
    // original length; unsuccessful bodies/metadata retain provider semantics.
    if (response.ok) headers.delete("content-length");
    return new Response(providerBody, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };

  const providerFailure = (error: unknown) => {
    const failure = localRejection ?? transportFailure ?? failureFrom(error, "remote_provider_error");
    // A terminal provider failure cannot wait for an unfinished inspection or
    // iterator return(). Abort both tee consumers/source and retain the known
    // safe reason before the resulting owned abort reaches the public race.
    onFatalFailure(failure);
    return compactionError(failure.code, failure.httpStatus);
  };

  let context: ProviderContext;
  try {
    context = contextForProvider(request.context, piAiCompat.normalizeContext);
  } catch {
    throw compactionError("payload_rejected");
  }
  try {
    const stream = request.provider.stream(request.model, context, {
      apiKey: request.apiKey,
      headers: request.headers,
      env: request.env,
      signal: operationSignal,
      transport: "sse",
      cacheRetention: "none",
      timeoutMs: request.requestTimeoutMs ?? 5 * 60 * 1000,
      maxRetries: request.maxRetries ?? 2,
      fetch: inspectedFetch,
      onPayload: (payload) => {
        if (operationSignal.aborted || !isCurrent()) throw compactionAbortError();
        // Providers may swallow onPayload exceptions and emit arbitrary text in
        // an error event. Capture the local reason before crossing that seam.
        try {
          if (request.validatePayload && !request.validatePayload(payload)) throw compactionError("loadout_mismatch");
        } catch {
          localRejection = compactionFailure("loadout_mismatch");
          throw compactionError(localRejection.code);
        }
        try {
          const prepared = prepareRemoteCompactionPayload(payload, request.priorCheckpoint);
          if (!Array.isArray(prepared.input) || !prepared.input.every(isObject)) {
            throw compactionError("payload_rejected");
          }
          sentInput = structuredClone(prepared.input.slice(0, -1)) as JsonObject[];
          return prepared;
        } catch {
          localRejection = compactionFailure("payload_rejected");
          throw compactionError(localRejection.code);
        }
      },
    });

    let usage = EMPTY_USAGE;
    for await (const event of stream) {
      if (operationSignal.aborted) throw compactionAbortError();
      if (event.type === "error") throw providerFailure(event.error);
      if (event.type === "done") usage = event.message.usage;
    }
    if (operationSignal.aborted) throw compactionAbortError();
    if (localRejection) throw compactionError(localRejection.code);
    if (transportFailure) throw compactionError(transportFailure.code, transportFailure.httpStatus);
    if (!sentInput) throw compactionError("payload_rejected");
    const inspection = await inspections.at(-1);
    if (operationSignal.aborted) throw compactionAbortError();
    if (!inspection) throw compactionError("remote_response_invalid");
    if (!inspection.ok) throw compactionError(inspection.failure.code);
    return { item: inspection.value.item, promptInput: sentInput, usage };
  } catch (error) {
    if (operationSignal.aborted || !isCurrent()) throw compactionAbortError();
    // Inspection failures report through onFatalFailure as soon as observed.
    // Never wait for a still-open HTTP body after the provider has failed.
    throw providerFailure(error);
  }
}
