# Task and human-control implementation

Status: implementation in progress. This document is an acceptance ledger, not a claim that the features below have shipped.

## Scope

1. Independent, opt-in session/branch Todo, distinct from an execution scheduler or project/shared backlog.
2. A visible background-task shortcut entry opening the existing task selector without consuming the subagent foreground handoff key.
3. Per-operation reviewed write/edit approval, not a session-wide permission for subsequent writes.
4. Human-owned, structured command approval across root, managed child and background launch paths.
5. Generic editable-summary linked-session handoff and cross-workspace session preview/navigation, distinct from the existing approved-plan implementation handoff.

No global installation or settings changes, default activation of experimental packages, automatic conversion of builtin bash to background work, PTY attachment, SSH backend, memory subsystem or project backlog is included.

## Non-negotiable boundaries

- Use public Pi APIs and validated `pi.events` payloads. Extract only intentional, side-effect-free shared contracts; extensions do not import each other's source.
- Preserve managed protocol v4 and workflow journal schema v4. An optional approval capability must not silently grant permissions or change ordinary parent clarification into an approver.
- Human approval binds to the specific operation, owner, effective cwd, input and reviewed file state. Changed input/file state, missing approver, cancellation and retired ownership invalidate it.
- Permission controls are not an OS sandbox. Existing stricter tool admission, project trust and Plan-mode policy remain authoritative. Coverage for noncanonical external execution tools must be explicit rather than inferred from a canonical bash gate.
- Status text is not itself an interactive component. A shortcut plus task selector must be described accurately and preserve existing dialog focus, editor drafts and footer ownership.
- Todo completion is a checklist assertion, not proof of workflow execution or successful verification. No automatic completion from prose, settlement, stops or partial results.
- Native command-only session replacement and navigation must remain command-owned. Previewing a session does not grant permission to execute instructions in it or copy credentials.

## Acceptance matrix

| Area | Required evidence |
| --- | --- |
| Todo state | Stable IDs; meaningful revision increments; validated full graph; immutable snapshots; append failure keeps old state; valid empty snapshots; bounded input/output |
| Todo recovery | Current-branch tree/fork/reload; compaction and precise model awareness; nested tool calls without standalone toolResult; stale revision and retired owner rejection |
| Todo UI | Explicit manual editing/status/reopen; distinct-key destructive confirmation; CJK/ANSI safety; narrow-width resize; root editor draft preservation |
| Background entry | Real host shortcut in fullscreen and regular modes; empty/running/finished list; other-dialog focus; no Ctrl+B collision; no process/model turn from inspection |
| Reviewed writes | Exact edit semantics; reviewed diff; original/new file binding; concurrent mutations; external editing; cancellation; append/write/queue failures; no unreviewed write fallback |
| Commands | Per-command decisions; root and managed child correlation; background launch; parallel requests; waiting/respond/resolved lifecycle; human-only responses; absent peer and non-UI fail closed |
| Session navigation | Bounded discovery/preview; malformed files; stable ID/path selection; cross-workspace cwd semantics; cancelled navigation; owner retirement |
| Handoff | Editable human-confirmed bounded summary; linked parent; in-memory source preservation; destination draft only; recovery and model mismatch; no automatic sending |
| Composition | Plan-mode tool policy; existing ask_tools restrictions; workflow checkpoint distinction; extension load order; exact-owned session/branch cleanup |
| Release | Independent manifests and changesets; complete root gate; packed loader smoke; actual offline CLI PTY/RPC/print tests; honest untested platform/provider limits |

## Approval integration design

Use a side-effect-free `pi-approval-core` library for reviewed tool definitions and a version-1 local event-bus service contract; the opt-in `pi-approvals` extension owns human decisions and their lifecycle. This is separate from managed protocol v4. A caller captures one validated service before awaiting work; a retired or ambiguous service must not become an unapproved fallback.

Reviewed edit operations use the public SDK factory's computed output inside its existing file-mutation queue. Reviewed write operations defer directory creation until approval. Neither wraps a factory in another same-file queue acquisition, which would deadlock the non-reentrant SDK queue. The final executed arguments must be validated and copied after tool-call handlers, not approved solely in an earlier mutable event hook. File state and ownership are rechecked after the decision. This serializes cooperating same-process operations, not arbitrary external writers or independently loaded runtimes.

Managed child integration captures the root service through the parent-owned public event bus and installs only reviewed tools already admitted by child policy. It does not forward every child UI method, widen extension admission, or turn ordinary parent clarification into permission. Background launch approval belongs immediately before the owned normalized start/watch operation. Existing stronger admission and trust rules remain in force.

