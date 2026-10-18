import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, test, vi } from "vitest";
import { ownedCustom } from "../src/command-owner.js";
import {
  STATUS_ACTION_OPEN,
  STATUS_ACTION_QUERY,
  type StatusActionOpen,
  type StatusActionQuery,
} from "../src/status-actions.js";
import { inspectStatuses } from "../src/status-inspector.js";
import statusline from "../src/statusline.js";
import { createCustomSelectorHarness, createMockContext, createMockPi } from "./support.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  assert.equal(vi.getTimerCount(), 0);
  vi.useRealTimers();
});
function provider(
  mock: ReturnType<typeof createMockPi>,
  options: { surface?: () => string; action?: () => string; delay?: number } = {},
) {
  const opens: StatusActionOpen[] = [];
  mock.eventBus.on(STATUS_ACTION_QUERY, (value) => {
    const request = value as StatusActionQuery;
    const respond = () =>
      mock.eventBus.emit(`${STATUS_ACTION_QUERY}:reply:${request.requestId}`, {
        success: true,
        data: {
          version: 1,
          providerId: "test",
          surfaceId: options.surface?.() ?? "surface",
          sessionId: request.sessionId,
          entries: [
            { statusKey: "second", actionId: options.action?.() ?? "second-detail", label: "Second detail" },
            { statusKey: "first", actionId: "first-detail", label: "First detail" },
          ],
        },
      });
    if (options.delay) setTimeout(respond, options.delay);
    else respond();
  });
  mock.eventBus.on(STATUS_ACTION_OPEN, (value) => {
    const request = value as StatusActionOpen;
    opens.push(request);
    mock.eventBus.emit(`${STATUS_ACTION_OPEN}:reply:${request.requestId}`, { success: true, data: { accepted: true } });
  });
  return opens;
}
function inspectorFixture(
  options: { statuses?: Map<string, string>; keys?: Parameters<typeof createCustomSelectorHarness>[2] } = {},
) {
  const mock = createMockPi();
  const statuses =
    options.statuses ??
    new Map([
      ["first", "one"],
      ["second", "two"],
    ]);
  const controller = new AbortController();
  let harness!: ReturnType<typeof createCustomSelectorHarness>;
  let customCalls = 0;
  let disposed = false;
  const context = createMockContext({
    mode: "tui",
    editorText: "draft stays\nexactly here",
    custom: async (factory: unknown) => {
      customCalls++;
      harness = createCustomSelectorHarness(factory, 80, options.keys);
      try {
        return await harness.resultPromise;
      } finally {
        harness.dispose();
        disposed = true;
      }
    },
  });
  const owner = { signal: controller.signal, isCurrent: () => !controller.signal.aborted };
  const start = () => inspectStatuses(mock.pi, context.ctx, owner, () => statuses);
  return {
    mock,
    statuses,
    controller,
    context,
    owner,
    start,
    get harness() {
      return harness;
    },
    get customCalls() {
      return customCalls;
    },
    get disposed() {
      return disposed;
    },
  };
}

test("exact selected key opens its owner only after selector disposal, preserving the editor draft", async () => {
  const fixture = inspectorFixture();
  const opens = provider(fixture.mock);
  let disposedAtOpen = false;
  fixture.mock.eventBus.on(STATUS_ACTION_OPEN, () => {
    disposedAtOpen = fixture.disposed;
  });
  const pending = fixture.start();
  await vi.advanceTimersByTimeAsync(50);
  fixture.harness.handleInput("tui.select.down");
  fixture.harness.handleInput("tui.select.confirm");
  assert.equal(opens.length, 0);
  await vi.advanceTimersByTimeAsync(50);
  await pending;
  assert.equal(disposedAtOpen, true);
  assert.equal(opens.length, 1);
  assert.equal(opens[0]?.actionId, "second-detail");
  assert.equal(fixture.context.editorText, "draft stays\nexactly here");
  assert.deepEqual(fixture.mock.sentUserMessages, []);
  assert.deepEqual(fixture.mock.sentMessages, []);
  assert.deepEqual(fixture.mock.setModels, []);
  assert.deepEqual(fixture.mock.entries, []);
  assert.deepEqual(fixture.mock.thinkingLevels, []);
  assert.equal(fixture.customCalls, 1);
});

