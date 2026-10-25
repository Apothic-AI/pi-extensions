import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import statusline from "../src/statusline.js";
import { createMockContext, createMockPi } from "./support.js";

const model = { id: "model-a", provider: "provider-a", api: "openai-responses", contextWindow: 921_000 };
let sequence = 0;
function assistant(overrides: Record<string, unknown> = {}): AgentMessage {
  return {
    role: "assistant",
    provider: model.provider,
    api: model.api,
    model: model.id,
    timestamp: ++sequence,
    stopReason: "stop",
    usage: { input: 400_000, output: 1, cacheRead: 0, cacheWrite: 0 },
    ...overrides,
  } as AgentMessage;
}
function entry(message: AgentMessage, parentId: string | null = null): SessionEntry {
  return { type: "message", id: `entry-${++sequence}`, parentId, message } as SessionEntry;
}
function partial(timestamp: number, overrides: Record<string, unknown> = {}): AgentMessage {
  return {
    role: "assistant",
    provider: model.provider,
    api: model.api,
    model: model.id,
    timestamp,
    content: [],
    stopReason: "stop",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...overrides,
  } as AgentMessage;
}
function footer(context: ReturnType<typeof createMockContext>) {
  return (
    context.footer as (
      tui: unknown,
      theme: unknown,
      data: unknown,
    ) => {
      render(width: number): string[];
      dispose(): void;
    }
  )(
    { requestRender() {} },
    { fg: (_color: string, text: string) => text, bold: (text: string) => text },
    { getGitBranch: () => null, getExtensionStatuses: () => new Map(), onBranchChange: () => () => undefined },
  );
}
async function harness(run: (mock: ReturnType<typeof createMockPi>, root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "pi-statusline-confidence-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  vi.useFakeTimers();
  const mock = createMockPi();
  Object.assign(mock.rawPi, { exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }) });
  try {
    await run(mock, root);
  } finally {
    vi.useRealTimers();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}
async function emit(mock: ReturnType<typeof createMockPi>, name: string, event: unknown, ctx: unknown) {
  for (const handler of mock.events.get(name) ?? []) await handler(event, ctx);
}
async function complete(mock: ReturnType<typeof createMockPi>, ctx: unknown, message = assistant()) {
  const start =
    message.role === "assistant"
      ? partial(message.timestamp, { provider: message.provider, api: message.api, model: message.model })
      : message;
  await emit(mock, "message_start", { message: { ...start } }, ctx);
  await emit(mock, "message_end", { message: { ...message } }, ctx);
}

