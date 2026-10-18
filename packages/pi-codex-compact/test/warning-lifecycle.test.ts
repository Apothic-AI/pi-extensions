import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createCheckpointDetails, fallbackSummary } from "../src/checkpoint.js";
import { createCodexCompactExtension } from "../src/codex-compact.js";
import {
  type CodexCompactSettingsRuntime,
  type CodexCompactSettingsState,
  DEFAULT_CODEX_COMPACT_SETTINGS,
} from "../src/settings.js";
import { createMockContext, createMockPi } from "./support.js";

function runtime(overrides: Partial<CodexCompactSettingsState> = {}): CodexCompactSettingsRuntime {
  const state: CodexCompactSettingsState = {
    kind: "loaded",
    path: "/test/pi-codex-compact.json",
    settings: { ...DEFAULT_CODEX_COMPACT_SETTINGS },
    ...overrides,
  };
  return {
    get: () => structuredClone(state),
    reload: async () => structuredClone(state),
    update: async () => structuredClone(state),
    flush: async () => {},
  };
}

async function emit(mock: ReturnType<typeof createMockPi>, name: string, event: unknown, ctx: unknown) {
  for (const handler of mock.events.get(name) ?? []) await handler(event, ctx);
}

function remoteCheckpoint(session: SessionManager, id: string) {
  const kept = { role: "user" as const, content: "retained task", timestamp: 1 };
  const keptId = session.appendMessage(kept);
  const details = createCheckpointDetails({
    modelId: "test-codex",
    checkpointId: id,
    replacementHistory: [{ type: "compaction", encrypted_content: `opaque-${id}` }],
    keptMessages: [kept],
  });
  const entryId = session.appendCompaction(fallbackSummary(id), keptId, 100, details, true);
  const entry = session.getEntry(entryId);
  assert.equal(entry?.type, "compaction");
  return entry;
}

const model = { provider: "openai-codex", api: "openai-codex-responses", id: "test-codex" };
const compactEvent = (entry: ReturnType<typeof remoteCheckpoint>) => ({
  type: "session_compact",
  compactionEntry: entry,
  fromExtension: true,
  willRetry: false,
});

test("healthy starts are quiet in every mode, whether Remote V2 is enabled or disabled", async () => {
  for (const mode of ["tui", "rpc", "print", "json"] as const) {
    for (const enabled of [false, true]) {
      const mock = createMockPi();
      createCodexCompactExtension({
        settingsRuntime: runtime({ settings: { ...DEFAULT_CODEX_COMPACT_SETTINGS, enabled } }),
      })(mock.pi);
      const session = SessionManager.inMemory();
      remoteCheckpoint(session, "already-persisted");
      const current = createMockContext({
        mode,
        hasUI: mode === "tui" || mode === "rpc",
        model,
        sessionManager: session,
      });
      for (const reason of ["startup", "reload", "resume", "new"] as const) {
        await emit(mock, "session_start", { reason }, current.ctx);
        assert.deepEqual(current.notifications, [], `${mode}/${reason}/${enabled}`);
      }
    }
  }
});

test("only the first committed remote checkpoint warns, not native compaction or repeated starts", async () => {
  const mock = createMockPi();
  createCodexCompactExtension({ settingsRuntime: runtime() })(mock.pi);
  const session = SessionManager.inMemory();
  const current = createMockContext({ mode: "tui", hasUI: true, model, sessionManager: session });
  await emit(mock, "session_start", { reason: "startup" }, current.ctx);
  const keptId = session.appendMessage({ role: "user", content: "native task", timestamp: 1 });
  const nativeId = session.appendCompaction("Native readable summary", keptId, 100);
  await emit(mock, "session_compact", { compactionEntry: session.getEntry(nativeId) }, current.ctx);
  assert.deepEqual(current.notifications, []);
  const first = remoteCheckpoint(session, "first-checkpoint");
  await emit(mock, "session_compact", compactEvent(first), current.ctx);
  assert.equal(current.notifications.length, 1);
  assert.equal(current.notifications[0]?.level, "warning");
  assert.match(current.notifications[0]?.message ?? "", /same openai-codex model/);
  await emit(mock, "session_compact", compactEvent(first), current.ctx);
  await emit(mock, "session_start", { reason: "reload" }, current.ctx);
  const second = remoteCheckpoint(session, "second-checkpoint");
  await emit(mock, "session_compact", compactEvent(second), current.ctx);
  assert.equal(current.notifications.length, 1);
});

test("superseded checkpoint events do not warn, and headless success does not consume a later UI notice", async () => {
  const mock = createMockPi();
  createCodexCompactExtension({ settingsRuntime: runtime() })(mock.pi);
  const session = SessionManager.inMemory();
  const headless = createMockContext({ mode: "print", hasUI: false, model, sessionManager: session });
  await emit(mock, "session_start", { reason: "startup" }, headless.ctx);
  const old = remoteCheckpoint(session, "headless");
  await emit(mock, "session_compact", compactEvent(old), headless.ctx);
  assert.deepEqual(headless.notifications, []);
  const current = createMockContext({ mode: "rpc", hasUI: true, model, sessionManager: session });
  await emit(mock, "session_start", { reason: "resume" }, current.ctx);
  const keptId = session.appendMessage({ role: "user", content: "new task", timestamp: 2 });
  session.appendCompaction("Superseding native summary", keptId, 50);
  await emit(mock, "session_compact", compactEvent(old), current.ctx);
  assert.deepEqual(current.notifications, []);
  const next = remoteCheckpoint(session, "interactive");
  await emit(mock, "session_compact", compactEvent(next), current.ctx);
  assert.equal(current.notifications.length, 1);
});

test("genuine invalid-settings and incompatible-checkpoint warnings remain visible", async () => {
  const mock = createMockPi();
  createCodexCompactExtension({ settingsRuntime: runtime({ kind: "invalid", issue: "Invalid enabled setting" }) })(
    mock.pi,
  );
  const session = SessionManager.inMemory();
  remoteCheckpoint(session, "existing");
  const current = createMockContext({ mode: "tui", hasUI: true, model, sessionManager: session });
  await emit(mock, "session_start", { reason: "startup" }, current.ctx);
  assert.equal(current.notifications.length, 1);
  assert.match(current.notifications[0]?.message ?? "", /Invalid pi-codex-compact\.json/);
  const wrongModel = { ...model, id: "different-codex" };
  await emit(mock, "model_select", { model: wrongModel }, current.ctx);
  await emit(mock, "model_select", { model: wrongModel }, current.ctx);
  assert.equal(current.notifications.length, 2);
  assert.match(current.notifications[1]?.message ?? "", /cannot replay on this model/);
});

test("a failed UI notification does not throw after a checkpoint is committed", async () => {
  const mock = createMockPi();
  createCodexCompactExtension({ settingsRuntime: runtime() })(mock.pi);
  const session = SessionManager.inMemory();
  const current = createMockContext({ mode: "tui", hasUI: true, model, sessionManager: session });
  const ctx = current.ctx as ExtensionContext;
  ctx.ui.notify = () => {
    throw new Error("UI disposed");
  };
  const entry = remoteCheckpoint(session, "committed");
  await emit(mock, "session_compact", compactEvent(entry), ctx);
  assert.equal(session.getBranch().at(-1)?.id, entry?.id);
});
