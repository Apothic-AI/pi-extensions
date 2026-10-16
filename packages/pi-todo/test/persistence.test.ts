import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { empty, STATE_TYPE } from "../src/state.js";
import { TodoStore } from "../src/store.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function fixture(conversation = true) {
  const dir = mkdtempSync(join(tmpdir(), "todo-disk-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const manager = SessionManager.create(dir, dir);
  if (conversation) manager.appendMessage({ role: "user", content: "An ordinary user message", timestamp: 1 });
  const ctx = { sessionManager: manager } as unknown as ExtensionContext;
  const append = vi.fn((type: string, data: unknown) => {
    manager.appendCustomEntry(type, data);
  });
  const store = new TodoStore({ appendEntry: append });
  store.reconcile(ctx);
  const file = manager.getSessionFile();
  if (!file) throw new Error("Missing native session file path");
  return { dir, manager, ctx, append, store, file };
}
const add = { action: "add", baseRevision: 0, title: "Durable task" };
function fault(file: string, afterWrite = false) {
  const nativeAppend = fs.appendFileSync;
  const spy = vi.spyOn(fs, "appendFileSync").mockImplementation((...args: Parameters<typeof fs.appendFileSync>) => {
    if (args[0] === file) {
      if (afterWrite) nativeAppend(...args);
      throw Object.assign(new Error("Native EIO after memory append"), { code: "EIO" });
    }
    nativeAppend(...args);
  });
  syncBuiltinESMExports();
  return spy;
}
function reopened(f: ReturnType<typeof fixture>) {
  const manager = SessionManager.open(f.file, f.dir);
  const ctx = { sessionManager: manager } as unknown as ExtensionContext;
  const store = new TodoStore({
    appendEntry: (type, data) => {
      manager.appendCustomEntry(type, data);
    },
  });
  store.reconcile(ctx);
  return { manager, ctx, store };
}

describe("native file-backed durability (no private SDK writes or rollback)", () => {
  it("rejects a fresh manual edit BEFORE append; no phantom success before first conversation", () => {
    const f = fixture(false);
    expect(existsSync(f.file)).toBe(false);
    expect(() => f.store.mutate(f.ctx, add)).toThrow(/ordinary message.*--no-session/i);
    expect(f.append).not.toHaveBeenCalled();
    expect(f.manager.getBranch()).toEqual([]);
    expect(f.store.read(f.ctx)).toEqual(empty());
  });
  it("does not recover an EIO ghost completion on reconciliation or actual reopen", () => {
    const f = fixture();
    const first = f.store.mutate(f.ctx, add);
    const spy = fault(f.file);
    expect(() =>
      f.store.mutate(f.ctx, {
        action: "update",
        baseRevision: 1,
        updates: [{ id: first.tasks[0].id, status: "completed" }],
      }),
    ).toThrow(/EIO/);
    expect(spy).toHaveBeenCalledOnce();
    expect(f.manager.getBranch().at(-1)).toMatchObject({ data: { revision: 2, tasks: [{ status: "completed" }] } });
    expect(readFileSync(f.file, "utf8")).not.toContain('"revision":2');
    spy.mockRestore();
    syncBuiltinESMExports();
    f.store.reconcile(f.ctx);
    expect(f.store.read(f.ctx)).toEqual(first);
    const open = reopened(f);
    expect(open.store.read(open.ctx)).toEqual(first);
  });
  it("fails closed on mismatched header BEFORE append and can explicitly reconcile repaired storage", () => {
    const f = fixture();
    const original = readFileSync(f.file, "utf8");
    writeFileSync(f.file, original.replace(f.manager.getSessionId(), "not-this-session"));
    expect(() => f.store.mutate(f.ctx, add)).toThrow(/header|session|unavailable/i);
    expect(f.append).not.toHaveBeenCalled();
    writeFileSync(f.file, original);
    f.store.reconcile(f.ctx);
    expect(f.store.mutate(f.ctx, add).revision).toBe(1);
  });
  it("quarantines unreadable post-append storage until explicit repaired reconciliation", () => {
    const f = fixture();
    const original = readFileSync(f.file, "utf8");
    const nativeAppend = fs.appendFileSync;
    vi.spyOn(fs, "appendFileSync").mockImplementation((...args: Parameters<typeof fs.appendFileSync>) => {
      if (args[0] !== f.file) return nativeAppend(...args);
      renameSync(f.file, `${f.file}.saved`);
      mkdirSync(f.file);
      throw new Error("EIO; verification destination unreadable");
    });
    syncBuiltinESMExports();
    expect(() => f.store.mutate(f.ctx, add)).toThrow(/unavailable.*uncertain/i);
    expect(f.store.isUnavailable).toBe(true);
    expect(() => f.store.read(f.ctx)).toThrow(/unavailable/);
    expect(() => f.store.mutate(f.ctx, add)).toThrow(/unavailable/);
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    rmSync(f.file, { recursive: true });
    renameSync(`${f.file}.saved`, f.file);
    expect(readFileSync(f.file, "utf8")).toBe(original);
    f.store.reconcile(f.ctx);
    expect(f.store.read(f.ctx)).toEqual(empty());
    expect(() => f.store.mutate(f.ctx, add)).toThrow(/uncommitted.*reload/i);
    const open = reopened(f);
    expect(open.store.mutate(open.ctx, add).revision).toBe(1);
  });
  it("detects a same-size file rewrite and never serves a cached authoritative record after storage becomes unreadable", () => {
    const f = fixture();
    f.store.mutate(f.ctx, add);
    const contents = readFileSync(f.file, "utf8");
    const corrupted = contents.replace("Durable task", "Corrupt task");
    expect(Buffer.byteLength(corrupted)).toBe(Buffer.byteLength(contents));
    writeFileSync(f.file, corrupted);
    expect(() => f.store.read(f.ctx)).toThrow(/unavailable/);
    writeFileSync(f.file, contents);
    f.store.reconcile(f.ctx);
    expect(f.store.read(f.ctx).revision).toBe(1);
    renameSync(f.file, `${f.file}.saved`);
    mkdirSync(f.file);
    expect(() => f.store.read(f.ctx)).toThrow(/unavailable/);
    expect(() => f.store.mutate(f.ctx, { action: "clear", baseRevision: 1 })).toThrow(/unavailable/);
    expect(f.append).toHaveBeenCalledOnce();
  });
  it("does not adopt destination ownership if the public context changes during post-append verification", () => {
    const f = fixture();
    const destination = SessionManager.inMemory();
    const nativeRead = fs.readSync;
    const nativeAppend = fs.appendFileSync;
    let duringPostAppend = false;
    vi.spyOn(fs, "appendFileSync").mockImplementation((...args: Parameters<typeof fs.appendFileSync>) => {
      nativeAppend(...args);
      if (args[0] === f.file) duringPostAppend = true;
    });
    vi.spyOn(fs, "readSync").mockImplementation((...args: Parameters<typeof fs.readSync>) => {
      const count = nativeRead(...args);
      if (duringPostAppend) {
        Object.assign(f.ctx, { sessionManager: destination });
        duringPostAppend = false;
      }
      return count;
    });
    syncBuiltinESMExports();
    expect(() => f.store.mutate(f.ctx, add)).toThrow(/ownership changed during durability/);
    expect(f.store.isUnavailable).toBe(true);
    expect(destination.getBranch()).toEqual([]);
    expect(() => f.store.read(f.ctx)).toThrow(/ownership/);
  });
  it("accepts a positively verified commit even when native append throws AFTER the complete disk write", () => {
    const f = fixture();
    const spy = fault(f.file, true);
    expect(f.store.mutate(f.ctx, add).revision).toBe(1);
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
    syncBuiltinESMExports();
    const open = reopened(f);
    expect(open.store.read(open.ctx).tasks[0].title).toBe("Durable task");
  });
  it("restores only exact committed branch entries; ignores altered same-ID data and incomplete records", () => {
    const f = fixture();
    const first = f.store.mutate(f.ctx, add);
    const root = f.manager.getLeafId();
    const firstDisk = readFileSync(f.file, "utf8");
    f.store.mutate(f.ctx, { action: "clear", baseRevision: 1 });
    if (!root) throw new Error("No branch root");
    f.manager.branch(root);
    f.store.reconcile(f.ctx);
    expect(f.store.read(f.ctx)).toEqual(first);
    const entry = f.manager.getBranch().at(-1);
    if (entry?.type !== "custom") throw new Error("Missing own entry");
    (entry.data as typeof first).tasks[0].status = "completed";
    f.store.reconcile(f.ctx);
    expect(f.store.read(f.ctx)).toEqual(empty()); // Same ID, different data is not durable authority.
    writeFileSync(f.file, firstDisk.slice(0, -1)); // Remove terminating newline, leaving an incomplete own record.
    f.store.reconcile(f.ctx);
    expect(f.store.read(f.ctx)).toEqual(empty());
    expect(() => f.store.mutate(f.ctx, add)).toThrow(/incomplete/);
    // Public native open repairs a syntactically complete final JSON value with a newline.
    // It becomes authority only AFTER the SDK actually persists that complete line.
    const open = reopened(f);
    expect(readFileSync(f.file, "utf8").endsWith("\n")).toBe(true);
    expect(open.store.read(open.ctx)).toEqual(first);
  });
  it("bounds streaming lines without rejecting a large unrelated persisted conversation", () => {
    const f = fixture(false);
    f.manager.appendMessage({ role: "user", content: "x".repeat(1024 * 1024), timestamp: 1 });
    f.manager.appendCustomEntry("other-extension", { blob: "x".repeat(1024 * 1024) });
    f.store.reconcile(f.ctx);
    const first = f.store.mutate(f.ctx, add);
    expect(first.revision).toBe(1);
    const open = reopened(f);
    expect(open.store.read(open.ctx)).toEqual(first);
    // A same-file ordinary append is allowed, but earlier native data tampering is not.
    open.manager.appendMessage({ role: "user", content: "Continue normally", timestamp: 2 });
    expect(open.store.mutate(open.ctx, { action: "clear", baseRevision: 1 }).revision).toBe(2);
  });
  it("recovers durable empty snapshots across native fork/open without adopting an abandoned branch", () => {
    const f = fixture();
    f.store.mutate(f.ctx, add);
    const root = f.manager.getLeafId();
    f.store.mutate(f.ctx, { action: "clear", baseRevision: 1 });
    const open = reopened(f);
    expect(open.store.read(open.ctx)).toMatchObject({ revision: 2, tasks: [] });
    if (!root) throw new Error("Missing fork root");
    const forkFile = f.manager.createBranchedSession(root);
    if (!forkFile) throw new Error("Missing native fork file");
    const forkManager = SessionManager.open(forkFile, f.dir);
    const forkCtx = { sessionManager: forkManager } as unknown as ExtensionContext;
    open.store.reconcile(forkCtx);
    expect(open.store.read(forkCtx)).toMatchObject({ revision: 1, tasks: [{ title: "Durable task" }] });
  });
  it("does not adopt native ghosts of invalid or fresh state during file-backed recovery", () => {
    const f = fixture(false);
    f.manager.appendCustomEntry(STATE_TYPE, { schemaVersion: 1, revision: 1, tasks: [] });
    f.store.reconcile(f.ctx);
    expect(f.store.read(f.ctx)).toEqual(empty());
    expect(f.store.persistenceStatus).toContain("not persisted yet");
  });
});