test("noncooperating statuses open sanitized bounded wrapped text inside the same inspector", async () => {
  const fixture = inspectorFixture({
    statuses: new Map([
      ["unknown", `\x1b]8;;https://bad\x07linked\x1b]8;;\x07\x1b[31m text\n\u202e${" long".repeat(2000)}`],
    ]),
  });
  const pending = fixture.start();
  await vi.advanceTimersByTimeAsync(50);
  fixture.harness.handleInput("tui.select.confirm");
  const detail = fixture.harness.render(20);
  assert.match(detail.join(" "), /unknown/);
  assert.match(detail.join(" "), /linked text/);
  for (const unsafe of ["\x1b", "https:", "\u202e"]) assert.ok(!detail.slice(1, -1).join(" ").includes(unsafe));
  assert.ok(detail.every((line) => visibleWidth(line) <= 20));
  fixture.harness.handleInput("tui.select.pageDown");
  const next = fixture.harness.render(20);
  assert.notDeepEqual(next, detail);
  for (const width of [1, 2, 4, 20, 80]) {
    for (const rows of [1, 2, 4, 24]) {
      fixture.harness.setTerminalRows(rows);
      const rendered = fixture.harness.render(width);
      assert.ok(rendered.every((line) => visibleWidth(line) <= width));
      assert.ok(rendered.length <= Math.max(1, rows - 2));
    }
  }
  assert.equal(fixture.customCalls, 1);
  fixture.harness.handleInput("tui.select.cancel");
  await pending;
  assert.equal(fixture.mock.sentUserMessages.length, 0);
});

test("live row removal clears identity; queued Enter never activates the neighboring row", async () => {
  const fixture = inspectorFixture();
  const opens = provider(fixture.mock);
  const pending = fixture.start();
  await vi.advanceTimersByTimeAsync(50);
  // No paint is required to establish the initial selected identity.
  fixture.statuses.delete("first");
  fixture.harness.handleInput("tui.select.confirm");
  await vi.advanceTimersByTimeAsync(100);
  fixture.harness.handleInput("tui.select.confirm");
  assert.equal(opens.length, 0);
  assert.doesNotMatch(fixture.harness.render().join("\n"), /› second/);
  fixture.statuses.set("third", "live newly added row");
  assert.match(fixture.harness.render().join("\n"), /third.*live newly/);
  fixture.harness.handleInput("tui.select.down");
  fixture.harness.handleInput("tui.select.confirm");
  await vi.advanceTimersByTimeAsync(50);
  await pending;
  assert.equal(opens[0]?.actionId, "second-detail");
});

test("empty state, configured keys plus arrows, releases, and delayed discovery are safe", async () => {
  const fixture = inspectorFixture({
    statuses: new Map(),
    keys: {
      matches: (data, key) =>
        ({ "tui.select.up": "k", "tui.select.down": "j", "tui.select.confirm": "x", "tui.select.cancel": "q" })[key] ===
        data,
      getKeys: () => [],
    },
  });
  const opens = provider(fixture.mock, { delay: 25 });
  const pending = fixture.start();
  assert.match(fixture.harness.render().join("\n"), /No extension statuses/);
  fixture.harness.handleInput("x");
  fixture.statuses.set("first", "one");
  fixture.statuses.set("second", "two");
  fixture.harness.handleInput("j");
  fixture.harness.handleInput("x"); // Loading: no fallback and no activation.
  await vi.advanceTimersByTimeAsync(50);
  fixture.harness.handleInput("\x1b[13;1:3u"); // Kitty Enter release.
  assert.equal(opens.length, 0);
  fixture.harness.handleInput("\x1b[B"); // Native arrow despite customized bindings.
  fixture.harness.handleInput("x");
  await vi.advanceTimersByTimeAsync(50);
  await pending;
  assert.equal(opens[0]?.actionId, "second-detail");
});

test("configured confirmation on Up wins over the raw-arrow fallback", async () => {
  const fixture = inspectorFixture({
    keys: {
      matches: (data, key) =>
        ({
          "tui.select.up": "k",
          "tui.select.down": "j",
          "tui.select.confirm": "\x1b[A",
          "tui.select.cancel": "q",
        })[key] === data,
      getKeys: () => [],
    },
  });
  const opens = provider(fixture.mock);
  const pending = fixture.start();
  await vi.advanceTimersByTimeAsync(50);
  fixture.harness.handleInput("\x1b[A");
  await vi.advanceTimersByTimeAsync(50);
  await pending;
  assert.equal(opens.length, 1);
  assert.equal(opens[0]?.actionId, "first-detail");
});

