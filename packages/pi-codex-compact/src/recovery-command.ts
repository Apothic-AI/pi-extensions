import { lstatSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model, Tool } from "@earendil-works/pi-ai";
import {
  convertToLlm,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type SessionEntry,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { authorizeCanonicalHistory } from "./authorization.js";
import {
  buildReplacementHistory,
  type CodexCheckpointDetails,
  checkpointMarker,
  createCheckpointDetails,
} from "./checkpoint.js";
import { compactionAbortError, compactionError, failureFrom, formatCompactionFailure } from "./failure.js";
import { exportRecoverySession } from "./recovery-export.js";
import { splitRecoveryContext } from "./recovery-snapshot.js";
import { requestRemoteCompaction } from "./remote.js";
import type { CodexCompactSettingsRuntime } from "./settings.js";
import { sameTools } from "./tool-state.js";

interface RecoveryDependencies {
  project(
    branch: SessionEntry[],
    model: Model<"openai-codex-responses">,
  ): {
    messages: AgentMessage[];
    transcript: AgentMessage[];
    prior?: CodexCheckpointDetails;
  };
  matches(transcript: AgentMessage[], ctx: ExtensionContext): boolean;
  tools(): Tool[];
  authenticate(
    ctx: ExtensionContext,
    model: Model<"openai-codex-responses">,
    signal: AbortSignal,
    deadline: number,
  ): ReturnType<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>;
  payloadValidator(ctx: ExtensionContext): ((payload: unknown) => boolean) | undefined;
  fetch?: typeof globalThis.fetch;
}

function route(model: Model<Api> | undefined): string {
  return JSON.stringify([model?.provider, model?.api, model?.id, model?.baseUrl]);
}
function fileIdentity(path: string): string {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsupported recovery source file");
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}
function safeText(text: string): string {
  return Array.from(text, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 ||
      (code >= 127 && code <= 159) ||
      (code >= 0x2028 && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
      ? " "
      : character;
  }).join("");
}
function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" = "warning"): void {
  try {
    ctx.ui.notify(message, level);
  } catch {
    /* A late UI failure cannot undo a published export. */
  }
}

