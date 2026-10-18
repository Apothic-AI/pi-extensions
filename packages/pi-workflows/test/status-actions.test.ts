import { describe, expect, it, vi } from "vitest";
import {
  STATUS_OPEN,
  STATUS_QUERY,
  StatusActions,
  type StatusSurface,
  workflowStatusSummary,
} from "../src/status-actions.js";

class Bus {
  readonly handlers = new Map<string, Set<(raw: unknown) => void>>();
  on(channel: string, handler: (raw: unknown) => void) {
    const listeners = this.handlers.get(channel) ?? new Set();
    this.handlers.set(channel, listeners);
    listeners.add(handler);
    return () => {
      listeners.delete(handler);
    };
  }
  emit(channel: string, raw: unknown) {
    for (const handler of [...(this.handlers.get(channel) ?? [])]) handler(raw);
  }
}
const descriptor = { providerId: "pi-workflows", statusKey: "pi-workflows", actionId: "runs", label: "Workflow runs" };
const query = { version: 1, requestId: "q", sessionId: "session" };
const open = {
  version: 1,
  requestId: "o",
  providerId: descriptor.providerId,
  surfaceId: "surface",
  sessionId: "session",
  actionId: descriptor.actionId,
};
function surface(): StatusSurface {
  return { owner: {}, surfaceId: "surface", sessionId: "session", busy: () => false, open: vi.fn(async () => {}) };
}
async function drain() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe("workflow status producer", () => {
  it("advertises exact plain descriptors synchronously and admits before mounting", async () => {
    const bus = new Bus();
    const current = surface();
    const producer = new StatusActions(bus, descriptor, () => current);
    const reply = vi.fn();
    bus.on(`${STATUS_QUERY}:reply:q`, reply);
    bus.emit(STATUS_QUERY, query);
    expect(reply).toHaveBeenCalledExactlyOnceWith({
      success: true,
      data: {
        version: 1,
        providerId: descriptor.providerId,
        surfaceId: "surface",
        sessionId: "session",
        entries: [{ statusKey: descriptor.statusKey, actionId: descriptor.actionId, label: descriptor.label }],
      },
    });
    expect(current.open).not.toHaveBeenCalled();
    const admission = vi.fn();
    bus.on(`${STATUS_OPEN}:reply:o`, admission);
    bus.emit(STATUS_OPEN, open);
    expect(admission).toHaveBeenCalledExactlyOnceWith({ success: true, data: { accepted: true } });
    expect(current.open).not.toHaveBeenCalled();
    await drain();
    expect(current.open).toHaveBeenCalledOnce();
    producer.dispose();
    expect(bus.handlers.get(STATUS_QUERY)?.size).toBe(0);
    expect(bus.handlers.get(STATUS_OPEN)?.size).toBe(0);
  });

  it("coexists with unrelated and duplicate providers without false failure replies", async () => {
    const bus = new Bus();
    const a = surface();
    const b = { ...surface(), surfaceId: "other" };
    const c = { ...surface(), surfaceId: "duplicate" };
    const producers = [
      new StatusActions(bus, descriptor, () => a),
      new StatusActions(
        bus,
        { providerId: "pi-background", statusKey: "pi-background", actionId: "tasks", label: "Background tasks" },
        () => b,
      ),
      new StatusActions(bus, descriptor, () => c),
    ];
    const replies = vi.fn();
    bus.on(`${STATUS_OPEN}:reply:o`, replies);
    for (const change of [{ providerId: "missing" }, { sessionId: "other" }, { surfaceId: "missing" }])
      bus.emit(STATUS_OPEN, { ...open, ...change });
    expect(replies).not.toHaveBeenCalled();
    bus.emit(STATUS_OPEN, open);
    expect(replies).toHaveBeenCalledExactlyOnceWith({ success: true, data: { accepted: true } });
    await drain();
    expect(a.open).toHaveBeenCalledOnce();
    expect(b.open).not.toHaveBeenCalled();
    expect(c.open).not.toHaveBeenCalled();
    for (const producer of producers) producer.dispose();
  });

  it("rejects unknown actions, busy openers, duplicate opens and completed request replay safely", async () => {
    const bus = new Bus();
    const current = surface();
    let close = () => {};
    current.open = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          close = resolve;
        }),
    );
    const producer = new StatusActions(bus, descriptor, () => current);
    const reply = vi.fn();
    bus.on(`${STATUS_OPEN}:reply:o`, reply);
    const failure = { success: false, error: "Status action is unavailable." };
    bus.emit(STATUS_OPEN, { ...open, actionId: "stop" });
    expect(reply).toHaveBeenLastCalledWith(failure);
    current.busy = () => true;
    bus.emit(STATUS_OPEN, open);
    expect(reply).toHaveBeenLastCalledWith(failure);
    current.busy = () => false;
    bus.emit(STATUS_OPEN, open);
    bus.emit(STATUS_OPEN, open);
    expect(reply).toHaveBeenLastCalledWith(failure);
    await drain();
    close();
    await drain();
    bus.emit(STATUS_OPEN, open);
    expect(reply).toHaveBeenLastCalledWith(failure);
    expect(current.open).toHaveBeenCalledOnce();
    producer.dispose();
  });

  it("ignores accessor, inherited, unknown and malformed own data without invoking getters", () => {
    const bus = new Bus();
    const current = surface();
    const source = vi.fn(() => current);
    const producer = new StatusActions(bus, descriptor, source);
    const getter = vi.fn(() => "q");
    for (const [channel, valid] of [
      [STATUS_QUERY, query],
      [STATUS_OPEN, open],
    ] as const) {
      const malformed: unknown[] = [
        null,
        [],
        { ...valid, unknown: true },
        Object.create(valid),
        { ...valid, [Symbol()]: true },
      ];
      for (const key of Object.keys(valid)) {
        malformed.push(Object.defineProperty({ ...valid }, key, { get: getter }));
        for (const value of [undefined, "", "x".repeat(129), 3]) malformed.push({ ...valid, [key]: value });
      }
      for (const raw of malformed) bus.emit(channel, raw);
    }
    expect(getter).not.toHaveBeenCalled();
    expect(source).not.toHaveBeenCalled();
    expect(current.open).not.toHaveBeenCalled();
    producer.dispose();
  });

  it("fences absent sources, shutdown and exact owner/surface/session replacement before mount", async () => {
    for (const scenario of ["absent", "dispose", "surface", "session", "owner", "retired", "throw"] as const) {
      const bus = new Bus();
      const original = surface();
      let current: StatusSurface | undefined = scenario === "absent" ? undefined : original;
      const producer = new StatusActions(bus, descriptor, () => current);
      bus.emit(STATUS_OPEN, open);
      if (scenario === "dispose") producer.dispose();
      if (scenario === "surface") current = { ...surface(), surfaceId: "new" };
      if (scenario === "session") current = { ...surface(), sessionId: "new" };
      if (scenario === "owner") current = surface();
      if (scenario === "retired") current = undefined;
      if (scenario === "throw")
        original.open = vi.fn(async () => {
          throw new Error("private");
        });
      await drain();
      expect(original.open).toHaveBeenCalledTimes(scenario === "throw" ? 1 : 0);
      if (current && current !== original) expect(current.open).not.toHaveBeenCalled();
      producer.dispose();
    }
  });
});

describe("workflow footer authority", () => {
  it.each([
    [[], undefined],
    [["pending", "running", "pausing", "stopping", "completed"], "Workflows · A4 P0"],
    [["paused", "interrupted", "failed"], "Workflows · A0 P2"],
    [["running", "paused"], "Workflows · A1 P1"],
    [["completed", "completed", "failed", "stopped"], "Workflows · C2 F1 S1"],
    [["stopped"], "Workflows · C0 F0 S1"],
  ] as const)("counts %j", (statuses, expected) => {
    expect(workflowStatusSummary(statuses.map((status) => ({ status })))).toBe(expected);
  });
});
