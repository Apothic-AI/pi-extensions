# Upstream and portfolio review — 2026-10-23

## Scope and method

Reviewed the repository at `4d64929f678500db6b6f485d018cfd06e56fe075`:
34 packages, 31 extensions and three resource-free libraries. Findings concern
repository capabilities, not the enabled resources of any particular installation.

Default-branch refs were resolved through GitHub's API, then relevant pinned
source and commit patches were compared with local implementations. A newer
repository commit, a larger package version or an npm release alone was not
counted as a missing feature. These are selectively maintained implementations,
not mirrors; many fixes already exist under different local modules/tests.

### Checked upstream refs

| Source | Checked commit | Relationship |
| --- | --- | --- |
| [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents) | [`ca93a524`](https://github.com/tintinweb/pi-subagents/commit/ca93a5247e72e7053fcd10bea7125d6c4205f949) | Subagents fork; latest release v0.22.0 has additional commits after its tag. |
| [narumiruna/pi-extensions](https://github.com/narumiruna/pi-extensions) | [`942d52df`](https://github.com/narumiruna/pi-extensions/commit/942d52df32e848817255acf08d77d6d265602dae) | Multiple locally maintained packages; implementation comparison used `ecf221ec`. |
| [tmustier/pi-extensions](https://github.com/tmustier/pi-extensions) | [`2db3b417`](https://github.com/tmustier/pi-extensions/commit/2db3b4171e9d1eb88338036688857c2589d5032d) | Recap, Ralph and developer/UI tools; the reviewed paths last changed at `4a63a2e`. |
| [ouzhenkun/pi-input-history](https://github.com/ouzhenkun/pi-input-history) | [`b183aacb`](https://github.com/ouzhenkun/pi-input-history/commit/b183aacb231734c02bb34009c5972178ee79b844) | Input-history fork, upstream v1.1.3. |
| [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents) | [`1bc94136`](https://github.com/nicobailon/pi-subagents/commit/1bc941363cb62fc23c94c5519364b03dc150be3e) | Design/performance reference, not a replacement runtime. |
| [aliou/pi-processes](https://github.com/aliou/pi-processes) | [`434fa0a8`](https://github.com/aliou/pi-processes/commit/434fa0a860b1fa4fe9fccdc986964d865ef98e47) | Independent process-management reference. |
| [99percentpeople/pi-extensions](https://github.com/99percentpeople/pi-extensions) | [`a7ae6b89`](https://github.com/99percentpeople/pi-extensions/commit/a7ae6b89a211c35b657e886e9ceeafbf51616c22) | Background-task design reference; relevant path last changed at `7819191`. |
| [fl4p/pi-extensions](https://github.com/fl4p/pi-extensions) | [`d2ae801f`](https://github.com/fl4p/pi-extensions/commit/d2ae801f8448c1ea2b3b65808f232d8c734f99f6) | Background-shell design reference; relevant path last changed at `4bbe64a`. |
| [tomsej/pi-ext](https://github.com/tomsej/pi-ext) | [`e132c44b`](https://github.com/tomsej/pi-ext/commit/e132c44b3b06f88f7fcfb67b80c91698d8c1814f) | Worktime reference; worktime unchanged since `204182c`. |

A final ref recheck found narumiruna had advanced from `ecf221ec` to
`942d52df`. The intervening functional commit
[`63357c6`](https://github.com/narumiruna/pi-extensions/commit/63357c6f91649aa3c513d393e5f8df58096be927)
only renames the deferred image-generation slash command to `/codex-imagegen`;
it does not change the selected ports. The other three primary fork refs were
unchanged.

The tested host remains **Pi 1.0.4**. Pi's latest release at review time was
[1.4.0](https://github.com/earendil-works/pi/releases/tag/v1.4.0). Some upstream
packages now develop against newer hosts; this review does not silently upgrade
host dependencies or claim complete acceptance on those versions.

## Selected changes

Prioritize correctness, terminal compatibility and bounded implementation over
another settings or execution framework:

| Package(s) | Selected adaptation | Upstream reference |
| --- | --- | --- |
| Subagents | Honor definition isolation in ordinary RPC/registry execution, preserve explicit `off`; enforce model scope on the final untiered model; snapshot delayed completion notifications. | [`fc1ddb3`](https://github.com/tintinweb/pi-subagents/commit/fc1ddb3f0bb289232fd531607b7cbe4c7e4c5f6f), [`bb7d208`](https://github.com/tintinweb/pi-subagents/commit/bb7d2082235a61169c30d6e05de370cba95da62d), [`084d177`](https://github.com/tintinweb/pi-subagents/commit/084d177cfa71a9ce75da5dc69c505b4adbef32b4), [`2f8dd3a`](https://github.com/tintinweb/pi-subagents/commit/2f8dd3a3a16fcbad7a5105cbfacb1b722fe04c24) |
| Statusline + GitHub PR | Respect effective truecolor/hyperlink capabilities; keep plain PR references inline without duplicate status. | [`36a5ad5`](https://github.com/narumiruna/pi-extensions/commit/36a5ad5149d890b03803c9fa971b875656dcf4e4) |
| Stamp | Bound formatter reuse without replacing persisted timestamp schemas. | [`bae6fea`](https://github.com/narumiruna/pi-extensions/commit/bae6fea402b26006e9daaac3799f29274dd77bcd), [`0b1e77d`](https://github.com/narumiruna/pi-extensions/commit/0b1e77d2ce972c2fcefde142020be48fb43e4eb6) |
| Input History | Enable native embedded working-status layout only for its fallback editor; preserve inherited factories. | [`5824bd6`](https://github.com/ouzhenkun/pi-input-history/commit/5824bd6ff04de6545e02acd8537fd869aa9f16a6) |
| BTW | Give each side thread its own stable provider routing identity, not the parent identity. | [`81be3f7`](https://github.com/narumiruna/pi-extensions/commit/81be3f7250b26bfd4d51ab20d193b5edae70e688) |
| LSP | Normalize document URI keys and cancel/drain session-owned invocations across routes on retirement. | [`c23e604`](https://github.com/narumiruna/pi-extensions/commit/c23e6047759f6eb628eccf7395cac97a1fa4d47e), [`756e1e2`](https://github.com/narumiruna/pi-extensions/commit/756e1e2939eaf149fb4568a505117c3a8fbdf707) |
| Workflows | Delay terminal publication until its exact journal append succeeds; recheck soft budgets at actual dispatch and retries. | Locally reproduced audit findings, not upstream replacement code. |

### Already present: no second port

- Subagents resume budget/cancellation and shutdown parity through upstream
  `ca93a52`, custom-editor focus handling and builtin extension capability checks.
- Input History's `77be6f4` repaint fix.
- Session Recap's projected-context and settlement behavior through v0.5.1
  (`4a63a2e`); no newer relevant upstream production change was established.
- LSP's session-relative workspace roots (`df7c88e`).
- Worktree's Windows cwd normalization (`7f56adf`), PR's nonblocking startup
  (`71179ed`), Analytics' rotation/deadline corrections, and Goal's clock repair.
- Usage's context-edit accounting and files-widget viewer adaptations from
  tmustier `4a63a2e`. Local ancestry/reconciliation and process cleanup must not
  be overwritten by older upstream implementations.
- Worktime has no upstream path delta; accepted-user-message reset remains the
  intentional local behavior.

## New capabilities investigated, not added

No new extension is included in this release. New capabilities must justify
another runtime owner and its maintenance rather than merely increase the
catalogue size.

| Candidate / checked ref | Decision |
| --- | --- |
| [pi-notify at `ecf221e`](https://github.com/narumiruna/pi-extensions/tree/ecf221ec37952c882d23f2807be01d449bc7154f/packages/pi-notify) | Deferred. External settlement alerts are distinct from footer/title state, but another notification integration is outside this release's scope. No notification package, command or flag is added. |
| [pi-web-access `d0e323a`](https://github.com/nicobailon/pi-web-access/commit/d0e323ac935e8753d11e1853b81c057e39dee4dc), npm 0.44.0 | Useful external research capability, not a reason to maintain another fork. Do not register a second copy where already available. |
| [pi-agent-browser-native `f7db559`](https://github.com/fitchmultz/pi-agent-browser-native/commit/f7db559927b155f2cba7b6aa88afd0ec61b0168b), npm 0.9.6 | Prefer an existing browser CLI/skill until native integration earns its process/profile/approval maintenance. Main was ahead of the published package; do not attribute unpublished behavior to npm. |
| [pi-diff-review `cb71cf2`](https://github.com/cmpadden/pi-diff-review/commit/cb71cf22ca139b020a66ce2034cf842394b161fe), npm 0.1.29 | Real human hunk-review capability, but Files Widget already owns file/diff comments. Evaluate as an explicit replacement/extension of that interaction, not another browser. Requires async bounded Git and draft-only export before admission. |
| [pi-interactive-shell `04fb78e`](https://github.com/nicobailon/pi-interactive-shell/commit/04fb78eba3001dd8d4b2bae442241055295ce7c7), npm 0.17.1 | PTY takeover is distinct, but native binaries, terminal controls, process cleanup and permission semantics need separate qualification. License text was absent from checked tree/tarball despite an MIT manifest. No copying. |
| [pi-sandbox `1391cdf`](https://github.com/carderne/pi-sandbox/commit/1391cdfac55f989116d8a26b8924906e017974f1), npm 0.7.2 | Defer: declared host range excludes 1.0.4; startup failure can fall back to ordinary bash. Not fail-closed whole-process isolation and conflicts with certified native backends. |
| narumiruna cache-hit-monitor / inspect / tool catalogue | Potential opt-in diagnostics, not routine requirements. Cache totals, tool counts and active-tool lists already have owners. Add only for a demonstrated debugging need. |
| narumiruna AgentFS / Codex image generation | Do not add: replacement native backends change approval assumptions; private image endpoints have unverified account access/cancellation and quota implications. |

## Deferred changes and known audit limits

The following were not silently treated as routine sync fixes:

- Goal/Plan's persistent conversation-contract redesign and admission protocol:
  potentially useful cache-prefix stability, but it changes publication,
  compaction and controller state machines. Requires a dedicated acceptance run.
- Recall preview search requires qualifying a shared Kit upgrade; configurable
  History shortcuts, richer Stamp timings and Statusline dialog activity are
  useful follow-ups, not reasons for a whole-package replacement.
- Opaque Codex checkpoint cross-model replay/plaintext transfer changes privacy,
  network and portability obligations. Retain consent and issuer checks.
- Do not port ignored-file deletion, lossy checkpoint fallback, automatic parent
  history sharing, a second model/tier catalogue, or a competing background owner.
- Files Widget deferred browser loading is a startup optimization with a new
  async ownership boundary; no measured startup benefit was established here.

Source review also identified follow-up risks outside the selected ports:
Usage's asynchronous dashboard opening needs stronger session/UI fencing;
BTW alternate-screen focus-reporting teardown can interfere with automatic
Recap focus observation; Tab Status commit detection remains a shell-command
heuristic rather than proof that a commit was created. They are not evidence
that those packages are interchangeable, nor are they fixed merely by passing
existing tests.

Goal and Ralph can both be active; documentation recommends one controller but
that is not a global mutual-exclusion mechanism. Plan tool selection is not a
universal execution policy, and replayable Workflow checkpoints are not operation
approvals. Keep strict planning loadouts narrow.

See [extension portfolio](extension-portfolio.md) for every package's concrete
value and when native functionality or an existing CLI is enough.

## Validation

The notification-free release gate is `bun run check` across all 34 packages:
configuration/boundary/version/Changeset/capability checks, lint, typecheck,
package and integration tests, release/configuration tests, loader smoke,
tarball validation and secret scanning. Loader smoke checks all 31 extension
tarballs independently, the Subagents/Workflows pair, and the 24 stable
extensions together. The portfolio table covers all 34 packages. Pending
Changesets name only the eight changed existing extensions.

Independent follow-up review checked the repaired branch-local isolation,
attempt-specific grouping and terminal-receipt cancellation paths.

This acceptance does not establish live providers, physical desktop display,
browser profiles, every terminal or every language server. Releases,
installation updates and activation remain separate operations; this review
performs none of them.
