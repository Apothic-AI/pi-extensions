import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

type ModelRoute = Pick<NonNullable<ExtensionContext["model"]>, "provider" | "api" | "id">;
type Assistant = Extract<AgentMessage, { role: "assistant" }>;

export const CONTEXT_CONFIDENCE_ENTRY = "pi-statusline:context-confidence";
export const CONTEXT_CONFIDENCE_UNKNOWN = Object.freeze({ version: 1, state: "unknown" } as const);

function unknownRecord(data: unknown): boolean {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  try {
    const prototype = Object.getPrototypeOf(data);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const fields = Object.getOwnPropertyDescriptors(data);
    return Reflect.ownKeys(fields).length === 2 && fields.version?.value === 1 && fields.state?.value === "unknown";
  } catch {
    return false;
  }
}

function routeKey(model: ModelRoute | undefined): string | undefined {
  return model?.provider && model.api && model.id ? JSON.stringify([model.provider, model.api, model.id]) : undefined;
}

function messageRoute(message: Assistant): string | undefined {
  return routeKey({ provider: message.provider, api: message.api, id: message.model });
}

function failed(message: Assistant): boolean {
  return message.stopReason === "error" || message.stopReason === "aborted";
}

function successfulUsage(message: Assistant): boolean {
  if (!["stop", "length", "toolUse"].includes(message.stopReason)) return false;
  const usage = message.usage;
  if (!usage) return false;
  const counts = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite];
  // This validates provider evidence, not an alternative context estimator.
  return (
    counts.every((count) => Number.isFinite(count) && count >= 0) &&
    counts.some((count) => count > 0) &&
    (usage.totalTokens === undefined || (Number.isFinite(usage.totalTokens) && usage.totalTokens >= 0))
  );
}

/** A display-only confidence latch. It never estimates or corrects Pi's tokens. */
export class ContextConfidence {
  unknown = false;
  private route: string | undefined;
  // One admission per public assistant start, not per timestamp/response ID value.
  // Retiring an owner or invalidating evidence discards its in-flight admission.
  private active: { message: Assistant; timestamp: number; responseId: string | undefined } | undefined;

  rebuild(entries: readonly SessionEntry[], model: ModelRoute | undefined): void {
    // No failure evidence on older hosts/fixtures preserves public API behavior.
    this.unknown = false;
    this.route = routeKey(model);
    this.active = undefined;
    let previousModel: { provider: string; id: string } | undefined;
    for (const entry of entries) {
      if (entry.type === "compaction") this.invalidate();
      if (entry.type === "custom" && entry.customType === CONTEXT_CONFIDENCE_ENTRY && unknownRecord(entry.data)) {
        this.invalidate();
      }
      if (entry.type === "model_change") {
        if (previousModel && (previousModel.provider !== entry.provider || previousModel.id !== entry.modelId)) {
          this.invalidate();
        }
        previousModel = { provider: entry.provider, id: entry.modelId };
      }
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;
      const message = entry.message;
      if (messageRoute(message)) previousModel = { provider: message.provider, id: message.model };
      this.apply(message);
    }
  }

  selectModel(model: ModelRoute | undefined): void {
    const next = routeKey(model);
    if (next === this.route) return;
    this.route = next;
    this.invalidate();
  }

  invalidate(): void {
    this.unknown = true;
    this.active = undefined;
  }

  start(message: AgentMessage): void {
    if (message.role !== "assistant") return;
    this.active = undefined;
    if (!this.route || messageRoute(message) !== this.route) return;
    // Providers emit start before responseId exists; agent-core shallow-copies
    // that partial. Keep the admitted timestamp/object stable as the ID arrives.
    this.active = { message, timestamp: message.timestamp, responseId: message.responseId };
  }

  finish(message: AgentMessage): void {
    if (message.role !== "assistant") return;
    const route = messageRoute(message);
    if (this.route && route && route !== this.route) return;
    // Failure is evidence even without an admission, including colliding IDs.
    if (failed(message)) {
      this.invalidate();
      return;
    }
    const active = this.active;
    if (!active || !this.route || route !== this.route) return;
    if (message !== active.message && (!Number.isFinite(active.timestamp) || message.timestamp !== active.timestamp)) {
      return;
    }
    if (active.responseId && message.responseId && active.responseId !== message.responseId) return;
    this.active = undefined;
    // A duplicate/historical finish cannot recover without a new public start.
    this.apply(message);
  }

  private apply(message: Assistant): void {
    if (failed(message)) this.invalidate();
    else if (this.route && messageRoute(message) && messageRoute(message) !== this.route) this.invalidate();
    else if (this.route && messageRoute(message) === this.route && successfulUsage(message)) this.unknown = false;
  }
}