test("overflow, cancelled compaction and queued notifications retain unknown until fresh usage", async () => {
  await harness(async (mock, root) => {
    writeFileSync(join(root, "pi-statusline.json"), JSON.stringify({ segments: ["context", "tokens", "cost"] }));
    statusline(mock.pi);
    const entries: SessionEntry[] = [];
    const usage = { percent: 100.6, tokens: 926_627, contextWindow: 921_000 };
    let scans = 0;
    const current = createMockContext({
      mode: "tui",
      model,
      getContextUsage: () => usage,
      sessionManager: {
        getBranch: () => entries,
        getEntry: (id: string) => entries.find((entry) => entry.id === id),
        getEntries: () => {
          scans += 1;
          return entries;
        },
        getLeafId: () => entries.at(-1)?.id ?? null,
      },
    });
    await emit(mock, "session_start", {}, current.ctx);
    const view = footer(current);
    const line = () => view.render(200).join(" ");
    try {
      assert.match(line(), /ctx 101%/, "overflow values must never be clamped");
      const failed = assistant({ stopReason: "error" });
      await emit(mock, "message_start", { message: failed }, current.ctx);
      entries.push(entry(failed));
      usage.percent = 44.234;
      usage.tokens = 407_398;
      await emit(mock, "message_end", { message: failed }, current.ctx);
      assert.match(line(), /ctx \?/);
      await emit(mock, "session_compact_failed", { aborted: true }, current.ctx);
      for (const name of ["agent_end", "agent_start", "agent_settled"]) {
        await emit(mock, name, {}, current.ctx);
        assert.match(line(), /ctx \?/);
      }
      await emit(
        mock,
        "message_end",
        { message: { role: "custom", content: "queued background notification" } },
        current.ctx,
      );
      await complete(
        mock,
        current.ctx,
        assistant({ stopReason: "error", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
      );
      await complete(mock, current.ctx, assistant({ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }));
      entries.push({
        type: "usage",
        id: "cache-warm",
        parentId: entries.at(-1)?.id ?? null,
        usage: { input: 10, output: 1 },
      } as unknown as SessionEntry);
      vi.advanceTimersByTime(5_000);
      assert.match(line(), /ctx \?/);
      await emit(mock, "message_update", { message: assistant() }, current.ctx);
      await emit(mock, "turn_end", { message: assistant(), toolResults: [] }, current.ctx);
      assert.match(line(), /ctx \?/);
      const scansBeforeRender = scans;
      line();
      line();
      line();
      assert.equal(scans, scansBeforeRender, "rendering never scans history");
      const fresh = assistant();
      await complete(mock, current.ctx, fresh);
      assert.match(line(), /ctx 44%/, "restore the unmodified public API value, not an invented estimate");
      await emit(mock, "session_compact", {}, current.ctx);
      assert.match(line(), /ctx \?/);
      await emit(mock, "message_end", { message: fresh }, current.ctx);
      assert.match(line(), /ctx \?/, "old usage after compaction is not new evidence");
      await complete(mock, current.ctx);
      assert.match(line(), /ctx 44%/);
      await emit(mock, "session_compact_failed", { aborted: false }, current.ctx);
      assert.match(line(), /ctx \?/);
    } finally {
      view.dispose();
    }
  });
});

test("active-branch restore, tree/model boundaries and retired owners cannot borrow usage", async () => {
  await harness(async (mock) => {
    statusline(mock.pi);
    const success = entry(assistant());
    const failure = entry(assistant({ stopReason: "aborted" }));
    let branch = [success, failure];
    const currentModel = { ...model };
    const current = createMockContext({
      mode: "tui",
      model: currentModel,
      getContextUsage: () => ({ percent: 44, contextWindow: 921_000 }),
      sessionManager: {
        getEntries: () => [success, failure],
        getBranch: () => branch,
        getEntry: (id: string) => branch.find((entry) => entry.id === id),
        getLeafId: () => branch.at(-1)?.id ?? null,
      },
    });
    let view: ReturnType<typeof footer> | undefined;
    try {
      await emit(mock, "session_start", {}, current.ctx);
      view = footer(current);
      assert.match(view.render(200).join(" "), /ctx \?/, "reload/resume sees raw failed attempts");
      branch = [success];
      await emit(mock, "session_tree", {}, current.ctx);
      assert.deepEqual(view.render(200), [], "old footer retired");
      view = footer(current);
      assert.match(view.render(200).join(" "), /ctx 44%/, "abandoned failures in getEntries do not poison this branch");
      branch = [success, failure, entry(assistant()), { type: "compaction", id: "compact" } as SessionEntry];
      await emit(mock, "session_tree", {}, current.ctx);
      view = footer(current);
      assert.match(view.render(200).join(" "), /ctx \?/, "later compaction survives reload/tree rebuild");
      await complete(mock, current.ctx);
      assert.match(view.render(200).join(" "), /ctx 44%/);

      const stale = assistant();
      await emit(mock, "message_start", { message: stale }, current.ctx);
      currentModel.id = "model-b";
      await emit(mock, "model_select", { model: currentModel }, current.ctx);
      await emit(mock, "message_end", { message: stale }, current.ctx);
      await complete(mock, current.ctx, assistant({ model: "model-b", provider: "other-provider" }));
      await complete(mock, current.ctx, assistant({ model: "model-b", api: "other-api" }));
      assert.match(view.render(200).join(" "), /ctx \?/);
      await complete(mock, current.ctx, assistant({ model: "model-b" }));
      assert.match(view.render(200).join(" "), /ctx 44%/);

      const pending = assistant({ model: "model-b" });
      await emit(mock, "message_start", { message: pending }, current.ctx);
      branch = [failure]; // navigation becomes visible before session_tree dispatch
      await emit(mock, "message_end", { message: pending }, current.ctx);
      assert.match(view.render(200).join(" "), /ctx \?/);
      await emit(mock, "session_tree", {}, current.ctx);
      view = footer(current);
      assert.match(view.render(200).join(" "), /ctx \?/);
      await complete(mock, current.ctx, assistant({ model: "model-b" }));
      assert.match(view.render(200).join(" "), /ctx 44%/);

      const replacement = createMockContext({
        mode: "tui",
        model,
        getContextUsage: () => ({ percent: 71, contextWindow: 921_000 }),
      });
      await emit(mock, "session_start", {}, replacement.ctx);
      view = footer(replacement);
      for (const name of ["session_compact_failed", "session_compact", "session_tree", "model_select"]) {
        await emit(mock, name, {}, current.ctx);
      }
      await complete(mock, current.ctx, assistant({ stopReason: "error" }));
      assert.match(
        view.render(200).join(" "),
        /ctx 71%/,
        "stale session events cannot mutate or replace the new footer",
      );
      view.dispose();
      await complete(mock, replacement.ctx, assistant({ stopReason: "error" }));
      assert.deepEqual(view.render(200), [], "disposed owner is inert");
    } finally {
      view?.dispose();
    }
  });
});

test("failed compaction persists only an owned display marker across tree, reload and UI rebind", async () => {
  await harness(async (mock) => {
    const old = assistant({ timestamp: 10, responseId: "old-response" });
    const success = entry(old);
    let branch = [success];
    const entries = [success];
    const manager = {
      getBranch: () => branch,
      getEntries: () => entries,
      getEntry: (id: string) => entries.find((entry) => entry.id === id),
      getLeafId: () => branch.at(-1)?.id ?? null,
    };
    const context = () =>
      createMockContext({
        mode: "tui",
        model,
        getContextUsage: () => ({ percent: 44, contextWindow: model.contextWindow }),
        sessionManager: manager,
      });
    const recordAppends = (target: ReturnType<typeof createMockPi>) => {
      Object.assign(target.rawPi, { exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }) });
      const append = target.rawPi.appendEntry;
      target.rawPi.appendEntry = (customType, data) => {
        append(customType, data);
        const record = {
          type: "custom",
          id: `marker-${++sequence}`,
          parentId: manager.getLeafId(),
          customType,
          data: JSON.parse(JSON.stringify(data)),
        } as SessionEntry;
        entries.push(record);
        branch = [...branch, record];
      };
    };
    recordAppends(mock);
    statusline(mock.pi);
    let current = context();
    let active = mock;
    let view: ReturnType<typeof footer> | undefined;
    try {
      await emit(active, "session_start", {}, current.ctx);
      view = footer(current);
      assert.match(view.render(200).join(" "), /ctx 44%/);
      assert.equal(mock.entries.length, 0, "startup and render never journal");
      await emit(active, "message_start", { message: partial(10) }, current.ctx);
      await emit(active, "session_compact_failed", { error: "sensitive provider error", aborted: true }, current.ctx);
      assert.deepEqual(mock.entries, [
        { customType: "pi-statusline:context-confidence", data: { version: 1, state: "unknown" } },
      ]);
      assert.equal(entries.length, 2, "assistant/compaction history is unchanged except for our own marker");
      const failedBranch = [...branch];
      assert.match(view.render(200).join(" "), /ctx \?/);
      await emit(active, "message_end", { message: { ...old } }, current.ctx);
      assert.match(view.render(200).join(" "), /ctx \?/, "pre-failure start was retired");

      branch = [success];
      await emit(active, "session_tree", {}, current.ctx);
      view = footer(current);
      assert.match(view.render(200).join(" "), /ctx 44%/, "marker is local to its branch");
      branch = failedBranch;
      await emit(active, "session_tree", {}, current.ctx);
      view = footer(current);
      assert.match(view.render(200).join(" "), /ctx \?/, "returning restores the marker in order");
      assert.equal(mock.entries.length, 1, "tree rebuild does not append");

      await emit(active, "session_shutdown", { reason: "reload" }, current.ctx);
      active = createMockPi(); // A new extension instance has no runtime latch to rely on.
      recordAppends(active);
      statusline(active.pi);
      current = context();
      await emit(active, "session_start", {}, current.ctx);
      view = footer(current);
      assert.match(view.render(200).join(" "), /ctx \?/, "old successful history cannot undo failed compaction");
      await emit(active, "message_end", { message: { ...old } }, current.ctx);
      assert.match(view.render(200).join(" "), /ctx \?/, "late historical success is not a new admission");

      const retired = current;
      current = context(); // same session/branch, different UI ownership
      await emit(active, "session_start", {}, current.ctx);
      view = footer(current);
      assert.match(view.render(200).join(" "), /ctx \?/, "TUI rebind rebuilds the persisted guard");
      await emit(active, "session_compact_failed", {}, retired.ctx);
      await complete(active, retired.ctx);
      await emit(mock, "session_compact_failed", {}, retired.ctx);
      assert.equal(active.entries.length, 0, "stale UI owner must not persist invalidation");
      assert.equal(mock.entries.length, 1, "retired extension owner must not persist invalidation");
      assert.match(view.render(200).join(" "), /ctx \?/);

      // Actual provider ordering: response ID is absent at the copied start.
      await emit(active, "message_start", { message: { ...partial(11) } }, current.ctx);
      const fresh = assistant({ timestamp: 11, responseId: "new-response" });
      const freshEntry = entry(fresh, manager.getLeafId());
      entries.push(freshEntry);
      branch = [...branch, freshEntry];
      await emit(active, "message_end", { message: { ...fresh } }, current.ctx);
      assert.match(view.render(200).join(" "), /ctx 44%/);
      await emit(active, "session_start", {}, current.ctx);
      view = footer(current);
      assert.match(view.render(200).join(" "), /ctx 44%/, "later same-route persisted success supersedes the marker");
      assert.equal(active.entries.length, 0, "success/rebuild/render never append confidence metadata");
    } finally {
      view?.dispose();
    }
  });
});

