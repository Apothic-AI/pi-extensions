import assert from "node:assert/strict";
import fs, { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import promises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { createCheckpointDetails, projectCheckpointContext } from "../src/checkpoint.js";
import { buildRecoverySession, exportRecoverySession, type RecoveryExportInput } from "../src/recovery-export.js";
import type { RecoveryMessage } from "../src/recovery-snapshot.js";

const usage = {
  input: 7,
  output: 3,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 10,
  cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
};
const historicalTail: RecoveryMessage[] = [
  {
    role: "user",
    content: [
      { type: "text", text: "Tail canary" },
      { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
    ],
    timestamp: 10,
  },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Reasoning", thinkingSignature: "signed-reasoning" },
      { type: "toolCall", id: "tool-id|item-id", name: "inspect", arguments: { exact: "argument" } },
    ],
    provider: "openai-codex",
    api: "openai-codex-responses",
    model: "test",
    stopReason: "toolUse",
    timestamp: 11,
    usage: { ...usage, input: 900000, totalTokens: 900003 },
  },
  {
    role: "toolResult",
    toolCallId: "tool-id|item-id",
    toolName: "inspect",
    content: [{ type: "text", text: "Tool canary" }],
    isError: false,
    timestamp: 12,
    usage,
  },
  { role: "custom", customType: "synthetic", content: "Custom canary", display: false, timestamp: 13 },
];
function fixture(directory: string): RecoveryExportInput {
  return {
    cwd: directory,
    sessionDir: directory,
    sourceSessionId: "source",
    sourceEntryIds: ["source-entry"],
    head: { role: "system", content: "Synthetic resolved envelope", timestamp: 1 },
    details: createCheckpointDetails({
      modelId: "test",
      replacementHistory: [{ type: "compaction", encrypted_content: "opaque-new" }],
      keptMessages: [],
    }),
    suffix: historicalTail,
    usage,
    signal: new AbortController().signal,
    isCurrent: () => true,
  };
}

test("fresh current-format retain-none export reopens and forks with exact tail once and zero copied accounting", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-recovery-export-"));
  try {
    const input = fixture(directory);
    const before = JSON.stringify(input.suffix);
    const result = await exportRecoverySession(input);
    const reopened = SessionManager.open(result.path);
    assert.notEqual(reopened.getSessionId(), input.sourceSessionId);
    assert.equal(reopened.getHeader()?.parentSession, undefined);
    assert.equal(reopened.getEntries().filter((entry) => entry.type === "compaction").length, 1);
    const replay = projectCheckpointContext(reopened.buildSessionContext().messages, input.details, "full");
    assert.ok(replay);
    assert.equal(replay.length, historicalTail.length + 2);
    assert.equal(JSON.stringify(replay).split("Tail canary").length - 1, 1);
    for (const message of replay)
      if (message.role === "assistant" || message.role === "toolResult") {
        assert.equal(message.usage?.totalTokens, 0);
        assert.equal(message.usage?.cost.total, 0);
      }
    assert.equal(JSON.stringify(input.suffix), before);
    const fork = SessionManager.forkFrom(result.path, directory, directory);
    assert.deepEqual(fork.buildSessionContext(), reopened.buildSessionContext());
    assert.deepEqual(getCurrentSystemMessage(replay)?.content, input.head.content);
    assert.deepEqual(
      readdirSync(directory).filter((file) => file.startsWith(".codex-recovery")),
      [],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const failure of ["write", "sync", "directory-sync", "link", "cancel", "revalidate", "collision"] as const) {
  test(`staging/publication ${failure} leaves no partial output or overwritten destination`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-recovery-failure-"));
    try {
      const input = fixture(directory);
      const original = join(directory, "original.jsonl");
      writeFileSync(original, "untouched synthetic original\n");
      const originalBytes = readFileSync(original);
      const controller = new AbortController();
      input.signal = controller.signal;
      const open = promises.open;
      if (failure === "write" || failure === "sync" || failure === "cancel") {
        vi.spyOn(promises, "open").mockImplementation(async (...args) => {
          const handle = await open(...args);
          if (failure === "write")
            vi.spyOn(handle, "writeFile").mockRejectedValueOnce(new Error("Synthetic write failure"));
          if (failure === "sync") vi.spyOn(handle, "sync").mockRejectedValueOnce(new Error("Synthetic sync failure"));
          if (failure === "cancel") controller.abort();
          return handle;
        });
      }
      if (failure === "directory-sync")
        vi.spyOn(fs, "fsyncSync").mockImplementation(() => {
          throw new Error("Synthetic directory fsync failure");
        });
      let collision: string | undefined;
      if (failure === "link")
        vi.spyOn(fs, "linkSync").mockImplementation(() => {
          throw new Error("Synthetic publication failure");
        });
      if (failure === "collision") {
        const link = fs.linkSync;
        vi.spyOn(fs, "linkSync").mockImplementation((source, destination) => {
          collision = String(destination);
          writeFileSync(destination, "existing unrelated destination\n", { flag: "wx" });
          return link(source, destination);
        });
      }
      if (failure === "revalidate") {
        let calls = 0;
        input.isCurrent = () => ++calls < 5;
      }
      await assert.rejects(exportRecoverySession(input));
      assert.deepEqual(readFileSync(original), originalBytes);
      const outputs = readdirSync(directory).filter((file) => file !== "original.jsonl");
      if (collision) {
        assert.equal(readFileSync(collision, "utf8"), "existing unrelated destination\n");
        assert.equal(outputs.length, 1);
      } else assert.deepEqual(outputs, []);
      assert.equal(existsSync(original), true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("post-publication directory fsync failure preserves the complete usable export", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-recovery-late-fsync-"));
  try {
    const sync = fs.fsyncSync;
    let calls = 0;
    vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if (++calls === 2) throw new Error("Synthetic late directory fsync failure");
      sync(fd);
    });
    const result = await exportRecoverySession(fixture(directory));
    assert.equal(result.durabilityConfirmed, false);
    assert.equal(SessionManager.open(result.path).getSessionId(), result.sessionId);
    assert.deepEqual(readdirSync(directory), [result.path.split("/").at(-1)]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("non-retain-none or unsupported suffix is rejected before staging", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-recovery-invalid-"));
  try {
    const input = fixture(directory);
    input.details.keptMessageFingerprints = ["a".repeat(64)];
    assert.throws(() => buildRecoverySession(input));
    input.details.keptMessageFingerprints = [];
    input.suffix = [
      { role: "compactionSummary", summary: "Unsent summary is forbidden", timestamp: 1 } as unknown as RecoveryMessage,
    ];
    assert.throws(() => buildRecoverySession(input));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
