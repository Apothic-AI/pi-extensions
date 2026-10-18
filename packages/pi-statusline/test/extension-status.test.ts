import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import {
  buildExtensionStatusIconAliases,
  findDuplicateExtensions,
  formatExtensionStatus,
  formatExtensionStatuses,
  readInstalledExtensionPackages,
  stripStatusColor,
  wrapExtensionStatusline,
} from "../src/extension-status.js";
import { prContextFromStatuses, type RuntimeState, renderExtensionStatusline } from "../src/render.js";
import { createDefaultConfig } from "../src/settings.js";

test("installed package discovery uses the configured Pi agent directory", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-statusline-agent-dir-"));
  const agentDir = join(root, "configured-agent");
  const homeDir = join(root, "unrelated-home");
  const homeAgentDir = join(homeDir, ".pi", "agent");
  const projectDir = join(root, "project");
  const projectSettingsDir = join(projectDir, ".pi");
  const localExtensionDir = join(projectDir, "local-foo");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousHome = process.env.HOME;

  mkdirSync(agentDir, { recursive: true });
  mkdirSync(homeAgentDir, { recursive: true });
  mkdirSync(projectSettingsDir, { recursive: true });
  mkdirSync(localExtensionDir, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:@test/pi-foo@1.0.0"] }));
  writeFileSync(join(homeAgentDir, "settings.json"), JSON.stringify({ packages: ["npm:@test/pi-home-only@1.0.0"] }));
  writeFileSync(
    join(projectSettingsDir, "settings.json"),
    JSON.stringify({ packages: ["../local-foo", "npm:@test/pi-project@1.0.0"] }),
  );
  writeFileSync(join(localExtensionDir, "package.json"), JSON.stringify({ name: "@test/pi-foo" }));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.HOME = homeDir;

  try {
    const installedPackages = readInstalledExtensionPackages(projectDir);

    assert.deepEqual(
      installedPackages.map(({ packageName, source }) => ({ packageName, source })),
      [
        { packageName: "@test/pi-foo", source: "npm:@test/pi-foo@1.0.0" },
        { packageName: "@test/pi-foo", source: "../local-foo" },
        { packageName: "@test/pi-project", source: "npm:@test/pi-project@1.0.0" },
      ],
    );
    assert.deepEqual(findDuplicateExtensions(installedPackages), ["foo"]);
    const aliases = buildExtensionStatusIconAliases(installedPackages);
    assert.ok(aliases.get("foo")?.includes("npm:@test/pi-foo"));
    assert.equal(aliases.has("home-only"), false);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

const theme = { fg: (_color: string, text: string) => `\u001b[32m${text}\u001b[39m` } as Theme;
const config = createDefaultConfig();

function runtime(duplicateExtensions: string[] = []): RuntimeState {
  return {
    turnCount: 0,
    activeTools: new Map(),
    isStreaming: false,
    thinkingLevel: "off",
    duplicateExtensions,
    extensionStatusIconAliases: new Map(),
  };
}

function busyStatuses(): Map<string, string> {
  return new Map([
    ["statusline", "self-hidden"],
    ["empty", " \t "],
    ["hidden", "explicitly-hidden"],
    ["one", "ready"],
    ["two", "active"],
    ["three", "enabled"],
    ["four", "awake"],
    ["five", "\u001b[31m待機中\u001b[0m"],
    ["background", "running 2"],
    ["approvals", "1 pending (/approvals)"],
  ]);
}

test("all visible producers survive beyond five entries, with or without duplicate warnings", () => {
  for (const duplicates of [[], ["one", "two", "three"]]) {
    const formatted = stripStatusColor(
      formatExtensionStatuses(busyStatuses(), theme, config, runtime(duplicates), new Set(["hidden"])),
    );
    const entries = [
      ...(duplicates.length ? ["duplicate one, two +1"] : []),
      "one ready",
      "two active",
      "three enabled",
      "four awake",
      "five 待機中",
      "background running 2",
      "approvals 1 pending (/approvals)",
    ];
    assert.equal(formatted, entries.join(" · "));
  }
});

test("narrow ANSI/CJK wrapping retains the complete producer list within terminal width", () => {
  const formatted = formatExtensionStatuses(busyStatuses(), theme, config, runtime(["one"]), new Set(["hidden"]));
  for (const width of [8, 17, 30]) {
    const lines = wrapExtensionStatusline(formatted, width);
    assert.ok(lines.length > 1);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    const compact = (text: string) => stripStatusColor(text).replace(/\s+/gu, "");
    assert.equal(compact(lines.join("")), compact(formatted));
    assert.match(compact(lines.join("")), /待機中.*backgroundrunning2.*approvals/u);
    assert.ok(compact(lines.join("")).endsWith("approvals1pending(/approvals)"));
  }
});

test("producer parentheticals retain armed state and approval actions", () => {
  assert.equal(stripStatusColor(formatExtensionStatus("mode", "fast", theme, config)), "mode fast");
  assert.equal(stripStatusColor(formatExtensionStatus("mode", "fast (armed)", theme, config)), "mode fast (armed)");
  assert.equal(
    stripStatusColor(formatExtensionStatus("approvals", "1 pending (/approvals)", theme, config)),
    "approvals 1 pending (/approvals)",
  );
});

test("inline PR hiding only removes the PR when its context is rendered in the main line", () => {
  const statuses = busyStatuses();
  statuses.delete("hidden");
  const link = "\u001b]8;;https://github.com/o/r/pull/7\u0007#7\u001b]8;;\u0007";
  statuses.set("github-pr", `PR ${link}: checks pending (2), approved`);
  const footerData: ReadonlyFooterDataProvider = {
    getGitBranch: () => "main",
    getExtensionStatuses: () => statuses,
    onBranchChange: () => () => undefined,
    getAvailableProviderCount: () => 1,
  };
  const prContext = prContextFromStatuses(statuses);
  assert.ok(prContext);
  const inline = renderExtensionStatusline(300, footerData, theme, config, runtime(), `main (${prContext})`).join(" ");
  assert.equal(inline.includes(link), false);
  assert.match(stripStatusColor(inline), /approvals 1 pending \(\/approvals\)/u);

  const fallback = renderExtensionStatusline(300, footerData, theme, config, runtime(), "main").join(" ");
  assert.ok(fallback.includes(link));
  assert.match(stripStatusColor(fallback), /checks pending \(2\) approved/u);
});
