# @signalridge/pi-approvals

**Opt-in experimental extension**, tested with Pi **1.0.4**. Loading it explicitly installs a session-scoped human approval broker. Root canonical native `edit`, `write`, `bash`, and public `user_bash` execution additionally require the human's explicit `--approvals-native-tools` certification. It does not enable itself or write global configuration. The independent `@signalridge/pi-approval-core` library owns the version-1 contract and reviewed factories.

## Human workflow

Proposed operations wait with an owned footer count. They do **not** open unsolicited dialogs, replace the editor, steal native/foreign dialog focus, or automatically ask a parent model for clarification.

- `/approvals` or `/approvals list` lists pending IDs, source labels, and operation kinds.
- `/approvals review <id>` or `/approvals approve <id>` opens a full bounded review and a human decision. Typing `approve <id>` without the command/confirmation does not authorize anything.
- `/approvals deny <id>` closes exactly that request, including while a review/foreign dialog is open; denial opens no UI and never grants another request.

Commands run while tools wait; no `waitForIdle` is used. In TUI mode a full-terminal public overlay shows the escaped full diff or exact command/CWD/source. Header/controls/body fit terminal bounds; narrow terminals use a fully scrollable document fallback, including at one column. **Ctrl+A** approves that one review; **Esc** denies; Up/Down/PgUp/PgDn/Home/End navigate the review. Enter does not approve. There is no automatic next review, so repeated approval keys cannot approve subsequent requests. A currently observed public native/extension dialog must close before a review opens. Native overlay teardown pops the last overlay. Therefore cancellation waits for this review's public focus lifetime to resume before completing the native custom interaction; it never hides a custom overlay directly or dismisses a later focused foreign dialog. The foreign dialog remains respondable, then the cancelled review closes without requiring approval. Normal editor draft/focus restoration belongs to the public custom-UI host contract; this extension never writes editor text.

RPC uses the public native `confirm` transport when the human invokes the command. The client must display the full review and reply to the fresh `extension_ui_request.id` using `extension_ui_response`; lifecycle approval IDs and model text are not transport nonces. RPC clients must preserve human-only response ownership. A dialog timeout denies. Print/JSON/no-UI modes deny immediately, before native filesystem/process mutations.

Each approval is per-operation. There is no allow-all mode or permission cache, no response tool, and no background conversion of built-in bash. Pending operations are immutable; the broker caps pending requests at 32, retains at most 128 metadata-only resolutions, and expires requests after five minutes. Caller cancellation, committed branch/session divergence, reload/invalidation, missing UI, callback errors, and peer retirement fail closed. Native rename/custom-entry appends and parallel results preserve append affinity using full branch-entry fingerprints. Vetoed navigation and aborted summaries do not retire an unchanged session. Committed `session_start` and `session_tree` bindings install fresh brokers and wrapper closures; captured old services remain permanently retired. Neither cancellation nor denial resolves another request.

## Coverage and ownership

A loaded extension always advertises one typed service, including before startup and after unavailable/collision/retirement failures; discovery reports no peer only when the extension is absent. An unavailable service rejects rather than inviting ungated fallback. `/approvals` reports the root policy to the human.

**Root certification is required:** `--approvals-native-tools` is a public boolean CLI flag, default **false**. The human certifies that canonical backends are the host's standard local native Pi backends. Without it, root canonical calls and user bash deny clearly, before process/filesystem mutation, and original backends are **not replaced**. The human service can still review independently integrated child/background operations that construct their own known native factories. The model cannot enable this policy through a tool.

With certification, committed session bindings install reviewed definitions only for available admitted canonical tools. Missing/excluded tools are stronger host admission, never activated by this extension. Known selected extension/custom canonical collisions are rejected, not replaced. The exact current stricter active loadout is restored after late registration, including SDK initial allowlists and earlier Plan deactivations. Subsequent effective schema/description/source ownership loss blocks calls and retires requests.

**Public-SDK limitation:** Pi 1.0.4 labels `AgentSession.baseToolsOverride` backends `builtin:<name>`, even when their operations are custom, rejecting, or remote. Public metadata cannot certify backend provenance. The flag is explicit human certification, **not metadata proof**. SDK hosts with overridden backends must omit it and supply an explicit known-backend reviewed integration. Never use this flag to silently substitute unknown custom operations with local operations.

## Not a security boundary

Approval is not an OS sandbox. Extensions and local event-bus callbacks are trusted same-process code. Command-shaped noncanonical calls (own `command` input, including an `input.command` envelope) are denied unless exactly one synchronous cooperative adapter advertises the current effective schema by object identity on `signalridge:approvals:adapter:v1`. See the core contract for validators and response shape. No source-name heuristic authorizes aliases; older command adapters without the capability are blocked. Unrelated metadata tools are not blanket-blocked.

This bounded policy does **not** detect arbitrary evaluation/execution in tools without command-shaped inputs; those tools, child runtimes, MCP tools, and external processes need separately restricted admission or explicit integrations. Cooperative peers are trusted to gate their final backend operation and to attest only while their own context/binding remains live. Captured services fail closed; absence is not permission to bypass a previously loaded service.

File reviews retain native edit BOM/CRLF/fuzzy/original-batch semantics. Limits: 256 KiB files/input, 64 KiB review, no clipped approval. Invalid UTF-8/binary files and target symlink/hardlink aliases are rejected; display controls are explicitly escaped, actual byte hashes are complete. Stable ancestor symlinks are permitted with identity/realpath rechecks. Queue and post-review checks are not OS-atomic against external writers/aliases/processes. Approved write directory creation may remain after a subsequent failure/cancellation; no rollback is promised.

Full reviewed changes/commands can contain secrets. The broker shows them only in human reviews; its pending notices, status, errors, and lifecycle metadata do not echo proposed credentials. Native SDK tool output/error behavior is retained. Loading third-party extensions remains a trust decision.
