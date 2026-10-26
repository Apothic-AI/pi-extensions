import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import { createRecoveryCommand } from "../src/recovery-command.js";
import { type CodexCompactSettingsRuntime, DEFAULT_CODEX_COMPACT_SETTINGS } from "../src/settings.js";
import { createMockContext, createMockPi } from "./support.js";

for (const mode of ["rpc", "json", "print", "busy", "pending"] as const) {
  test(`recovery ${mode} cannot inspect a source, request credentials or start work`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-recovery-guard-"));
    try {
      vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected live HTTP"));
      vi.spyOn(globalThis, "WebSocket").mockImplementation(() => {
        throw new Error("Unexpected live WebSocket");
      });
      const runtime: CodexCompactSettingsRuntime = {
        get: () => ({
          kind: "missing",
          path: join(directory, "settings.json"),
          document: {},
          settings: DEFAULT_CODEX_COMPACT_SETTINGS,
        }),
        reload: async () => runtime.get(),
        update: async () => {
          throw new Error("No writes");
        },
        flush: async () => {},
      };
      const unexpected = () => {
        assert.fail("Must reject before source, credentials or UI confirmation");
      };
      const recovery = createRecoveryCommand(createMockPi().pi, runtime, {
        project: unexpected,
        matches: unexpected,
        tools: unexpected,
        authenticate: unexpected,
        payloadValidator: unexpected,
      });
      const { ctx } = createMockContext({
        mode: mode === "busy" || mode === "pending" ? "tui" : mode,
        isIdle: () => mode !== "busy",
        hasPendingMessages: () => mode === "pending",
        confirm: unexpected,
        sessionManager: { getSessionId: unexpected },
      });
      await recovery.run(ctx, new AbortController().signal);
      assert.deepEqual(readdirSync(directory), []);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