## Verification status

The first integrated background-entry delta passed its package lint/typecheck and **114 tests**, including the existing 108. Its repeatable actual Pi 1.0.4 CLI/PT Y script passed **72 checks** across fullscreen/regular and 100×30/40×12. The complete repository gate also passed for that integrated tree. Independent review and approval composition are still pending.

Todo, approvals and generic sessions/handoff remain under implementation. Unit tests, fake-provider SDK tests and physical/live-provider acceptance will be reported separately. No publication is implied by this ledger.


### Integrated package checkpoint

The integrated Todo package now passes lint/typecheck and 86 tests, including native-keyboard host scenarios after the durability, tool-exposure and UI fixes. Current approval core, approvals and background package checks pass with 20, 41 and 146 tests. The managed-child approval SDK suite was rerun separately. These are package/SDK checks, not live-provider or physical-terminal acceptance.

The lockfile now includes the new workspace packages and approval adapters. JSON/manifests, package boundaries, shared dependency ranges, test inventory, changeset coverage and generated capability gates pass. The full current-tree repository gate and packed-loader acceptance remain pending.

### Current verification checkpoint

The four initial session/handoff findings were reproduced and repaired. Follow-up review identified additional pre-insertion cursor/Undo, exact whitespace approval and picker-offset defects, plus usage/content restoration and growing-file read bounds. The current tree includes those fixes; its session package passes lint/typecheck and **202 tests**, including the final native-role, custom-directory discovery and remapped-key regressions. Parent reruns confirm the destination's interaction lock and vetoed-navigation fencing prevent a late Yes from overwriting a newer client draft, without a model turn. The repeatable session UI CLI script passes **112 public post-composition assertions** across regular/fullscreen and resizing; raw ANSI is retained separately, not claimed independently reconstructed by that script. Actual full command acceptance also passes **16 RPC checks** and **27 TUI checks** for native creation, exact whitespace/CJK draft, explicit recovery and no automatic model turn. A custom-directory discovery regression is repaired and its actual CLI discovery/switch check passes **11 checks**, including separate consent, foreign tool/resource workspace rebinding and unchanged process cwd. Final focused independent recheck and full repository gates remain pending.

The repaired Todo source passes an actual offline CLI subset of **176 checks**, including normal manual editing, both terminal modes/sizes, revisions/dependencies, persisted recovery, nested calls, and JSON/RPC/plain paths. Separate lifecycle checks pass typed commands and compaction/context recovery. No-Todo native controls confirm new/reload cursor reset and fork draft-prefill behavior are host-owned; these do not reduce the package's ordinary overlay preservation assertions. Prompt retirement on an external authoritative Todo-state change is now repaired using lightweight lease checks rather than repeated persistence reads: the Todo package passes **139 tests**, and the authority-only actual CLI case passes **9 checks**. The complete ordinary CLI subset passed again at the terminal-input hardening epoch; its final unchanged-title preservation follow-up is included in the native package suite.

Actual root/background approval composition passes **39 RPC checks** and **60 TUI checks**: specific write denial, exact approved write/edit CRLF bytes, canonical bash/background/monitor launch gates, transport nonce separation, explicit review and no extra model turn. Managed-child approval has **36 focused native SDK tests**; the complete Subagents package also passes **1996 tests, 4 skipped**. The background selector shortcut passes **80 actual CLI checks** after approval integration. These are offline/faux-provider or SDK results, not live-provider or physical-terminal qualification.

The complete root gate passed once, including 34 manifests, independent packed loaders, versions/Changesets and secret scanning; Subagents build passed too. Final small input-boundary/lifecycle follow-ups are being rechecked against the final source epoch before submission. Todo's edit prefill/paste safety has native regression coverage, including raw Backspace and unchanged-state preservation. Scope-specific reviews closed the session restoration, custom-directory enumeration and remapped-submit findings; the last Todo input recheck is tracked separately.

Publication is a separate gate: npm currently has no packages named `@signalridge/pi-approval-core`, `@signalridge/pi-approvals`, `@signalridge/pi-sessions` or `@signalridge/pi-todo`. Per the repository release policy, each requires maintainer-owned first-name bootstrap and its package-specific Trusted Publisher binding before normal OIDC Changesets publication. No local publish, manual version bump or global configuration change is part of this implementation. Do not merge a version-release PR until those prerequisites are satisfied. No publication is claimed.
