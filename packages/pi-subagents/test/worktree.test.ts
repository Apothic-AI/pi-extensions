import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import type { AgentRecord } from "../src/types.js";
import * as worktreeModule from "../src/worktree.js";
import {
  cleanupWorktree,
  createWorktree,
  isWorktreeIsolationEnabled,
  pruneWorktrees,
  setWorktreeIsolationEnabled,
} from "../src/worktree.js";

/**
 * Helper: create a temporary git repo with an initial commit.
 */
function initGitRepo(prefix = join(tmpdir(), "pi-wt-test-")): string {
  const dir = mkdtempSync(prefix);
  execFileSync("git", ["init"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# Test repo");
  execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, stdio: "pipe" });
  return dir;
}

describe("worktree", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = initGitRepo();
  });

  afterEach(() => {
    // Clean up any lingering worktrees first, then remove repo
    try { pruneWorktrees(repoDir); } catch { /* ignore */ }
    rmSync(repoDir, { recursive: true, force: true });
  });

  describe("createWorktree", () => {
    it("creates a worktree in tmpdir", () => {
      const wt = createWorktree(repoDir, "test-id-1");
      expect(wt).toBeDefined();
      expect(existsSync(wt!.path)).toBe(true);
      expect(wt!.branch).toBe("pi-agent-test-id-1");
      expect(wt!.baseSha).toBe(execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repoDir, stdio: "pipe",
      }).toString().trim());

      // Verify it's a valid worktree with the repo's files
      expect(existsSync(join(wt!.path, "README.md"))).toBe(true);

      // Cleanup
      try { execFileSync("git", ["worktree", "remove", "--force", wt!.path], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
    });

    it("returns undefined for non-git directory", () => {
      const nonGit = mkdtempSync(join(tmpdir(), "pi-wt-nongit-"));
      try {
        const wt = createWorktree(nonGit, "test-id-2");
        expect(wt).toBeUndefined();
      } finally {
        rmSync(nonGit, { recursive: true, force: true });
      }
    });

    it("returns undefined for git repo with no commits", () => {
      const emptyRepo = mkdtempSync(join(tmpdir(), "pi-wt-empty-"));
      try {
        execFileSync("git", ["init"], { cwd: emptyRepo, stdio: "pipe" });
        const wt = createWorktree(emptyRepo, "no-commits");
        expect(wt).toBeUndefined();
      } finally {
        rmSync(emptyRepo, { recursive: true, force: true });
      }
    });

    it("workPath equals path when created from the repo root", () => {
      const wt = createWorktree(repoDir, "root-wp")!;
      expect(wt.workPath).toBe(wt.path);
      try { execFileSync("git", ["worktree", "remove", "--force", wt.path], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
    });

    it("workPath preserves subdirectory scoping (monorepo package cwd)", () => {
      mkdirSync(join(repoDir, "packages", "api"), { recursive: true });
      writeFileSync(join(repoDir, "packages", "api", "index.ts"), "export {}");
      execFileSync("git", ["add", "-A"], { cwd: repoDir, stdio: "pipe" });
      execFileSync("git", ["commit", "-m", "add package"], { cwd: repoDir, stdio: "pipe" });

      const wt = createWorktree(join(repoDir, "packages", "api"), "subdir-wp")!;
      expect(wt).toBeDefined();
      expect(wt.workPath).toBe(join(wt.path, "packages", "api"));
      expect(existsSync(wt.workPath)).toBe(true);
      try { execFileSync("git", ["worktree", "remove", "--force", wt.path], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
    });

    it("uses unique paths for multiple worktrees", () => {
      const wt1 = createWorktree(repoDir, "multi-1");
      const wt2 = createWorktree(repoDir, "multi-2");
      expect(wt1).toBeDefined();
      expect(wt2).toBeDefined();
      expect(wt1!.path).not.toBe(wt2!.path);

      // Cleanup
      try { execFileSync("git", ["worktree", "remove", "--force", wt1!.path], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
      try { execFileSync("git", ["worktree", "remove", "--force", wt2!.path], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
    });
  });

  describe("cleanupWorktree", () => {
    it("removes worktree when no changes made", () => {
      const wt = createWorktree(repoDir, "clean-1")!;
      expect(wt).toBeDefined();

      const result = cleanupWorktree(repoDir, wt, "test cleanup");
      expect(result.hasChanges).toBe(false);
      expect(result.branch).toBeUndefined();
    });

    it("commits changes and creates branch when changes exist", () => {
      const wt = createWorktree(repoDir, "dirty-1")!;
      expect(wt).toBeDefined();

      // Make a change in the worktree
      writeFileSync(join(wt.path, "new-file.txt"), "agent wrote this");

      const result = cleanupWorktree(repoDir, wt, "added new file");
      expect(result.hasChanges).toBe(true);
      expect(result.branch).toBeDefined();
      expect(result.branch).toContain("pi-agent-dirty-1");

      // Verify the branch exists in the main repo
      const branches = execFileSync("git", ["branch", "--list", result.branch!], {
        cwd: repoDir, stdio: "pipe",
      }).toString().trim();
      expect(branches).toContain(result.branch!);

      // Verify the commit message
      const log = execFileSync("git", ["log", "--oneline", "-1", result.branch!], {
        cwd: repoDir, stdio: "pipe",
      }).toString().trim();
      expect(log).toContain("pi-agent: added new file");

      // Cleanup branch
      try { execFileSync("git", ["branch", "-D", result.branch!], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
    });

    it("commits changes even when a pre-commit hook rejects (--no-verify)", () => {
      // A failing pre-commit hook in the main repo also applies to its
      // worktrees — without --no-verify it would abort the preservation commit.
      const hookPath = join(repoDir, ".git", "hooks", "pre-commit");
      writeFileSync(hookPath, "#!/bin/sh\nexit 1\n", { mode: 0o755 });

      const wt = createWorktree(repoDir, "hooked-1")!;
      expect(wt).toBeDefined();
      writeFileSync(join(wt.path, "hooked-file.txt"), "agent wrote this");

      const result = cleanupWorktree(repoDir, wt, "hook should not block");
      expect(result.hasChanges).toBe(true);
      expect(result.branch).toBe("pi-agent-hooked-1");

      // Cleanup branch
      try { execFileSync("git", ["branch", "-D", result.branch!], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
    });

    it("creates branch when worktree is clean but HEAD moved", () => {
      const wt = createWorktree(repoDir, "committed-1")!;
      expect(wt).toBeDefined();

      writeFileSync(join(wt.path, "committed-file.txt"), "agent committed this");
      execFileSync("git", ["add", "committed-file.txt"], { cwd: wt.path, stdio: "pipe" });
      execFileSync("git", ["commit", "-m", "agent commit"], { cwd: wt.path, stdio: "pipe" });
      const agentCommit = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: wt.path, stdio: "pipe",
      }).toString().trim();

      const result = cleanupWorktree(repoDir, wt, "already committed");
      expect(result.hasChanges).toBe(true);
      expect(result.branch).toBeDefined();
      expect(result.branch).toBe("pi-agent-committed-1");

      const branchCommit = execFileSync("git", ["rev-parse", result.branch!], {
        cwd: repoDir, stdio: "pipe",
      }).toString().trim();
      expect(branchCommit).toBe(agentCommit);
      expect(existsSync(wt.path)).toBe(false);

      // Cleanup branch
      try { execFileSync("git", ["branch", "-D", result.branch!], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
    });

    it("does not force-overwrite existing branch", () => {
      // Create first worktree, make changes, cleanup → creates branch
      const wt1 = createWorktree(repoDir, "conflict-1")!;
      writeFileSync(join(wt1.path, "file1.txt"), "first run");
      const result1 = cleanupWorktree(repoDir, wt1, "first");
      expect(result1.branch).toBe("pi-agent-conflict-1");

      // Create second worktree with same agent ID, make changes
      const wt2 = createWorktree(repoDir, "conflict-1")!;
      writeFileSync(join(wt2.path, "file2.txt"), "second run");
      const result2 = cleanupWorktree(repoDir, wt2, "second");

      // Should use a different branch name (timestamp suffix)
      expect(result2.hasChanges).toBe(true);
      expect(result2.branch).toBeDefined();
      expect(result2.branch).not.toBe("pi-agent-conflict-1");
      expect(result2.branch).toContain("pi-agent-conflict-1-");

      // Both branches should exist
      const branches = execFileSync("git", ["branch", "--list", "pi-agent-conflict-1*"], {
        cwd: repoDir, stdio: "pipe",
      }).toString().trim();
      expect(branches).toContain("pi-agent-conflict-1");
      expect(branches).toContain(result2.branch!);

      // Cleanup
      try { execFileSync("git", ["branch", "-D", result1.branch!], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
      try { execFileSync("git", ["branch", "-D", result2.branch!], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
    });

    it("handles already-deleted worktree gracefully", () => {
      const wt = createWorktree(repoDir, "gone-1")!;
      // Manually delete the worktree directory
      rmSync(wt.path, { recursive: true, force: true });

      const result = cleanupWorktree(repoDir, wt, "already gone");
      expect(result.hasChanges).toBe(false);
    });

    it("truncates commit message at 200 chars", () => {
      const wt = createWorktree(repoDir, "long-msg")!;
      writeFileSync(join(wt.path, "change.txt"), "something");
      const longDesc = "x".repeat(300);
      const result = cleanupWorktree(repoDir, wt, longDesc);
      expect(result.hasChanges).toBe(true);

      const log = execFileSync("git", ["log", "--oneline", "-1", result.branch!], {
        cwd: repoDir, stdio: "pipe",
      }).toString().trim();
      // "pi-agent: " prefix (10 chars) + 200 chars of x = 210 total max
      expect(log.length).toBeLessThanOrEqual(220); // some slack for hash prefix

      // Cleanup
      try { execFileSync("git", ["branch", "-D", result.branch!], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
    });
  });

  describe("pruneWorktrees", () => {
    it("does not throw on a clean repo", () => {
      expect(() => pruneWorktrees(repoDir)).not.toThrow();
    });

    it("does not throw on non-git directory", () => {
      const nonGit = mkdtempSync(join(tmpdir(), "pi-wt-nongit-"));
      try {
        expect(() => pruneWorktrees(nonGit)).not.toThrow();
      } finally {
        rmSync(nonGit, { recursive: true, force: true });
      }
    });
  });
});

// Real Git failures must retain the checkout and its registration. A failure
// result alone is insufficient evidence of preservation: check the actual bytes.
describe("cleanupWorktree — preservation and removal failures", () => {
  let repoDir: string;
  let paths: string[];
  const bytes = Buffer.from([0, 1, 2, 255, 10]);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repoDir, stdio: "pipe" }).toString();
  const registry = () => git("worktree", "list", "--porcelain", "-z");
  const create = (id: string) => {
    const wt = createWorktree(repoDir, id)!;
    expect(wt).toBeDefined();
    paths.push(wt.path);
    writeFileSync(join(wt.path, "work.bin"), bytes);
    return wt;
  };

  beforeEach(() => { repoDir = initGitRepo(); paths = []; });
  afterEach(() => {
    // Only generated disposable fixtures, including deliberately corrupt/locked
    // checkouts. Never operate on the current or a reference checkout.
    for (const path of paths) rmSync(path, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  });

  for (const failure of ["commit", "both branches", "status"] as const) {
    it(`preserves bytes and registration after ${failure} failure, including retries`, () => {
      const wt = create(`preserve-${failure.replaceAll(" ", "-")}`);
      const originalRegistrations = registry().split("\0").filter((field) => field.startsWith("worktree "));
      const gitLink = readFileSync(join(wt.path, ".git"));
      if (failure === "commit") {
        // Deterministic repository-local signing failure: independent of the
        // process's author/committer identity or any live signing credentials.
        git("config", "commit.gpgSign", "true");
        git("config", "gpg.format", "openpgp");
        git("config", "gpg.program", join(repoDir, "missing-signing-program"));
      }
      if (failure === "both branches") wt.branch = "pi-agent-bad..id";
      if (failure === "status") writeFileSync(join(wt.path, ".git"), "gitdir: /nonexistent/pi-worktree-test\n");

      for (let attempt = 0; attempt < 2; attempt++) {
        const result = cleanupWorktree(repoDir, wt, "must preserve");
        expect(result.cleanupSucceeded).toBe(false);
        expect(result.path).toBe(wt.path);
        expect(result.branch).toBeUndefined();
        expect(result.cleanupDiagnostic).toBeTruthy();
        expect(result.hasChanges).toBe(failure !== "status");
        expect(readFileSync(join(wt.path, "work.bin"))).toEqual(bytes);
        // The successful preservation commit before branch failure may advance
        // HEAD, but the checkout's Git registration must remain attached.
        expect(registry().split("\0").filter((field) => field.startsWith("worktree "))).toEqual(originalRegistrations);
        expect(result.recoveryCommands?.join("\n")).not.toMatch(/rm -rf|worktree remove|worktree prune/);
        expect(result.recoveryCommands?.join("\n")).toMatch(/status|log/);
      }

      // Repair the fixture and prove a later cleanup can safely preserve it.
      git("config", "commit.gpgSign", "false");
      wt.branch = "pi-agent-repaired";
      writeFileSync(join(wt.path, ".git"), gitLink);
      const recovered = cleanupWorktree(repoDir, wt, "repaired");
      expect(recovered.cleanupSucceeded).toBe(true);
      expect(execFileSync("git", ["show", `${recovered.branch}:work.bin`], { cwd: repoDir })).toEqual(bytes);
      expect(existsSync(wt.path)).toBe(false);
      expect(registry()).not.toContain(wt.path);
    });
  }

  it("quotes recovery paths literally without executing shell metacharacters", () => {
    const specialRepo = initGitRepo(join(repoDir, "repo ' $(touch injected-cwd-dollar) `touch injected-cwd-backtick` $WT_QUOTE_CANARY "));
    const wt = createWorktree(specialRepo, "quoted-recovery")!;
    expect(wt).toBeDefined();
    paths.push(wt.path);
    const movedPath = join(repoDir, "checkout ' $(touch injected-path-dollar) `touch injected-path-backtick` $WT_QUOTE_CANARY");
    execFileSync("git", ["worktree", "move", wt.path, movedPath], { cwd: specialRepo, stdio: "pipe" });
    paths.push(movedPath);
    wt.path = movedPath;
    wt.workPath = movedPath;
    writeFileSync(join(wt.path, "work.bin"), bytes);
    for (const [key, value] of [
      ["commit.gpgSign", "true"],
      ["gpg.format", "openpgp"],
      ["gpg.program", join(repoDir, "missing-signing-program")],
    ]) execFileSync("git", ["config", key!, value!], { cwd: specialRepo, stdio: "pipe" });
    const result = cleanupWorktree(specialRepo, wt, "quoted paths");
    expect(result.cleanupSucceeded).toBe(false);
    expect(result.recoveryCommands).toHaveLength(4);
    const inspections = result.recoveryCommands!.slice(0, 3).map((command) => spawnSync("sh", ["-c", command], {
      cwd: repoDir,
      env: { ...process.env, WT_QUOTE_CANARY: "EXPANDED" },
      encoding: "utf8",
    }));
    for (const canary of ["injected-cwd-dollar", "injected-cwd-backtick", "injected-path-dollar", "injected-path-backtick"]) {
      expect(existsSync(join(repoDir, canary)), canary).toBe(false);
    }
    expect(inspections.map((inspection) => inspection.status)).toEqual([0, 0, 0]);
    expect(inspections[0]!.stdout).toContain(movedPath);
    expect(inspections[1]!.stdout).toContain("work.bin");
    expect(inspections[2]!.stdout).toContain("initial");
    expect(readFileSync(join(wt.path, "work.bin"))).toEqual(bytes);
  });

  it("reports locked removal as failure and includes the preservation branch", () => {
    const wt = create("locked");
    git("worktree", "lock", wt.path);
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = cleanupWorktree(repoDir, wt, "locked checkout");
      expect(result.cleanupSucceeded).toBe(false);
      expect(result.branch).toBe(wt.branch);
      expect(result.cleanupDiagnostic).toMatch(/locked/i);
      expect(readFileSync(join(wt.path, "work.bin"))).toEqual(bytes);
      expect(registry()).toContain(wt.path);
      expect(execFileSync("git", ["show", `${result.branch}:work.bin`], { cwd: repoDir })).toEqual(bytes);
    }
    git("worktree", "unlock", wt.path);
    expect(cleanupWorktree(repoDir, wt, "unlocked").cleanupSucceeded).toBe(true);
    expect(existsSync(wt.path)).toBe(false);
    expect(registry()).not.toContain(wt.path);
  });

  it("Git locks a missing registered checkout and cleanup preserves its existing lock reason", () => {
    const wt = create("missing-lock-primitive");
    wt.branch = "pi-agent-bad..id";
    expect(cleanupWorktree(repoDir, wt, "failed preservation").cleanupSucceeded).toBe(false);
    const gitDirectory = readFileSync(join(wt.path, ".git"), "utf8").trim().slice("gitdir: ".length);
    const head = readFileSync(join(gitDirectory, "HEAD"));
    const index = readFileSync(join(gitDirectory, "index"));
    rmSync(wt.path, { recursive: true, force: true });
    git("worktree", "lock", "--reason", "Existing manual recovery reason", wt.path);
    const lock = readFileSync(join(gitDirectory, "locked"));
    expect(cleanupWorktree(repoDir, wt, "missing locked checkout").cleanupSucceeded).toBe(false);
    expect(readFileSync(join(gitDirectory, "locked"))).toEqual(lock);
    git("worktree", "prune", "--expire", "now");
    expect(registry()).toContain(wt.path);
    expect(readFileSync(join(gitDirectory, "HEAD"))).toEqual(head);
    expect(readFileSync(join(gitDirectory, "index"))).toEqual(index);
  });

  it.skipIf(process.getuid?.() === 0)("reports a recovery-lock write failure explicitly and retains recovery state", () => {
    const wt = create("missing-lock-failure");
    wt.branch = "pi-agent-bad..id";
    expect(cleanupWorktree(repoDir, wt, "failed preservation").cleanupSucceeded).toBe(false);
    const gitDirectory = readFileSync(join(wt.path, ".git"), "utf8").trim().slice("gitdir: ".length);
    const head = readFileSync(join(gitDirectory, "HEAD"));
    const index = readFileSync(join(gitDirectory, "index"));
    rmSync(wt.path, { recursive: true, force: true });
    // Real filesystem refusal in the disposable registration. Root bypasses
    // Unix mode bits, so this specific permission-failure fixture excludes it.
    chmodSync(gitDirectory, 0o555);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = cleanupWorktree(repoDir, wt, "cannot lock missing recovery");
        expect(result.cleanupSucceeded).toBe(false);
        expect(result.cleanupDiagnostic).toContain("recovery registration could not be locked");
        expect(registry()).toContain(wt.path);
        expect(readFileSync(join(gitDirectory, "HEAD"))).toEqual(head);
        expect(readFileSync(join(gitDirectory, "index"))).toEqual(index);
      }
    } finally {
      chmodSync(gitDirectory, 0o755);
    }
    expect(cleanupWorktree(repoDir, wt, "retry locking").cleanupSucceeded).toBe(false);
    expect(existsSync(join(gitDirectory, "locked"))).toBe(true);
  });

  it.skipIf(process.getuid?.() === 0)("appends recovery-lock refusal to a pinned cleanup diagnostic without dropping ownership", async () => {
    const wt = create("pinned-lock-failure");
    const gitDirectory = readFileSync(join(wt.path, ".git"), "utf8").trim().slice("gitdir: ".length);
    rmSync(wt.path, { recursive: true, force: true });
    const record: AgentRecord = {
      id: "pinned", type: "test", description: "pinned missing worktree", status: "completed",
      toolUses: 0, startedAt: Date.now(), lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0, worktree: wt,
    };
    const manager = new AgentManager();
    const internal = manager as unknown as {
      agents: Map<string, AgentRecord>;
      providerPendingRecords: Set<string>;
      cleanupRecordWorktree(record: AgentRecord, cwd: string, description: string): { cleanupSucceeded?: boolean; cleanupDiagnostic?: string };
    };
    internal.agents.set(record.id, record);
    internal.providerPendingRecords.add(record.id);
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(repoDir);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    chmodSync(gitDirectory, 0o555);
    try {
      const result = internal.cleanupRecordWorktree(record, repoDir, "pinned");
      expect(result.cleanupSucceeded).toBe(false);
      expect(result.cleanupDiagnostic).toContain("provider/tool settlement");
      expect(result.cleanupDiagnostic).toContain("recovery registration could not be locked");
      expect(record.worktree).toBe(wt);
      expect(registry()).toContain(wt.path);
      expect(existsSync(join(gitDirectory, "locked"))).toBe(false);
    } finally {
      chmodSync(gitDirectory, 0o755);
      await manager.dispose();
      cwd.mockRestore();
      warning.mockRestore();
    }
  });

  for (const scenario of ["agent commit", "staged index", "failed branch preservation"] as const) {
    it(`retains missing-checkout HEAD and index recovery after ${scenario}`, () => {
      const wt = create("missing-recovery");
      const gitDirectory = readFileSync(join(wt.path, ".git"), "utf8").trim().slice("gitdir: ".length);
      if (scenario === "agent commit" || scenario === "staged index") {
        execFileSync("git", ["add", "work.bin"], { cwd: wt.path, stdio: "pipe" });
        if (scenario === "agent commit") {
          execFileSync("git", ["commit", "-m", "detached agent work"], { cwd: wt.path, stdio: "pipe" });
        }
      } else {
        wt.branch = "pi-agent-bad..id";
        expect(cleanupWorktree(repoDir, wt, "failed preservation").cleanupSucceeded).toBe(false);
      }
      const head = readFileSync(join(gitDirectory, "HEAD"));
      const index = readFileSync(join(gitDirectory, "index"));
      if (scenario === "staged index") expect(head.toString().trim()).toBe(wt.baseSha);
      else expect(head.toString().trim()).not.toBe(wt.baseSha);
      rmSync(wt.path, { recursive: true, force: true });
      let retainedRegistry: string | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = cleanupWorktree(repoDir, wt, "missing recoverable checkout");
        expect(result.cleanupSucceeded).toBe(false);
        expect(result.path).toBe(wt.path);
        expect(result.cleanupDiagnostic).toMatch(/missing|absent/i);
        expect(registry()).toContain(wt.path);
        expect(readFileSync(join(gitDirectory, "locked"), "utf8").trim()).toBe("pi-subagents: missing checkout retained for HEAD/index recovery");
        retainedRegistry ??= registry();
        expect(registry()).toBe(retainedRegistry);
        expect(readFileSync(join(gitDirectory, "HEAD"))).toEqual(head);
        expect(readFileSync(join(gitDirectory, "index"))).toEqual(index);
        const revision = scenario === "staged index" ? ":work.bin" : `${head.toString().trim()}:work.bin`;
        expect(execFileSync("git", ["--git-dir", gitDirectory, "show", revision], { cwd: repoDir })).toEqual(bytes);
      }
    });
  }

  for (const location of ["root", "package subdirectory", "linked checkout"] as const) {
    it(`shutdown retains missing-checkout recovery when cwd is a ${location}`, async () => {
      const wt = create("shutdown-missing-recovery");
      const gitDirectory = readFileSync(join(wt.path, ".git"), "utf8").trim().slice("gitdir: ".length);
      wt.branch = "pi-agent-bad..id";
      expect(cleanupWorktree(repoDir, wt, "failed preservation").cleanupSucceeded).toBe(false);
      const head = readFileSync(join(gitDirectory, "HEAD"));
      const index = readFileSync(join(gitDirectory, "index"));
      expect(head.toString().trim()).not.toBe(wt.baseSha);
      rmSync(wt.path, { recursive: true, force: true });
      // Make the recovery registration eligible even under Git's expiry rules.
      for (const file of ["gitdir", "index"]) utimesSync(join(gitDirectory, file), new Date(0), new Date(0));
      const prunable = spawnSync("git", ["worktree", "prune", "--dry-run", "--verbose"], { cwd: repoDir, encoding: "utf8" });
      expect(prunable.status).toBe(0);
      expect(prunable.stdout + prunable.stderr).toContain("gitdir file points to non-existent location");
      let sessionCwd = repoDir;
      if (location === "package subdirectory") {
        sessionCwd = join(repoDir, "packages", "fixture");
        mkdirSync(sessionCwd, { recursive: true });
      } else if (location === "linked checkout") {
        const linked = createWorktree(repoDir, "session-cwd")!;
        expect(linked).toBeDefined();
        paths.push(linked.path);
        sessionCwd = linked.path;
      }
      const missingRegistrations = registry().split("\0").filter((field) => field.startsWith("worktree "));
      const manager = new AgentManager();
      const record: AgentRecord = {
        id: "missing", type: "test", description: "missing worktree", status: "completed",
        toolUses: 0, startedAt: Date.now(), lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
        compactionCount: 0, worktree: wt,
      };
      // A healthy sibling still receives individual cleanup despite deferred
      // global pruning; retain its result on the original record for inspection.
      const sibling = createWorktree(repoDir, "shutdown-healthy-sibling")!;
      expect(sibling).toBeDefined();
      paths.push(sibling.path);
      const siblingRecord: AgentRecord = { ...record, id: "sibling", worktree: sibling };
      const records = (manager as unknown as { agents: Map<string, AgentRecord> }).agents;
      records.set(record.id, record);
      records.set(siblingRecord.id, siblingRecord);
      // Manager disposal includes process.cwd among prune targets. Every real
      // Git operation must stay in this fixture, never the shared checkout.
      const cwd = vi.spyOn(process, "cwd").mockReturnValue(sessionCwd);
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const failures = await manager.dispose();
        expect(failures).toHaveLength(1);
        expect(failures[0]!.path).toBe(wt.path);
        expect(failures[0]!.recoveryCommands).not.toHaveLength(0);
        expect(record.worktree).toBe(wt);
        expect(record.worktreeResult?.cleanupSucceeded).toBe(false);
        expect(siblingRecord.worktree).toBeUndefined();
        expect(siblingRecord.worktreeResult?.cleanupSucceeded).toBe(true);
        expect(existsSync(sibling.path)).toBe(false);
        expect(registry().split("\0").filter((field) => field.startsWith("worktree "))).toEqual(missingRegistrations);
        const retainedRegistry = registry();
        expect(readFileSync(join(gitDirectory, "HEAD"))).toEqual(head);
        expect(readFileSync(join(gitDirectory, "index"))).toEqual(index);
        expect(execFileSync("git", ["--git-dir", gitDirectory, "show", `${head.toString().trim()}:work.bin`], { cwd: repoDir })).toEqual(bytes);
        expect(cleanupWorktree(repoDir, wt, "retry after shutdown").cleanupSucceeded).toBe(false);
        expect(await manager.dispose()).toBe(failures);
        expect(registry()).toBe(retainedRegistry);
      } finally {
        await manager.dispose();
        cwd.mockRestore();
        warning.mockRestore();
      }
    });
  }

  it("shutdown still prunes orphan registrations after all attached worktrees clean up", async () => {
    const orphan = createWorktree(repoDir, "shutdown-orphan")!;
    expect(orphan).toBeDefined();
    paths.push(orphan.path);
    const gitDirectory = readFileSync(join(orphan.path, ".git"), "utf8").trim().slice("gitdir: ".length);
    rmSync(orphan.path, { recursive: true, force: true });
    for (const file of ["gitdir", "index"]) utimesSync(join(gitDirectory, file), new Date(0), new Date(0));
    const prunable = spawnSync("git", ["worktree", "prune", "--dry-run", "--verbose"], { cwd: repoDir, encoding: "utf8" });
    expect(prunable.status).toBe(0);
    expect(prunable.stdout + prunable.stderr).toContain("gitdir file points to non-existent location");
    const wt = createWorktree(repoDir, "shutdown-clean")!;
    expect(wt).toBeDefined();
    paths.push(wt.path);
    const record: AgentRecord = {
      id: "clean", type: "test", description: "clean worktree", status: "completed",
      toolUses: 0, startedAt: Date.now(), lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0, worktree: wt,
    };
    const manager = new AgentManager();
    (manager as unknown as { agents: Map<string, AgentRecord> }).agents.set(record.id, record);
    const sessionCwd = join(repoDir, "packages", "fixture");
    mkdirSync(sessionCwd, { recursive: true });
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(sessionCwd);
    try {
      expect(await manager.dispose()).toEqual([]);
      expect(record.worktree).toBeUndefined();
      expect(record.worktreeResult?.cleanupSucceeded).toBe(true);
      expect(existsSync(wt.path)).toBe(false);
      expect(registry()).not.toContain(wt.path);
      expect(registry()).not.toContain(orphan.path);
      expect(existsSync(gitDirectory)).toBe(false);
    } finally {
      await manager.dispose();
      cwd.mockRestore();
    }
  });

  it("locks missing-checkout recovery across explicit pruning and fresh-manager shutdown", async () => {
    const wt = create("reload-missing-recovery");
    const gitDirectory = readFileSync(join(wt.path, ".git"), "utf8").trim().slice("gitdir: ".length);
    wt.branch = "pi-agent-bad..id";
    expect(cleanupWorktree(repoDir, wt, "failed preservation").cleanupSucceeded).toBe(false);
    const head = readFileSync(join(gitDirectory, "HEAD"));
    const index = readFileSync(join(gitDirectory, "index"));
    rmSync(wt.path, { recursive: true, force: true });
    for (const file of ["gitdir", "index"]) utimesSync(join(gitDirectory, file), new Date(0), new Date(0));
    const record: AgentRecord = {
      id: "missing", type: "test", description: "missing worktree", status: "completed",
      toolUses: 0, startedAt: Date.now(), lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0, worktree: wt,
    };
    const manager = new AgentManager();
    const fresh = new AgentManager();
    (manager as unknown as { agents: Map<string, AgentRecord> }).agents.set(record.id, record);
    const sessionCwd = join(repoDir, "packages", "fixture");
    mkdirSync(sessionCwd, { recursive: true });
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(sessionCwd);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await manager.dispose()).toHaveLength(1);
      expect(record.worktree).toBe(wt);
      expect(readFileSync(join(gitDirectory, "locked"), "utf8").trim()).toBe("pi-subagents: missing checkout retained for HEAD/index recovery");
      const retainedRegistry = registry();
      git("worktree", "prune", "--expire", "now");
      expect(await fresh.dispose()).toEqual([]);
      expect(registry()).toBe(retainedRegistry);
      expect(readFileSync(join(gitDirectory, "HEAD"))).toEqual(head);
      expect(readFileSync(join(gitDirectory, "index"))).toEqual(index);
      expect(execFileSync("git", ["--git-dir", gitDirectory, "show", `${head.toString().trim()}:work.bin`], { cwd: repoDir })).toEqual(bytes);
      expect(cleanupWorktree(repoDir, wt, "retry after reload").cleanupSucceeded).toBe(false);
      expect(registry()).toBe(retainedRegistry);
    } finally {
      await manager.dispose();
      await fresh.dispose();
      cwd.mockRestore();
      warning.mockRestore();
    }
  });

  for (const pin of ["provider", "steering", "teardown", "descendant"] as const) {
    it(`protects observed missing recovery before ${pin}-pinned shutdown and fresh-manager pruning`, async () => {
      const wt = create(`pinned-${pin}`);
      const gitDirectory = readFileSync(join(wt.path, ".git"), "utf8").trim().slice("gitdir: ".length);
      execFileSync("git", ["add", "work.bin"], { cwd: wt.path, stdio: "pipe" });
      execFileSync("git", ["commit", "-m", "detached pinned work"], { cwd: wt.path, stdio: "pipe" });
      const stagedBytes = Buffer.from("staged but not committed");
      writeFileSync(join(wt.path, "staged.bin"), stagedBytes);
      execFileSync("git", ["add", "staged.bin"], { cwd: wt.path, stdio: "pipe" });
      const head = readFileSync(join(gitDirectory, "HEAD"));
      const index = readFileSync(join(gitDirectory, "index"));
      const refs = git("show-ref");
      rmSync(wt.path, { recursive: true, force: true });
      for (const file of ["gitdir", "index"]) utimesSync(join(gitDirectory, file), new Date(0), new Date(0));
      const pending = new Promise<void>(() => {});
      const manager = new AgentManager();
      const fresh = new AgentManager();
      const record: AgentRecord = {
        id: "pinned", type: "test", description: "pinned missing worktree", status: "completed",
        toolUses: 0, startedAt: Date.now(), lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
        compactionCount: 0, worktree: wt,
      };
      const internal = manager as unknown as {
        agents: Map<string, AgentRecord>;
        settlingRecords: Set<string>;
        providerPendingRecords: Set<string>;
        steeringOperations: Map<AgentRecord, Set<Promise<void>>>;
        recordSessionTeardowns: Map<string, Promise<void>>;
        sessionTeardowns: Set<Promise<void>>;
      };
      internal.agents.set(record.id, record);
      if (pin === "provider") {
        record.promise = pending.then(() => "");
        internal.settlingRecords.add(record.id);
        internal.providerPendingRecords.add(record.id);
      } else if (pin === "steering") internal.steeringOperations.set(record, new Set([pending]));
      else if (pin === "teardown") {
        internal.recordSessionTeardowns.set(record.id, pending);
        internal.sessionTeardowns.add(pending);
      } else {
        const child: AgentRecord = { ...record, id: "child", worktree: undefined, ancestorAgentIds: [record.id], promise: pending.then(() => "") };
        internal.agents.set(child.id, child);
        internal.providerPendingRecords.add(child.id);
        internal.settlingRecords.add(child.id);
      }
      const cleanup = vi.spyOn(worktreeModule, "cleanupWorktree");
      const cleanupAsync = vi.spyOn(worktreeModule, "cleanupWorktreeAsync");
      const sessionCwd = join(repoDir, "packages", "fixture");
      mkdirSync(sessionCwd, { recursive: true });
      const cwd = vi.spyOn(process, "cwd").mockReturnValue(sessionCwd);
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const failures = await manager.dispose();
        expect(failures).toHaveLength(1);
        expect(failures[0]!.reason).toMatch(/pinned/);
        expect(failures[0]!.reason).toContain("Git registration remains locked for HEAD/index recovery");
        expect(failures[0]!.recoveryCommands.length).toBeGreaterThan(0);
        expect(record.worktree).toBe(wt);
        expect(record.worktreeResult?.cleanupSucceeded).toBe(false);
        expect(cleanup).not.toHaveBeenCalled();
        expect(cleanupAsync).not.toHaveBeenCalled();
        expect(readFileSync(join(gitDirectory, "locked"), "utf8").trim()).toBe("pi-subagents: missing checkout retained for HEAD/index recovery");
        const retainedRegistry = registry();
        git("worktree", "prune", "--expire", "now");
        expect(await fresh.dispose()).toEqual([]);
        expect(registry()).toBe(retainedRegistry);
        expect(readFileSync(join(gitDirectory, "HEAD"))).toEqual(head);
        expect(readFileSync(join(gitDirectory, "index"))).toEqual(index);
        expect(git("show-ref")).toBe(refs);
        expect(execFileSync("git", ["--git-dir", gitDirectory, "show", `${head.toString().trim()}:work.bin`], { cwd: repoDir })).toEqual(bytes);
        expect(execFileSync("git", ["--git-dir", gitDirectory, "show", ":staged.bin"], { cwd: repoDir })).toEqual(stagedBytes);
      } finally {
        await manager.dispose();
        await fresh.dispose();
        cleanup.mockRestore();
        cleanupAsync.mockRestore();
        cwd.mockRestore();
        warning.mockRestore();
      }
    });
  }

  it("retains even a base-HEAD missing checkout when index recovery is uncertain", () => {
    const wt = create("vanished");
    rmSync(wt.path, { recursive: true, force: true });
    expect(registry()).toContain(wt.path);
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(cleanupWorktree(repoDir, wt, "already gone").cleanupSucceeded).toBe(false);
      expect(existsSync(wt.path)).toBe(false);
      expect(registry()).toContain(wt.path);
    }
  });

  it("does not report success for a locked stale registration", () => {
    const wt = create("missing-locked");
    git("worktree", "lock", wt.path);
    rmSync(wt.path, { recursive: true, force: true });
    expect(cleanupWorktree(repoDir, wt, "missing locked").cleanupSucceeded).toBe(false);
    expect(registry()).toContain(wt.path);
    git("worktree", "unlock", wt.path);
    expect(cleanupWorktree(repoDir, wt, "unlocked missing").cleanupSucceeded).toBe(false);
    expect(registry()).toContain(wt.path);
  });

  it("confirms normal preservation, directory removal and deregistration", () => {
    const wt = create("ordered");
    const result = cleanupWorktree(repoDir, wt, "ordered agent");
    expect(result.cleanupSucceeded).toBe(true);
    expect(result.hasChanges).toBe(true);
    expect(result.branch).toBe(wt.branch);
    expect(execFileSync("git", ["show", `${result.branch}:work.bin`], { cwd: repoDir })).toEqual(bytes);
    expect(existsSync(wt.path)).toBe(false);
    expect(registry()).not.toContain(wt.path);
    expect(cleanupWorktree(repoDir, wt, "again").cleanupSucceeded).toBe(true);
  });
});

/**
 * The project switch itself (`worktreeIsolation`, #184). It gates
 * agent-manager before createWorktree; createWorktree itself remains
 * unconditional so a direct caller that has already decided still gets a real
 * worktree. The default (enabled) is what every "worktree isolation still
 * behaves as before" claim rests on.
 */
describe("worktree isolation switch", () => {
  afterEach(() => setWorktreeIsolationEnabled(true));

  it("defaults to enabled", () => {
    expect(isWorktreeIsolationEnabled()).toBe(true);
  });

  it("round-trips both ways", () => {
    setWorktreeIsolationEnabled(false);
    expect(isWorktreeIsolationEnabled()).toBe(false);
    setWorktreeIsolationEnabled(true);
    expect(isWorktreeIsolationEnabled()).toBe(true);
  });

  // The switch gates callers; it deliberately does not disarm createWorktree
  // itself, so a caller that has already decided (agent-manager checks first)
  // still gets a real worktree rather than a silent no-op.
  it("does not disable createWorktree directly", () => {
    const repoDir = initGitRepo();
    try {
      setWorktreeIsolationEnabled(false);
      const wt = createWorktree(repoDir, "switch-test");
      expect(wt).toBeDefined();
      cleanupWorktree(repoDir, wt!, "switch test");
    } finally {
      pruneWorktrees(repoDir);
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
