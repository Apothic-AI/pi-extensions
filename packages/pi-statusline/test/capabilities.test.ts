import assert from "node:assert/strict";
import type { ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { ansiFg, ansiStyle } from "../src/ansi.js";
import { powerlineExtensionSeparator, renderPowerlineStatusline } from "../src/powerline.js";
import {
  prContextFromStatuses,
  type RuntimeState,
  renderExtensionStatusline,
  renderStatusline,
} from "../src/render.js";
import { createDefaultConfig, normalizeStatuslineConfig } from "../src/settings.js";
import { createMockContext } from "./support.js";

test("ANSI helpers retain truecolor defaults and map RGB to the 256-color cube", () => {
  assert.equal(ansiFg("#ff0000", "x"), "\x1b[38;2;255;0;0mx\x1b[0m");
  assert.equal(ansiFg("#ff0000", "x", false), "\x1b[38;5;196mx\x1b[0m");
  assert.equal(ansiStyle("x", { fg: "#000000", bg: "#ffffff" }, false), "\x1b[38;5;16;48;5;231mx\x1b[0m");
  assert.equal(ansiStyle("x", {}, false), "x");
});

test("custom palettes and powerline transitions honor capability without changing layout", () => {
  const config = normalizeStatuslineConfig({
    palette: { model: { fg: "#ff0000", bg: "#000000" }, cwd: { fg: "#00ff00", bg: "#ffffff" } },
  }).config;
  const items = [
    { name: "model", text: "model", block: "header", color: "accent" },
    { name: "cwd", text: "cwd", block: "directory", color: "muted" },
  ] as const;
  const rgb = renderPowerlineStatusline(100, [...items], config);
  const indexed = renderPowerlineStatusline(100, [...items], config, false);
  assert.match(indexed, /38;5;196;48;5;16/u);
  assert.match(indexed, /38;5;16;48;5;231/u);
  assert.match(indexed, /38;5;46;48;5;231/u);
  assert.doesNotMatch(indexed, /(?:38|48);2;/u);
  assert.equal(visibleWidth(rgb), visibleWidth(indexed));
  assert.ok(visibleWidth(renderPowerlineStatusline(12, [...items], config, false)) <= 12);
  const theme = { fg: (_color: string, text: string) => `theme:${text}` } as Theme;
  assert.match(powerlineExtensionSeparator(theme, "tokyo-night", false), /38;5;/u);
  assert.equal(powerlineExtensionSeparator(theme, "classic", false), "theme: · ");
});

test("plain and linked PRs render exactly once, including fallback when branch is absent", () => {
  const link = "\x1b]8;;https://github.com/o/r/pull/7\x07#7\x1b]8;;\x07";
  const theme = { fg: (_color: string, text: string) => text } as Theme;
  const config = createDefaultConfig();
  config.segments = ["branch"];
  const runtime: RuntimeState = {
    turnCount: 0,
    activeTools: new Map(),
    isStreaming: false,
    thinkingLevel: "off",
    duplicateExtensions: [],
    extensionStatusIconAliases: new Map(),
  };
  const context = createMockContext();
  for (const reference of ["#7", link]) {
    const statuses = new Map([["github-pr", `PR ${reference}: checks pending (2), approved`]]);
    let branch: string | null = "main";
    const data: ReadonlyFooterDataProvider = {
      getGitBranch: () => branch,
      getExtensionStatuses: () => statuses,
      onBranchChange: () => () => undefined,
      getAvailableProviderCount: () => 1,
    };
    for (const trueColor of [false, true]) {
      const main = renderStatusline(100, context.ctx, data, theme, config, runtime, trueColor);
      assert.match(main, /2 pending/u);
      assert.deepEqual(renderExtensionStatusline(100, data, theme, config, runtime, main, trueColor), []);
      assert.equal((main.match(/#7/gu) ?? []).length, 1);
      branch = null;
      const noBranch = renderStatusline(100, context.ctx, data, theme, config, runtime, trueColor);
      const fallback = renderExtensionStatusline(200, data, theme, config, runtime, noBranch, trueColor).join("");
      assert.equal((fallback.match(/#7/gu) ?? []).length, 1);
      branch = "main";
    }
  }
});

test("malformed plain PR references do not become inline context", () => {
  for (const value of [
    "PR gh missing",
    "PR #7",
    "PR #7 checks passing",
    "PR #7x: approved",
    "x PR #7: approved",
    "PR #-7: approved",
    "PR #7.1: approved",
    "PR  #7: approved",
    "PR\n#7: approved",
    "PR #7: unknown",
    "PR \x1b]8;;https://example.test\x07#7: approved",
  ]) {
    assert.equal(prContextFromStatuses(new Map([["github-pr", value]])), undefined, value);
  }
});
