import { isDeepStrictEqual, types } from "node:util";
import type { Tool } from "@earendil-works/pi-ai";
import * as piAi from "@earendil-works/pi-ai";

// ToolInfo does not expose prepareLoadout's effective descriptions or sampling
// metadata. Compare only fields available on both sides of the public API.
export function comparableTools(tools: readonly Tool[]): Tool[] {
  return tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
}

const compat: { getToolStateChanges?: typeof piAi.getToolStateChanges } = piAi;

export function sameTools(previous: Tool[], current: Tool[]): boolean {
  const changes = compat.getToolStateChanges?.(previous, current);
  return !!changes && changes.toolsAdded.length === 0 && changes.toolsRemoved.length === 0;
}

export type SystemPromptViews = { canonical: string; effective: string };
type PreparedTools = { sessionId: string; recorded: Tool[]; registry: Tool[]; prompts?: SystemPromptViews };

function samePrompts(left: SystemPromptViews | undefined, right: SystemPromptViews | undefined): boolean {
  return left?.canonical === right?.canonical && left?.effective === right?.effective;
}

function instructionsMatch(payload: unknown, prompt: string): boolean {
  if (!record(payload)) return false;
  rejectJsonOverride(payload);
  const instructions = field(payload, "instructions");
  return typeof instructions === "string" && instructions === prompt;
}
type WireDeclarations = {
  tools: unknown[];
  additionalTools: Array<{ type: "additional_tools"; role: "developer"; tools: unknown[] }>;
};
type ObservedTools = PreparedTools & { accepted: boolean; wire?: WireDeclarations };

function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// Never invoke accessors or retain ordinary input content while inspecting the
// declaration surface. Unsupported/exotic values are rejected by the caller.
function field(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) {
    if (key in value) throw new Error("Inherited wire field");
    return undefined;
  }
  if (!descriptor.enumerable || !("value" in descriptor)) throw new Error("Unsupported wire field");
  return descriptor.value;
}

function rejectJsonOverride(value: object): void {
  for (let current: object | null = value; current; current = Object.getPrototypeOf(current)) {
    const descriptor = Object.getOwnPropertyDescriptor(current, "toJSON");
    if (!descriptor) continue;
    if (!("value" in descriptor) || typeof descriptor.value === "function") {
      throw new Error("Unsupported wire serialization override");
    }
    // Non-callable data shadows any inherited hook without changing JSON.
    return;
  }
}

function arrayItems(value: unknown): unknown[] {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error("Unsupported wire array");
  }
  rejectJsonOverride(value);
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  // Dense, ordinary arrays only: no holes, extra properties or own iterators.
  if (typeof length !== "number" || Reflect.ownKeys(value).length !== length + 1) {
    throw new Error("Unsupported wire array properties");
  }
  const items: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) throw new Error("Unsupported wire array index");
    items.push(descriptor.value);
  }
  return items;
}

function checkWireValue(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (
    typeof value !== "object" ||
    types.isProxy(value) ||
    (!Array.isArray(value) && !record(value)) ||
    ancestors.has(value)
  ) {
    throw new Error("Unsupported wire metadata");
  }
  ancestors.add(value);
  rejectJsonOverride(value);
  if (Array.isArray(value)) {
    for (const item of arrayItems(value)) checkWireValue(item, ancestors);
  } else {
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== "string" || !descriptor || !("value" in descriptor)) {
        throw new Error("Unsupported wire property");
      }
      // Non-enumerable data (such as schema-builder annotations) is not sent
      // on the JSON wire and structuredClone intentionally omits it.
      if (descriptor.enumerable) checkWireValue(descriptor.value, ancestors);
    }
  }
  ancestors.delete(value);
}

function freezeWireValue(value: object): void {
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") freezeWireValue(child);
  }
  Object.freeze(value);
}

function wireDeclarations(payload: unknown): WireDeclarations | undefined {
  if (!record(payload)) return undefined;
  rejectJsonOverride(payload);
  const tools = "tools" in payload ? field(payload, "tools") : [];
  if (!Array.isArray(tools)) return undefined;
  const input = "input" in payload ? field(payload, "input") : [];
  if (!Array.isArray(input)) return undefined;
  const additionalTools: WireDeclarations["additionalTools"] = [];
  for (const item of arrayItems(input)) {
    if (!record(item)) return undefined;
    // Inspect only the declaration envelope, never ordinary nested content.
    rejectJsonOverride(item);
    const type = field(item, "type");
    if (type === "additional_tools") {
      const group = field(item, "tools");
      if (
        field(item, "role") !== "developer" ||
        !Array.isArray(group) ||
        arrayItems(group).length === 0 ||
        Reflect.ownKeys(item).length !== 3
      )
        return undefined;
      checkWireValue(item);
      additionalTools.push({ type, role: "developer", tools: group });
    } else if (type === "tool_search_call" || type === "tool_search_output" || "tools" in item) {
      return undefined;
    }
  }
  const surface = { tools, additionalTools };
  checkWireValue(surface);
  const snapshot = structuredClone(surface);
  freezeWireValue(snapshot);
  return snapshot;
}

