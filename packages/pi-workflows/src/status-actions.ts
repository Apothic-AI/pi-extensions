import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const STATUS_QUERY = "pi-ui:status-actions:v1:query";
export const STATUS_OPEN = "pi-ui:status-actions:v1:open";
const FAILURE = "Status action is unavailable.";

export interface StatusSurface {
  surfaceId: string;
  sessionId: string;
  /** Private identity, never placed on the wire. */
  owner: object;
  busy(): boolean;
  open(): Promise<void>;
}

/** Inspect descriptors, never values on an untrusted object (including getters). */
function request(raw: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  try {
    if (!raw || typeof raw !== "object") return;
    const prototype = Object.getPrototypeOf(raw);
    if (prototype !== Object.prototype && prototype !== null) return;
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    if (Reflect.ownKeys(descriptors).length !== keys.length) return;
    const values: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor)) return;
      const value: unknown = descriptor.value;
      if (key === "version" ? value !== 1 : typeof value !== "string" || value.length < 1 || value.length > 128) return;
      values[key] = value;
    }
    return values;
  } catch {
    return;
  }
}

/** Optional presentation-only endpoint; the source must fail closed on live divergence. */
export class StatusActions {
  private readonly unsubscribe: Array<() => void>;
  private disposed = false;
  private opening = false;
  private readonly admitted = new Set<string>();

  constructor(
    private readonly events: ExtensionAPI["events"],
    private readonly descriptor: { providerId: string; statusKey: string; actionId: string; label: string },
    private readonly source: () => StatusSurface | undefined,
  ) {
    this.unsubscribe = [
      events.on(STATUS_QUERY, (raw: unknown) => this.query(raw)),
      events.on(STATUS_OPEN, (raw: unknown) => this.open(raw)),
    ];
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const unsubscribe of this.unsubscribe) unsubscribe();
    this.admitted.clear();
  }

  private query(raw: unknown): void {
    if (this.disposed) return;
    const parsed = request(raw, ["version", "requestId", "sessionId"]);
    if (!parsed) return;
    const surface = this.source();
    if (!surface || parsed.sessionId !== surface.sessionId || this.disposed) return;
    this.events.emit(`${STATUS_QUERY}:reply:${parsed.requestId}`, {
      success: true,
      data: {
        version: 1,
        providerId: this.descriptor.providerId,
        surfaceId: surface.surfaceId,
        sessionId: surface.sessionId,
        entries: [
          { statusKey: this.descriptor.statusKey, actionId: this.descriptor.actionId, label: this.descriptor.label },
        ],
      },
    });
  }

  private open(raw: unknown): void {
    if (this.disposed) return;
    const parsed = request(raw, ["version", "requestId", "providerId", "surfaceId", "sessionId", "actionId"]);
    if (!parsed || parsed.providerId !== this.descriptor.providerId) return;
    const surface = this.source();
    if (!surface || this.disposed || parsed.sessionId !== surface.sessionId || parsed.surfaceId !== surface.surfaceId)
      return; // Other owners, including duplicate providers, may share this bus.
    const channel = `${STATUS_OPEN}:reply:${parsed.requestId}`;
    const id = String(parsed.requestId);
    if (parsed.actionId !== this.descriptor.actionId || this.opening || surface.busy() || this.admitted.has(id)) {
      this.events.emit(channel, { success: false, error: FAILURE });
      return;
    }
    this.admitted.add(id);
    if (this.admitted.size > 256) this.admitted.delete(this.admitted.values().next().value as string);
    this.opening = true;
    // Admission is synchronous; the selector can relinquish focus before mount.
    this.events.emit(channel, { success: true, data: { accepted: true } });
    void Promise.resolve()
      .then(() => {
        if (this.disposed) return;
        const current = this.source();
        if (
          this.disposed ||
          !current ||
          current.owner !== surface.owner ||
          current.surfaceId !== surface.surfaceId ||
          current.sessionId !== surface.sessionId
        )
          return;
        return surface.open();
      })
      .catch(() => {
        // Admission does not promise successful mount. Never redirect to another owner.
      })
      .finally(() => {
        this.opening = false;
      });
  }
}

/** The host may defer a custom factory after admission; fence that boundary too. */
export function guardStatusMount(ctx: ExtensionContext, guard: () => void): ExtensionContext {
  const custom: ExtensionContext["ui"]["custom"] = (factory, options) =>
    ctx.ui.custom((...args) => {
      guard();
      return factory(...args);
    }, options);
  return { ...ctx, ui: { ...ctx.ui, custom } };
}

/** Count run authority only; child completion cannot establish run completion. */
export function workflowStatusSummary(runs: ReadonlyArray<{ status: string }>): string | undefined {
  if (!runs.length) return undefined;
  const count = (statuses: string[]) => runs.filter((run) => statuses.includes(run.status)).length;
  const active = count(["pending", "running", "pausing", "stopping"]);
  const paused = count(["paused", "interrupted"]);
  return active || paused
    ? `Workflows · A${active} P${paused}`
    : `Workflows · C${count(["completed"])} F${count(["failed"])} S${count(["stopped"])}`;
}
