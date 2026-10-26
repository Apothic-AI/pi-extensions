import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { SystemMessage, Usage } from "@earendil-works/pi-ai";
import { CURRENT_SESSION_VERSION, SessionManager } from "@earendil-works/pi-coding-agent";
import {
  type CodexCheckpointDetails,
  fallbackSummary,
  parseCheckpointDetails,
  projectCheckpointContext,
} from "./checkpoint.js";
import { assertClosedToolPairs, type RecoveryMessage, resetHistoricalUsage } from "./recovery-snapshot.js";

const MAX_EXPORT_BYTES = 64 * 1024 * 1024;
// Native JSONL omits optional undefined properties. Compare its persisted
// representation, never object-only metadata that cannot survive any reload.
function persisted<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
export interface RecoveryExportInput {
  cwd: string;
  sessionDir: string;
  sourceSessionId: string;
  sourceEntryIds: readonly string[];
  head: SystemMessage;
  details: CodexCheckpointDetails;
  suffix: readonly RecoveryMessage[];
  usage: Usage;
  signal: AbortSignal;
  isCurrent(): boolean;
}
export interface RecoveryExportResult {
  sessionId: string;
  path: string;
  /** The complete file is usable even if its directory durability could not be confirmed. */
  durabilityConfirmed: boolean;
}

function assertCurrent(input: RecoveryExportInput): void {
  input.signal.throwIfAborted();
  if (!input.isCurrent()) throw new Error("Recovery source changed");
}

/** Public append APIs construct an entirely new native graph, never a source fork. */
export function buildRecoverySession(input: RecoveryExportInput): SessionManager {
  const details = parseCheckpointDetails(input.details);
  if (!details || details.keptMessageFingerprints.length || details.retryTrimmedTail || !input.suffix.length) {
    throw new Error("Recovery requires a retain-none checkpoint and nonempty suffix");
  }
  assertClosedToolPairs(input.suffix);
  const manager = SessionManager.inMemory(input.cwd);
  if (manager.getSessionId() === input.sourceSessionId) throw new Error("Recovery identity collision");
  manager.appendMessage(persisted(input.head));
  manager.appendCompaction(fallbackSummary(details.checkpointId), null, 0, details, true, input.usage);
  for (const message of input.suffix) manager.appendMessage(persisted(resetHistoricalUsage(message)));
  validateRecoverySession(manager, input);
  return manager;
}

/** Validate the native current-format reload, not just our input objects. */
export function validateRecoverySession(manager: SessionManager, input: RecoveryExportInput): void {
  const header = manager.getHeader();
  if (
    !header ||
    header.version !== CURRENT_SESSION_VERSION ||
    header.parentSession ||
    header.cwd !== input.cwd ||
    header.id === input.sourceSessionId
  )
    throw new Error("Invalid recovery header");
  if (!/^[a-f0-9-]{36}$/u.test(header.id)) throw new Error("Invalid recovery session ID");
  const entries = manager.getEntries();
  const expectedSuffix = persisted(input.suffix.map(resetHistoricalUsage));
  if (
    entries.length !== expectedSuffix.length + 2 ||
    entries[0]?.type !== "message" ||
    !isDeepStrictEqual(entries[0].message, persisted(input.head))
  )
    throw new Error("Invalid recovery envelope");
  const checkpoint = entries[1];
  if (
    checkpoint?.type !== "compaction" ||
    checkpoint.firstKeptEntryId !== checkpoint.id ||
    checkpoint.summary !== fallbackSummary(input.details.checkpointId) ||
    !isDeepStrictEqual(parseCheckpointDetails(checkpoint.details), input.details) ||
    !isDeepStrictEqual(checkpoint.usage, input.usage)
  )
    throw new Error("Invalid recovery checkpoint");
  const sourceIds = new Set(input.sourceEntryIds);
  let parentId: string | null = null;
  const ids = new Set<string>();
  for (const entry of entries) {
    if (!entry.id || ids.has(entry.id) || sourceIds.has(entry.id) || entry.parentId !== parentId) {
      throw new Error("Invalid fresh recovery lineage");
    }
    ids.add(entry.id);
    parentId = entry.id;
  }
  if (
    !isDeepStrictEqual(
      entries.slice(2).map((entry) => (entry.type === "message" ? entry.message : null)),
      expectedSuffix,
    )
  ) {
    throw new Error("Recovery suffix changed");
  }
  const replay = projectCheckpointContext(manager.buildSessionContext().messages, input.details, "full");
  if (
    replay?.filter((message) => message.role === "system").length !== 1 ||
    !isDeepStrictEqual(
      replay.filter((message) => message.role === "system")[0],
      persisted({ ...input.head, timestamp: checkpoint.systemMessage?.timestamp }),
    ) ||
    !isDeepStrictEqual(replay.filter((message) => message.role !== "system").slice(1), expectedSuffix) ||
    replay.length !== expectedSuffix.length + 2
  )
    throw new Error("Recovery canonical replay changed");
}

