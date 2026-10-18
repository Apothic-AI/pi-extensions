import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const STATUS_ACTION_QUERY = "pi-ui:status-actions:v1:query";
export const STATUS_ACTION_OPEN = "pi-ui:status-actions:v1:open";
export const STATUS_ACTION_ERROR = "Status detail is unavailable. Please try again.";
export interface StatusActionQuery {
  version: 1;
  requestId: string;
  sessionId: string;
}
export interface StatusActionEntry {
  statusKey: string;
  actionId: string;
  label: string;
}
export interface StatusActionSnapshot {
  version: 1;
  providerId: string;
  surfaceId: string;
  sessionId: string;
  entries: StatusActionEntry[];
}
export interface StatusActionDescriptor extends StatusActionEntry {
  providerId: string;
  surfaceId: string;
  sessionId: string;
}
export interface StatusActionOpen extends Omit<StatusActionDescriptor, "statusKey" | "label"> {
  version: 1;
  requestId: string;
}
type Bus = ExtensionAPI["events"];
function active(signal: AbortSignal, isCurrent: () => boolean): boolean {
  try {
    return !signal.aborted && isCurrent();
  } catch {
    return false;
  }
}

/** Exact own data fields only. Never read an untrusted property through ordinary access. */
function record(value: unknown, fields: readonly string[]): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some((key) => typeof key !== "string" || !fields.includes(key))) return;
  const result: Record<string, unknown> = Object.create(null);
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !("value" in descriptor)) return;
    result[field] = descriptor.value;
  }
  return result;
}
function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}
function entriesArray(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return;
  const size = Object.getOwnPropertyDescriptor(value, "length")?.value as unknown;
  if (typeof size !== "number" || size > 64) return;
  if (Reflect.ownKeys(value).length !== size + 1) return;
  const entries: unknown[] = [];
  for (let i = 0; i < size; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !("value" in descriptor)) return;
    entries.push(descriptor.value);
  }
  return entries;
}

export function parseStatusActionSnapshot(value: unknown, sessionId: string): StatusActionSnapshot | undefined {
  try {
    const reply = record(value, ["success", "data"]);
    if (reply?.success !== true) return;
    const data = record(reply.data, ["version", "providerId", "surfaceId", "sessionId", "entries"]);
    if (
      data?.version !== 1 ||
      !text(data.providerId, 128) ||
      !text(data.surfaceId, 128) ||
      !text(data.sessionId, 128) ||
      data.sessionId !== sessionId
    )
      return;
    const rawEntries = entriesArray(data.entries);
    if (!rawEntries) return;
    const entries: StatusActionEntry[] = [];
    const keys = new Set<string>();
    const actions = new Set<string>();
    for (const raw of rawEntries) {
      const entry = record(raw, ["statusKey", "actionId", "label"]);
      if (!entry || !text(entry.statusKey, 512) || !text(entry.actionId, 128) || !text(entry.label, 512)) return;
      if (keys.has(entry.statusKey) || actions.has(entry.actionId)) return;
      keys.add(entry.statusKey);
      actions.add(entry.actionId);
      entries.push({ statusKey: entry.statusKey, actionId: entry.actionId, label: entry.label });
    }
    return { version: 1, providerId: data.providerId, surfaceId: data.surfaceId, sessionId, entries };
  } catch {
    return; // Includes exotic/proxy records; they confer no authority.
  }
}

