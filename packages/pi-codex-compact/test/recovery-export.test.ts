import assert from "node:assert/strict";
import fs, { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import promises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { createCheckpointDetails, projectCheckpointContext } from "../src/checkpoint.js";
import {
  buildRecoverySession,
  exportRecoverySession,
  type RecoveryExportInput,
  type RecoveryExportResult,
} from "../src/recovery-export.js";
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
    assert.deepEqual(reopened.buildSessionContext().model, {
      provider: input.details.provider,
      modelId: input.details.modelId,
    });
    assert.equal(reopened.getEntries().at(-1)?.type, "model_change");
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
      const onPublished = vi.fn();
      input.onPublished = onPublished;
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
      assert.equal(onPublished.mock.calls.length, 0, "incomplete or stale publication is never success");
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

test("throwing publication observer sees the complete result before cleanup and cannot undo it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-recovery-observer-"));
  try {
    const input = fixture(directory);
    const observations: unknown[] = [];
    const onPublished = vi.fn((result: RecoveryExportResult) => {
      observations.push({
        sessionId: SessionManager.open(result.path).getSessionId(),
        durabilityConfirmed: result.durabilityConfirmed,
        stagingCount: readdirSync(directory).filter((name) => name.startsWith(".codex-recovery-")).length,
      });
      throw new Error("Synthetic observer failure");
    });
    input.onPublished = onPublished;
    const result = await exportRecoverySession(input);
    assert.equal(onPublished.mock.calls.length, 1);
    assert.deepEqual(onPublished.mock.calls[0], [result]);
    assert.deepEqual(observations, [{ sessionId: result.sessionId, durabilityConfirmed: true, stagingCount: 1 }]);
    assert.deepEqual(readdirSync(directory), [result.path.split("/").at(-1)]);
    assert.equal(SessionManager.open(result.path).getSessionId(), result.sessionId);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("post-publication directory fsync failure preserves the complete usable export", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-recovery-late-fsync-"));
  try {
    const sync = fs.fsyncSync;
    let calls = 0;
    vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if (++calls === 2) throw new Error("Synthetic late directory fsync failure");
      sync(fd);
    });
    const input = fixture(directory);
    const onPublished = vi.fn();
    input.onPublished = onPublished;
    const result = await exportRecoverySession(input);
    assert.equal(result.durabilityConfirmed, false);
    assert.deepEqual(onPublished.mock.calls, [[result]]);
    assert.equal(SessionManager.open(result.path).getSessionId(), result.sessionId);
    assert.deepEqual(readdirSync(directory), [result.path.split("/").at(-1)]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const swap of [
  "file",
  "symlink",
  "staging-directory",
  "destination-directory",
  "foreign-content",
  "in-place",
] as const) {
  test(`final owner callback ${swap} swap cannot publish, mutate or delete foreign data`, async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-recovery-swap-"));
    const directory = join(root, "sessions");
    fs.mkdirSync(directory);
    try {
      const input = fixture(directory);
      const original = join(root, "source.jsonl");
      writeFileSync(original, "synthetic unchanged source\n");
      const foreign = join(root, "foreign");
      // A native-looking header-only target must never be repaired by open().
      const foreignBytes = `${JSON.stringify({
        type: "session",
        version: 3,
        id: "foreign",
        timestamp: new Date(0).toISOString(),
        cwd: root,
      })}\n`;
      writeFileSync(foreign, foreignBytes);
      let validated = false;
      const sync = fs.fsyncSync;
      vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
        sync(fd);
        validated = true;
      });
      let replaced = false;
      let replacement: string | undefined;
      input.isCurrent = () => {
        if (!validated || replaced) return true;
        replaced = true;
        const stageName = readdirSync(directory).find((name) => name.startsWith(".codex-recovery-"));
        assert.ok(stageName);
        const stageDir = join(directory, stageName);
        const staged = join(stageDir, "session.pending");
        if (swap === "in-place") {
          const data = readFileSync(staged);
          data[0] = 32;
          writeFileSync(staged, data);
          // Deliberately change metadata as well, independent of FS resolution.
          fs.utimesSync(staged, new Date(0), new Date(0));
          replacement = foreign;
        } else if (swap === "file" || swap === "symlink") {
          fs.renameSync(staged, join(root, "owned-file"));
          if (swap === "file") writeFileSync(staged, foreignBytes);
          else fs.symlinkSync(foreign, staged);
          replacement = staged;
        } else if (swap === "staging-directory") {
          fs.renameSync(stageDir, join(root, "owned-directory"));
          fs.mkdirSync(stageDir);
          writeFileSync(staged, foreignBytes);
          replacement = staged;
        } else if (swap === "destination-directory") {
          fs.renameSync(directory, join(root, "owned-sessions"));
          fs.mkdirSync(directory);
          replacement = join(directory, "foreign");
          writeFileSync(replacement, foreignBytes);
        } else {
          replacement = join(stageDir, "foreign");
          writeFileSync(replacement, foreignBytes);
        }
        return true;
      };
      if (swap === "foreign-content") {
        const result = await exportRecoverySession(input);
        assert.ok(SessionManager.open(result.path).getSessionId());
      } else await assert.rejects(exportRecoverySession(input));
      assert.equal(replaced, true);
      assert.equal(readFileSync(foreign, "utf8"), foreignBytes);
      assert.ok(replacement);
      assert.equal(readFileSync(replacement, "utf8"), foreignBytes);
      assert.equal(readFileSync(original, "utf8"), "synthetic unchanged source\n");
      if (swap !== "foreign-content")
        assert.deepEqual(
          readdirSync(directory).filter((name) => name.endsWith(".jsonl")),
          [],
        );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("real descriptor read followed by same-size mutation before read returns cannot publish", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-recovery-read-race-"));
  try {
    const open = promises.open;
    let mutated = false;
    vi.spyOn(promises, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      const read = handle.read.bind(handle);
      vi.spyOn(handle, "read").mockImplementation(async (...readArgs: Parameters<typeof handle.read>) => {
        const result = await read(...readArgs);
        const bytes = readFileSync(String(args[0]));
        bytes[0] = 32;
        writeFileSync(String(args[0]), bytes);
        fs.utimesSync(String(args[0]), new Date(0), new Date(0));
        mutated = true;
        return result;
      });
      return handle;
    });
    await assert.rejects(exportRecoverySession(fixture(directory)), /staging changed/);
    assert.equal(mutated, true);
    assert.deepEqual(readdirSync(directory), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("staging is pinned synchronously; first async completion replacement is never adopted or cleaned", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-recovery-create-race-"));
  const directory = join(root, "sessions");
  fs.mkdirSync(directory);
  try {
    const asyncCreation = vi.spyOn(promises, "mkdtemp").mockRejectedValue(new Error("Async creation forbidden"));
    const open = promises.open;
    let foreign: string | undefined;
    vi.spyOn(promises, "open").mockImplementation(async (...args) => {
      const handle = await open(...args); // First async completion, after sync pin.
      const stage = String(args[0]);
      const stageDirectory = join(stage, "..");
      fs.renameSync(stageDirectory, join(root, "owned-stage"));
      fs.mkdirSync(stageDirectory);
      writeFileSync(stage, "foreign-stage-bytes");
      foreign = stage;
      return handle;
    });
    await assert.rejects(exportRecoverySession(fixture(directory)), /identity changed/);
    assert.equal(asyncCreation.mock.calls.length, 0, "no stale asynchronous creation result can be adopted");
    assert.ok(foreign);
    assert.equal(readFileSync(foreign, "utf8"), "foreign-stage-bytes");
    assert.deepEqual(
      readdirSync(directory).filter((name) => name.endsWith(".jsonl")),
      [],
    );
    assert.ok(existsSync(join(root, "owned-stage", "session.pending")), "uncertain cleanup preserves artifacts");
  } finally {
    rmSync(root, { recursive: true, force: true });
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