/**
 * Private same-filesystem staging; only a complete fsynced validated native file
 * becomes selector-visible. linkSync is a no-replace publication point, with a
 * synchronous final owner check (no await between it and publication).
 */
export async function exportRecoverySession(input: RecoveryExportInput): Promise<RecoveryExportResult> {
  assertCurrent(input);
  if (!isAbsolute(input.cwd) || !isAbsolute(input.sessionDir)) throw new Error("Recovery needs absolute paths");
  const manager = buildRecoverySession(input);
  const header = manager.getHeader();
  if (!header) throw new Error("Missing recovery header");
  const bytes = `${[header, ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  if (Buffer.byteLength(bytes) > MAX_EXPORT_BYTES) throw new Error("Recovery export exceeds byte bound");
  const filename = `${header.timestamp.replace(/[:.]/g, "-")}_${header.id}.jsonl`;
  if (basename(filename) !== filename || !/^[0-9a-fTZ_-]+\.jsonl$/u.test(filename))
    throw new Error("Invalid recovery filename");
  const destination = join(input.sessionDir, filename);
  const directory = await fsPromises.mkdtemp(join(input.sessionDir, ".codex-recovery-"));
  // No .jsonl staging name, even if a selector traverses private subdirectories.
  const staged = join(directory, "session.pending");
  try {
    assertCurrent(input);
    const handle = await fsPromises.open(staged, "wx", 0o600);
    try {
      await handle.writeFile(bytes, "utf8");
      assertCurrent(input);
      await handle.sync();
    } finally {
      await handle.close();
    }
    assertCurrent(input);
    if ((await fsPromises.readFile(staged, "utf8")) !== bytes) throw new Error("Recovery staging changed");
    const reopened = SessionManager.open(staged);
    if (
      reopened.getSessionId() !== manager.getSessionId() ||
      !isDeepStrictEqual(reopened.getEntries(), persisted(manager.getEntries()))
    )
      throw new Error("Recovery reload changed");
    validateRecoverySession(reopened, input);
    // Fail unsupported directory syncing before publication whenever possible.
    const dir = fs.openSync(input.sessionDir, "r");
    try {
      fs.fsyncSync(dir);
      assertCurrent(input);
      fs.linkSync(staged, destination); // EEXIST (including symlinks) must never overwrite.
      let durabilityConfirmed = true;
      try {
        fs.fsyncSync(dir);
      } catch {
        durabilityConfirmed = false;
      }
      return { sessionId: manager.getSessionId(), path: destination, durabilityConfirmed };
    } finally {
      try {
        fs.closeSync(dir);
      } catch {
        // Cleanup cannot turn a completed no-replace publication into failure.
      }
    }
  } finally {
    // Never remove a completed externally usable export, even on late UI/error.
    await fsPromises.rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}
