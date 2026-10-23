import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkflowEngine, WorkflowWaitAbortedError } from "../src/engine.js";
import { JOURNAL_ENTRY_TYPE, type JournalEvent } from "../src/journal.js";
import type { ManagedSpawnClient, WorkflowEventBus } from "../src/rpc-client.js";
import * as runtime from "../src/runtime.js";

const SCRIPT = 'export const meta = {name:"receipt",description:"test"}; return 42;';
const engines: WorkflowEngine[] = [];
const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
function fixture(mock = true, failure = false, rejectFailed = true) {
  if (mock) {
    vi.spyOn(runtime, "runWorkflow").mockImplementation(async () => {
      if (failure) throw new Error("script failed");
      return {
        meta: { name: "receipt", description: "test" },
        result: { answer: 42 },
        logs: [],
        phases: [],
        agentCount: 0,
        durationMs: 0,
      };
    });
    vi.useFakeTimers();
  }
  const bus: WorkflowEventBus = { on: () => () => {}, emit: () => {} };
  const client: ManagedSpawnClient = {
    spawn: vi.fn(async () => ({ id: "unused" })),
    stop: async () => {},
    checkProtocol: async () => ({ routingPolicyFingerprint: "test" }),
  };
  const entries: JournalEvent[] = [];
  const attempts: JournalEvent[] = [];
  let rejectTerminal = true;
  const engine = new WorkflowEngine(bus, client, {
    append(event) {
      if (event.kind === "workflow_transition" && ["completed", "failed"].includes(event.status)) {
        attempts.push(structuredClone(event));
        if (rejectTerminal && (event.status === "completed" || rejectFailed))
          throw new Error("terminal append rejected");
      }
      entries.push(structuredClone(event));
    },
  });
  engines.push(engine);
  const settled = vi.fn();
  engine.onRunSettled = settled;
  return {
    engine,
    entries,
    attempts,
    settled,
    release: () => {
      rejectTerminal = false;
    },
    session: () => entries.map((data) => ({ type: "custom", customType: JOURNAL_ENTRY_TYPE, data })),
  };
}
afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("terminal append receipts", () => {
  it.each([false, true])("withholds every publication until the exact receipt (background=%s)", async (background) => {
    const h = fixture();
    let foregroundDone = false;
    const started = h.engine.start(SCRIPT, { background }).then((value) => {
      foregroundDone = true;
      return value;
    });
    await flush();
    const runId = String(h.engine.list()[0].runId);
    const existing = vi.fn();
    const late = vi.fn();
    const first = h.engine.waitFor(runId).then(existing);
    await flush(); // Includes the immediate retry after the initial rejection.
    const second = h.engine.waitFor(runId).then(late);
    await vi.advanceTimersByTimeAsync(30);
    expect(h.attempts.length).toBeGreaterThanOrEqual(3);
    expect(h.attempts.every((event) => JSON.stringify(event) === JSON.stringify(h.attempts[0]))).toBe(true);
    expect(h.engine.getRun(runId)).toMatchObject({ status: "running" });
    expect(h.engine.getRun(runId)?.finalResult).toBeUndefined();
    expect(h.engine.getState(runId)?.result).toBeUndefined();
    expect(h.engine.getInspection(runId)?.status).toBe("running");
    expect(h.engine.list()[0]).not.toHaveProperty("resultPreview");
    expect(await h.engine.control("get", runId)).toMatchObject({ run: { status: "running" } });
    expect(existing).not.toHaveBeenCalled();
    expect(late).not.toHaveBeenCalled();
    expect(h.settled).not.toHaveBeenCalled();
    expect(foregroundDone).toBe(background);
    expect(h.engine.hasUnsettledWork()).toBe(true);
    h.release();
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all([first, second]);
    const response = await started;
    expect(h.engine.getRun(runId)).toMatchObject({ status: "completed", finalResult: { answer: 42 } });
    if (!background) expect(response).toMatchObject({ status: "completed", result: '{\n  "answer": 42\n}' });
    expect(existing).toHaveBeenCalledTimes(1);
    expect(late).toHaveBeenCalledTimes(1);
    expect((await h.engine.waitFor(runId)).status).toBe("completed");
    expect(h.settled).toHaveBeenCalledTimes(1);
    expect(
      h.entries.filter((event) => event.kind === "workflow_transition" && event.status === "completed"),
    ).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.settled).toHaveBeenCalledTimes(1);
    expect(h.engine.hasUnsettledWork()).toBe(false);
  });

  it("does not turn exhausted terminal persistence into successful completion", async () => {
    const h = fixture();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { runId } = await h.engine.start(SCRIPT, { background: true });
    const resolved = vi.fn();
    const waiting = h.engine.waitFor(runId).then(resolved, (error) => error);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("retry exhausted"));
    expect(h.engine.getRun(runId)?.status).toBe("running");
    expect(h.engine.getRun(runId)?.finalResult).toBeUndefined();
    expect(h.engine.getState(runId)?.pendingTerminal).toBeDefined();
    expect(h.engine.hasUnsettledWork()).toBe(true);
    expect(resolved).not.toHaveBeenCalled();
    expect(h.settled).not.toHaveBeenCalled();
    h.engine.dispose();
    expect(await waiting).toBeInstanceOf(WorkflowWaitAbortedError);
  });

  it("reports a receipted persistence failure when only successful transitions are permanently rejected", async () => {
    const h = fixture(true, false, false);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { runId } = await h.engine.start(SCRIPT, { background: true });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await h.engine.waitFor(runId)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("journal has not settled"),
    });
    expect(h.engine.getState(runId)?.result).toBeUndefined();
    expect(h.engine.getRun(runId)?.finalResult).toBeUndefined();
    expect(h.entries.filter((event) => event.kind === "workflow_transition" && event.status === "failed")).toHaveLength(
      1,
    );
    expect(h.entries.some((event) => event.kind === "workflow_transition" && event.status === "completed")).toBe(false);
    expect(h.settled).toHaveBeenCalledTimes(1);
  });

  it("also withholds a failed terminal state until its receipt", async () => {
    const h = fixture(true, true);
    const { runId } = await h.engine.start(SCRIPT, { background: true });
    await flush();
    expect(h.engine.getRun(runId)?.status).toBe("running");
    h.release();
    await vi.advanceTimersByTimeAsync(30);
    expect(await h.engine.waitFor(runId)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("script failed"),
    });
    expect(h.settled).toHaveBeenCalledTimes(1);
  });

  it.each(
    ["stop", "pause", "restore", "fence", "quiesce"].flatMap((mode) =>
      [false, true].map((failure) => ({ mode, failure })),
    ),
  )("invalidates pending terminal intent (failure=$failure) during $mode", async ({ mode, failure }) => {
    const h = fixture(true, failure);
    const { runId } = await h.engine.start(SCRIPT, { background: true });
    await flush();
    const waiting = h.engine.waitFor(runId).catch((error) => error);
    if (mode === "stop" || mode === "pause") {
      const stopping = h.engine.control(mode, runId);
      await flush();
      await vi.advanceTimersByTimeAsync(30);
      await stopping;
    } else if (mode === "restore") h.engine.restore(h.session());
    else if (mode === "fence") h.engine.fenceCommittedBranch();
    else await h.engine.quiesceForBranchChange();
    h.release();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(
      h.entries.some((event) => event.kind === "workflow_transition" && ["completed", "failed"].includes(event.status)),
    ).toBe(false);
    expect(h.engine.getRun(runId)?.finalResult).toBeUndefined();
    if (mode === "stop") {
      expect(h.engine.getRun(runId)?.status).toBe("stopped");
      expect((await waiting).status).toBe("stopped");
      expect(h.settled).toHaveBeenCalledTimes(1);
    } else if (mode === "pause") {
      expect(h.engine.getRun(runId)?.status).toBe("interrupted");
      expect((await waiting).status).toBe("interrupted");
      expect(h.engine.getState(runId)?.pendingTerminal).toBeUndefined();
      expect(h.engine.hasUnsettledWork()).toBe(false);
      expect(h.settled).not.toHaveBeenCalled();
      expect(await h.engine.resume(runId, h.session(), { background: true })).toBeDefined();
      await flush();
    } else {
      expect(h.settled).not.toHaveBeenCalled();
      h.engine.dispose();
      expect(await waiting).toBeInstanceOf(WorkflowWaitAbortedError);
    }
  });

  it.each([false, true])(
    "foreground abort settles existing and late waiters during rejected terminal receipt (failure=%s)",
    async (failure) => {
      const h = fixture(true, failure);
      const controller = new AbortController();
      const started = h.engine.start(SCRIPT, { signal: controller.signal });
      await flush();
      const runId = String(h.engine.list()[0].runId);
      expect(h.attempts.length).toBeGreaterThanOrEqual(2);
      const observed = vi.fn();
      const existing = h.engine.waitFor(runId).then(observed, (error) => error);
      controller.abort();
      await vi.advanceTimersByTimeAsync(30);
      await flush();
      expect(await started).toMatchObject({ status: "interrupted", waitAborted: true });
      expect(h.engine.getState(runId)?.pendingTerminal).toBeUndefined();
      expect(observed).toHaveBeenCalledTimes(1);
      await existing;
      expect(await h.engine.waitFor(runId)).toMatchObject({ status: "interrupted" });
      expect(h.engine.getState(runId)?.activeExecutionGenerations.size).toBe(0);
      expect(h.engine.getState(runId)?.pendingCleanup.size).toBe(0);
      expect(h.engine.hasUnsettledWork()).toBe(false);
      const attempts = h.attempts.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.attempts).toHaveLength(attempts);
      expect(h.settled).not.toHaveBeenCalled();
      expect(
        h.entries.some(
          (event) => event.kind === "workflow_transition" && ["completed", "failed"].includes(event.status),
        ),
      ).toBe(false);
      expect(h.entries.filter((event) => event.kind === "run_recovery")).toHaveLength(1);
    },
  );

  it("holds a real helper result behind the receipt as well", async () => {
    const h = fixture(false);
    const { runId } = await h.engine.start(SCRIPT, { background: true });
    await expect.poll(() => h.attempts.length).toBeGreaterThan(0);
    expect(h.engine.getRun(runId)?.status).toBe("running");
    expect(h.settled).not.toHaveBeenCalled();
    h.release();
    expect(await h.engine.waitFor(runId)).toMatchObject({ status: "completed", finalResult: 42 });
    expect(h.settled).toHaveBeenCalledTimes(1);
  });
});
