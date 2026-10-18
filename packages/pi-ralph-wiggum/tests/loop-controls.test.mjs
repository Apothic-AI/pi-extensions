import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import ralph from "../index.ts";

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-controls-"));
  const commands = new Map();
  const tools = new Map();
  const queued = [];
  const notices = [];
  const ctx = {
    cwd,
    hasUI: false,
    sessionManager: { getSessionId: () => "owner", getBranch: () => [{ id: "root", type: "custom" }] },
    ui: { notify: (message) => notices.push(message), setStatus() {}, setWidget() {} },
  };
  ralph({
    on() {},
    registerCommand: (name, command) => commands.set(name, command),
    registerTool: (tool) => tools.set(tool.name, tool),
    sendUserMessage: (message) => queued.push(message),
  });
  return {
    cwd,
    ctx,
    tools,
    queued,
    notices,
    command: (args) => commands.get("ralph").handler(args, ctx),
    start: (params) => tools.get("ralph_start").execute("start", params, undefined, undefined, ctx),
    state: (name) => JSON.parse(fs.readFileSync(path.join(cwd, ".ralph", `${name}.state.json`), "utf8")),
    close: () => fs.rmSync(cwd, { recursive: true, force: true }),
  };
}

const controls = [
  ["maxIterations", "--max-iterations"],
  ["itemsPerIteration", "--items-per-iteration"],
  ["reflectEvery", "--reflect-every"],
];

for (const [key, flag] of controls) {
  test(`${key} rejects invalid direct-tool and full CLI values before touching files`, async () => {
    const f = fixture();
    try {
      await f.start({ name: "completed", taskContent: "# Original task\n" });
      const stateFile = path.join(f.cwd, ".ralph", "completed.state.json");
      const completed = { ...f.state("completed"), status: "completed", active: false };
      fs.writeFileSync(stateFile, JSON.stringify(completed));
      const beforeState = fs.readFileSync(stateFile);
      const taskFile = path.join(f.cwd, ".ralph", "completed.md");
      const beforeTask = fs.readFileSync(taskFile);
      const assertUnchanged = () => {
        assert.deepEqual(fs.readFileSync(stateFile), beforeState);
        assert.deepEqual(fs.readFileSync(taskFile), beforeTask);
        assert.equal(fs.existsSync(path.join(f.cwd, ".ralph", "missing.md")), false);
        assert.equal(fs.existsSync(path.join(f.cwd, "docs")), false);
        assert.equal(f.queued.length, 1);
      };
      for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "2", null]) {
        for (const name of ["completed", "missing"]) {
          await assert.rejects(
            f.start({ name, taskContent: "# Overwrite", [key]: value }),
            new RegExp(`${key}.*nonnegative safe integer`),
          );
          assertUnchanged();
        }
      }
      for (const token of [
        "-1",
        "0.5",
        "9007199254740992",
        "NaN",
        "Infinity",
        "2garbage",
        "--reflect-every",
        "",
        "-1e-999",
        "1e-999",
        "1.000000000000000000001",
        "-0",
        "0x10",
        "1e3",
      ]) {
        for (const name of ["completed", "missing", "docs/plan.md"]) {
          await f.command(`start ${name} ${flag} ${token}`);
          assert.match(f.notices.at(-1), /must be a nonnegative safe integer/);
          assertUnchanged();
        }
      }
      const schema = f.tools.get("ralph_start").parameters.properties[key];
      assert.equal(schema.type, "integer");
      assert.equal(schema.minimum, 0);
      assert.equal(schema.maximum, Number.MAX_SAFE_INTEGER);
    } finally {
      f.close();
    }
  });
}

test("invalid starts do not even create the task/state directory", async () => {
  const f = fixture();
  try {
    await assert.rejects(f.start({ name: "new", taskContent: "task", maxIterations: 0.5 }));
    await f.command("start new --items-per-iteration");
    assert.equal(fs.existsSync(path.join(f.cwd, ".ralph")), false);
    assert.equal(f.queued.length, 0);
  } finally {
    f.close();
  }
});

test("tool and named/path CLI starts preserve defaults and explicit zero controls", async () => {
  const f = fixture();
  try {
    await f.start({ name: "tool-default", taskContent: "task" });
    await f.start({ name: "tool-zero", taskContent: "task", maxIterations: 0, itemsPerIteration: 0, reflectEvery: 0 });
    await f.command("start cli-default");
    await f.command("start docs/path-zero.md --max-iterations 0 --items-per-iteration 0 --reflect-every 0");
    for (const name of ["tool-default", "cli-default"]) {
      const state = f.state(name);
      assert.equal(state.maxIterations, 50);
      assert.equal(state.itemsPerIteration, 0);
      assert.equal(state.reflectEvery, 0);
    }
    for (const name of ["tool-zero", "path-zero"]) {
      const state = f.state(name);
      assert.equal(state.maxIterations, 0);
      assert.equal(state.itemsPerIteration, 0);
      assert.equal(state.reflectEvery, 0);
    }
    assert.equal(fs.existsSync(path.join(f.cwd, "docs", "path-zero.md")), true);
    await f.command('start quoted-count --max-iterations "2" --items-per-iteration "0" --reflect-every "3"');
    assert.equal(f.state("quoted-count").maxIterations, 2);
    assert.equal(f.state("quoted-count").itemsPerIteration, 0);
    assert.equal(f.state("quoted-count").reflectEvery, 3);
    await f.command("start upper-bound --max-iterations 9007199254740991 --items-per-iteration 2 --reflect-every 3");
    assert.equal(f.state("upper-bound").maxIterations, Number.MAX_SAFE_INTEGER);
    assert.equal(f.state("upper-bound").itemsPerIteration, 2);
    assert.equal(f.state("upper-bound").reflectEvery, 3);
  } finally {
    f.close();
  }
});
