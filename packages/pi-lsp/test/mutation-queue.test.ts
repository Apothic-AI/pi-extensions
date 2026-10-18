import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createEditToolDefinition } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { LspClient } from "../src/lsp-client.js";
import { runFix } from "../src/runner.js";
import type { LspServerAdapter } from "../src/types.js";

function gate() {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function gatedFix(
  options: { write?: boolean; noop?: boolean; signal?: AbortSignal; linked?: boolean; rootLink?: boolean } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "lsp-freshness-"));
  const root = options.rootLink ? join(directory, "workspace") : directory;
  if (options.rootLink) {
    const originalRoot = join(directory, "original");
    mkdirSync(originalRoot);
    symlinkSync(originalRoot, root);
  }
  const file = join(root, "main.ts");
  const original = "let a = 10;\n";
  if (options.linked) {
    const target = join(root, "target.ts");
    writeFileSync(target, original);
    symlinkSync(target, file);
  } else {
    writeFileSync(file, original);
  }
  const entered = gate();
  const held = gate();
  const adapter: LspServerAdapter = {
    name: "test",
    isDefault: true,
    defaultCommand: { command: "unused", args: [] },
    missingCommandHint: "",
    extensions: [".ts"],
    skipDirectories: new Set(),
    isSupportedFile: () => true,
    languageIdFor: () => "typescript",
  };
  vi.spyOn(LspClient.prototype, "start").mockResolvedValue(undefined);
  vi.spyOn(LspClient.prototype, "initialize").mockResolvedValue(undefined);
  vi.spyOn(LspClient.prototype, "didOpen").mockImplementation(() => {});
  vi.spyOn(LspClient.prototype, "didClose").mockImplementation(() => {});
  vi.spyOn(LspClient.prototype, "shutdown").mockResolvedValue(undefined);
  vi.spyOn(LspClient.prototype, "close").mockImplementation(() => {});
  vi.spyOn(LspClient.prototype, "diagnostics").mockResolvedValue([]);
  vi.spyOn(LspClient.prototype, "resolveActions").mockImplementation(async (actions) => actions);
  vi.spyOn(LspClient.prototype, "codeActions").mockImplementation(async (_uri, text) => {
    assert.equal(text, original);
    entered.release();
    await held.promise;
    return options.noop
      ? []
      : [
          {
            title: "fix",
            kind: "source.fixAll",
            edit: {
              changes: {
                [pathToFileURL(file).href]: [
                  { range: { start: { line: 0, character: 8 }, end: { line: 0, character: 10 } }, newText: "2" },
                ],
              },
            },
          },
        ];
  });
  const running = runFix(
    adapter,
    { root, path: file, write: options.write ?? true },
    1000,
    options.signal,
    { ui: { setStatus: () => {} } },
    "lsp",
  );
  return {
    root,
    file,
    original,
    running,
    ready: entered.promise,
    release: held.release,
    async close() {
      held.release();
      await running.catch(() => {});
      vi.restoreAllMocks();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

for (const change of ["same-inode save", "replacement inode", "outside symlink"] as const) {
  test(`LSP fix preserves an external ${change} during code actions`, async () => {
    const f = gatedFix({ linked: change === "outside symlink" });
    const outside = mkdtempSync(join(tmpdir(), "lsp-outside-"));
    const outsideFile = join(outside, "external.ts");
    writeFileSync(outsideFile, "outside\n");
    try {
      await f.ready;
      const originalIdentity = statSync(f.file);
      if (change === "same-inode save") {
        writeFileSync(f.file, "external save\n");
        assert.equal(statSync(f.file).ino, originalIdentity.ino);
      } else if (change === "replacement inode") {
        const replacement = join(f.root, "replacement.ts");
        writeFileSync(replacement, f.original); // Equal bytes still cannot authorize a replacement inode.
        renameSync(replacement, f.file);
        assert.notEqual(statSync(f.file).ino, originalIdentity.ino);
      } else {
        unlinkSync(f.file);
        symlinkSync(outsideFile, f.file);
      }
      const saved = readFileSync(f.file);
      f.release();
      await assert.rejects(f.running, /changed while computing LSP fixes|outside workspace root/);
      assert.deepEqual(readFileSync(f.file), saved);
      assert.equal(readFileSync(outsideFile, "utf8"), "outside\n");
      if (change === "outside symlink") assert.equal(readFileSync(join(f.root, "target.ts"), "utf8"), f.original);
    } finally {
      await f.close();
      rmSync(outside, { recursive: true, force: true });
    }
  });
}

test("LSP fix rejects a retargeted workspace even when the file inode and bytes move with it", async () => {
  const f = gatedFix({ rootLink: true });
  const outside = mkdtempSync(join(tmpdir(), "lsp-root-retarget-"));
  const moved = join(outside, "main.ts");
  try {
    await f.ready;
    const identity = statSync(f.file);
    renameSync(f.file, moved);
    unlinkSync(f.root);
    symlinkSync(outside, f.root);
    assert.equal(statSync(f.file).ino, identity.ino);
    assert.equal(readFileSync(f.file, "utf8"), f.original);
    f.release();
    await assert.rejects(f.running, /changed while computing LSP fixes/);
    assert.equal(readFileSync(moved, "utf8"), f.original);
  } finally {
    await f.close();
    rmSync(outside, { recursive: true, force: true });
  }
});

test("unchanged snapshot permits an in-place fix and truncates shorter output", async () => {
  const f = gatedFix();
  try {
    await f.ready;
    const identity = statSync(f.file);
    f.release();
    const result = await f.running;
    assert.equal(readFileSync(f.file, "utf8"), "let a = 2;\n");
    assert.equal(statSync(f.file).ino, identity.ino);
    assert.equal((result.details as { outcome: string }).outcome, "updated");
  } finally {
    await f.close();
  }
});

for (const options of [{ write: false }, { noop: true }]) {
  test(`${options.noop ? "no-op" : "preview"} does not overwrite an external save or require freshness`, async () => {
    const f = gatedFix(options);
    try {
      await f.ready;
      writeFileSync(f.file, "external save\n");
      const saved = statSync(f.file);
      f.release();
      const result = await f.running;
      assert.equal(readFileSync(f.file, "utf8"), "external save\n");
      assert.equal(statSync(f.file).mtimeMs, saved.mtimeMs);
      assert.equal(statSync(f.file).ctimeMs, saved.ctimeMs);
      assert.equal((result.details as { outcome: string }).outcome, options.noop ? "unchanged" : "preview");
      if (!options.noop) assert.match(result.content[0].text, /let a = 2;/);
    } finally {
      await f.close();
    }
  });
}

test("cancellation during code actions never writes the computed fix", async () => {
  const controller = new AbortController();
  const f = gatedFix({ signal: controller.signal });
  try {
    await f.ready;
    controller.abort();
    f.release();
    await assert.rejects(f.running, /request aborted/);
    assert.equal(readFileSync(f.file, "utf8"), f.original);
  } finally {
    await f.close();
  }
});

test("built-in edit and LSP fix serialize their complete mutation windows", async () => {
  const root = mkdtempSync(join(tmpdir(), "lsp-queue-"));
  const file = join(root, "main.ts");
  writeFileSync(file, "let a = 1;\nlet b = 1;\n");
  const adapter: LspServerAdapter = {
    name: "test",
    isDefault: true,
    defaultCommand: { command: "unused", args: [] },
    missingCommandHint: "",
    extensions: [".ts"],
    skipDirectories: new Set(),
    isSupportedFile: () => true,
    languageIdFor: () => "typescript",
  };
  let started: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(LspClient.prototype, "start").mockResolvedValue(undefined);
  vi.spyOn(LspClient.prototype, "initialize").mockResolvedValue(undefined);
  vi.spyOn(LspClient.prototype, "didOpen").mockImplementation(() => {});
  vi.spyOn(LspClient.prototype, "didClose").mockImplementation(() => {});
  vi.spyOn(LspClient.prototype, "shutdown").mockResolvedValue(undefined);
  vi.spyOn(LspClient.prototype, "diagnostics").mockResolvedValue([]);
  vi.spyOn(LspClient.prototype, "resolveActions").mockImplementation(async (actions) => actions);
  vi.spyOn(LspClient.prototype, "codeActions").mockImplementation(async () => {
    started();
    await gate;
    return [
      {
        title: "fix",
        kind: "source.fixAll",
        edit: {
          changes: {
            [pathToFileURL(file).href]: [
              { range: { start: { line: 0, character: 8 }, end: { line: 0, character: 9 } }, newText: "2" },
            ],
          },
        },
      },
    ];
  });
  try {
    const fixing = runFix(
      adapter,
      { root, path: "./main.ts", write: true },
      1000,
      undefined,
      { ui: { setStatus: () => {} } },
      "lsp",
    );
    await ready;
    let builtInRead = false;
    const edit = createEditToolDefinition(root, {
      operations: {
        access,
        readFile: async (target) => {
          builtInRead = true;
          const bytes = await readFile(target);
          assert.match(bytes.toString("utf8"), /let a = 2;/, "native edit reads only after the LSP write");
          return bytes;
        },
        writeFile,
      },
    });
    const editing = edit.execute(
      "edit",
      { path: file, edits: [{ oldText: "let b = 1;", newText: "let b = 2;" }] },
      undefined,
      undefined,
      { cwd: root } as never,
    );
    assert.equal(builtInRead, false);
    release();
    await Promise.all([fixing, editing]);
    assert.equal(builtInRead, true);
    assert.equal(readFileSync(file, "utf8"), "let a = 2;\nlet b = 2;\n");
    writeFileSync(file, "let a = 1;\n");
    await runFix(adapter, { root, path: file, write: false }, 1000, undefined, { ui: { setStatus: () => {} } }, "lsp");
    assert.equal(readFileSync(file, "utf8"), "let a = 1;\n");
  } finally {
    release();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  }
});
