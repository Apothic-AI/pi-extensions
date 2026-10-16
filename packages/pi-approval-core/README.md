# @signalridge/pi-approval-core

Independent, side-effect-free library for local human-approval service discovery and reviewed native Pi tool definitions. Tested against Pi **1.0.4**; host modules are peers. Importing the library installs no extension, settings, listeners, tools, timers, or resources. Calling its factories/discovery functions is explicit.

See [coreAPI.md](coreAPI.md) for the version-1 contract. This is intentionally separate from managed-subagent protocols. The service/request/factory/lifecycle shape remains API v1. Tool-call IDs are opaque bounded Unicode (including provider `|` and native nested `/n` identities), separate from strict source/service/request labels.

`APPROVAL_ADAPTER_QUERY_CHANNEL`, `validateAdapterQuery`, `validateAdapter`, and `queryApprovalAdapter` support explicit cooperative command gates. Exactly one synchronous reply must identify the requested tool and its current effective schema **by object identity**; absent/duplicate/malformed/copied-schema replies deny. Cooperating extensions own their listeners and attest only for live owned gates. Importing this library never registers events. See the contract for the exact query/response shapes.

These factories construct known local native backends. An SDK host must explicitly choose this integration; never use public `builtin:<name>` metadata as proof of an arbitrary overridden backend. The approvals extension's separate human `--approvals-native-tools` flag is not required by hosts constructing their own known factories.

## Reviewed native tools

`createApprovalToolDefinitions({ source, request, isCurrent, shellPath?, commandPrefix? })` returns `[edit, write, bash]` definitions for `registerTool` or SDK `customTools`. The host supplies a human-owned request callback and a current-owner predicate. Each invocation revalidates the final parameters with the SDK's schemas, then deep-clones/freezes them **before its first await**. Calls share no approval operation or context.

- Edit uses the public SDK edit factory. Its supplied `readFile` captures exact original bytes; its `writeFile` reviews the actual SDK-generated output, including BOM, line endings, fuzzy matching, and original-file batch semantics. No edit algorithm is reimplemented.
- Write supplies a no-op `mkdir`, reads a bounded existing/missing target, reviews the actual output, rechecks identity and bytes, then performs the real directory creation and write.
- Both await approval **inside the SDK factory's existing mutation queue**. Never wrap these definitions in another `withFileMutationQueue`: that queue is non-reentrant and nested acquisition deadlocks. Different files can wait independently. Cancelled calls already queued wait for their predecessor, then fail without requesting approval and release their slot.
- Bash wraps the public `createLocalBashOperations` backend at `exec`, reviewing the exact final command and CWD. Native output, truncation, timeout, cancellation, process-tree cleanup, and foreground execution are retained. The command input hash combines the final command/CWD/timeout with the frozen input's hash. The lower-level `createApprovalBashOperations` supports native `user_bash` interception.

## Bounds and limitations

Files and final inputs are capped at 256 KiB; human review payloads at 64 KiB. Oversized reviews fail, never approve clipped changes. Invalid UTF-8 and NUL-containing files are rejected. Display controls (including BOM, CR, tabs, bidi/format characters, and ANSI escapes) are shown explicitly as `\\u{hex}`; literal backslashes are doubled. Hashes cover complete actual bytes, not the escaped display.

Target symlinks, nonregular files, and multiply-linked files are denied. Existing ancestor realpaths and lstat identities are captured/rechecked; stable ancestor symlinks are allowed. File identities and bytes are rechecked after approval and, for write, after mkdir. This is **not OS-atomic** against external writers, aliases, other processes, or separately loaded queue implementations. A write failure or cancellation after approved mkdir can leave directories behind; there is no atomic rollback claim.

Approval is **not a sandbox**. Trusted extension callbacks and event-bus peers run in the same process and may access the filesystem or execute arbitrary code. Other execution tools, MCP tools, and external processes require separate restrictions. Human review can expose credentials contained in a proposed change; the library does not log them or send review payloads in lifecycle events.
