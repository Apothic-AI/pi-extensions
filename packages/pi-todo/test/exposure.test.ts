import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  getPackageDir,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import todo from "../src/extension.js";
import { CONTEXT_TYPE } from "../src/state.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(
  options: {
    tools?: string[];
    defaultTools?: string[];
    copiedSdkTodo?: boolean;
    before?: (pi: ExtensionAPI) => void;
    after?: (pi: ExtensionAPI) => void;
  } = {},
) {
  const cwd = mkdtempSync(join(tmpdir(), "todo-exposure-"));
  const agentDir = join(cwd, "agent");
  mkdirSync(agentDir);
  cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
  const faux = fauxProvider({ provider: "todo-exposure", models: [{ id: "fixture" }] });
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });
  runtime.registerNativeProvider(faux.provider);
  await runtime.refresh({ allowNetwork: false });
  const model = new ModelRegistry(runtime).find("todo-exposure", "fixture");
  if (!model) throw new Error("No fixture model");
  let api!: ExtensionAPI;
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    noExtensions: true,
    noContextFiles: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [
      ...(options.before ? [{ name: "before", factory: options.before }] : []),
      {
        name: "todo",
        factory: (pi) => {
          api = pi;
          todo(pi);
        },
      },
      ...(options.after ? [{ name: "after", factory: options.after }] : []),
    ],
  });
  await loader.reload();
  expect(loader.getExtensions().errors).toEqual([]);
  const definition = loader
    .getExtensions()
    .extensions.find((e) => e.path.includes("todo"))
    ?.tools.get("todo")?.definition;
  if (!definition) throw new Error("Missing factory-registered Todo");
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    modelRuntime: runtime,
    resourceLoader: loader,
    settingsManager: SettingsManager.inMemory({
      defaultTools: options.defaultTools,
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
    sessionManager: SessionManager.inMemory(cwd),
    ...(options.tools === undefined ? {} : { tools: options.tools }),
    ...(options.copiedSdkTodo
      ? { customTools: [{ ...definition, execute: async () => ({ content: [], details: "foreign" }) }] }
      : {}),
  });
  cleanups.push(async () => {
    await session.abort();
    session.dispose();
  });
  const errors: string[] = [];
  await session.bindExtensions({ mode: "print", onError: (e) => errors.push(String(e)) });
  return { session, api, faux, loader, errors };
}

