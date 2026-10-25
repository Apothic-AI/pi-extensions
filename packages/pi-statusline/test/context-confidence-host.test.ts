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
function entry(message: AgentMessage): SessionEntry {
  return { type: "message", id: `entry-${++sequence}`, message } as SessionEntry;
}
function footer(context: ReturnType<typeof createMockContext>) {
  return (context.footer as (tui: unknown, theme: unknown, data: unknown) => {
    render(width: number): string[];
    dispose(): void;
  })(
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
  await emit(mock, "message_start", { message }, ctx);
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
      entries.push({ type: "usage", id: "cache-warm", usage: { input: 10, output: 1 } } as unknown as SessionEntry);
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
      assert.match(
        view.render(200).join(" "),
        /ctx 44%/,
        "abandoned failures in getEntries do not poison this branch",
      );
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
