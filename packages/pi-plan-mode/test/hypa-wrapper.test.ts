import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { resolveHypaExecutablePaths } from "../src/hypa-wrapper.js";
import { findBlockedCommandSegment, isSafeCommand } from "../src/tool-policy.js";

const quote = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;
const executable = async (path: string) => {
  await writeFile(path, "#!/bin/sh\nexit 0\n");
  await chmod(path, 0o755);
};

test("Hypa resolves only the first executable file on the session's POSIX PATH", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "plan-hypa-path-"));
  try {
    for (const directory of ["missing", "directory/hypa", "no-exec", "bin's tools", "later"]) {
      await mkdir(join(cwd, directory), { recursive: true });
    }
    await writeFile(join(cwd, "no-exec/hypa"), "not executable");
    await chmod(join(cwd, "no-exec/hypa"), 0o644);
    const first = join(cwd, "bin's tools/hypa");
    const later = join(cwd, "later/hypa");
    await executable(first);
    await executable(later);
    const searchPath = "missing:directory:no-exec:bin's tools:later";
    assert.deepEqual([...(await resolveHypaExecutablePaths(cwd, searchPath, "linux"))], [first]);
    assert.deepEqual([...(await resolveHypaExecutablePaths(cwd, join(cwd, "later"), "darwin"))], [later]);
    assert.deepEqual([...(await resolveHypaExecutablePaths(cwd, "missing:no-exec", "linux"))], []);
    assert.deepEqual([...(await resolveHypaExecutablePaths(cwd, searchPath, "win32"))], []);
    assert.deepEqual([...(await resolveHypaExecutablePaths("relative", searchPath, "linux"))], []);

    const wrappers = { hypaExecutables: await resolveHypaExecutablePaths(cwd, searchPath, "linux") };
    assert.equal(isSafeCommand(`${quote(first)} git --no-optional-locks status --short`, {}, wrappers), true);
    assert.equal(isSafeCommand(`${quote(first)} --timeout-ms 2000 -c 'ls -l -a'`, {}, wrappers), true);
    assert.equal(isSafeCommand(`"${first}" -c ls`, {}, wrappers), true);
    assert.equal(isSafeCommand(`"${first.replace("/hypa", "/\\hypa")}" -c ls`, {}, wrappers), false);
    assert.equal(isSafeCommand("hypa -c ls", {}, { hypaExecutables: new Set() }), false);
    assert.equal(isSafeCommand(`${quote(later)} -c 'ls'`, {}, wrappers), false);
    assert.equal(isSafeCommand(`${quote(first)} -c 'ls'`), false, "pure default admits no absolute paths");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Hypa resolution preserves symlink spelling and resolves empty PATH entries against session cwd", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "plan-hypa-link-"));
  try {
    const target = join(cwd, "native-program");
    const path = join(cwd, "hypa");
    await executable(target);
    await symlink(target, path);
    for (const searchPath of ["", ":missing", ".", cwd]) {
      assert.deepEqual([...(await resolveHypaExecutablePaths(cwd, searchPath, "linux"))], [path]);
    }
    const wrappers = { hypaExecutables: await resolveHypaExecutablePaths(cwd, "", "linux") };
    assert.equal(isSafeCommand(`${quote(path)} -c ls`, {}, wrappers), true);
    assert.equal(isSafeCommand(`${quote(target)} -c ls`, {}, wrappers), false);
    assert.equal(isSafeCommand("./hypa -c ls", {}, wrappers), false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Hypa admits an explicit native executable override without trusting other paths or launchers", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "plan-hypa-override-"));
  try {
    await mkdir(join(cwd, "path-bin"));
    await mkdir(join(cwd, "native's bin"));
    const fromPath = join(cwd, "path-bin/hypa");
    const override = join(cwd, "native's bin/hypa");
    const launcher = join(cwd, "hypa.js");
    await executable(fromPath);
    await executable(override);
    await executable(launcher);
    const paths = await resolveHypaExecutablePaths(cwd, join(cwd, "path-bin"), "linux", override);
    assert.deepEqual(paths, new Set([override, fromPath]));
    assert.equal(isSafeCommand(`${quote(override)} --timeout-ms 1000 -c pwd`, {}, { hypaExecutables: paths }), true);
    for (const unsupported of [launcher, "./native's bin/hypa", join(cwd, "missing/hypa")]) {
      assert.deepEqual(
        await resolveHypaExecutablePaths(cwd, join(cwd, "path-bin"), "linux", unsupported),
        new Set([fromPath]),
      );
    }
    assert.deepEqual(await resolveHypaExecutablePaths(cwd, join(cwd, "path-bin"), "win32", override), new Set());
    const previousPath = process.env.PATH;
    try {
      delete process.env.PATH;
      assert.deepEqual(await resolveHypaExecutablePaths(cwd, undefined, "linux", override), new Set([override]));
      assert.deepEqual(await resolveHypaExecutablePaths(cwd, undefined, "linux"), new Set());
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Hypa wrapper boundaries preserve literal POSIX Unicode characters", () => {
  const path = "/trusted/bin/hypa";
  const wrappers = { hypaExecutables: new Set([path]) };
  for (const whitespace of ["\u00a0", "\u2003", "\ufeff"]) {
    for (const command of [`${path} -c pwd`, `${quote(path)} -c pwd`, "hypa -c pwd"]) {
      assert.equal(isSafeCommand(`${whitespace}${command}`, {}, wrappers), false);
      assert.equal(isSafeCommand(` \t${whitespace}${command}`, {}, wrappers), false);
      assert.equal(isSafeCommand(`${command} ${whitespace}`, {}, wrappers), false);
    }
  }
  assert.equal(isSafeCommand(` \t${quote(path)} -c pwd \t`, {}, wrappers), true);
});

test("bounded Hypa forms reuse native validators, without adding safe subcommands", () => {
  for (const native of [
    "git --no-optional-locks status --short",
    "git diff --no-ext-diff --no-textconv --stat",
    "git show --no-patch HEAD",
    "git branch --show-current",
  ]) {
    assert.equal(isSafeCommand(native), true, native);
    for (const timeout of ["", "--timeout-ms 1 ", "--timeout-ms 30000 "]) {
      assert.equal(isSafeCommand(`hypa ${timeout}${native}`), true, native);
      assert.equal(isSafeCommand(`hypa ${timeout}-c ${quote(native)}`), true, native);
    }
  }
  for (const native of ["ls", "ls -l -a 'a path'", "rg -n value src", "sed -n '1,20p' source.ts"]) {
    assert.equal(isSafeCommand(native), true, native);
    assert.equal(isSafeCommand(`hypa -c ${quote(native)}`), true, native);
    assert.equal(isSafeCommand(`hypa --timeout-ms 1000 -c ${quote(native)}`), true, native);
  }
  assert.equal(isSafeCommand("hypa git rev-parse --show-toplevel"), false);
  assert.equal(isSafeCommand("hypa git rev-parse --show-toplevel", { git: ["rev-parse"] }), true);
  assert.equal(isSafeCommand("hypa -c 'git rev-parse --show-toplevel'", { git: ["rev-parse"] }), true);
  assert.equal(isSafeCommand("hypa -c 'gh pr list --json number'", { gh: ["pr list"] }), true);
  assert.equal(isSafeCommand("hypa -c 'gh pr list --json number'"), false);
});

test("Hypa never bypasses native mutation, helper, or syntax rejection", () => {
  for (const native of [
    "git status --short", // Existing lock-isolation requirement remains mandatory.
    "git diff", // Existing external-diff/textconv isolation remains mandatory.
    "git diff --ext-diff",
    "git diff --no-ext-diff --no-textconv --output=copy",
    "git show --no-patch --binary HEAD",
    "git -c alias.x=evil status",
    "git --exec-path=elsewhere status",
    "git --paginate log",
    "git log --format=%G?",
    "git branch -D old",
    "git remote update",
    "git reset --hard",
    "git checkout main",
    "git commit -m changed",
    "git status; touch file",
    "git status && touch file",
    "git diff | sh",
    "git diff > file",
    "git log $(touch file)",
    "git log `touch file`",
    "git log $FLAGS",
    "git log *",
    "git status\ngit reset --hard",
  ]) {
    assert.equal(isSafeCommand(native), false, native);
    assert.equal(isSafeCommand(`hypa ${native}`), false, native);
    assert.equal(isSafeCommand(`hypa -c ${quote(native)}`), false, native);
  }
  for (const native of [
    "ls -la", // Do not broaden native flag validation for a wrapper.
    "touch file",
    "rm -rf build",
    "sh -c 'ls'",
    "bash -c 'ls'",
    "node -e '1'",
    "python -c 'print(1)'",
    "npm test",
    "unknown --dry-run",
    "find . -delete",
    "sort input -o output",
    "echo x > file",
    "ls && touch file",
    "ls | cat",
    "echo '$(touch file)'",
    "ls '-l; touch file'",
    "ls 'a\nb'",
    "hypa -c ls",
    "hypa git --no-optional-locks status",
    "/usr/bin/ls",
  ]) {
    assert.equal(isSafeCommand(`hypa -c ${quote(native)}`), false, native);
  }
});

test("Hypa rejects unreviewed wrapper executables, modes, timeouts, and trailing arguments", () => {
  for (const command of [
    "hypa",
    "HYPA -c ls",
    "/tmp/hypa -c ls",
    "./hypa -c ls",
    "../hypa -c ls",
    "node hypa -c ls",
    "bun hypa -c ls",
    "env hypa -c ls",
    "command hypa -c ls",
    "hypa.exe -c ls",
    "hypa\u00a0-c\u00a0ls",
    "hypa -c 'ls\u00a0path'",
    `hypa -c '"\\l\\s"'`,
    '"\\hypa" -c ls',
    "hypa.js -c ls",
    "hypa raw git --no-optional-locks status",
    "hypa -t ls",
    "hypa --config custom -c ls",
    "hypa --remote host -c ls",
    "hypa --session session -c ls",
    "hypa --unknown -c ls",
    "hypa ls",
    "hypa -- -c ls",
    "hypa -c",
    "hypa -c ''",
    "hypa -c ls extra",
    "hypa -c 'ls' -c 'pwd'",
    "hypa -c 'hypa -c ls'",
    "hypa -c 'ls' --timeout-ms 1000",
    "hypa --timeout-ms",
    "hypa --timeout-ms -c ls",
    "hypa --timeout-ms 0 -c ls",
    "hypa --timeout-ms -1 -c ls",
    "hypa --timeout-ms +1 -c ls",
    "hypa --timeout-ms 1.5 -c ls",
    "hypa --timeout-ms 1e3 -c ls",
    "hypa --timeout-ms 999999999999999999999999 -c ls",
    "hypa --timeout-ms=1000 -c ls",
    "hypa --timeout-ms 1000 --timeout-ms 2000 -c ls",
    "hypa --timeout-ms 1000 hypa -c ls",
    "hypa -c 'ls' && touch file",
    "hypa -c 'ls' > output",
    'hypa -c "ls $(touch file)"',
    "hypa -c 'echo x'\nls",
  ]) {
    assert.equal(isSafeCommand(command), false, command);
    assert.equal(findBlockedCommandSegment(command), command.trim(), command);
  }
});
