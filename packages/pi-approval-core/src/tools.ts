import {
  type BashOperations,
  createBashToolDefinition,
  createEditToolDefinition,
  createLocalBashOperations,
  createWriteToolDefinition,
  type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import {
  type ApprovalOperation,
  type ApprovalRequestOptions,
  approvalId,
  approvalToolCallId,
  assertCurrent,
  boundedText,
  escapeDisplay,
  hashBytes,
  MAX_INPUT_BYTES,
  validateOperation,
} from "./contract.js";
import { createFileOperations } from "./files.js";

export interface ApprovalToolOptions {
  readonly source: string;
  readonly request: (operation: ApprovalOperation, options: ApprovalRequestOptions) => Promise<void>;
  /** Called against this invocation's captured context, before and after every gate. Errors deny. */
  readonly isCurrent: (ctx: ExtensionToolContext) => boolean;
  readonly shellPath?: string;
  readonly commandPrefix?: string;
}
function frozenInput<T>(input: T, schema: TSchema): T {
  if (!Value.Check(schema, input)) throw new Error("Invalid final tool input schema");
  const serialized = JSON.stringify(input);
  boundedText(serialized, MAX_INPUT_BYTES);
  const copy: T = JSON.parse(serialized);
  function freeze(value: unknown): void {
    if (value && typeof value === "object") {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
  }
  freeze(copy);
  return copy;
}
export function createApprovalBashOperations(options: {
  readonly source: string;
  readonly toolCallId: string;
  readonly inputHash: string;
  readonly request: ApprovalToolOptions["request"];
  readonly isCurrent: () => boolean;
  readonly shellPath?: string;
}): BashOperations {
  options = Object.freeze({ ...options });
  const delegate = createLocalBashOperations({ shellPath: options.shellPath });
  return {
    exec: async (command, cwd, execution) => {
      // Gate the final command/cwd received by the native backend, not tool_call input.
      const owner = { signal: execution.signal, isCurrent: options.isCurrent };
      assertCurrent(owner);
      const operation = validateOperation({
        kind: "command",
        toolName: "bash",
        source: options.source,
        toolCallId: options.toolCallId,
        inputHash: hashBytes(
          JSON.stringify({ inputHash: options.inputHash, command, cwd, timeout: execution.timeout }),
        ),
        command,
        cwd,
        preview: `Source: ${options.source}\nCWD: ${escapeDisplay(cwd)}\nExact command (escaped controls, doubled backslashes):\n${escapeDisplay(command)}`,
      });
      await options.request(operation, owner);
      assertCurrent(owner);
      return delegate.exec(command, cwd, execution);
    },
  };
}
/** Definitions work with registerTool or SDK customTools. No registrations occur here. */
export function createApprovalToolDefinitions(options: ApprovalToolOptions) {
  options = Object.freeze({ ...options });
  const source = approvalId(options.source);
  const editBase = createEditToolDefinition("");
  const writeBase = createWriteToolDefinition("");
  const bashBase = createBashToolDefinition("");
  const edit: typeof editBase = {
    ...editBase,
    async execute(id, params, signal, update, ctx) {
      const input = frozenInput(params, editBase.parameters);
      if (
        typeof input.path !== "string" ||
        !Array.isArray(input.edits) ||
        !input.edits.length ||
        input.edits.some(
          (item) =>
            typeof item.oldText !== "string" ||
            typeof item.newText !== "string" ||
            Object.keys(item).some((key) => !["oldText", "newText"].includes(key)),
        ) ||
        Object.keys(input).some((key) => !["path", "edits"].includes(key))
      )
        throw new Error("Invalid final edit input");
      const cwd = boundedText(ctx.cwd, 4096);
      const owner = { signal, isCurrent: () => options.isCurrent(ctx) };
      assertCurrent(owner);
      const operations = createFileOperations({
        kind: "edit",
        cwd,
        toolCallId: approvalToolCallId(id),
        source,
        inputHash: hashBytes(JSON.stringify(input)),
        options: owner,
        request: options.request,
      });
      return createEditToolDefinition(cwd, { operations }).execute(id, input, signal, update, ctx);
    },
  };
  const write: typeof writeBase = {
    ...writeBase,
    async execute(id, params, signal, update, ctx) {
      const input = frozenInput(params, writeBase.parameters);
      if (
        typeof input.path !== "string" ||
        typeof input.content !== "string" ||
        Object.keys(input).some((key) => !["path", "content"].includes(key))
      )
        throw new Error("Invalid final write input");
      const cwd = boundedText(ctx.cwd, 4096);
      const owner = { signal, isCurrent: () => options.isCurrent(ctx) };
      assertCurrent(owner);
      const operations = createFileOperations({
        kind: "write",
        cwd,
        toolCallId: approvalToolCallId(id),
        source,
        inputHash: hashBytes(JSON.stringify(input)),
        options: owner,
        request: options.request,
      });
      return createWriteToolDefinition(cwd, { operations }).execute(id, input, signal, update, ctx);
    },
  };
  const bash: typeof bashBase = {
    ...bashBase,
    async execute(id, params, signal, update, ctx) {
      const input = frozenInput(params, bashBase.parameters);
      if (
        typeof input.command !== "string" ||
        (input.timeout !== undefined &&
          (!Number.isFinite(input.timeout) || input.timeout <= 0 || input.timeout > 2147483.647)) ||
        Object.keys(input).some((key) => !["command", "timeout"].includes(key))
      )
        throw new Error("Invalid final bash input");
      const cwd = boundedText(ctx.cwd, 4096);
      const operations = createApprovalBashOperations({
        source,
        toolCallId: approvalToolCallId(id),
        inputHash: hashBytes(JSON.stringify(input)),
        request: options.request,
        isCurrent: () => options.isCurrent(ctx),
        shellPath: options.shellPath,
      });
      return createBashToolDefinition(cwd, {
        operations,
        commandPrefix: options.commandPrefix,
        shellPath: options.shellPath,
      }).execute(id, input, signal, update, ctx);
    },
  };
  return [edit, write, bash] as const;
}
