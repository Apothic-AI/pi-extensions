import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type {
  AgentSession,
  AgentSessionEvent,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createAgentSession } = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
}));
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
  createAgentSession,
}));

import { AgentManager, type ResumeOptions } from "../src/agent-manager.js";
import {
  resumeAgent,
  runAgent,
  setDefaultMaxTokens,
  setDefaultMaxToolCalls,
  setDefaultMaxTurns,
  setGraceTurns,
} from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import { GroupJoinManager } from "../src/group-join.js";
import subagentsExtension from "../src/index.js";
import { createNestedSubagentTools } from "../src/nested-tools.js";
import type { AgentConfig } from "../src/types.js";
import { SPINNER_INTERVAL_MS } from "../src/ui/agent-display.js";
import { FleetList } from "../src/ui/fleet-list.js";
import { mockParentRegistry } from "./helpers/model-runtime.js";

function fakeSession() {
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  const messages: AgentSession["messages"] = [];
  let stopped = false;
  const emit = (event: AgentSessionEvent) => {
    for (const listener of [...listeners]) listener(event);
  };
  const session = {
    messages,
    state: { messages },
    subscribe: (listener: (event: AgentSessionEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    abort: vi.fn(async () => {
      stopped = true;
    }),
    steer: vi.fn(async () => "queued"),
    dispose: vi.fn(),
    setSessionName: vi.fn(),
    bindExtensions: vi.fn(async () => {}),
    getAllTools: () => [],
    getActiveToolNames: () => [],
    prompt: vi.fn(async (prompt: string) => {
      stopped = false;
      for (let turn = 1; turn <= Number(prompt) && !stopped; turn++) {
        const message = fauxAssistantMessage(`answer ${turn}`);
        message.usage.input = 1;
        message.usage.output = 1;
        messages.push(message);
        emit({ type: "message_start", message });
        emit({ type: "message_end", message });
        emit({
          type: "tool_execution_start",
          toolCallId: String(turn),
          toolName: "read",
          args: {},
        });
        emit({
          type: "tool_execution_end",
          toolCallId: String(turn),
          toolName: "read",
          result: {},
          isError: false,
        });
        emit({ type: "turn_end", message, toolResults: [] });
      }
    }),
  } as unknown as AgentSession;
  return { session, emit, listeners };
}
class Bus {
  listeners = new Map<string, Set<(raw: unknown) => void>>();
  on(name: string, handler: (raw: unknown) => void) {
    const handlers = this.listeners.get(name) ?? new Set();
    handlers.add(handler);
    this.listeners.set(name, handlers);
    return () => {
      handlers.delete(handler);
    };
  }
  emit(name: string, raw: unknown) {
    for (const handler of [...(this.listeners.get(name) ?? [])]) handler(raw);
  }
}
function harness(cwd: string) {
  const lifecycle = new Map<
    string,
    (event: unknown, ctx: ExtensionContext) => unknown
  >();
  const tools = new Map<
    string,
    {
      execute: (
        id: string,
        args: Record<string, unknown>,
        signal: AbortSignal | undefined,
        update: ((result: unknown) => void) | undefined,
        ctx: ExtensionContext,
      ) => Promise<unknown>;
    }
  >();
  const pi = {
    on: (
      name: string,
      handler: (event: unknown, ctx: ExtensionContext) => unknown,
    ) => lifecycle.set(name, handler),
    events: new Bus(),
    registerTool: (tool: { name: string }) =>
      tools.set(tool.name, tool as never),
    registerCommand: vi.fn(),
    registerMessageRenderer: vi.fn(),
    sendMessage: vi.fn(),
    appendEntry: vi.fn(),
    exec: vi.fn(async () => ({
      stdout: "",
      stderr: "",
      code: 0,
      killed: false,
    })),
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd,
    mode: "print",
    hasUI: false,
    isProjectTrusted: () => true,
    modelRegistry: mockParentRegistry,
    getSystemPrompt: () => "parent",
    sessionManager: { getSessionId: () => "root", getBranch: () => [] },
    ui: { notify: vi.fn(), setWidget: vi.fn(), setStatus: vi.fn() },
  } as unknown as ExtensionContext;
  subagentsExtension(pi);
  return { pi, ctx, lifecycle, tools };
}
const definition = (
  name = "bounded",
  limits: Partial<AgentConfig> = {},
): AgentConfig => ({
  name,
  description: name,
  systemPrompt: "Do the task",
  extensions: false,
  skills: false,
  isolated: true,
  persistSession: false,
  outputTranscript: false,
  promptMode: "replace",
  ...limits,
});

// Actual runner, manager, registered Agent tools and nested tools; only the SDK
// session/provider seam is fake. Each prompt emits real events beyond the cap.
describe("bounded resume parity", () => {
  let root: string;
  let previousAgentDir: string | undefined;
  let h: ReturnType<typeof harness>;
  let manager: AgentManager;
  let seam: ReturnType<typeof fakeSession>;
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "resume-budget-parity-"));
    mkdirSync(join(root, ".pi", "agents"), { recursive: true });
    mkdirSync(join(root, "agent"));
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(root, "agent");
    writeFileSync(
      join(root, ".pi", "subagents.json"),
      JSON.stringify({
        schedulingEnabled: false,
        outputTranscript: false,
        rememberAgents: false,
        defaultMaxTurns: 2,
        graceTurns: 1,
      }),
    );
    writeFileSync(
      join(root, ".pi", "agents", "bounded.md"),
      "---\nextensions: false\nskills: false\nisolated: true\npersist_session: false\noutput_transcript: false\n---\nDo the task\n",
    );
    seam = fakeSession();
    createAgentSession.mockResolvedValue({ session: seam.session });
    h = harness(root);
    await h.lifecycle.get("session_start")?.({}, h.ctx);
    manager = new AgentManager(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { append: vi.fn() },
    );
  });
  afterEach(async () => {
    await manager.dispose();
    await h.lifecycle.get("session_shutdown")?.({}, h.ctx);
    setDefaultMaxTurns(undefined);
    setDefaultMaxTokens(0);
    setDefaultMaxToolCalls(0);
    setGraceTurns(5);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });
  async function spawned(maxTurns?: number) {
    const { record } = await manager.spawnAndWait(h.pi, h.ctx, "bounded", "1", {
      description: "first",
      maxTurns,
    });
    return record;
  }
  async function call(
    args: Record<string, unknown>,
    update?: (result: unknown) => void,
  ) {
    return (await h.tools
      .get("Agent")!
      .execute(
        "call",
        { subagent_type: "bounded", description: "task", ...args },
        undefined,
        update,
        h.ctx,
      )) as {
      content: Array<{ type: string; text: string }>;
      details: {
        agentId?: string;
        turnCount: number;
        maxTurns: number;
        status: string;
      };
    };
  }

  async function legacySpawn() {
    const spawn = vi.spyOn(AgentManager.prototype, "spawn");
    const registry = Reflect.get(
      globalThis,
      Symbol.for("pi-subagents:manager"),
    ) as {
      spawn(
        pi: ExtensionAPI,
        ctx: ExtensionContext,
        type: string,
        prompt: string,
        options: { description: string; isBackground: boolean },
      ): string;
    };
    const id = registry.spawn(h.pi, h.ctx, "bounded", "1", {
      description: "legacy",
      isBackground: true,
    });
    const rootManager = spawn.mock.contexts.at(-1)!;
    const record = rootManager.getRecordMutable(id)!;
    await record.promise;
    return { rootManager, record };
  }
  async function mention(handle: string, prompt = "1") {
    return h.lifecycle.get("input")!(
      { source: "interactive", text: `@${handle} ${prompt}` },
      { ...h.ctx, mode: "tui" },
    );
  }

  it.each([false, true])(
    "resumes with inherited own-run cap, per-turn updates and no accumulated listeners (background=%s)",
    async (isBackground) => {
      const record = await spawned(3);
      const turns: number[] = [];
      const usage = vi.fn();
      await manager.resume(record.id, "20", undefined, {
        isBackground,
        onTurnEnd: (n) => turns.push(n),
        onAssistantUsage: usage,
      });
      await record.promise;
      expect(record.status).toBe("aborted");
      expect(turns).toEqual([1, 2, 3, 4]);
      expect(usage).toHaveBeenCalledTimes(4);
      expect(record.lifetimeUsage).toEqual({
        input: 5,
        output: 5,
        cacheWrite: 0,
      });
      expect(seam.listeners.size).toBe(0);
      await manager.resume(record.id, "1");
      expect(record.status).toBe("completed");
      expect(record.lifetimeUsage.input).toBe(6);
      expect(seam.listeners.size).toBe(0);
    },
  );

  it.each([false, true])(
    "actual Agent resume forwards an explicit cap and updates a fresh tracker (background=%s)",
    async (background) => {
      const spawned = await call({
        prompt: "1",
        run_in_background: true,
        max_turns: 4,
      });
      const id = spawned.details.agentId!;
      const rootManager = Reflect.get(
        globalThis,
        Symbol.for("pi-subagents:manager"),
      ) as { waitForAll(): Promise<void> };
      await rootManager.waitForAll();
      const observed: number[] = [];
      const update = vi
        .spyOn(FleetList.prototype, "update")
        .mockImplementation(function (this: FleetList) {
          const activity = Reflect.get(this, "agentActivity") as
            | Map<string, { turnCount: number }>
            | undefined;
          if (activity?.get(id)) observed.push(activity.get(id)!.turnCount);
        });
      const stream: unknown[] = [];
      const result = await call(
        {
          resume: id,
          prompt: "20",
          max_turns: 2,
          run_in_background: background,
        },
        (x) => stream.push(x),
      );
      await rootManager.waitForAll();
      expect(seam.session.steer).toHaveBeenCalled();
      expect(seam.session.abort).toHaveBeenCalled();
      if (!background) {
        expect(result.details).toMatchObject({
          status: "aborted",
          turnCount: 3,
          maxTurns: 2,
        });
        expect(stream.length).toBeGreaterThanOrEqual(3);
      }
      expect(update).toHaveBeenCalled();
      expect(observed).toContain(3);
      const activity = Reflect.get(
        update.mock.contexts.at(-1)!,
        "agentActivity",
      ) as Map<string, unknown>;
      expect(activity.has(id)).toBe(false);
      expect(seam.listeners.size).toBe(0);
    },
  );

  it.each([
    ["20", "aborted", "answer 3", "the task is unfinished"],
    ["2", "steered", "answer 2", "the task may be unfinished"],
    ["1", "completed", "answer 1", ""],
  ] as const)(
    "registered foreground resume exposes %s outcome to the model (%s)",
    async (prompt, status, output, note) => {
      const { record } = await legacySpawn();
      const result = await call({ resume: record.id, prompt, max_turns: 2 });
      expect(result.details.status).toBe(status);
      const modelText = result.content[0].text;
      if (status === "completed") {
        expect(modelText).toBe(output);
      } else {
        expect(
          modelText.startsWith(`${output}\n\n[pi-subagents outcome]`),
        ).toBe(true);
        expect(modelText).toContain(
          status === "aborted"
            ? "aborted at the turn limit"
            : "wrapped up at the turn limit",
        );
        expect(modelText).toContain(note);
        expect(modelText).toContain("everything the agent produced is above");
        expect(modelText).not.toMatch(
          /agent id|get_subagent_result|restart|re-?spawn/i,
        );
      }
    },
  );

  it("uses current defaults when no invocation budget exists and refuses invalid overrides", async () => {
    const record = await spawned();
    const onTurnEnd = vi.fn();
    await manager.resume(record.id, "20", undefined, { onTurnEnd });
    expect(record.status).toBe("aborted");
    expect(onTurnEnd).toHaveBeenLastCalledWith(3);
    for (const maxTurns of [-1, 1.5, NaN, Infinity]) {
      await expect(
        manager.resume(record.id, "20", undefined, { maxTurns }),
      ).rejects.toThrow("non-negative safe integer");
    }
    await manager.resume(record.id, "20", undefined, {
      maxTurns: 0,
      onTurnEnd,
    });
    expect(onTurnEnd).toHaveBeenLastCalledWith(3);
  });

  it("frontmatter stays authoritative over an explicit resume override", async () => {
    registerAgents(
      new Map([["bounded", definition("bounded", { maxTurns: 2 })]]),
    );
    const record = await spawned();
    const turns = vi.fn();
    await manager.resume(record.id, "20", undefined, {
      maxTurns: 100,
      onTurnEnd: turns,
    });
    expect(record.status).toBe("aborted");
    expect(turns).toHaveBeenLastCalledWith(3);
  });

  it("retains the frontmatter unlimited policy rather than reviving the project default", async () => {
    registerAgents(
      new Map([
        [
          "bounded",
          definition("bounded", { maxTurns: 0, maxTokens: 0, maxToolCalls: 0 }),
        ],
      ]),
    );
    setDefaultMaxTokens(2);
    setDefaultMaxToolCalls(2);
    const record = await spawned();
    const turns = vi.fn();
    await manager.resume(record.id, "20", undefined, { onTurnEnd: turns });
    expect(record.status).toBe("completed");
    expect(turns).toHaveBeenLastCalledWith(20);
    expect(seam.session.abort).not.toHaveBeenCalled();
  });

  it("a soft-limit response is steered, not completed or hard-aborted", async () => {
    const record = await spawned(2);
    await manager.resume(record.id, "2");
    expect(record.status).toBe("steered");
    expect(record.result).toBe("answer 2");
  });

  it.each(["maxTokens", "maxToolCalls"] as const)(
    "inherits %s and resets the counter on every resume",
    async (limit) => {
      registerAgents(
        new Map([
          [
            "bounded",
            definition("bounded", { [limit]: limit === "maxTokens" ? 6 : 3 }),
          ],
        ]),
      );
      const record = await spawned(100);
      await manager.resume(record.id, "2");
      expect(record.status).toBe("completed");
      const turns = vi.fn();
      await manager.resume(record.id, "20", undefined, { onTurnEnd: turns });
      expect(record.status).toBe("aborted");
      expect(turns).toHaveBeenLastCalledWith(3);
      expect(record.lifetimeUsage.input).toBe(6);
    },
  );

  it("fresh and resumed runner budgets have the same outcome and grace", async () => {
    const turns = vi.fn();
    const first = await runAgent(h.ctx, "bounded", "20", {
      pi: h.pi,
      maxTurns: 2,
      onTurnEnd: turns,
    });
    expect(first).toMatchObject({ aborted: true, steered: true });
    expect(turns).toHaveBeenLastCalledWith(3);
    turns.mockClear();
    const resumed = await resumeAgent(seam.session, "20", {
      onTurnEnd: turns,
    });
    expect(resumed).toMatchObject({ aborted: true, steered: true });
    expect(turns).toHaveBeenLastCalledWith(3);
    expect(seam.listeners.size).toBe(0);
  });

  it("nested Agent resume forwards max_turns to the real manager", async () => {
    const parentSession = fakeSession();
    let finishParent!: () => void;
    vi.mocked(parentSession.session.prompt).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishParent = resolve;
        }),
    );
    createAgentSession.mockResolvedValueOnce({
      session: parentSession.session,
    });
    const parentId = manager.spawn(h.pi, h.ctx, "bounded", "1", {
      description: "parent",
      maxTurns: 100,
    });
    const parent = manager.getRecordMutable(parentId)!;
    const child = manager.spawn(h.pi, h.ctx, "bounded", "1", {
      description: "nested",
      parentAgentId: parent.id,
      maxTurns: 4,
    });
    await manager.getRecordMutable(child)!.promise;
    const tools = createNestedSubagentTools({
      manager,
      pi: h.pi,
      parentAgentId: parent.id,
      depth: 1,
      maxSubagentDepth: 2,
      allowedSubagents: ["bounded"],
      configCwd: root,
      projectTrust: { cwd: root, trusted: true, deniedRoots: [] },
    });
    const result = await tools[0].execute(
      "nested",
      { resume: child, prompt: "20", max_turns: 2 } as never,
      undefined,
      undefined,
      h.ctx,
    );
    expect(manager.getRecordMutable(child)?.status).toBe("aborted");
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining("aborted"),
    });
    finishParent();
    await parent.promise;
  });

  it("uses branch-local nested resume policy, never the divergent root registry", async () => {
    registerAgents(
      new Map([["bounded", definition("bounded", { maxTurns: 100 })]]),
    );
    const branch = join(root, "branch");
    mkdirSync(join(branch, ".pi", "agents"), { recursive: true });
    const branchDefinition = join(branch, ".pi", "agents", "bounded.md");
    const writeBranch = (maxTurns: number) =>
      writeFileSync(
        branchDefinition,
        `---\nextensions: false\nskills: false\nisolated: true\nmax_turns: ${maxTurns}\n---\nDo the task\n`,
      );
    writeBranch(2);
    const parentSession = fakeSession();
    let finishParent!: () => void;
    vi.mocked(parentSession.session.prompt).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishParent = resolve;
        }),
    );
    createAgentSession.mockResolvedValueOnce({
      session: parentSession.session,
    });
    const parentId = manager.spawn(h.pi, h.ctx, "bounded", "1", {
      description: "parent",
      maxTurns: 100,
    });
    const tools = createNestedSubagentTools({
      manager,
      pi: h.pi,
      parentAgentId: parentId,
      depth: 1,
      maxSubagentDepth: 2,
      allowedSubagents: ["bounded"],
      configCwd: branch,
      projectTrust: { cwd: branch, trusted: true, deniedRoots: [] },
    });
    const fresh = await tools[0].execute(
      "nested",
      {
        subagent_type: "bounded",
        description: "branch child",
        prompt: "1",
        run_in_background: true,
      } as never,
      undefined,
      undefined,
      h.ctx,
    );
    const text = fresh.content[0];
    if (text.type !== "text") throw new Error("expected nested ID");
    const childId = text.text.match(/Agent ID: (\S+)/)![1];
    const child = manager.getRecordMutable(childId)!;
    await child.promise;
    expect(child.invocation?.maxTurns).toBe(2);
    await tools[0].execute(
      "resume",
      { resume: childId, prompt: "20", max_turns: 100 } as never,
      undefined,
      undefined,
      h.ctx,
    );
    expect(child.status).toBe("aborted");
    expect(child.result).toBe("answer 3");
    // An internal caller without branch provenance must retain admission policy.
    await manager.resume(childId, "20", undefined, { maxTurns: 100 });
    expect(child.status).toBe("aborted");
    expect(child.result).toBe("answer 3");
    writeBranch(0);
    await tools[0].execute(
      "resume-zero",
      { resume: childId, prompt: "20", max_turns: 1 } as never,
      undefined,
      undefined,
      h.ctx,
    );
    expect(child.status).toBe("completed");
    expect(child.result).toBe("answer 20");
    finishParent();
    await manager.getRecordMutable(parentId)!.promise;
  });

  it("refreshes finite root policy to authoritative frontmatter zero in runner and tracker", async () => {
    const spawn = vi.spyOn(AgentManager.prototype, "spawn");
    const first = await call({
      prompt: "1",
      run_in_background: true,
      max_turns: 2,
    });
    const rootManager = spawn.mock.contexts[0];
    const record = rootManager.getRecordMutable(first.details.agentId!)!;
    await record.promise;
    writeFileSync(
      join(root, ".pi", "agents", "bounded.md"),
      "---\nextensions: false\nskills: false\nisolated: true\npersist_session: false\noutput_transcript: false\nmax_turns: 0\n---\nDo the task\n",
    );
    const result = await call({
      resume: record.id,
      prompt: "20",
      max_turns: 1,
    });
    expect(result.details).toMatchObject({
      status: "completed",
      turnCount: 20,
    });
    expect(result.details.maxTurns).toBeUndefined();
    expect(record.result).toBe("answer 20");
  });

  it("managed reused threads keep policy limits and report failed at the hard cap", async () => {
    const request = (attempt: number) => ({
      requestId: `request-${attempt}`,
      spawnKey: `key-${attempt}`,
      type: "bounded",
      prompt: attempt === 1 ? "1" : "20",
      description: "thread",
      thread: "same",
      owner: {
        extension: "pi-workflows" as const,
        runId: "run",
        nodeId: `node-${attempt}`,
        attemptId: `attempt-${attempt}`,
      },
    });
    const first = manager.spawnManaged(h.pi, h.ctx, request(1), {
      maxTurns: 2,
    });
    await manager.getRecordMutable(first.id)!.promise;
    const turns = vi.fn();
    const second = manager.spawnManaged(
      h.pi,
      h.ctx,
      request(2),
      { maxTurns: 2 },
      { onTurnEnd: turns },
    );
    expect(second.id).toBe(first.id);
    await manager.getRecordMutable(first.id)!.promise;
    expect(turns).toHaveBeenLastCalledWith(3);
    expect(manager.getManagedSpawn("key-2")?.terminal?.status).toBe("failed");
  });

  it.each(["fresh", "resume"] as const)(
    "shutdown synchronously retires captured %s invocation UI while its provider ignores abort",
    async (kind) => {
      const spawn = vi.spyOn(AgentManager.prototype, "spawn");
      let resumeId: string | undefined;
      if (kind === "resume") {
        const first = await call({ prompt: "1", run_in_background: true });
        resumeId = first.details.agentId!;
        await spawn.mock.contexts[0].getRecordMutable(resumeId)!.promise;
      }
      vi.useFakeTimers();
      const capturedIntervals: Array<{
        callback: () => void;
        handle: ReturnType<typeof setInterval>;
      }> = [];
      const nativeInterval = globalThis.setInterval;
      vi.spyOn(globalThis, "setInterval").mockImplementation(((
        callback: () => void,
        delay: number,
        ...args: unknown[]
      ) => {
        const handle = nativeInterval(callback, delay, ...args);
        if (delay === SPINNER_INTERVAL_MS)
          capturedIntervals.push({ callback, handle });
        return handle;
      }) as typeof setInterval);
      const clear = vi.spyOn(globalThis, "clearInterval");
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      let finish!: () => void;
      vi.mocked(seam.session.prompt).mockImplementation(async () => {
        started();
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      });
      const onUpdate = vi.fn();
      const pending = call(
        { prompt: "unfinished", ...(resumeId ? { resume: resumeId } : {}) },
        onUpdate,
      );
      await ready;
      const message = fauxAssistantMessage("live output");
      message.usage.input = 1;
      const textEvent = {
        type: "message_update",
        message,
        assistantMessageEvent: {
          type: "text_delta",
          delta: "live output",
          contentIndex: 0,
          partial: message,
        },
      } as AgentSessionEvent;
      seam.emit(textEvent);
      seam.emit({ type: "message_end", message });
      expect(onUpdate.mock.calls.length).toBeGreaterThan(0);
      if (kind === "fresh") {
        expect(capturedIntervals).toHaveLength(1);
        const before = onUpdate.mock.calls.length;
        capturedIntervals[0].callback();
        expect(onUpdate.mock.calls.length).toBeGreaterThan(before);
      }
      const capturedListeners = [...seam.listeners];
      const beforeShutdown = onUpdate.mock.calls.length;
      const shutdown = h.lifecycle.get("session_shutdown")!(
        {},
        h.ctx,
      ) as Promise<void>;
      for (const { callback, handle } of capturedIntervals) {
        expect(clear).toHaveBeenCalledWith(handle);
        callback();
      }
      // These are direct, already-captured session observers, before quiescence
      // has detached the record. Runtime retirement itself must fence delivery.
      for (const listener of capturedListeners) {
        listener(textEvent);
        listener({ type: "message_end", message });
      }
      expect(onUpdate).toHaveBeenCalledTimes(beforeShutdown);
      await vi.advanceTimersByTimeAsync(40_000);
      await shutdown;
      for (const { callback } of capturedIntervals) callback();
      for (const listener of capturedListeners) listener(textEvent);
      expect(onUpdate).toHaveBeenCalledTimes(beforeShutdown);
      finish();
      await pending;
      expect(onUpdate).toHaveBeenCalledTimes(beforeShutdown);
    },
  );

  it.each(["Agent", "mention"] as const)(
    "fresh background %s retires every synchronous failed-admission tracker and preserves admitted activity",
    async (surface) => {
      writeFileSync(
        join(root, ".pi", "subagents.json"),
        JSON.stringify({
          schedulingEnabled: false,
          outputTranscript: false,
          rememberAgents: false,
          defaultMaxTurns: 2,
          graceTurns: 1,
          agentMentions: "direct",
        }),
      );
      await h.lifecycle.get("session_start")!({}, h.ctx);
      const registrations: Array<{ owner: Set<unknown>; retire: () => void }> =
        [];
      const add = Set.prototype.add;
      vi.spyOn(Set.prototype, "add").mockImplementation(function (
        this: Set<unknown>,
        value: unknown,
      ) {
        if (typeof value === "function" && value.name === "retire") {
          registrations.push({ owner: this, retire: value as () => void });
        }
        return add.call(this, value);
      });
      const originalSpawn = AgentManager.prototype.spawn;
      const failures: unknown[] = [];
      const spawn = vi
        .spyOn(AgentManager.prototype, "spawn")
        .mockImplementation(function (this: AgentManager, ...args) {
          try {
            return originalSpawn.apply(this, args);
          } catch (error) {
            failures.push(error);
            throw error;
          }
        });
      const invalidPrompt = "x".repeat(100_001);
      for (let attempt = 0; attempt < 5; attempt++) {
        if (surface === "Agent") {
          const pending = call({
            prompt: invalidPrompt,
            run_in_background: true,
          });
          await expect(pending).rejects.toBe(failures.at(-1));
        } else {
          await mention("bounded", invalidPrompt);
          expect(h.ctx.ui.notify).toHaveBeenLastCalledWith(
            expect.stringContaining(
              "Agent prompt must be a string of at most 100000 characters",
            ),
            "error",
          );
        }
        expect(registrations).toHaveLength(attempt + 1);
        expect(
          registrations.every(({ owner, retire }) => !owner.has(retire)),
        ).toBe(true);
      }
      expect(failures).toHaveLength(5);
      expect(createAgentSession).not.toHaveBeenCalled();
      const rootManager = spawn.mock.contexts.at(-1)!;
      expect(rootManager.listAgentsMutable()).toEqual([]);

      const fleet = vi.spyOn(FleetList.prototype, "update");
      const completed = vi.fn();
      h.pi.events.on("subagents:completed", completed);
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      let finish!: () => void;
      vi.mocked(seam.session.prompt).mockImplementationOnce(async () => {
        started();
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      });
      if (surface === "Agent")
        await call({ prompt: "unfinished", run_in_background: true });
      else await mention("bounded", "unfinished");
      await ready;
      expect(registrations).toHaveLength(6);
      const admitted = registrations.at(-1)!;
      expect(admitted.owner.has(admitted.retire)).toBe(true);
      const record = rootManager.listAgentsMutable()[0];
      try {
        const message = fauxAssistantMessage("admitted answer");
        message.usage.input = 3;
        message.usage.output = 0;
        seam.emit({ type: "message_end", message });
        const activities = Reflect.get(
          fleet.mock.contexts.at(-1)!,
          "agentActivity",
        ) as Map<string, { lifetimeUsage: { input: number } }>;
        expect(activities.get(record.id)?.lifetimeUsage.input).toBe(3);
        expect(record.lifetimeUsage.input).toBe(3);
      } finally {
        finish();
        await record.promise;
      }
      expect(admitted.owner.has(admitted.retire)).toBe(false);
      expect(completed).toHaveBeenCalledWith(
        expect.objectContaining({ tokens: { input: 3, output: 0, total: 3 } }),
      );
    },
  );

  it.each(["admitted", "refused", "error"] as const)(
    "mention continuation after shutdown does not notify (%s)",
    async (outcome) => {
      const { record } = await legacySpawn();
      await mention(record.handle!);
      expect(h.ctx.ui.notify).toHaveBeenCalled();
      vi.mocked(h.ctx.ui.notify).mockClear();
      const original = AgentManager.prototype.resume;
      let entered!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.spyOn(AgentManager.prototype, "resume").mockImplementationOnce(
        async function (this: AgentManager, ...args) {
          const admitted =
            outcome === "admitted"
              ? await original.apply(this, args)
              : undefined;
          entered();
          await gate;
          if (outcome === "error")
            throw new Error("resume refused during shutdown");
          return admitted;
        },
      );
      const pending = mention(record.handle!);
      await ready;
      await h.lifecycle.get("session_shutdown")!({}, h.ctx);
      release();
      await pending;
      expect(h.ctx.ui.notify).not.toHaveBeenCalled();
    },
  );

  it.each(["Agent", "mention"] as const)(
    "repeated %s resume refusals retire captured UI callbacks; admitted work still updates",
    async (surface) => {
      const fleet = vi.spyOn(FleetList.prototype, "update");
      const { record } = await legacySpawn();
      const original = AgentManager.prototype.resume;
      const callbacks: ResumeOptions[] = [];
      const resume = vi
        .spyOn(AgentManager.prototype, "resume")
        .mockImplementation(async (_id, _prompt, _signal, options) => {
          callbacks.push(options!);
          if (callbacks.length === 5) throw new Error("resume refused");
          return undefined;
        });
      for (let attempt = 0; attempt < 5; attempt++) {
        if (surface === "Agent") {
          const result = call({
            resume: record.id,
            prompt: "1",
            run_in_background: true,
          });
          if (attempt === 4)
            await expect(result).rejects.toThrow("resume refused");
          else await result;
        } else await mention(record.handle!);
      }
      const before = fleet.mock.calls.length;
      for (const options of callbacks) {
        options.onStarted?.();
        options.onBudgetResolved?.(99);
        options.onTextDelta?.("stale", "stale");
        options.onAssistantUsage?.({ input: 1, output: 1, cacheWrite: 0 });
        options.onTurnEnd?.(99);
      }
      expect(fleet).toHaveBeenCalledTimes(before);
      const activities = Reflect.get(
        fleet.mock.contexts.at(-1)!,
        "agentActivity",
      ) as Map<string, unknown>;
      expect(activities.has(record.id)).toBe(false);
      resume.mockImplementation(original);
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      let finish!: () => void;
      vi.mocked(seam.session.prompt).mockImplementationOnce(async () => {
        started();
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      });
      if (surface === "Agent")
        await call({
          resume: record.id,
          prompt: "unfinished",
          run_in_background: true,
        });
      else await mention(record.handle!, "unfinished");
      await ready;
      const message = fauxAssistantMessage("live");
      message.usage.input = 1;
      seam.emit({ type: "message_end", message });
      expect(fleet.mock.calls.length).toBeGreaterThan(before);
      expect(activities.has(record.id)).toBe(true);
      finish();
      await record.promise;
      expect(activities.has(record.id)).toBe(false);
    },
  );

  it.each([
    ["Agent", false],
    ["mention", false],
    ["Agent", true],
    ["mention", true],
  ] as const)(
    "%s queued resume displays and enforces inherited session policy after defaults change (unlimited=%s)",
    async (surface, unlimited) => {
      setDefaultMaxTurns(unlimited ? 0 : 2);
      const fleet = vi.spyOn(FleetList.prototype, "update");
      const { rootManager, record } = await legacySpawn();
      expect(record.invocation?.maxTurns).toBeUndefined();
      setDefaultMaxTurns(5);
      rootManager.setMaxConcurrent(1);
      const blockerSession = fakeSession();
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      let finish!: () => void;
      vi.mocked(blockerSession.session.prompt).mockImplementation(async () => {
        started();
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      });
      createAgentSession.mockResolvedValueOnce({
        session: blockerSession.session,
      });
      const blockerId = rootManager.spawn(
        h.pi,
        h.ctx,
        "bounded",
        "unfinished",
        { description: "blocker", isBackground: true },
      );
      await ready;
      if (surface === "Agent")
        await call({
          resume: record.id,
          prompt: "20",
          run_in_background: true,
        });
      else await mention(record.handle!, "20");
      expect(record.status).toBe("queued");
      const activities = Reflect.get(
        fleet.mock.contexts.at(-1)!,
        "agentActivity",
      ) as Map<string, { maxTurns?: number; turnCount: number }>;
      // The cap is available while queued, before any resumed provider event.
      const activity = activities.get(record.id)!;
      expect(activity).toBeDefined();
      expect(activity.maxTurns).toBe(unlimited ? undefined : 2);
      expect(activity.turnCount).toBe(1);
      finish();
      await rootManager.getRecordMutable(blockerId)!.promise;
      await record.promise;
      expect(record.status).toBe(unlimited ? "completed" : "aborted");
      expect(record.result).toBe(unlimited ? "answer 20" : "answer 3");
      expect(activity.maxTurns).toBe(unlimited ? undefined : 2);
      expect(activity.turnCount).toBe(unlimited ? 20 : 3);
    },
  );

  it("shutdown preserves managed lifecycle and usage receipts while suppressing nudges", async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish!: () => void;
    vi.mocked(seam.session.prompt).mockImplementation(async () => {
      started();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    vi.mocked(seam.session.abort).mockImplementation(async () => {
      const message = fauxAssistantMessage("partial before shutdown");
      message.usage.input = 3;
      message.usage.output = 1;
      seam.emit({ type: "message_end", message });
      finish();
    });
    const failed = vi.fn();
    h.pi.events.on("subagents:failed", failed);
    h.pi.events.emit("subagents:rpc:spawn-managed", {
      requestId: "shutdown-request",
      spawnKey: "shutdown-key",
      type: "bounded",
      prompt: "unfinished",
      description: "managed shutdown",
      owner: {
        extension: "pi-workflows",
        runId: "run",
        nodeId: "node",
        attemptId: "attempt",
      },
    });
    await ready;
    await h.lifecycle.get("session_shutdown")!({}, h.ctx);
    expect(failed).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "stopped",
        managedTokens: { input: 3, output: 1, total: 4 },
      }),
    );
    expect(h.pi.appendEntry).toHaveBeenCalledWith(
      "subagents:record",
      expect.objectContaining({
        status: "stopped",
        tokens: 4,
      }),
    );
    expect(h.pi.sendMessage).not.toHaveBeenCalled();
  });

  it.each(["batch", "group", "nudge"] as const)(
    "confirmed shutdown retires %s timers before waiting for an abort-ignoring provider",
    async (stage) => {
      vi.useFakeTimers();
      const callbacks: Array<{ callback: () => void; delay: number }> = [];
      const nativeTimeout = globalThis.setTimeout;
      vi.spyOn(globalThis, "setTimeout").mockImplementation(((
        callback: () => void,
        delay: number,
        ...args: unknown[]
      ) => {
        callbacks.push({ callback, delay });
        return nativeTimeout(callback, delay, ...args);
      }) as typeof setTimeout);
      const dispose = vi.spyOn(GroupJoinManager.prototype, "dispose");
      const grouped = vi.spyOn(GroupJoinManager.prototype, "registerGroup");
      const spawn = vi.spyOn(AgentManager.prototype, "spawn");
      const first = await call({ prompt: "1", run_in_background: true });
      const rootManager = spawn.mock.contexts[0];
      await rootManager.getRecordMutable(first.details.agentId!)!.promise;
      const stuck = fakeSession();
      let release!: () => void;
      vi.mocked(stuck.session.prompt).mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      createAgentSession.mockResolvedValueOnce({ session: stuck.session });
      await call({ prompt: "unfinished", run_in_background: true });
      // Wait on an independent, actual runner boundary, not timer polling.
      const bind = vi.spyOn(stuck.session, "bindExtensions");
      await vi.advanceTimersByTimeAsync(stage === "batch" ? 0 : 100);
      expect(bind).toHaveBeenCalled();
      if (stage === "nudge") await vi.advanceTimersByTimeAsync(30_000);
      const groupCount = grouped.mock.calls.length;
      const captured = callbacks
        .filter(
          ({ delay }) =>
            delay ===
            (stage === "batch" ? 100 : stage === "group" ? 30_000 : 200),
        )
        .map(({ callback }) => callback);
      expect(captured.length).toBeGreaterThan(0);
      const shutdown = h.lifecycle.get("session_shutdown")!(
        {},
        h.ctx,
      ) as Promise<void>;
      expect(dispose).toHaveBeenCalledOnce();
      // Even a timer callback already captured by the host must be inert.
      for (const callback of captured) callback();
      expect(grouped).toHaveBeenCalledTimes(groupCount);
      await vi.advanceTimersByTimeAsync(40_000);
      await shutdown;
      expect(h.pi.sendMessage).not.toHaveBeenCalled();
      release();
      await Promise.allSettled(
        rootManager.listAgentsMutable().map((record) => record.promise),
      );
      for (const callback of captured) callback();
      expect(h.pi.sendMessage).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "keeps cancellation/error controls and removes observers (background=%s)",
    async (isBackground) => {
      const record = await spawned(2);
      const controller = new AbortController();
      controller.abort();
      const before = vi.mocked(seam.session.prompt).mock.calls.length;
      await manager.resume(record.id, "20", controller.signal, {
        isBackground,
      });
      expect(vi.mocked(seam.session.prompt).mock.calls).toHaveLength(before);
      vi.mocked(seam.session.prompt).mockImplementationOnce(async () => {
        throw new Error("provider failed");
      });
      await manager.resume(record.id, "20", undefined, { isBackground });
      await record.promise;
      expect(record.status).toBe("error");
      expect(record.error).toBe("provider failed");
      expect(seam.listeners.size).toBe(0);
      const active = new AbortController();
      vi.mocked(seam.session.prompt).mockImplementationOnce(async () => {
        active.abort();
      });
      await manager.resume(record.id, "20", active.signal, { isBackground });
      await record.promise;
      expect(record.status).toBe("stopped");
      expect(seam.listeners.size).toBe(0);
    },
  );
});
