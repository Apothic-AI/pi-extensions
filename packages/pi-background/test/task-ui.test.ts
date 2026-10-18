import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as utilities from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type JobManager, type JobSnapshot, LIMITS } from "../src/contracts.js";
import { createJobManager } from "../src/manager.js";
import { BackgroundView, showBackgroundUI, UI_LOG_BYTES } from "../src/task-ui.js";
import { nativeUIFixture } from "./tui-fixture.js";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  vi.restoreAllMocks();
});

function job(id: string, terminal = false): JobSnapshot {
  return {
    id,
    command: `echo ${id}`,
    cwd: "/workspace",
    description: id,
    status: terminal ? "exited" : "running",
    startedAt: 1,
    endedAt: terminal ? 2 : undefined,
    exitCode: terminal ? 0 : undefined,
    attention: "off",
    droppedBytes: 7,
  };
}

function fixture(ids = ["one", "two"], fullscreen = true, id?: string, keys?: utilities.KeybindingsManager) {
  const native = nativeUIFixture(fullscreen);
  cleanup.push(native.dispose);
  let jobs = ids.map((value) => job(value));
  let logs = Array.from({ length: 60 }, (_, index) => `line-${index}`).join("\n");
  let alive = true;
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of [...listeners]) listener();
  };
  const manager: JobManager = {
    subscribe: vi.fn((listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
    start: vi.fn(async () => {
      throw new Error("not used");
    }),
    watch: vi.fn((value) => manager.get(value)),
    list: () => jobs,
    get: (value) => {
      const found = jobs.find((item) => item.id === value);
      if (!found) throw new Error("Unknown job");
      return found;
    },
    logs: vi.fn((_id, _tail, stream) => ({ text: stream === "stderr" ? "stderr-only" : logs, droppedBytes: 7 })),
    stop: vi.fn(async (value) => {
      const found = manager.get(value);
      found.status = "stopped";
      found.endedAt = 3;
      changed();
      return found;
    }),
    clear: vi.fn((value) => {
      jobs = jobs.filter((item) => item.id !== value);
      changed();
      return 1;
    }),
    shutdown: vi.fn(async () => {}),
  };
  const done = vi.fn();
  const cancel = vi.fn();
  const release = vi.fn();
  const view = new BackgroundView(
    native.tui,
    native.theme,
    utilities,
    {
      manager,
      live: () => alive,
      cancel,
      mount: () => release,
    },
    done,
    id,
    keys,
  );
  cleanup.push(() => view.dispose());
  const text = () => view.render(native.terminal.columns).join("\n");
  return {
    native,
    view,
    manager,
    listeners,
    changed,
    done,
    cancel,
    release,
    text,
    setJobs: (values: JobSnapshot[]) => {
      jobs = values;
      changed();
    },
    setLogs: (value: string) => {
      logs = value;
      changed();
    },
    retire: () => {
      alive = false;
      changed();
    },
  };
}

describe("explicit background task UI", () => {
  it.each([true, false])(
    "preserves every ASCII cell through native width-one scrolling (fullscreen=%s)",
    async (fullscreen) => {
      const h = fixture(["one"], fullscreen, "one");
      h.setLogs("abcdef");
      h.native.resize(1, 4); // two compact headers, one log cell, reserved footer space
      h.view.mount();
      const viewing = h.native.ui.custom(
        (_tui, _theme, _keys, done) => {
          h.done.mockImplementation(() => done(undefined));
          return h.view;
        },
        {
          overlay: true,
          overlayOptions: { width: "100%", maxHeight: "100%", margin: 0, anchor: "center" },
        },
      );
      await vi.waitFor(() => expect(h.native.component()).toBe(h.view));
      h.native.key("\x1b[H");
      const cells: string[] = [];
      for (let i = 0; i < 6; i++) {
        cells.push(utilities.stripTerminalSequences(h.native.render()[2]).trim());
        h.native.key("\x1b[B");
      }
      expect(cells.join("")).toBe("abcdef");
      // Oversized graphemes get an explicit placeholder without consuming neighbors.
      h.native.key("\x1b[F");
      h.setLogs("a中b😀c");
      h.native.render();
      h.native.key("\x1b[H");
      const mixed: string[] = [];
      for (let i = 0; i < 5; i++) {
        mixed.push(utilities.stripTerminalSequences(h.native.render()[2]).trim());
        h.native.key("\x1b[B");
      }
      expect(mixed.join("")).toBe("a?b?c");
      h.native.resize(40, 12);
      h.native.key("\x1b[H");
      expect(h.native.render().join("\n")).toContain("a中b😀c");
      h.view.close();
      await viewing;
    },
  );

  it.each(["lines", "bytes"])(
    "keeps a bounded paused snapshot stable across rolling %s, duplicates and rewrap",
    (cap) => {
      const h = fixture(["one"], true, "one");
      h.view.mount();
      const line = (i: number) => (i % 3 === 0 ? "repeated" : `line-${i}-${"a".repeat(cap === "bytes" ? 90 : 0)}`);
      const window = (start: number) => Array.from({ length: 1000 }, (_, i) => line(start + i)).join("\n");
      h.setLogs(window(0));
      h.text();
      h.view.handleInput("\x1b[H");
      for (let i = 0; i < 500; i++) h.view.handleInput("\x1b[B");
      const before = h.view.render(100).slice(2, 11);
      const reads = vi.mocked(h.manager.logs).mock.calls.length;
      for (const start of [1, 8, 100, 1500]) {
        h.setLogs(window(start));
        expect(h.view.render(100).slice(2, 11)).toEqual(before);
      }
      expect(h.text()).toContain("snapshot");
      h.native.terminal.columns = 40;
      expect(h.view.render(40)[2]).toContain(before[0].slice(0, 30));
      h.native.terminal.columns = 100;
      expect(h.view.render(100).slice(2, 11)).toEqual(before);
      expect(vi.mocked(h.manager.logs).mock.calls.length).toBe(reads);
      h.view.handleInput("\x1b[F");
      expect(h.text()).toContain("line-2498");
      expect(h.text()).not.toContain("snapshot");
      h.view.handleInput("f");
      h.text();
      h.setLogs("fresh-output");
      h.view.handleInput("f");
      expect(h.text()).toContain("fresh-output");
    },
  );

  it.each([true, false])(
    "uses a full public overlay above host chrome with encoded paging (fullscreen=%s)",
    async (fullscreen) => {
      const selected = "b3fb95b7-df76-44a2-bb85-5f2d85c8a11c";
      const h = fixture([selected], fullscreen);
      const ctx = { mode: "tui", hasUI: true, ui: h.native.ui } as unknown as ExtensionContext;
      const viewing = showBackgroundUI(ctx, {
        manager: h.manager,
        live: () => true,
        cancel: h.cancel,
        mount: () => () => {},
      });
      await vi.waitFor(() => expect(h.native.component()).toBeDefined());
      for (const [width, height] of [
        [80, 24],
        [40, 12],
      ]) {
        h.native.resize(width, height);
        let screen = h.native.render().map(utilities.stripTerminalSequences).join("\n");
        expect(screen).toContain("Background tasks");
        expect(screen).toContain("> running");
        expect(screen).not.toContain("ID:");
        expect(h.native.overlayBounds()).toMatchObject({ col: 0, width });
        expect(h.native.overlayBounds()?.height).toBeLessThanOrEqual(height);
        for (const control of ["Enter details", "x stop", "d clear", "Esc close"]) expect(screen).toContain(control);
        h.native.key("x");
        screen = h.native.render().map(utilities.stripTerminalSequences).join("\n");
        expect(screen).toContain("y confirms");
        h.native.key("n");
        h.native.key("\r");
        screen = h.native.render().map(utilities.stripTerminalSequences).join("\n");
        expect(screen).toContain("Background details");
        expect(screen).toContain("Logs: Enter/l");
        h.native.key("\r");
        screen = h.native.render().map(utilities.stripTerminalSequences).join("\n");
        expect(screen).toContain("Background logs");
        expect(screen).toContain("line-59");
        for (const control of ["f follow", "s stream", "x stop", "d clear", "Esc details"])
          expect(screen).toContain(control);
        h.native.key("\x1b[H");
        const first = h.native
          .render()
          .map(utilities.stripTerminalSequences)
          .filter((row) => row.trim().startsWith("line-"));
        expect(first[0]?.trim()).toBe("line-0");
        h.native.key("\x1b[6~");
        const second = h.native
          .render()
          .map(utilities.stripTerminalSequences)
          .filter((row) => row.trim().startsWith("line-"));
        expect(second[0]?.trim()).toBe(`line-${first.length}`);
        h.native.key("\x1b[5~");
        expect(h.native.render().join("\n")).toContain("line-0");
        h.native.key("\x1b[F");
        expect(h.native.render().join("\n")).toContain("line-59");
        h.native.key("\x1b");
        expect(h.native.render().join("\n")).toContain("Background details");
        h.native.key("\x1b");
        h.setJobs([job(selected, true)]);
        h.native.key("d");
        screen = h.native.render().map(utilities.stripTerminalSequences).join("\n");
        expect(screen).toContain("Clear");
        expect(screen).toContain("y confirms");
        expect(screen).toContain("other keys cancel");
        h.native.key("n");
        h.setJobs([job(selected)]);
      }
      expect(h.native.custom).toHaveBeenCalledWith(expect.any(Function), {
        overlay: true,
        overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%", margin: 0 },
      });
      h.native.key("\x1b");
      await viewing;
      expect(h.native.render().join("\n")).toContain("Host draft");
    },
  );
  it("has no subscription in construction and releases exactly once on close/dispose", () => {
    const h = fixture();
    expect(h.manager.subscribe).not.toHaveBeenCalled();
    h.view.mount();
    expect(h.listeners.size).toBe(1);
    const late = [...h.listeners][0];
    h.view.close();
    h.view.close();
    h.view.dispose();
    expect(h.listeners.size).toBe(0);
    expect(h.release).toHaveBeenCalledOnce();
    expect(h.done).toHaveBeenCalledOnce();
    const render = vi.spyOn(h.native.tui, "requestRender");
    render.mockClear();
    late();
    h.view.handleInput("x");
    expect(render).not.toHaveBeenCalled();
    expect(h.view.render(80)).toEqual([]);
  });

  it("navigates by stable ID through updates, insertion and removal", () => {
    const h = fixture(Array.from({ length: 25 }, (_, index) => `job-${index}`));
    h.view.mount();
    h.text();
    h.view.handleInput("\x1b[B");
    expect(h.text()).toMatch(/> running \S+ job-1 ·/);
    h.setJobs([job("insert"), ...Array.from({ length: 25 }, (_, index) => job(`job-${index}`))]);
    expect(h.text()).toMatch(/> running \S+ job-1 ·/);
    const visible = h.view.render(100).filter((line) => /^. running /.test(line)).length;
    h.view.handleInput("\x1b[6~");
    expect(h.text()).toMatch(new RegExp(`> running \\S+ job-${1 + visible} ·`));
    h.view.handleInput("\x1b[F");
    expect(h.text()).toMatch(/> running \S+ job-24 ·/);
    h.view.handleInput("\x1b[H");
    expect(h.text()).toMatch(/> running \S+ insert ·/);
    h.setJobs([job("other")]);
    expect(h.text()).toContain("Selected job was removed");
    expect(h.text()).not.toContain("> running");
    h.setJobs([]);
    expect(h.text()).toContain("No background jobs");
  });

  it.each(["\r", "x", "d"])("consumes stale %j activation after eviction until deliberate navigation", (activation) => {
    const h = fixture();
    h.setJobs([job("one", true), job("two", true)]);
    h.text();
    // No intervening render: the activation itself must re-read identity.
    h.setJobs([job("two", true)]);
    h.view.handleInput(activation);
    h.view.handleInput("y");
    expect(h.text()).toContain("Background tasks");
    expect(h.text()).toContain("Selected job was removed");
    expect(h.text()).not.toMatch(/^>/m);
    expect(h.manager.logs).not.toHaveBeenCalled();
    expect(h.manager.stop).not.toHaveBeenCalled();
    expect(h.manager.clear).not.toHaveBeenCalled();
    // Neither insertion nor repeated render reselects a fallback neighbor.
    h.setJobs([job("insert", true), job("two", true)]);
    h.text();
    h.view.handleInput("\r");
    expect(h.text()).toContain("Background tasks");
    h.view.handleInput("\x1b[B");
    h.view.handleInput("\r");
    expect(h.text()).toContain("Background details");
    expect(h.text()).toContain("ID: insert");
  });

  it.each(["list", "details", "logs"])(
    "cancels vanished confirmation in %s without controlling a neighbor",
    (screen) => {
      const h = fixture();
      h.text();
      if (screen !== "list") h.view.handleInput("\r");
      if (screen === "logs") h.view.handleInput("\r");
      h.text();
      h.view.handleInput("x");
      h.setJobs([job("two")]);
      h.view.handleInput("y");
      expect(h.manager.stop).not.toHaveBeenCalled();
      expect(h.manager.clear).not.toHaveBeenCalled();
      expect(h.text()).toContain("Background tasks");
      expect(h.text()).toContain("Selected job was removed");
      expect(h.text()).not.toMatch(/^>/m);
    },
  );

  it("keeps a compact description-first roster at 40 columns without full-height padding", () => {
    const h = fixture(["c112faba-f2cb-4b13-9eef-6fac792a8db9"]);
    h.native.resize(40, 24);
    h.setJobs([
      {
        ...job("c112faba-f2cb-4b13-9eef-6fac792a8db9"),
        startedAt: Date.now() - 42_000,
        description: "Repository checks",
      },
    ]);
    const rows = h.view.render(40);
    expect(rows[0]).toBe("Background tasks · 1 running / 0 done");
    expect(rows[1]).toContain("Jobs 1-1/1");
    expect(rows[2]).toMatch(/^> running 42s Repository checks/);
    expect(rows.join("\n")).not.toContain("ID:");
    expect(rows.length).toBeLessThan(12);
    expect(rows).not.toContain("");
  });

  it("preserves selected and top-row identities through detail/log back navigation and insertions", () => {
    const h = fixture(Array.from({ length: 30 }, (_, i) => `job-${i}`));
    h.native.resize(40, 12);
    h.text();
    for (let i = 0; i < 12; i++) {
      h.view.handleInput("\x1b[B");
      h.text();
    }
    const roster = () => h.view.render(40).filter((line) => /^[ >] running /.test(line));
    const before = roster();
    expect(before.at(-1)).toMatch(/^> running \S+ job-12/);
    h.view.handleInput("\r");
    h.text();
    h.view.handleInput("l");
    h.text();
    h.view.handleInput("\x1b[H");
    h.view.handleInput("\x1b");
    expect(h.text()).toContain("Background details");
    h.view.handleInput("\x1b");
    expect(roster()).toEqual(before);
    h.setJobs([job("insert"), ...Array.from({ length: 30 }, (_, i) => job(`job-${i}`))]);
    expect(roster()).toEqual(before);
    // Removing a row before the viewport preserves its first visible identity.
    h.setJobs(Array.from({ length: 30 }, (_, i) => job(`job-${i}`)));
    expect(roster()).toEqual(before);
    h.view.handleInput("\x1b");
    expect(h.done).toHaveBeenCalledOnce();
  });

  it("wraps and scrolls full sanitized metadata and restores the detail source on resize/back", () => {
    const id = "c112faba-f2cb-4b13-9eef-6fac792a8db9";
    const h = fixture([id]);
    h.native.resize(40, 12);
    h.setJobs([
      {
        ...job(id, true),
        description: "Repository checks",
        command: `printf '${Array.from({ length: 35 }, (_, i) => `part-${i}`).join(" ")} command-end'`,
        cwd: `/workspace/${"long-directory/".repeat(20)}cwd-end`,
        error: `\x1b]52;c;SECRET\x07${"failure-detail ".repeat(12)}error-end`,
      },
    ]);
    h.text();
    h.view.handleInput("\r");
    const detailRows = () => {
      const rows = h.view.render(40);
      const range = /Lines (\d+)-(\d+)\//.exec(rows[1]);
      if (!range) throw new Error("Missing detail position indicator");
      return rows.slice(2, 3 + Number(range[2]) - Number(range[1]));
    };
    const collected: string[] = [];
    for (let i = 0; i < 70; i++) {
      collected.push(...detailRows());
      h.view.handleInput("\x1b[B");
    }
    const text = collected.join("\n");
    for (const value of [
      "Command:",
      "command-end",
      "Cwd:",
      "cwd-end",
      "Status: exited",
      "Exit: 0",
      "Dropped: 7 bytes",
      "Error:",
      "error-end",
    ])
      expect(text).toContain(value);
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("\x1b");
    h.view.handleInput("\x1b[H");
    h.text();
    const identityRows = h.view.render(40).slice(2).join("\n");
    expect(identityRows).toContain(`ID: ${id}`);
    for (let i = 0; i < 12; i++) {
      h.view.handleInput("\x1b[B");
      h.text();
    }
    const before = detailRows();
    h.native.terminal.columns = 20;
    h.view.render(20);
    h.native.terminal.columns = 40;
    expect(detailRows()).toEqual(before);
    h.view.handleInput("l");
    h.text();
    h.view.handleInput("\x1b");
    expect(detailRows()).toEqual(before);
  });

  it("preserves an unrounded detail source anchor through non-divisible resize round trips", () => {
    const h = fixture(["one"]);
    h.setJobs([{ ...job("one", true), command: `${"a".repeat(40)}B${"c".repeat(160)}` }]);
    h.native.resize(40, 12);
    h.text();
    h.view.handleInput("\r");
    for (let index = 0; index < 20 && !h.view.render(40)[2]?.includes("B"); index++) {
      h.view.handleInput("\x1b[B");
    }
    const before = h.view.render(40).slice(2, 6);
    expect(before[0]).toContain("B");
    for (const width of [30, 19, 40, 31, 40]) h.view.render(width);
    expect(h.view.render(40).slice(2, 6)).toEqual(before);
  });

  it("passes native custom keybindings and gives configured selection actions priority over fixed controls", async () => {
    const h = fixture(Array.from({ length: 30 }, (_, i) => `job-${i}`));
    const nativeCustom = h.native.ui.custom;
    const custom: ExtensionContext["ui"]["custom"] = (factory, options) =>
      nativeCustom((tui, theme, keys, done) => {
        // The fixture injects a base manager with no definitions; supply the
        // host's native TUI definitions and user configuration for this screen.
        const configured = new utilities.KeybindingsManager(utilities.TUI_KEYBINDINGS, {
          "tui.select.up": "k",
          "tui.select.down": "x",
          "tui.select.confirm": "f",
          "tui.select.cancel": "q",
          "tui.select.pageUp": "u",
          "tui.select.pageDown": "d",
        });
        return factory(tui, theme, configured as unknown as typeof keys, done);
      }, options);
    const ctx = { mode: "tui", hasUI: true, ui: { ...h.native.ui, custom } } as unknown as ExtensionContext;
    const viewing = showBackgroundUI(ctx, {
      manager: h.manager,
      live: () => true,
      cancel: h.cancel,
      mount: () => h.release,
    });
    await vi.waitFor(() => expect(h.native.component()).toBeDefined());
    h.native.key("x");
    expect(h.native.render().join("\n")).toMatch(/> running \S+ job-1 ·/);
    expect(h.native.render().join("\n")).toContain("f details");
    h.native.key("d");
    expect(h.native.render().join("\n")).not.toContain("job-1 ·");
    h.native.key("u");
    h.native.key("k");
    expect(h.native.render().join("\n")).toMatch(/> running \S+ job-0 ·/);
    h.native.key("f");
    expect(h.native.render().join("\n")).toContain("Background details");
    h.native.key("f");
    expect(h.native.render().join("\n")).toContain("Background logs");
    h.native.key("d");
    expect(h.native.render().join("\n")).toContain("snapshot");
    h.native.key("q");
    expect(h.native.render().join("\n")).toContain("Background details");
    h.native.key("q");
    expect(h.native.render().join("\n")).toContain("Background tasks");
    h.native.key("q");
    await viewing;
    expect(h.manager.stop).not.toHaveBeenCalled();
    expect(h.manager.clear).not.toHaveBeenCalled();
  });

  it.each(["list", "details", "logs"])("keeps widths 1/2/40 and rows 1/2/24 bounded and escapable in %s", (screen) => {
    for (const width of [1, 2, 40])
      for (const height of [1, 2, 24]) {
        const h = fixture();
        h.native.resize(width, height);
        h.text();
        if (screen !== "list") h.view.handleInput("\r");
        if (screen === "logs") h.view.handleInput("\r");
        const rows = h.view.render(width);
        expect(rows.length).toBeLessThanOrEqual(height);
        expect(rows.every((row) => utilities.visibleWidth(row) <= width)).toBe(true);
        for (let i = 0; i < (screen === "list" ? 1 : screen === "details" ? 2 : 3); i++) h.view.handleInput("\x1b");
        expect(h.done).toHaveBeenCalledOnce();
      }
  });

  it("owns elapsed refresh only while mounted and needed and disposes its timer exactly once", () => {
    const h = fixture();
    const interval = vi.spyOn(globalThis, "setInterval");
    const clear = vi.spyOn(globalThis, "clearInterval");
    const render = vi.spyOn(h.native.tui, "requestRender");
    h.text();
    expect(interval).not.toHaveBeenCalled();
    h.view.mount();
    h.view.mount();
    expect(interval).toHaveBeenCalledOnce();
    expect(interval.mock.calls[0][1]).toBe(1000);
    const tick = interval.mock.calls[0][0] as () => void;
    render.mockClear();
    tick();
    expect(render).toHaveBeenCalledOnce();
    expect(h.manager.logs).not.toHaveBeenCalled();
    h.view.handleInput("\r");
    expect(interval).toHaveBeenCalledOnce();
    h.view.handleInput("l");
    expect(clear).toHaveBeenCalledWith(interval.mock.results[0].value);
    h.view.handleInput("\x1b");
    expect(interval).toHaveBeenCalledTimes(2);
    h.setJobs([job("one", true), job("two", true)]);
    expect(clear).toHaveBeenCalledWith(interval.mock.results[1].value);
    h.setJobs([job("one"), job("two", true)]);
    expect(interval).toHaveBeenCalledTimes(3);
    const lastTick = interval.mock.calls[2][0] as () => void;
    h.view.close();
    h.view.dispose();
    expect(clear.mock.calls.filter(([timer]) => timer === interval.mock.results[2].value)).toHaveLength(1);
    render.mockClear();
    lastTick();
    expect(render).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledOnce();
  });

  it("scrolls live logs, follows End/tail and switches both/stdout/stderr", () => {
    const h = fixture(["one"], true, "one");
    h.view.mount();
    expect(h.text()).toContain("line-59");
    h.view.handleInput("\x1b[H");
    expect(h.text()).toContain("line-0\n");
    h.setLogs(Array.from({ length: 80 }, (_, index) => `line-${index}`).join("\n"));
    expect(h.text()).toContain("line-0\n");
    expect(h.text()).not.toContain("line-79\n");
    const visible = h.view.render(100).filter((line) => line.startsWith("line-")).length;
    h.view.handleInput("\x1b[6~");
    expect(h.text()).toContain(`line-${visible}\n`);
    h.view.handleInput("\x1b[5~");
    expect(h.text()).toContain("line-0\n");
    h.view.handleInput("\x1b[F");
    expect(h.text()).toContain("line-79");
    h.view.handleInput("s");
    h.text();
    expect(h.manager.logs).toHaveBeenLastCalledWith("one", 1000, "stdout");
    h.view.handleInput("s");
    expect(h.text()).toContain("stderr-only");
    h.view.handleInput("s");
    expect(h.text()).toContain("Stream: both");
    h.view.handleInput("f");
    expect(h.text()).toContain("scroll paused");
    h.view.handleInput("\x1b");
    expect(h.text()).toContain("Background details");
    h.view.handleInput("\x1b");
    expect(h.text()).toContain("Background tasks");
  });

  it.each([true, false])(
    "bounds terminal-height layout and sanitizes before wrapping (fullscreen=%s)",
    (fullscreen) => {
      const h = fixture(["one"], fullscreen, "one");
      h.view.mount();
      const wrap = vi.fn(utilities.wrapTextWithAnsi);
      const view = new BackgroundView(
        h.native.tui,
        h.native.theme,
        { ...utilities, wrapTextWithAnsi: wrap },
        {
          manager: h.manager,
          live: () => true,
          cancel: h.cancel,
          mount: () => () => {},
        },
        () => {},
        "one",
      );
      cleanup.push(() => view.dispose());
      h.setLogs(`${"x".repeat(UI_LOG_BYTES * 4)}\x1b]52;c;SECRET\x07中😀\x1bPqhidden\x1b\\safe\x9b31m\x7f\n`);
      for (const width of [1, 2, 4, 20, 40, 80]) {
        for (const height of [1, 2, 4, 16, 24]) {
          h.native.terminal.rows = height;
          const lines = view.render(width);
          expect(lines.length).toBeLessThanOrEqual(height);
          expect(lines.every((line) => utilities.visibleWidth(line) <= width)).toBe(true);
          for (const forbidden of ["SECRET", "hidden", "\x1b", "\x9b", "\x7f"]) {
            // Pi's clipping helper adds its own harmless SGR reset.
            expect(lines.join("\n").replaceAll("\x1b[0m", "")).not.toContain(forbidden);
          }
        }
      }
      expect(wrap.mock.calls.every(([text]) => Buffer.byteLength(text) <= UI_LOG_BYTES)).toBe(true);
      expect(wrap.mock.calls.every(([text]) => !text.includes("\x1b"))).toBe(true);
    },
  );

  it("confirms only x then non-repeat y and targets exactly the captured owned job", async () => {
    const h = fixture();
    h.view.mount();
    h.text();
    h.view.handleInput("x");
    h.view.handleInput("x");
    h.view.handleInput("y");
    expect(h.manager.stop).not.toHaveBeenCalled();
    h.view.handleInput("x");
    h.view.handleInput("\x1b[121;1:2u");
    expect(h.manager.stop).not.toHaveBeenCalled();
    h.view.handleInput("x");
    h.setJobs([job("insert"), job("two"), job("one")]);
    h.view.handleInput("y");
    await vi.waitFor(() => expect(h.manager.stop).toHaveBeenCalledWith("one"));
    expect(h.manager.stop).toHaveBeenCalledOnce();
    expect(h.cancel).toHaveBeenCalledWith("one");
    expect(h.text()).toMatch(/> stopped \S+ one ·/);
  });

  it("requires confirmed terminal state for clear; repeating d/Enter never confirms", async () => {
    const h = fixture(["one"]);
    h.view.mount();
    h.text();
    h.view.handleInput("d");
    h.view.handleInput("y");
    expect(h.manager.clear).not.toHaveBeenCalled();
    h.setJobs([job("one", true), job("two")]);
    h.view.handleInput("d");
    h.view.handleInput("\r");
    expect(h.manager.clear).not.toHaveBeenCalled();
    h.view.handleInput("d");
    h.view.handleInput("d");
    h.view.handleInput("y");
    expect(h.manager.clear).not.toHaveBeenCalled();
    h.view.handleInput("d");
    h.view.handleInput("y");
    await vi.waitFor(() => expect(h.manager.clear).toHaveBeenCalledWith("one"));
    expect(h.cancel).toHaveBeenCalledWith("one");
    expect(h.text()).toContain("Selected job was removed");
    expect(h.text()).not.toContain("> running");
  });

  it.each(["list", "details", "logs"])(
    "requires distinct, non-repeat confirmation for stop and clear in %s",
    async (screen) => {
      const h = fixture(["one"]);
      h.text();
      if (screen !== "list") h.view.handleInput("\r");
      if (screen === "logs") h.view.handleInput("l");
      h.text();
      h.view.handleInput("\x1b[120;1:2u"); // Encoded repeat x cannot even arm stop.
      h.view.handleInput("y");
      expect(h.manager.stop).not.toHaveBeenCalled();
      h.view.handleInput("x");
      h.view.handleInput("\r");
      expect(h.manager.stop).not.toHaveBeenCalled();
      h.view.handleInput("x");
      h.view.handleInput("\x1b[121;1:2u");
      expect(h.manager.stop).not.toHaveBeenCalled();
      h.view.handleInput("x");
      h.view.handleInput("y");
      await vi.waitFor(() => expect(h.manager.stop).toHaveBeenCalledOnce());
      // Wait for the async stop's finally block to release action ownership.
      await Promise.resolve();
      h.view.handleInput("\x1b[100;1:2u");
      h.view.handleInput("y");
      expect(h.manager.clear).not.toHaveBeenCalled();
      h.view.handleInput("d");
      h.view.handleInput("d");
      h.view.handleInput("y");
      expect(h.manager.clear).not.toHaveBeenCalled();
      h.view.handleInput("d");
      h.view.handleInput("\x1b[121;1:2u");
      expect(h.manager.clear).not.toHaveBeenCalled();
      h.view.handleInput("d");
      h.view.handleInput("y");
      expect(h.manager.clear).toHaveBeenCalledExactlyOnceWith("one");
      expect(h.text()).toContain("Selected job was removed");
    },
  );

  it("awaits confirmed stop, preserves selection on failure and allows deliberate retry", async () => {
    const h = fixture();
    h.view.mount();
    h.text();
    let reject!: (error: Error) => void;
    vi.mocked(h.manager.stop).mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    h.view.handleInput("x");
    h.view.handleInput("y");
    expect(h.text()).toContain("Waiting for confirmed stop: one");
    h.view.handleInput("\x1b[B");
    expect(h.text()).toMatch(/> running \S+ one ·/);
    reject(new Error("temporary stop failure"));
    await vi.waitFor(() => expect(h.text()).toContain("temporary stop failure"));
    expect(h.text()).toMatch(/> running \S+ one ·/);
    h.view.handleInput("x");
    h.view.handleInput("y");
    await vi.waitFor(() => expect(h.manager.get("one").endedAt).toBeDefined());
    expect(h.manager.stop).toHaveBeenCalledTimes(2);
  });

  it("closes at ownership divergence and ignores saved/late IO and async stop results", async () => {
    const h = fixture();
    h.view.mount();
    h.text();
    const late = [...h.listeners][0];
    let resolve!: (job: JobSnapshot) => void;
    vi.mocked(h.manager.stop).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    h.view.handleInput("x");
    h.view.handleInput("y");
    h.retire();
    expect(h.done).toHaveBeenCalledOnce();
    expect(h.listeners.size).toBe(0);
    const render = vi.spyOn(h.native.tui, "requestRender");
    render.mockClear();
    resolve(job("one", true));
    await Promise.resolve();
    late();
    h.view.handleInput("x");
    h.view.handleInput("y");
    expect(render).not.toHaveBeenCalled();
    expect(h.manager.stop).toHaveBeenCalledOnce();
    expect(h.view.render(80)).toEqual([]);
  });

  it.each([true, false])(
    "uses real native output/drop bytes and confirmed stop in public custom UI (fullscreen=%s)",
    async (fullscreen) => {
      const native = nativeUIFixture(fullscreen);
      cleanup.push(native.dispose);
      const events = vi.fn();
      const manager = createJobManager(events);
      cleanup.push(() => manager.shutdown());
      const started = await manager.start({
        command: "printf '%300000s' x; printf 'stderr-marker\\n' >&2; sleep 20",
        cwd: process.cwd(),
        attention: "off",
      });
      await vi.waitFor(() => expect(manager.get(started.id).droppedBytes).toBeGreaterThan(0));
      const cancel = vi.fn();
      const ctx = { mode: "tui", hasUI: true, ui: native.ui } as unknown as ExtensionContext;
      const viewing = showBackgroundUI(ctx, { manager, live: () => true, cancel, mount: () => () => {} }, started.id);
      await vi.waitFor(() => expect(native.component()).toBeDefined());
      expect(native.render().join("\n")).toContain("Background logs");
      expect(native.render().join("\n")).toContain("dropped=");
      native.key("s");
      native.key("s");
      expect(native.render().join("\n")).toContain("stderr-marker");
      native.resize(2, 3);
      expect(native.render().every((line) => utilities.visibleWidth(line) <= 2)).toBe(true);
      native.resize(100, 16);
      native.key("x");
      native.key("y");
      await vi.waitFor(() => expect(manager.get(started.id).endedAt).toBeDefined());
      expect(manager.get(started.id).status).toBe("stopped");
      expect(cancel).toHaveBeenCalledWith(started.id);
      expect(events).not.toHaveBeenCalled();
      expect(Buffer.byteLength(manager.logs(started.id).text)).toBeLessThanOrEqual(LIMITS.logBytes);
      native.key("\x1b");
      expect(native.render().join("\n")).toContain("Background details");
      native.key("\x1b");
      expect(native.render().join("\n")).toContain("Background tasks");
      native.key("\x1b");
      await viewing;
      expect(native.component()).toBeUndefined();
    },
  );
});
