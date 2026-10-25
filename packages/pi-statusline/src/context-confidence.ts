import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

type ModelRoute = Pick<NonNullable<ExtensionContext["model"]>, "provider" | "api" | "id">;
type Assistant = Extract<AgentMessage, { role: "assistant" }>;

function routeKey(model: ModelRoute | undefined): string | undefined {
  return model?.provider && model.api && model.id ? JSON.stringify([model.provider, model.api, model.id]) : undefined;
}

function messageRoute(message: Assistant): string | undefined {
  return routeKey({ provider: message.provider, api: message.api, id: message.model });
}

function messageKey(message: Assistant): string | undefined {
  const identity = message.responseId ?? message.timestamp;
  return identity === undefined ? undefined : JSON.stringify([messageRoute(message), identity]);
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
  private readonly completed = new Set<string>();
  private started = new Set<string>();
  private startedObjects = new WeakSet<object>();
  private completedObjects = new WeakSet<object>();

  rebuild(entries: readonly SessionEntry[], model: ModelRoute | undefined): void {
    // No failure evidence on older hosts/fixtures preserves public API behavior.
    this.unknown = false;
    this.route = routeKey(model);
    this.completed.clear();
    this.completedObjects = new WeakSet();
    this.clearStarted();
    let previousModel: { provider: string; id: string } | undefined;
    for (const entry of entries) {
      if (entry.type === "compaction") this.invalidate();
      if (entry.type === "model_change") {
        if (previousModel && (previousModel.provider !== entry.provider || previousModel.id !== entry.modelId)) {
          this.invalidate();
        }
        previousModel = { provider: entry.provider, id: entry.modelId };
      }
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;
      const message = entry.message;
      if (messageRoute(message)) previousModel = { provider: message.provider, id: message.model };
      this.remember(message);
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
    this.clearStarted();
  }

  start(message: AgentMessage): void {
    if (message.role !== "assistant" || messageRoute(message) !== this.route || !this.route) return;
    const key = messageKey(message);
    if (key) this.started.add(key);
    else this.startedObjects.add(message);
  }

  finish(message: AgentMessage): void {
    if (message.role !== "assistant") return;
    const route = messageRoute(message);
    if (this.route && route && route !== this.route) return;
    const key = messageKey(message);
    const seen = key ? this.completed.has(key) : this.completedObjects.has(message);
    if (seen) return;
    const started = key ? this.started.delete(key) : this.startedObjects.has(message);
    this.startedObjects.delete(message);
    this.remember(message);
    // An unsuccessful completion is sufficient evidence even without a start.
    // Recovery requires a new response admitted by this branch/model owner.
    if (failed(message)) this.invalidate();
    else if (started) this.apply(message);
  }

  private apply(message: Assistant): void {
    if (failed(message)) this.invalidate();
    else if (this.route && messageRoute(message) && messageRoute(message) !== this.route) this.invalidate();
    else if (this.route && messageRoute(message) === this.route && successfulUsage(message)) this.unknown = false;
  }

  private remember(message: Assistant): void {
    const key = messageKey(message);
    if (key) this.completed.add(key);
    else this.completedObjects.add(message);
  }

  private clearStarted(): void {
    this.started.clear();
    this.startedObjects = new WeakSet();
  }
}