test.each(["surface", "action", "status"])(
  "revalidation suppresses changed %s after selector close",
  async (change) => {
    const fixture = inspectorFixture();
    let surface = "surface";
    let action = "second-detail";
    const opens = provider(fixture.mock, { surface: () => surface, action: () => action });
    const pending = fixture.start();
    await vi.advanceTimersByTimeAsync(50);
    fixture.harness.handleInput("tui.select.down");
    fixture.harness.handleInput("tui.select.confirm");
    if (change === "surface") surface = "replacement";
    if (change === "action") action = "replacement-action";
    if (change === "status") fixture.statuses.delete("second");
    await vi.advanceTimersByTimeAsync(50);
    await pending;
    assert.equal(opens.length, 0);
  },
);

test("abort retires discovery and late replies cannot reopen the inspector", async () => {
  const fixture = inspectorFixture();
  const opens = provider(fixture.mock, { delay: 30 });
  const pending = fixture.start();
  fixture.controller.abort();
  await pending;
  await vi.advanceTimersByTimeAsync(100);
  fixture.harness.handleInput("tui.select.confirm");
  assert.equal(opens.length, 0);
  assert.deepEqual(fixture.context.notifications, []);
});

test("owned custom awaits delayed async mount disposal even if the host resolves cancellation early", async () => {
  const controller = new AbortController();
  let mount!: (component: { render(): string[]; invalidate(): void; dispose(): void }) => void;
  let disposed = 0;
  let settled = false;
  const context = createMockContext({
    custom: (factory: (...args: unknown[]) => unknown) =>
      new Promise((resolve) => {
        void factory({}, {}, {}, resolve);
      }),
  });
  const pending = ownedCustom(context.ctx, { signal: controller.signal, isCurrent: () => true })(
    () =>
      new Promise((resolve) => {
        mount = resolve;
      }),
  );
  void pending.then(() => {
    settled = true;
  });
  controller.abort();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(settled, false);
  mount({
    render: () => [],
    invalidate() {},
    dispose() {
      disposed++;
    },
  });
  await pending;
  assert.equal(disposed, 1);
});