test("tool-heavy leaf growth validates only incremental ancestry and skips nonassistant evidence", async () => {
  await harness(async (mock) => {
    statusline(mock.pi);
    const entries: SessionEntry[] = [];
    const byId = new Map<string, SessionEntry>();
    let branchScans = 0;
    let entryLookups = 0;
    let leafChecks = 0;
    const current = createMockContext({
      mode: "tui",
      model,
      getContextUsage: () => ({ percent: 44, contextWindow: model.contextWindow }),
      sessionManager: {
        getBranch: () => {
          branchScans += 1;
          return entries;
        },
        getEntries: () => entries,
        getEntry: (id: string) => {
          entryLookups += 1;
          return byId.get(id);
        },
        getLeafId: () => {
          leafChecks += 1;
          return entries.at(-1)?.id ?? null;
        },
      },
    });
    await emit(mock, "session_start", {}, current.ctx);
    const view = footer(current);
    const baselineScans = branchScans;
    try {
      for (let turn = 0; turn < 100; turn += 1) {
        for (let tool = 0; tool < 10; tool += 1) {
          const message = {
            role: "toolResult",
            toolCallId: `tool-${turn}-${tool}`,
            content: [],
          } as unknown as AgentMessage;
          const checksBefore = leafChecks;
          await emit(mock, "message_start", { message }, current.ctx);
          const next = entry(message, entries.at(-1)?.id ?? null);
          entries.push(next);
          byId.set(next.id, next);
          await emit(mock, "message_end", { message }, current.ctx);
          assert.equal(leafChecks, checksBefore, "nonassistant messages do not validate confidence ancestry");
        }
        const timestamp = 1000 + turn;
        await emit(mock, "message_start", { message: partial(timestamp) }, current.ctx);
        const message = assistant({ timestamp, responseId: `response-${turn}` });
        const next = entry(message, entries.at(-1)?.id ?? null);
        entries.push(next);
        byId.set(next.id, next);
        await emit(mock, "message_end", { message: { ...message } }, current.ctx);
      }
      assert.equal(branchScans, baselineScans, "no full branch scans after installation");
      assert.equal(entryLookups, 1100, "each appended entry is visited once, not once per growing prefix");
      assert.match(view.render(200).join(" "), /ctx 44%/);
      view.render(200);
      assert.equal(entryLookups, 1100, "rendering never validates ancestry");
    } finally {
      view.dispose();
    }
  });
});