/** Collect on demand, so either extension load order works; no persistent registry. */
export function discoverStatusActions(
  bus: Bus,
  sessionId: string,
  signal: AbortSignal,
  isCurrent: () => boolean = () => true,
): Promise<StatusActionDescriptor[]> {
  if (!active(signal, isCurrent) || !text(sessionId, 128)) return Promise.resolve([]);
  return new Promise((resolve) => {
    const snapshots = new Map<string, StatusActionSnapshot>();
    const ambiguous = new Set<string>();
    // Preserve claims from conflicting surfaces too: hiding one ambiguous
    // provider must not grant another provider ownership of the same key.
    const claims = new Map<string, Set<string>>();
    let overflow = false;
    let settled = false;
    let unsubscribe = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      try {
        unsubscribe();
      } catch {
        /* settlement must still complete */
      }
      const descriptors: StatusActionDescriptor[] = [];
      if (active(signal, isCurrent) && !overflow) {
        for (const snapshot of snapshots.values()) {
          if (ambiguous.has(snapshot.providerId)) continue;
          for (const entry of snapshot.entries)
            descriptors.push({ ...entry, providerId: snapshot.providerId, surfaceId: snapshot.surfaceId, sessionId });
        }
      }
      resolve(descriptors.filter((entry) => claims.get(entry.statusKey)?.size === 1));
    };
    const requestId = randomUUID();
    try {
      unsubscribe = bus.on(`${STATUS_ACTION_QUERY}:reply:${requestId}`, (value) => {
        if (settled || overflow) return;
        if (!active(signal, isCurrent)) {
          finish();
          return;
        }
        const snapshot = parseStatusActionSnapshot(value, sessionId);
        if (!snapshot) return;
        const previous = snapshots.get(snapshot.providerId);
        if (
          !previous &&
          (snapshots.size >= 32 ||
            [...snapshots.values()].reduce((sum, item) => sum + item.entries.length, snapshot.entries.length) > 64)
        ) {
          overflow = true;
          return;
        }
        for (const entry of snapshot.entries) {
          let owners = claims.get(entry.statusKey);
          if (!owners) {
            if (claims.size >= 64) {
              overflow = true;
              return;
            }
            owners = new Set();
            claims.set(entry.statusKey, owners);
          }
          owners.add(snapshot.providerId);
        }
        if (previous) {
          if (JSON.stringify(previous) !== JSON.stringify(snapshot)) ambiguous.add(snapshot.providerId);
          return;
        }
        snapshots.set(snapshot.providerId, snapshot);
      });
      signal.addEventListener("abort", finish, { once: true });
      timer = setTimeout(finish, 50);
      if (!active(signal, isCurrent)) finish();
      else bus.emit(STATUS_ACTION_QUERY, { version: 1, requestId, sessionId } satisfies StatusActionQuery);
    } catch {
      overflow = true;
      finish();
    }
  });
}

/** Success means admission, not completion of the provider's owner-local view. */
export function openStatusAction(
  bus: Bus,
  action: StatusActionDescriptor,
  signal: AbortSignal,
  isCurrent: () => boolean = () => true,
): Promise<boolean> {
  if (!active(signal, isCurrent)) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (accepted = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      try {
        unsubscribe();
      } catch {
        /* settlement must still complete */
      }
      resolve(active(signal, isCurrent) && accepted);
    };
    const abort = () => finish();
    const requestId = randomUUID();
    try {
      unsubscribe = bus.on(`${STATUS_ACTION_OPEN}:reply:${requestId}`, (value) => {
        if (settled) return;
        if (!active(signal, isCurrent)) {
          finish();
          return;
        }
        try {
          const reply = record(value, ["success", "data"]);
          const data = reply?.success === true ? record(reply.data, ["accepted"]) : undefined;
          if (data?.accepted === true) finish(true);
        } catch {
          /* malformed replies have no authority */
        }
      });
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(abort, 2_000);
      if (!active(signal, isCurrent)) abort();
      else
        bus.emit(STATUS_ACTION_OPEN, {
          version: 1,
          requestId,
          providerId: action.providerId,
          surfaceId: action.surfaceId,
          sessionId: action.sessionId,
          actionId: action.actionId,
        } satisfies StatusActionOpen);
    } catch {
      finish();
    }
  });
}

export function sameStatusAction(a: StatusActionDescriptor, b: StatusActionDescriptor): boolean {
  return (
    a.providerId === b.providerId &&
    a.surfaceId === b.surfaceId &&
    a.sessionId === b.sessionId &&
    a.statusKey === b.statusKey &&
    a.actionId === b.actionId &&
    a.label === b.label
  );
}