function runtimeFixture(mode = "tui", beforeLoad?: (mock: ReturnType<typeof createMockPi>) => void) {
  const directory = mkdtempSync(join(tmpdir(), "status-inspector-runtime-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  const settingsPath = join(directory, "pi-statusline.json");
  const document = '{"segments":["model"]}\n';
  writeFileSync(settingsPath, document);
  const mock = createMockPi();
  const statuses = new Map([
    ["first", "one"],
    ["second", "two"],
  ]);
  let harness: ReturnType<typeof createCustomSelectorHarness> | undefined;
  let customs = 0;
  const branch = [{ id: "root" }];
  const context = createMockContext({
    mode,
    editorText: "untouched draft",
    sessionManager: {
      getSessionId: () => "session",
      getEntries: () => [],
      getLeafId: () => "root",
      getBranch: () => branch,
    },
    custom: async (factory: unknown) => {
      customs++;
      harness = createCustomSelectorHarness(factory);
      return harness.resultPromise;
    },
  });
  const emit = async (event: string, ctx = context.ctx) => {
    for (const handler of mock.events.get(event) ?? []) await handler({}, ctx);
  };
  let focus: unknown = { isShowingAutocomplete: () => false };
  let overlay = false;
  const tui = { requestRender() {}, getFocusedComponent: () => focus, hasOverlay: () => overlay };
  let footer: { render(width: number): string[]; dispose(): void } | undefined;
  const mount = () => {
    footer = (context.footer as (...args: unknown[]) => NonNullable<typeof footer>)(
      tui,
      { fg: (_color: string, text: string) => text, bold: (text: string) => text },
      { getGitBranch: () => null, getExtensionStatuses: () => statuses, onBranchChange: () => () => {} },
    );
  };
  beforeLoad?.(mock);
  statusline(mock.pi);
  return {
    mock,
    context,
    branch,
    emit,
    mount,
    statuses,
    tui,
    command: () => mock.commands.get("statusline")?.handler("inspect", context.ctx),
    shortcut: () => mock.shortcuts.get("ctrl+alt+s")?.handler(context.ctx),
    get harness() {
      return harness;
    },
    get customs() {
      return customs;
    },
    get footer() {
      return footer;
    },
    set focus(value: unknown) {
      focus = value;
    },
    set overlay(value: boolean) {
      overlay = value;
    },
    async cleanup() {
      await emit("session_shutdown");
      footer?.dispose();
      assert.equal(readFileSync(settingsPath, "utf8"), document, "inspection never writes settings");
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test.each(["provider-first", "consumer-first"])(
  "registered inspector discovers the provider with %s load order",
  async (order) => {
    let opens: StatusActionOpen[] = [];
    const fixture = runtimeFixture(
      "tui",
      order === "provider-first"
        ? (mock) => {
            opens = provider(mock);
          }
        : undefined,
    );
    if (order === "consumer-first") opens = provider(fixture.mock);
    try {
      await fixture.emit("session_start");
      fixture.mount();
      const pending = fixture.command();
      await vi.advanceTimersByTimeAsync(50);
      fixture.harness?.handleInput("tui.select.down");
      fixture.harness?.handleInput("tui.select.confirm");
      await vi.advanceTimersByTimeAsync(50);
      await pending;
      assert.equal(opens[0]?.actionId, "second-detail");
    } finally {
      await fixture.cleanup();
    }
  },
);

test("native shortcut is focus/autocomplete gated; command fallback, repeated opens and footer output stay safe", async () => {
  const fixture = runtimeFixture();
  try {
    await fixture.emit("session_start");
    fixture.mount();
    const before = fixture.footer?.render(80);
    for (const focus of [
      null,
      {},
      { isShowingAutocomplete: true },
      { isShowingAutocomplete: () => true },
      { isShowingAutocomplete: () => undefined },
    ]) {
      fixture.focus = focus;
      await fixture.shortcut();
      assert.equal(fixture.customs, 0);
    }
    fixture.focus = { isShowingAutocomplete: () => false };
    fixture.overlay = true;
    await fixture.shortcut();
    assert.equal(fixture.customs, 0);
    const command = fixture.command(); // Explicit command works even with unknown host focus.
    assert.equal(fixture.customs, 1);
    await fixture.command();
    await fixture.shortcut();
    assert.equal(fixture.customs, 1);
    fixture.harness?.handleInput("tui.select.cancel");
    await command;
    fixture.overlay = false;
    const shortcut = fixture.shortcut();
    assert.equal(fixture.customs, 2);
    fixture.harness?.handleInput("tui.select.cancel");
    await shortcut;
    assert.deepEqual(fixture.footer?.render(80), before);
    assert.equal(fixture.context.editorText, "untouched draft");
    assert.deepEqual(fixture.mock.sentUserMessages, []);
    assert.deepEqual(fixture.mock.setModels, []);
  } finally {
    await fixture.cleanup();
  }
});

test.each([
  "session_before_switch",
  "session_before_tree",
  "session_before_fork",
  "session_shutdown",
  "footer",
  "live-branch",
  "ui-rebind",
  "headless",
  "replacement",
])("%s retires interaction before late Enter or replies", async (boundary) => {
  const fixture = runtimeFixture();
  const opens = provider(fixture.mock, { delay: 30 });
  try {
    await fixture.emit("session_start");
    fixture.mount();
    const pending = fixture.command();
    if (boundary === "footer") fixture.footer?.dispose();
    else if (boundary === "live-branch") {
      fixture.branch[0] = { id: "replacement" };
      fixture.harness?.render();
    } else if (boundary === "ui-rebind") {
      Object.assign(fixture.context.ctx, { ui: createMockContext({ mode: "tui" }).ctx.ui });
      fixture.harness?.render();
    } else if (boundary === "headless") {
      Object.assign(fixture.context.ctx, { mode: "print" });
      fixture.harness?.render();
    } else if (boundary === "replacement")
      await fixture.emit("session_start", createMockContext({ mode: "print" }).ctx);
    else await fixture.emit(boundary);
    await pending;
    await vi.advanceTimersByTimeAsync(100);
    fixture.harness?.handleInput("tui.select.confirm");
    assert.equal(opens.length, 0);
    assert.equal(fixture.context.editorText, "untouched draft");
  } finally {
    await fixture.cleanup();
  }
});

test("append-only branch growth does not retire inspection", async () => {
  const fixture = runtimeFixture();
  try {
    await fixture.emit("session_start");
    fixture.mount();
    const pending = fixture.command();
    fixture.branch.push({ id: "append" });
    await vi.advanceTimersByTimeAsync(100);
    assert.match(fixture.harness?.render().join("\n") ?? "", /Extension statuses/);
    fixture.harness?.handleInput("tui.select.cancel");
    await pending;
  } finally {
    await fixture.cleanup();
  }
});

test.each(["print", "json", "rpc"])("%s inspection and shortcut are entirely silent", async (mode) => {
  const fixture = runtimeFixture(mode);
  try {
    await fixture.emit("session_start");
    await fixture.command();
    await fixture.shortcut();
    assert.equal(fixture.customs, 0);
    assert.deepEqual(fixture.context.notifications, []);
    assert.deepEqual(fixture.mock.sentUserMessages, []);
  } finally {
    await fixture.cleanup();
  }
});