for (const invalid of ["sibling", "missing", "cycle", "throws"] as const) {
  test(`invalid ancestry (${invalid}) retires confidence until session_tree`, async () => {
    await harness(async (mock) => {
      statusline(mock.pi);
      const original = entry(assistant());
      const sibling = entry(assistant());
      let leaf = original.id;
      const byId = new Map([
        [original.id, original],
        [sibling.id, sibling],
      ]);
      if (invalid === "cycle") byId.set(sibling.id, { ...sibling, parentId: sibling.id });
      const current = createMockContext({
        mode: "tui",
        model,
        getContextUsage: () => ({ percent: 44, contextWindow: model.contextWindow }),
        sessionManager: {
          getBranch: () => [original],
          getEntries: () => [original, sibling],
          getLeafId: () => leaf,
          getEntry: (id: string) => {
            if (invalid === "throws") throw new Error("entry unavailable");
            return byId.get(id);
          },
        },
      });
      await emit(mock, "session_start", {}, current.ctx);
      let view = footer(current);
      try {
        await emit(mock, "message_start", { message: partial(100) }, current.ctx);
        leaf = invalid === "missing" ? "missing-entry" : sibling.id;
        await emit(mock, "message_end", { message: assistant({ timestamp: 100, responseId: "late" }) }, current.ctx);
        assert.match(view.render(200).join(" "), /ctx \?/);
        leaf = original.id; // Even returning to the last accepted leaf cannot revive a retired owner.
        await complete(mock, current.ctx);
        await emit(mock, "session_compact_failed", {}, current.ctx);
        assert.match(view.render(200).join(" "), /ctx \?/);
        assert.equal(mock.entries.length, 0, "retired branch cannot journal stale invalidation");
        await emit(mock, "session_tree", {}, current.ctx);
        view = footer(current);
        await complete(mock, current.ctx);
        assert.match(view.render(200).join(" "), /ctx 44%/);
      } finally {
        view.dispose();
      }
    });
  });
}