describe("factory registration and effective public exposure", () => {
  it("is registered before startup and is model-usable by default when explicitly loaded", async () => {
    const f = await fixture();
    expect(
      f.loader
        .getExtensions()
        .extensions.find((e) => e.path.includes("todo"))
        ?.tools.has("todo"),
    ).toBe(true);
    expect(f.session.getActiveToolNames()).toContain("todo");
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("todo", { action: "list" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Listed."),
    ]);
    await f.session.prompt("List the checklist.");
    expect(f.session.messages.find((m) => m.role === "toolResult" && m.toolName === "todo")).toMatchObject({
      isError: false,
      details: { revision: 0 },
    });
  });
  it("actual CLI --tools includes Todo without reactivating an earlier restricted startup loadout", () => {
    const cwd = mkdtempSync(join(tmpdir(), "todo-cli-exposure-"));
    const agentDir = join(cwd, "agent");
    mkdirSync(agentDir);
    cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
    const probe = join(cwd, "probe.ts");
    for (const restrict of [false, true]) {
      writeFileSync(
        probe,
        `export default function(pi) {
        ${restrict ? 'pi.on("session_start", () => pi.setActiveTools(["read"]));' : ""}
        pi.registerCommand("todo-exposure-probe", { handler: async () => console.log("TODO_EXPOSURE=" + JSON.stringify(pi.getActiveTools())) });
      }`,
      );
      const result = spawnSync(
        process.execPath,
        [
          join(getPackageDir(), "dist", "cli.js"),
          "--offline",
          "--no-extensions",
          "--no-context-files",
          "--no-skills",
          "--no-themes",
          "--no-prompt-templates",
          "--no-mcp",
          "--no-session",
          "--extension",
          probe,
          "--extension",
          fileURLToPath(new URL("../src/index.ts", import.meta.url)),
          "--tools",
          "read,write,todo",
          "--print",
          "/todo-exposure-probe",
        ],
        {
          cwd,
          encoding: "utf8",
          timeout: 15000,
          env: {
            ...process.env,
            PI_CODING_AGENT_DIR: agentDir,
            PI_TELEMETRY: "0",
            NODE_PATH: [dirname(dirname(getPackageDir())), process.env.NODE_PATH].filter(Boolean).join(":"),
          },
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout + result.stderr).toContain(
        `TODO_EXPOSURE=${JSON.stringify(restrict ? ["read"] : ["read", "write", "todo"])}`,
      );
    }
  });
  it.each([{ tools: [] }, { tools: ["read"] }])(
    "does not inject checklist authority when todo is excluded: $tools",
    async ({ tools }) => {
      const f = await fixture({ tools });
      const branch = structuredClone(f.session.sessionManager.getBranch());
      const context = await f.session.extensionRunner.emitContext([
        { role: "custom", customType: CONTEXT_TYPE, content: "stale checklist", display: false, timestamp: 0 },
        { role: "user", content: "Continue the authorized implementation.", timestamp: 1 },
      ]);
      expect(context).toEqual([{ role: "user", content: "Continue the authorized implementation.", timestamp: 1 }]);
      expect(f.session.getActiveToolNames()).toEqual(tools);
      expect(f.session.sessionManager.getBranch()).toEqual(branch);
      expect(f.errors).toEqual([]);
    },
  );
  it("stops injecting checklist context after the active tool policy removes todo", async () => {
    const f = await fixture();
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("todo", { action: "add", baseRevision: 0, title: "Existing task" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("Tracked."),
    ]);
    await f.session.prompt("Track one task.");
    expect(JSON.stringify(await f.session.extensionRunner.emitContext([]))).toContain("Existing task");
    const branch = structuredClone(f.session.sessionManager.getBranch());
    f.api.setActiveTools(["read"]);
    expect(await f.session.extensionRunner.emitContext([])).toEqual([]);
    expect(f.session.getActiveToolNames()).toEqual(["read"]);
    expect(f.session.sessionManager.getBranch()).toEqual(branch);
    const probe = vi.fn(() => fauxAssistantMessage("Continuing the authorized work."));
    f.faux.setResponses([probe]);
    await f.session.prompt("Continue the implementation without changing the checklist.");
    expect(probe).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(probe.mock.calls)).not.toContain("Current session/branch checklist");
    expect(f.session.getActiveToolNames()).toEqual(["read"]);
    f.api.setActiveTools(["read", "todo"]);
    expect(JSON.stringify(await f.session.extensionRunner.emitContext([]))).toContain("Existing task");
    expect(f.errors).toEqual([]);
  });
  it("resolves defaultTools +todo before session_start", async () => {
    const f = await fixture({ defaultTools: ["+todo"] });
    expect(f.session.getActiveToolNames()).toContain("todo");
    expect(f.errors).toEqual([]);
  });
  it("preserves an earlier startup read-only policy despite an initial read/write/todo allowlist", async () => {
    const f = await fixture({
      tools: ["read", "write", "todo"],
      before: (pi) => {
        pi.on("session_start", () => {
          pi.setActiveTools(["read"]);
        });
      },
    });
    expect(f.session.getActiveToolNames()).toEqual(["read"]);
    await f.session.prompt("/todo");
    expect(f.session.getActiveToolNames()).toEqual(["read"]);
  });
  it("detects a different effective origin even when parameters/instructions are copied", async () => {
    const f = await fixture({ copiedSdkTodo: true });
    expect(f.api.getAllTools().find((tool) => tool.name === "todo")?.sourceInfo.source).toBe("sdk");
    const blocked = await f.session.extensionRunner.emitToolCall({
      type: "tool_call",
      toolName: "todo",
      toolCallId: "collision",
      input: { action: "list" },
    });
    expect(blocked).toMatchObject({ block: true, reason: expect.stringContaining("another effective todo tool") });
    expect(f.session.sessionManager.getBranch().some((entry) => entry.type === "custom")).toBe(false);
  });
  it("public discovery cannot enumerate excluded definitions; the excluded human command still works", async () => {
    const f = await fixture({
      tools: [],
      after: (pi) => {
        pi.on("session_start", () => {
          pi.registerTool({
            name: "todo",
            label: "excluded",
            description: "excluded foreign tool",
            parameters: { type: "object" },
            execute: async () => ({ content: [], details: undefined }),
          });
        });
      },
    });
    expect(f.api.getAllTools()).toEqual([]);
    await f.session.prompt("/todo");
    expect(f.session.getActiveToolNames()).toEqual([]);
    expect(f.errors).toEqual([]);
  });
  it("does not activate excluded tools or override a later Plan loadout", async () => {
    for (const tools of [[], ["read", "todo"]]) {
      const f = await fixture({
        tools,
        after: (pi) => {
          pi.on("session_start", () => {
            pi.setActiveTools(tools.length ? ["read"] : []);
          });
        },
      });
      expect(f.session.getActiveToolNames()).toEqual(tools.length ? ["read"] : []);
      expect(f.errors).toEqual([]);
    }
  });
});
