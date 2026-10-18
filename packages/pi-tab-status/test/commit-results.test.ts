import { test } from "bun:test";
import assert from "node:assert/strict";
import tabStatus, { formatTabTitle } from "../tab-status.js";

for (const [shell, failed] of [
  ["powershell", false],
  ["bash", true],
  ["hypa_shell", false],
  ["hypa_shell", true],
] as const) {
  test(`${shell} commit title requires its own successful result, failed=${failed}`, async () => {
    const handlers = new Map<string, (event: never, ctx: never) => Promise<void>>();
    const titles: string[] = [];
    const ctx = {
      cwd: "/tmp/demo",
      isIdle: () => true,
      hasUI: true,
      mode: "tui",
      ui: { setTitle: (title: string) => titles.push(title) },
    };
    tabStatus({
      on: (name: string, handler: (event: never, ctx: never) => Promise<void>) => handlers.set(name, handler),
    } as never);
    const emit = (name: string, event: unknown = {}) => handlers.get(name)?.(event as never, ctx as never);
    await emit("agent_start");
    await emit("tool_call", { toolName: shell, toolCallId: "commit", input: { command: "git commit -m done" } });
    assert.equal(titles.at(-1), formatTabTitle(ctx.cwd, "running"));
    await emit("tool_call", { toolName: "bash", toolCallId: "other", input: { command: "pwd" } });
    await emit("tool_result", { toolCallId: "other", isError: false });
    await emit("tool_result", {
      toolName: shell,
      toolCallId: "commit",
      input: { command: "git commit -m done" },
      isError: failed,
      ...(shell === "hypa_shell" ? { details: { source: "hypa-cli", exitCode: failed ? 1 : 0 } } : {}),
    });
    await emit("tool_result", { toolCallId: "other", isError: true });
    await emit("agent_end", { messages: [] });
    assert.equal(titles.at(-1), formatTabTitle(ctx.cwd, "running"));
    await emit("agent_settled");
    assert.equal(titles.at(-1), formatTabTitle(ctx.cwd, failed ? "doneNoCommit" : "doneCommitted"));
    await emit("session_shutdown");
  });
}

for (const { name, toolName, calledCommand, executedCommand, committed } of [
  {
    name: "Hypa noncommit output is not commit evidence",
    toolName: "hypa_shell",
    calledCommand: "pwd",
    executedCommand: "pwd",
    committed: false,
  },
  {
    name: "Hypa tool_call alone is not commit evidence",
    toolName: "hypa_shell",
    calledCommand: "git commit -m done",
    executedCommand: undefined,
    committed: false,
  },
  {
    name: "Hypa rewritten noncommit uses executed input",
    toolName: "hypa_shell",
    calledCommand: "git commit -m done",
    executedCommand: "pwd",
    committed: false,
  },
  {
    name: "Hypa rewritten commit uses executed input",
    toolName: "hypa_shell",
    calledCommand: "pwd",
    executedCommand: "git commit -m done",
    committed: true,
  },
  ...["bash_background", "monitor", "arbitrary_tool"].map((toolName) => ({
    name: `${toolName} successful result is not commit evidence`,
    toolName,
    calledCommand: "git commit -m done",
    executedCommand: "git commit -m done",
    committed: false,
  })),
]) {
  test(name, async () => {
    const handlers = new Map<string, (event: never, ctx: never) => Promise<void>>();
    const titles: string[] = [];
    const ctx = {
      cwd: "/tmp/demo",
      isIdle: () => true,
      hasUI: true,
      mode: "tui",
      ui: { setTitle: (title: string) => titles.push(title) },
    };
    tabStatus({
      on: (name: string, handler: (event: never, ctx: never) => Promise<void>) => handlers.set(name, handler),
    } as never);
    const emit = (name: string, event: unknown = {}) => handlers.get(name)?.(event as never, ctx as never);
    try {
      await emit("agent_start");
      await emit("tool_call", { toolName, toolCallId: "command", input: { command: calledCommand } });
      assert.equal(titles.at(-1), formatTabTitle(ctx.cwd, "running"));
      if (executedCommand !== undefined) {
        await emit("tool_result", {
          toolName,
          toolCallId: "command",
          input: { command: executedCommand },
          content: [{ type: "text", text: "git commit -m done" }],
          isError: false,
          details: { source: "hypa-cli", exitCode: 0 },
        });
      }
      await emit("agent_end", { messages: [] });
      assert.equal(titles.at(-1), formatTabTitle(ctx.cwd, "running"));
      await emit("agent_settled");
      assert.equal(titles.at(-1), formatTabTitle(ctx.cwd, committed ? "doneCommitted" : "doneNoCommit"));
    } finally {
      await emit("session_shutdown");
    }
  });
}
