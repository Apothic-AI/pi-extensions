import { test } from "bun:test";
import assert from "node:assert/strict";
import tabStatus, { formatTabTitle } from "../tab-status.js";

for (const [name, details, committed] of [
  ["verified zero exit", { source: "hypa-cli", exitCode: 0 }, true],
  ["failed process without tool error", { source: "hypa-cli", exitCode: 1 }, false],
  ["missing outcome", undefined, false],
  ["unrecognized source", { source: "other", exitCode: 0 }, false],
  ["string exit code", { source: "hypa-cli", exitCode: "0" }, false],
  ["missing exit code", { source: "hypa-cli" }, false],
] as const) {
  test(`Hypa commit requires verified command success: ${name}`, async () => {
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
      on: (event: string, handler: (event: never, ctx: never) => Promise<void>) => handlers.set(event, handler),
    } as never);
    const emit = (event: string, data: unknown = {}) => handlers.get(event)?.(data as never, ctx as never);
    try {
      await emit("agent_start");
      await emit("tool_result", {
        toolName: "hypa_shell",
        toolCallId: "commit",
        input: { command: "git commit -m done" },
        content: [{ type: "text", text: "git commit output" }],
        isError: false,
        details,
      });
      await emit("agent_end", { messages: [] });
      await emit("agent_settled");
      assert.equal(titles.at(-1), formatTabTitle(ctx.cwd, committed ? "doneCommitted" : "doneNoCommit"));
    } finally {
      await emit("session_shutdown");
    }
  });
}
