# Design decisions

Current implementation constraints, not an upstream synchronization log or a
backlog of proposed packages. Package ownership and communication contracts live
in [package boundaries](package-boundaries.md).

## Worktree isolation

`pi-subagents` owns child worktree creation, preservation, cleanup and recovery.
Workflow per-call isolation requests go through the managed protocol's
`managedPolicy` capability into that existing owner; Workflows does not implement
another worktree manager.

Workflow isolation labels use deterministic run/call/label identities so resume
addresses the same logical operations. Creation failures follow the runtime's
explicit fallback policy rather than silently inventing a new isolation backend.
Preservation and removal outcomes must remain truthful; a retained recovery
reference does not itself establish that work was saved.

## Deferred imports

Defer a dependency only to keep TUI-only code out of headless paths, after
checking the mode. This exception does not permit arbitrary dynamic source
imports, private host patches or imports of another extension's implementation.
Use public Pi APIs and validate cross-extension event payloads.

## Workflow execution

Workflow scripts and callbacks execute in owned, terminable Node helpers.
Managed child dispatch, execution policy, budgets and durable journal facts stay
parent-owned. This bounds asynchronous CPU stalls; it is not an OS sandbox or
isolation of arbitrary external resources.

Named dependencies, deterministic layer barriers, bounded failure policies and
journal recovery belong to Workflows. Provider-aware admission and agent
execution policy belong to Subagents. Do not add a second model/tier/concurrency
configuration surface to an orchestration script.

## Resource admission

Evaluate new packages individually against a concrete use and acceptance scope.
Do not bundle competing owners or auto-enable experimental resources. Native
commands are host-owned: in particular, `/import` must not be shadowed by a
transcript-import extension. Check command conflicts before registration.
