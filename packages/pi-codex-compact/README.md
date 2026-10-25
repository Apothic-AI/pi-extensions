# pi-codex-compact — remote compaction V2 for Pi

[![npm](https://img.shields.io/npm/v/@signalridge/pi-codex-compact)](https://www.npmjs.com/package/@signalridge/pi-codex-compact) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

> [!WARNING]
> This extension is experimental. It depends on an undocumented OpenAI Codex Responses wire
> contract and stores provider-specific opaque checkpoints. Keep backups of important sessions.

`@signalridge/pi-codex-compact` adds Codex Remote Compaction V2 to the
[Pi Coding Agent](https://pi.dev) for the built-in `openai-codex` OAuth provider. It replaces Pi's
plaintext summary-generation call with a server-generated opaque compaction item and safely replays
that item in later OpenAI Codex Responses requests.

Pi remains responsible for deciding when compaction runs, including automatic thresholds, the
built-in `/compact` command, overflow retries, retained-message selection, and append-only session
publication. This package owns only the Remote V2 request, checkpoint persistence, and later payload
replay.

## Features

- Uses the active `openai-codex` OAuth credentials without persisting tokens or request headers.
- Handles Pi's manual, threshold, and overflow compaction reasons through the same lifecycle hook.
- Validates one bounded opaque `compaction` item from a completed Responses SSE stream.
- Persists a versioned checkpoint in `CompactionEntry.details` and restores it after reload, resume,
  or a fork that retains the checkpoint.
- Replays the newest compatible checkpoint while preserving later conversation and extension-added
  context.
- Supports repeated compaction by carrying the previous opaque item into the next Remote V2 request.
- Requires informed authorization for persisted canonical history before credentials or transport.
  Unconsented compaction cancels, including in headless/RPC modes; it does not launch native fallback.
- With the hook enabled, an effective opaque boundary cancels compaction before consent or credentials
  if its checkpoint is malformed or the active provider, API, or model ID is incompatible.
- After authorization, failures can use Pi's native plaintext compaction only when the effective
  boundary is not an opaque checkpoint. Otherwise compaction cancels to preserve older context;
  native summarization cannot decode it. Session/branch divergence and user cancellation also cancel.
- Provides `/codex-compact` for manual compaction, effective-route visibility, and bounded settings.

## Install

Install persistently from npm:

```bash
pi install npm:@signalridge/pi-codex-compact
```

Try the published package without installing:

```bash
pi -e npm:@signalridge/pi-codex-compact
```

Try a local checkout from the repository root:

```bash
pi -e ./packages/pi-codex-compact
# or
just try codex-compact
```

Loading the package enables the Remote V2 hook, but does **not** authorize sending canonical history.
Avoid loading a global npm installation and the local workspace at the same time.

## Quick start

1. Sign in through Pi's built-in OpenAI Codex OAuth provider.
2. Select a model whose provider is `openai-codex` and API is `openai-codex-responses`.
3. Work normally. In a UI-capable TUI, compaction asks permission to use canonical history **once**.
   Declining, cancelling, timing out, or having no suitable UI cancels compaction, not just the remote
   request. To authorize future requests explicitly, toggle **Allow canonical history** in this
   extension's Settings menu. In headless/RPC modes that persistent opt-in is required.
4. Run `/codex-compact` to inspect the effective route or choose **Compact now**.
5. After compaction, continue the session normally; compatible requests replay the opaque checkpoint.

Healthy startup, reload, and resume do not emit an experimental warning. In UI-capable modes,
a short portability warning appears once per loaded extension instance when its first remote
checkpoint is committed—not on native compaction or failed/cancelled remote attempts. Invalid
settings, fallback failures, and incompatible-model warnings remain visible. Unsupported models
use Pi-native compaction only without an effective opaque boundary. With an active opaque boundary,
compaction cancels while this hook is enabled; disabling `enabled` explicitly opts out of that protection.

## Command

```text
/codex-compact
```

In TUI mode, the root menu shows whether Remote V2 is enabled, the active model, and whether a
manual compact will use **Codex Remote V2** (asking once unless canonical history is allowed) or
**Pi native**. These route labels do not override the opaque-boundary safety gate: an incompatible
or malformed active checkpoint cancels compaction while the hook is enabled. It contains:

```text
Compact now
Settings
Close
```

**Compact now** closes the menu before asking Pi to compact the active session. Escape or Ctrl+C
closes without compacting, and an obsolete menu cannot trigger work after session replacement or
shutdown. Deliberate SDK cancellation and caller abort do not become a red **Compaction failed**
notice; the hook's safe reason warning remains visible when applicable. Interrupting an active agent
turn is normal SDK compaction behavior, not evidence that compaction itself was cancelled. Unknown
failures still use a fixed, source-free failure notice, and throwing UI callbacks are harmless. **Settings** opens the bounded settings editor. In non-TUI modes, the command reports the
manual settings path instead of opening custom UI or compacting.

Pi's built-in `/compact` remains available and follows the same extension hook, including the
opaque-boundary safety gate on unsupported models.

## Safe failure diagnostics

A failed authorized attempt reports a fixed reason code, not a guessed backend cause. With an
active opaque checkpoint, the warning retains **cancelled to preserve the existing opaque checkpoint**
semantics, for example:

```text
Compaction cancelled to preserve the existing opaque checkpoint. [remote_http_error; HTTP 429]
```

Without an effective opaque boundary, an authorized failure can still use Pi-native compaction;
its optional fallback warning carries the same diagnostic. `notifyOnFallback` does not suppress
opaque-checkpoint cancellation warnings. Notifications and progress status are best effort: a UI
failure cannot turn opaque cancellation into native fallback.

| Fixed reason code | Known observation (not a provider diagnosis) |
| --- | --- |
| `authentication_failed` / `authentication_timeout` | Credential resolution threw / the extension's authentication wait deadline expired. |
| `credentials_unavailable` / `provider_unavailable` | No usable credential / no available provider implementation. |
| `checkpoint_malformed` / `checkpoint_incompatible` | The early opaque-boundary gate rejected checkpoint details / active provider, API, or exact model ID. |
| `checkpoint_projection_failed` | Canonical checkpoint projection failed its anchor or lineage checks, or could not be built. |
| `loadout_mismatch` | Persisted prompt/tools or the observed wire-tool snapshot could not be reproduced; this includes a locally rejected validator even if the provider swallows its exception. |
| `payload_rejected` | Local provider-context or Remote V2 payload preparation was rejected. |
| `remote_http_error; HTTP NNN` | The intercepted transport returned a non-success HTTP response. Only an integer `Response.status` from 100–599 is included, when valid. |
| `remote_timeout` | The extension-owned remote deadline expired, including response-body inspection. |
| `remote_transport_error` | Fetch or response-body reading failed without a more specific safe observation. |
| `remote_provider_error` | The provider threw/emitted an error, or SSE reported terminal failure, cancellation, or incomplete output, without a more specific safe observation. Arbitrary text is ignored. |
| `remote_context_window_exceeded` | JSON SSE reported exactly `context_window_exceeded` or `context_length_exceeded` at `code` / `error.code` on an `error` event, or `response.error.code` on `response.failed`. This is one fixed observation code, not overflow recovery or a diagnosis of an earlier failure. |
| `remote_response_invalid` | A successful HTTP response had absent, malformed, unsupported, oversized, or otherwise invalid compaction SSE. |
| `state_divergence` | Live prompt/tools no longer matched the completed request; the result was discarded. |
| `local_compaction_failed` | Local checkpoint construction failed after the response was accepted. |

Local cancellation is not an HTTP/provider failure. When UI is available and the operation still
belongs to the same non-aborted session owner, cancellation warnings distinguish:

| Fixed cancellation code | Known observation |
| --- | --- |
| `canonical_consent_required` | Persistent canonical-history consent is absent and no suitable one-operation TUI confirmation is available. |
| `canonical_consent_denied` | One-operation confirmation did not grant consent, including denial, uncertain/throwing result, or dialog timeout. |
| `preparation_model_changed` | The same owner's active provider/API/model route changed after preparation. No route values are shown. |
| `preparation_branch_changed` | The same owner's source lineage or leaf changed beyond the narrow Goal bookkeeping allowance below. No IDs or history are shown. |

These warnings never grant consent, request credentials for an unconsented operation, or enable
native fallback. With an effective opaque boundary they retain the checkpoint-preservation wording.
Explicit caller abort and retired session/reload/tree/shutdown owners remain silent; a late consent
or credential continuation cannot notify stale UI. Headless modes without UI still return only
cancellation, with no diagnostic journal or extra event payload. A later successful transport retry
does not inherit an earlier attempt's HTTP status; an owned deadline may supersede an HTTP response
whose body stalls. Fatal SSE inspection (invalid items, byte limits, or terminal provider error types)
cancels the provider and source promptly rather than waiting for EOF or relabelling the known failure
as timeout. A terminal provider failure also cancels promptly without awaiting an unfinished body
inspection or iterator closure, preserving any already observed safe failure. Local decoding/validation
failures are not classified as network read errors. A throwing
ownership callback/getter fails closed as source-free cancellation. Malformed/deep unsupported
checkpoint details return validation failure rather than escaping the hook into native fallback.
Successful compaction accepts `response.completed` and the built-in provider's `response.done`
alias, with absent (legacy) or `completed` status. Known unsuccessful terminal statuses and explicit
`response.incomplete` / `response.cancelled` events fail promptly, even without EOF. Other present
terminal statuses are invalid. Output-item and terminal-output copies are deduplicated, still requiring
exactly one bounded opaque item. CRLF delimiters are normalized to LF only on the successful SSE branch
consumed by the built-in provider, including fragmented CR/LF bytes; the inspector retains original
bytes and its 8 MiB limit. The normalized branch omits the original `content-length`. Non-success HTTP
bodies and existing retries are unchanged.

No extra model round, relaxed loadout equality, automatic checkpoint migration, or new retry is
introduced. Existing bounded provider retries are unchanged. These offline-proven protocol fixes do
not establish the cause of an unknown live failure.

Pi snapshots the compaction branch before running extension hooks sequentially. An earlier Goal
hook can then append plain `custom` records with exactly `customType: "goal-state"`. Preparation
allows only that bookkeeping tail: the complete original ID lineage must remain an exact prefix,
all appended IDs must be fresh, unique, nonempty strings with parents linking exactly from the
original tip, and the reported live leaf must equal the final branch ID. No Goal data is read.
This is not generic custom-record safety: unknown custom types (including `pi.virtual-model-state`),
custom messages, context edits, model/system changes, and other entries still invalidate preparation.
Session ownership, cancellation, consent, model routing, fresh tool evidence, exact wire validation,
and both prepared/latest canonical prompt and tool checks remain enforced, including after the
response. Offline regressions cover this ordering case, not proven recovery of a live session.

These diagnostics contain no error messages or causes, status text, bodies, headers, URLs,
credentials, checkpoint contents, history, or arbitrary provider-event text. No diagnostic journal,
debug log, new setting, or upload is added. They help scope a **next manually authorized retry**:
check authentication for credential failures, or establish a fresh unchanged ordinary request's
loadout evidence for a loadout mismatch. Only checkpoint incompatibility suggests the original
model; HTTP/authentication/loadout failures do not imply a model mismatch. The codes do not identify
an unknown live backend failure or claim to repair it. Confirming that failure requires a separately
authorized retry and observation of its safe code/status; installation and live requests are not
performed by repository tests.

## Settings

The extension has one optional, global-only JSON settings file:

```text
<getAgentDir()>/pi-codex-compact.json
```

The normal path is `~/.pi/agent/pi-codex-compact.json`. There is no environment-variable or
project-level override.

```json
{
  "enabled": true,
  "allowCanonicalHistory": false,
  "requestTimeoutMs": 300000,
  "maxRetries": 2,
  "replacementTokenBudget": 64000,
  "notifyOnFallback": true
}
```

| Setting | Default | Accepted values | Behavior | Recommendation |
| --- | ---: | --- | --- | --- |
| `enabled` | `true` | Boolean | Use remote compaction for compatible models and protect active opaque boundaries on all models. Turning it off explicitly permits Pi-native compaction outside both safety and consent gates. | Keep enabled to enforce the gate. |
| `allowCanonicalHistory` | `false` | Boolean | Explicit persistent authorization to send canonical history and permit native summary fallback when no opaque boundary is active. | Leave off unless you understand the privacy boundary below; toggle in this extension's Settings menu to opt in. |
| `requestTimeoutMs` | `300000` | Integer from 30,000 to 600,000 ms | Bound authentication, retries, and response-body inspection after authorization. | Keep five minutes; increase only for a consistently slow connection. |
| `maxRetries` | `2` | Integer from 0 to 2 | Retry transient provider transport failures before Pi fallback. | Keep two; use zero when diagnosing the first failure. |
| `replacementTokenBudget` | `64000` | Integer from 8,000 to 128,000 tokens | Bound approximate retained user-message text beside the opaque item. | Keep 64K; lower it to reduce session size or raise it only when recent user context is being lost. |
| `notifyOnFallback` | `true` | Boolean | Warn when Remote V2 fails and Pi-native compaction takes over. Does not suppress cancellation warnings protecting an active opaque checkpoint. | Keep enabled so silent fallback does not hide protocol or entitlement problems. |

Missing fields use defaults. Settings reload on every `session_start`, including `/reload`, resume,
and fork. Menu writes apply immediately, preserve unknown JSON fields, serialize within the current
Pi process, and use a final conflict check plus same-directory atomic rename. On Unix, temporary
files use mode `0600`.

Malformed, invalid, oversized, or symlinked settings files are never overwritten. Safe defaults stay
active, and the menu provides read-only repair guidance until the file is fixed and Pi is reloaded.
Separate Pi processes do not share a mutation lock; a detected concurrent edit is rejected so the
user can reopen Settings and retry.

### Relationship to Codex configuration

This extension does **not** read `~/.codex/config.toml`.

| Codex setting | Extension behavior |
| --- | --- |
| `features.remote_compaction_v2` | Conceptually corresponds to this extension's `enabled`; it is not imported. |
| `model_auto_compact_token_limit` | Not duplicated. Pi's own compaction threshold remains authoritative. |
| `model_auto_compact_token_limit_scope` | Not supported; Pi extensions do not own Codex's compact-window lineage. |
| `compact_prompt` / `experimental_compact_prompt_file` | Not used by Remote V2, whose opaque checkpoint is generated by the server. |
| `features.token_budget` | Not supported; token-budget context reset is a different experimental strategy. |

## Requirements and compatibility

- Pi APIs compatible with the package's declared peer dependencies.
- The built-in provider `openai-codex`.
- API `openai-codex-responses` on the active model.
- A working OpenAI Codex OAuth login and Remote V2 entitlement.

The repository's automated SDK regression baseline is **Pi 1.0.4**, matching the package's development
dependencies. **Pi 1.3.0 is a separate qualification lane**: an isolated loader check on that host does
not establish whole-host compatibility or repair an unknown live backend failure. Offline regression
results do not claim either. Live backend diagnosis requires a separately authorized retry.

OpenAI API-key, Azure, GitHub Copilot, and arbitrary Responses-compatible providers are not
supported. The built-in Codex provider's credential-resolved destination is honored together with
its API key, headers, and environment; a configured destination must implement the same Codex wire
contract. Compatibility with arbitrary proxies is not guaranteed. Switching to another provider or
model leaves Pi's visible fallback marker plus retained recent messages in ordinary request context;
those requests are not blocked. While enabled, this hook cancels compaction on that incompatible
active opaque boundary rather than replacing it with a native summary of the marker. Switching back
to the checkpoint's original compatible model restores opaque replay. No cross-model replay,
provider transfer, or automatic checkpoint migration is performed.

## How it works

1. Pi prepares compaction and selects the recent message suffix it will retain.
2. While enabled, the extension first cancels if the effective boundary is opaque and its checkpoint
   is malformed or incompatible with the active provider/API/model ID. Superseded opaque history
   does not activate this gate. It then captures session/branch ownership and requires canonical-history authorization,
   before resolving credentials. TUI confirmation is cancellable, expires after five minutes, and
   grants only this operation; persistent authorization is a separate explicit settings toggle.
   It then projects an earlier compatible checkpoint, if present, into the canonical Responses input.
3. It appends exactly one final `compaction_trigger` and sends a normal authenticated Codex Responses
   SSE request with cache retention disabled.
4. It requires a completed response containing exactly one non-empty opaque `compaction` item.
5. It constructs bounded replacement history from recent raw user-role Responses items followed by
   the opaque item.
6. It stores that history and fingerprints of Pi's retained suffix in versioned
   `CompactionEntry.details`.
7. On later compatible requests, it replaces an exactly validated marker with the persisted
   replacement history immediately before provider dispatch.

If fingerprints, model identity, payload shape, or marker count do not match exactly, the extension
leaves Pi's visible fallback context unchanged instead of guessing.

Loadout hooks can transform model-facing tool descriptions without changing the raw registry.
The extension recognizes those transformations only after fresh agent-context preparation and a
provider payload whose effective tool names and descriptions match the persisted declarations.
Supported wire declarations are the original top-level `tools` plus ordered, nonempty
`input` groups shaped as `{ type: "additional_tools", role: "developer", tools: [...] }`, including
Pi's native additive tool declarations. Names must be unique across all declarations; redefinitions,
missing/hidden tools, other group roles or fields, and tool-search updates (`tool_search_call` /
`tool_search_output`) are rejected. The raw recorded/registry membership and schema checks still apply.
It freezes both public tool surfaces and the original top-level tools plus ordered additive groups,
including schema, format, and strictness metadata; Remote V2 must reproduce that exact declaration
surface before sending. After successfully projecting a prior checkpoint, hosts exposing
`getCurrentSystemMessage` supply one resolved **canonical** system head for the remote request,
matching Pi's restoration after the ordinary checkpoint context hook. This avoids replaying historical
additive system entries in a different wire layout. First compaction and legacy hosts retain their
existing path; preflight and post-response guards still check the unmodified canonical transcript.
No request-local filter output is reused. Flattening, regrouping, or reordering declarations is not equivalent proof,
even with the same effective tool set. Ordinary input text, messages, and checkpoint content are not
retained or compared by this tracker. Cached provider callbacks cannot approve unsent registry edits,
and hidden declarations cause Pi-native fallback (or cancellation with an active opaque boundary)
rather than restoring hidden tools remotely. Evidence is
in-memory only and resets on startup, reload, or tree navigation. A fresh, unchanged normal request
can establish it again; prompt, tool, and schema changes remain guarded. For a loadout mismatch, a
user-authorized short ordinary request on the checkpoint's issuing compatible model, then manual
compaction without an intervening reload, can establish and reuse that evidence. This does not
bypass consent or equality checks and is not a fix for an unknown backend failure.

## Privacy, storage, and limits

Remote compaction sends Pi's **persisted canonical projection**, system instructions, and tool
schemas to the selected model's credential-resolved Codex destination. It honors durable
`context_edit` omissions/replacements; it does not send unprojected raw session entries.

This is **not** a snapshot of the final context sent in an ordinary model request. Pi 1.0.4 exposes
no such snapshot to extensions. Remote V2 does not invoke ordinary `context`,
`context_with_system`, or `before_provider_request` handlers. Pi 1.0.4's native summary also bypasses
ordinary context filters. Request-local privacy filters, hidden custom content, and historical
persisted workflow arming can therefore differ from ordinary model context. No generic text stripping can establish equivalent privacy. New request-local guidance
that is not persisted does not become canonical history, but existing persisted content remains.

Default `allowCanonicalHistory: false` requires a clear, one-operation TUI confirmation. No UI,
RPC, denial, cancellation, uncertain dialog result, or retired ownership returns cancellation:
**no credentials, remote request, checkpoint, or native summary fallback**. Native fallback alone
is not privacy-safe: Pi's native summary also consumes canonical history without these filters.
Malformed or provider/API/model-incompatible active opaque checkpoints cancel even before this
consent step, including on unsupported providers. After explicit authorization, remote failure may
use that native summary only if the effective compaction boundary is not opaque. An active opaque
checkpoint cancels instead: the native summary would contain only its portability warning and recent
messages, losing effective access to its older history. For checkpoint incompatibility, retry with
the checkpoint's original model; for other failures, use the safe reason code above to scope a
manually authorized retry. Alternatively, recover a pre-compaction branch and verify a readable
summary before migrating. An older opaque
record already superseded by a native boundary does not prevent fallback. Consent is never reused
for a changed session/branch. Disabling this extension's hook explicitly leaves native compaction
outside these gates. This is compaction safety, not universal request blocking or a privacy policy
for unsupported models or other extensions: ordinary mismatched requests still see only the fallback
marker and retained recent messages.

The session stores the opaque compaction item and bounded recent user-role Responses items,
including canonical content you authorized even if ordinary filters hid it. Replay can restore that
content after filters have run, including after reload. The authorization setting gates **new
compactions**, not replay of an existing checkpoint (including one created by an earlier version).
Opaque items cannot be inspected or selectively redacted. Authorization is not persisted in
checkpoint details. OAuth tokens, headers, environment secrets, and destination URLs are not
stored there. This extension's compaction-failure notifications use only the closed reason codes
and validated numeric HTTP status described above, never provider error details or causes. Manual
native-fallback failure notifications also remain fixed and source-free. Pi core and other extensions own their own
notifications and renderers; this package cannot sanitize those upstream messages.

| Boundary | Limit |
| --- | ---: |
| Observed SSE stream | 8 MiB |
| Serialized opaque compaction item | 2 MiB |
| Persisted replacement history | 8 MiB |
| Retained user text | 64K approximate tokens by default; configurable from 8K to 128K |
| Settings file | 64 KiB |
| Transport retries | At most 2 |
| Request timeout | At most 10 minutes |

An individually oversized media item is dropped rather than making the session entry unbounded. The
oldest fitting text item may be partially truncated to preserve newer context. These hard byte
ceilings are intentionally not configurable.

## Experimental limitations

- The wire contract is undocumented and can change independently of Pi or this package.
- Full older history depends on this extension and the same compatible model. Removing the extension
  exposes only the portability fallback marker and Pi-retained recent messages.
- The package does not reproduce Codex core's context-window UUID/number lineage, previous-model
  compatibility fallback, exact pre-turn ordering, or exact mid-turn model-session ownership.
- A live prompt or tool change that has not been written into Pi's transcript causes native
  fallback only without an active opaque boundary; otherwise compaction cancels. An opaque
  checkpoint must match the system state Pi will persist.
- Pi exposes no public effective-loadout snapshot. Observed, unchanged description-only rewrites
  (including codemode `mode: "on"`) can use Remote V2, but unproven transformations, hidden declarations
  (including codemode `mode: "only"`), membership/schema mismatches, unsupported tool-update shapes,
  or different serialized declaration surfaces use native compaction only without an active opaque
  boundary; otherwise they cancel. Observation
  does not weaken prompt/tool equality or stale-state checks.
- Pi invokes `session_before_compact` handlers in registration order. Another extension that mutates
  prompt, tools, or context **after this handler returns** can invalidate an already prepared opaque
  checkpoint before Pi appends it. Load such handlers before this extension or disable Remote V2 in
  that combination; the extension cannot inspect later handlers' changes.
- Only **authorized** remote failure without an effective opaque boundary falls back to Pi's
  plaintext summary. Raw history may still contain both entry kinds, but automatic fallback never
  supersedes an active opaque checkpoint. Both paths use canonical history, not a guaranteed
  filter-safe current-model projection.
- Request-local payload hooks such as priority service-tier selection are not dispatched for Remote
  V2. Ordinary and replay requests still compose those hooks in registration order. Remote V2 uses
  provider defaults, not necessarily an ordinary request's selected tier.
- Settings concurrency is coordinated only within one Pi process; separate processes rely on the
  final conflict check.

## Package layout

```text
src/index.ts          Thin Pi entrypoint
src/codex-compact.ts  Pi lifecycle, command, provider projection, and fallback
src/authorization.ts Cancellable, operation-owned canonical-history consent
src/tool-state.ts     Prepared/observed public tool surfaces and frozen wire evidence
src/remote.ts         Provider stream invocation, auth payload, timeout, and retry controls
src/failure.ts        Closed source-free reason codes and validated HTTP status
src/protocol.ts       Bounded SSE parsing and Remote V2 payload/output validation
src/checkpoint.ts     Replacement history, fingerprints, persistence, and replay projection
src/settings.ts       Global settings validation and atomic persistence
src/settings-menu.ts  Manual compaction and settings TUI

test/                 Protocol, checkpoint, lifecycle, remote, settings, and menu coverage
```

## Development

From the repository root:

```bash
npm --workspace @signalridge/pi-codex-compact run check
npm test
just pack codex-compact
```

The checkpoint and remote protocol boundaries are documented in `src/checkpoint.ts` and `src/remote.ts`.

## License

[MIT](LICENSE)