/** One cancellable explicit idle owner, separate from ordinary/full compaction. */
export function createRecoveryCommand(
  pi: ExtensionAPI,
  runtime: CodexCompactSettingsRuntime,
  dependencies: RecoveryDependencies,
) {
  let owner: AbortController | undefined;
  return {
    cancel(): void {
      owner?.abort();
    },
    async run(ctx: ExtensionCommandContext, sessionSignal: AbortSignal): Promise<void> {
      if (ctx.mode !== "tui" || !ctx.hasUI || sessionSignal.aborted) return;
      if (owner || !ctx.isIdle() || ctx.hasPendingMessages()) {
        notify(ctx, "Recovery export requires an idle session with no pending work or other recovery export.");
        return;
      }
      const controller = new AbortController();
      owner = controller;
      const signal = AbortSignal.any([controller.signal, sessionSignal]);
      // No generic ctx.abort fence: only the extension-owned recovery signal.
      let isCurrent = (): boolean => false;
      try {
        const manager = ctx.sessionManager;
        const sessionId = manager.getSessionId();
        isCurrent = () => {
          try {
            return !signal.aborted && ctx.sessionManager === manager && manager.getSessionId() === sessionId;
          } catch {
            return false;
          }
        };
        const settings = structuredClone(runtime.get().settings);
        const model = ctx.model;
        if (!settings.enabled || model?.provider !== "openai-codex" || model.api !== "openai-codex-responses") {
          throw compactionError("checkpoint_incompatible");
        }
        const sourceModel = route(model);
        const sourceFile = manager.getSessionFile();
        const sessionDir = manager.getSessionDir();
        if (!sourceFile || !isAbsolute(sourceFile) || !isAbsolute(sessionDir))
          throw new Error("Recovery needs a persisted source");
        const diskIdentity = fileIdentity(sourceFile);
        const branch = structuredClone(manager.getBranch());
        const branchKey = JSON.stringify(branch);
        const leafId = manager.getLeafId();
        if (
          !leafId ||
          branch.at(-1)?.id !== leafId ||
          new Set(branch.map((entry) => entry.id)).size !== branch.length ||
          branch.some((entry, index) => !entry.id || entry.parentId !== (branch[index - 1]?.id ?? null))
        ) {
          throw new Error("Recovery source lineage is invalid");
        }
        const effectiveSettings = pi.getSettings();
        const settingsKey = JSON.stringify(effectiveSettings);
        const trusted = ctx.isProjectTrusted();
        // Public, read-only effective settings snapshot includes host overrides
        // and trust scoping; never parse/reload or persist another settings file.
        const settingsView = SettingsManager.inMemory(effectiveSettings, { projectTrusted: trusted });
        const keepRecentTokens = settingsView.getCompactionKeepRecentTokens(model);
        const current = dependencies.project(branch, model);
        const prior = current.prior;
        if (!prior) throw compactionError("checkpoint_projection_failed");
        const head = current.messages[0];
        if (head?.role !== "system" || current.messages.filter((message) => message.role === "system").length !== 1) {
          throw compactionError("checkpoint_projection_failed");
        }
        const split = splitRecoveryContext(current.messages.slice(1), prior.checkpointId, keepRecentTokens);
        const tools = structuredClone(dependencies.tools());
        let retired = false;
        const owned = isCurrent;
        isCurrent = () => {
          if (retired) return false;
          try {
            retired =
              !owned() ||
              !ctx.isIdle() ||
              ctx.hasPendingMessages() ||
              route(ctx.model) !== sourceModel ||
              manager.getSessionFile() !== sourceFile ||
              manager.getSessionDir() !== sessionDir ||
              manager.getLeafId() !== leafId ||
              JSON.stringify(manager.getBranch()) !== branchKey ||
              fileIdentity(sourceFile) !== diskIdentity ||
              ctx.isProjectTrusted() !== trusted ||
              JSON.stringify(pi.getSettings()) !== settingsKey ||
              JSON.stringify(runtime.get().settings) !== JSON.stringify(settings) ||
              !dependencies.matches(current.transcript, ctx) ||
              !sameTools(tools, dependencies.tools());
          } catch {
            retired = true;
          }
          return !retired;
        };
        if (!isCurrent()) throw compactionAbortError();
        // Always informed per-export confirmation, even with persistent canonical consent.
        // This is also the one-operation canonical-history grant; no setting changes.
        const confirmed = await authorizeCanonicalHistory(ctx, signal, {
          title: "Codex recovery · Export into a NEW session?",
          notice: `Send ${split.prefix.length} canonical prefix messages (including the prior opaque checkpoint), keeping ${split.suffix.length} complete suffix messages UNSENT. Canonical history includes custom content, system instructions and tools, bypasses request-local filters, and may be retained/replayed; persisted context_edit omissions remain honored. This one prefix request may cost money and may still exceed the backend window. No retries or native fallback. Your original session and backups remain unchanged. Success creates a NEW session, not an in-place repair. Copied historical assistant/tool usage and cost are reset to zero; original accounting stays in the source, and only this recovery call is charged to the new checkpoint. No switch or follow-up send occurs. Allow once? Settings do not change.`,
        });
        if (!confirmed || !isCurrent()) return;
        // Defer the TUI dependency out of noninteractive paths.
        const { BorderedLoader } = await import("@earendil-works/pi-coding-agent");
        if (!isCurrent()) return;
        await ctx.ui.custom<void>((tui, theme, _keys, done) => {
          const loader = new BorderedLoader(tui, theme, "Codex recovery export · Escape cancels");
          const abort = () => controller.abort();
          loader.onAbort = abort;
          const retire = () => {
            try {
              loader.dispose();
            } catch {
              /* Best effort progress cleanup. */
            }
            try {
              done();
            } catch {
              /* A late UI failure cannot undo publication. */
            }
          };
          const work = async () => {
            if (!isCurrent()) return;
            const deadline = performance.now() + settings.requestTimeoutMs;
            const timeout = setTimeout(() => controller.abort(), settings.requestTimeoutMs);
            try {
              const auth = await dependencies.authenticate(ctx, model, signal, deadline);
              if (!isCurrent()) throw compactionAbortError();
              if (!auth.ok || !auth.apiKey) throw compactionError("credentials_unavailable");
              const provider = ctx.modelRegistry.getProvider(model.provider);
              if (!provider) throw compactionError("provider_unavailable");
              const remainingMs = deadline - performance.now();
              if (remainingMs <= 0) throw compactionError("remote_timeout");
              const response = await requestRemoteCompaction({
                provider,
                model: { ...model, baseUrl: auth.baseUrl ?? model.baseUrl },
                context: {
                  systemPrompt: ctx.getSystemPrompt(),
                  messages: convertToLlm([head, ...split.prefix]),
                  tools,
                },
                apiKey: auth.apiKey,
                headers: auth.headers,
                env: auth.env,
                signal,
                isCurrent,
                validatePayload: dependencies.payloadValidator(ctx),
                priorCheckpoint: {
                  marker: checkpointMarker(prior.checkpointId),
                  replacementHistory: prior.replacementHistory,
                },
                requestTimeoutMs: remainingMs,
                maxRetries: 0,
                fetch: dependencies.fetch,
              });
              if (!isCurrent()) throw compactionAbortError();
              const details = createCheckpointDetails({
                modelId: model.id,
                replacementHistory: buildReplacementHistory(response.promptInput, response.item, {
                  tokenBudget: settings.replacementTokenBudget,
                }),
                keptMessages: [],
              });
              const result = await exportRecoverySession({
                cwd: manager.getCwd(),
                sessionDir,
                sourceSessionId: sessionId,
                sourceEntryIds: branch.map((entry) => entry.id),
                head,
                details,
                suffix: split.suffix,
                usage: response.usage,
                signal,
                isCurrent,
              });
              if (isCurrent())
                notify(
                  ctx,
                  `Recovery exported to NEW session ${safeText(result.sessionId)} at ${safeText(result.path)}. Original unchanged. Open it explicitly with /resume; no follow-up was sent. This does not prove the next request fits.${result.durabilityConfirmed ? "" : " Directory durability could not be confirmed; the complete export remains available."}`,
                  "info",
                );
            } finally {
              clearTimeout(timeout);
            }
          };
          // Observe every late failure; cancellation must retire the progress UI,
          // while publication remains guarded through auth, body, and staging.
          void work()
            .catch((error: unknown) => {
              if (isCurrent())
                notify(
                  ctx,
                  `Recovery export failed; original unchanged. ${formatCompactionFailure(failureFrom(error, "local_compaction_failed"))}`,
                );
            })
            .finally(retire);
          return loader;
        });
      } catch (error) {
        if (isCurrent())
          notify(
            ctx,
            `Recovery export unavailable; original unchanged. ${formatCompactionFailure(failureFrom(error, "checkpoint_projection_failed"))}`,
          );
      } finally {
        controller.abort();
        if (owner === controller) owner = undefined;
      }
    },
  };
}
