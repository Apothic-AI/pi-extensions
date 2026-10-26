---
"@signalridge/pi-codex-compact": minor
---

Add an explicit, cancellable TUI recovery-export action under `/codex-compact`. A validated canonical prefix can be compacted once with no retries and exported into a fresh session with the complete unsent suffix, leaving the source unchanged. Copied historical assistant/tool-result usage and cost are zeroed; only the recovery call is recorded in the new checkpoint. Enforce canonical consent, loadout and ownership gates, closed tool pairs, native replay validation, and fsynced no-replace publication. No automatic send, switch, backend-fit guarantee, or migration promise.