function matchesDeclarations(recorded: Tool[], wire: unknown[]): boolean {
  if (recorded.length !== wire.length) return false;
  const remaining = new Map(recorded.map((tool) => [tool.name, tool.description]));
  if (remaining.size !== recorded.length) return false;
  for (const tool of wire) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) return false;
    if (!("name" in tool) || typeof tool.name !== "string" || !remaining.has(tool.name)) return false;
    if (!("description" in tool) || tool.description !== remaining.get(tool.name)) return false;
    remaining.delete(tool.name);
  }
  return remaining.size === 0;
}

/**
 * The agent-core context hook prepares fresh evidence; cached provider callbacks
 * alone cannot admit a changed registry. Validate actual wire declarations before
 * accepting the pair, then compare each public surface against its frozen copy.
 * Reload and tree navigation discard both prepared and accepted evidence.
 */
export class ToolStateTracker {
  private readonly prepared = new WeakMap<object, PreparedTools>();
  private readonly observed = new WeakMap<object, ObservedTools>();

  reset(owner: object): void {
    this.prepared.delete(owner);
    this.observed.delete(owner);
  }

  prepare(owner: object, sessionId: string, recorded: Tool[], registry: Tool[], prompts?: SystemPromptViews): void {
    const observed = this.observed.get(owner);
    // A pending request is not a cold owner. Keep accepted exact wire knowledge
    // (or a known rejection) tied to its ORIGINAL public tools, but retire the
    // divergent prompt authorization until a new ordinary callback witnesses it.
    if (observed) this.observed.set(owner, { ...observed, prompts: undefined });
    this.prepared.set(owner, structuredClone({ sessionId, recorded, registry, prompts }));
  }

  observe(
    owner: object,
    sessionId: string,
    recorded: Tool[],
    registry: Tool[],
    payload: unknown,
    prompts?: SystemPromptViews,
  ): void {
    const prepared = this.prepared.get(owner);
    if (!prepared || prepared.sessionId !== sessionId) {
      const observed = this.observed.get(owner);
      if (observed?.sessionId === sessionId) {
        this.observed.set(owner, { ...observed, accepted: false, wire: undefined, prompts: undefined });
      }
      return;
    }
    // Even early mismatches retire an earlier accepted observation.
    this.observed.set(owner, { ...prepared, accepted: false });
    try {
      if (
        !sameTools(prepared.recorded, recorded) ||
        !sameTools(prepared.registry, registry) ||
        !samePrompts(prepared.prompts, prompts)
      )
        return;
      // Flatten ONLY for eligibility. Remote serialization must reproduce the
      // original body tools and ordered additive groups, including all metadata.
      const withoutDescriptions = (tools: Tool[]) => tools.map((tool) => ({ ...tool, description: "" }));
      const wire = wireDeclarations(payload);
      const effective = wire && [...wire.tools, ...wire.additionalTools.flatMap((group) => group.tools)];
      const accepted =
        !!effective &&
        (!prompts ||
          prompts.canonical === prompts.effective ||
          (prompts.canonical.length > 0 && instructionsMatch(payload, prompts.effective))) &&
        matchesDeclarations(recorded, effective) &&
        sameTools(withoutDescriptions(recorded), withoutDescriptions(registry));
      this.observed.set(owner, { ...prepared, accepted, wire: accepted ? wire : undefined });
    } catch {
      // A malformed/exotic callback must not escape into hook recovery or leave
      // earlier accepted evidence authorizing this request.
      this.observed.set(owner, { ...prepared, accepted: false });
    }
  }

  matches(owner: object, sessionId: string, recorded: Tool[], registry: Tool[]): boolean {
    const observed = this.observed.get(owner);
    if (!observed || observed.sessionId !== sessionId) return sameTools(recorded, registry);
    return observed.accepted && sameTools(observed.recorded, recorded) && sameTools(observed.registry, registry);
  }

  matchesPrompt(owner: object, sessionId: string, prompts: SystemPromptViews): boolean {
    if (prompts.canonical === prompts.effective) return true;
    const observed = this.observed.get(owner);
    return (
      prompts.canonical.length > 0 &&
      !!observed?.accepted &&
      observed.sessionId === sessionId &&
      samePrompts(observed.prompts, prompts)
    );
  }

  payloadValidator(
    owner: object,
    sessionId: string,
    prompts?: SystemPromptViews,
  ): ((payload: unknown) => boolean) | undefined {
    const divergent = !!prompts && prompts.canonical !== prompts.effective;
    if (divergent && !this.matchesPrompt(owner, sessionId, prompts)) return () => false;
    const observed = this.observed.get(owner);
    if (!observed || observed.sessionId !== sessionId || !observed.accepted || !observed.wire) {
      return divergent ? () => false : undefined;
    }
    const expected = observed.wire;
    const canonical = divergent ? prompts.canonical : undefined;
    // Preserve provider-specific schema normalization and sampling metadata
    // without reimplementing its serializer. Freeze evidence for this request.
    return (payload) => {
      try {
        return (
          (canonical === undefined || instructionsMatch(payload, canonical)) &&
          isDeepStrictEqual(expected, wireDeclarations(payload))
        );
      } catch {
        return false;
      }
    };
  }
}
