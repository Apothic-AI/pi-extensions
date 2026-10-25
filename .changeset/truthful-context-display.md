---
"@signalridge/pi-statusline": patch
---

Show unknown context usage after failed/aborted assistant responses and failed/cancelled or completed compaction until a fresh successful current-route response establishes provider usage. Admit assistant streams independently of repeated timestamps or late response IDs, persist only minimal display-confidence metadata for owned failed compactions, and rebuild it in active-branch order. Reject stale owners using incremental parent-link ancestry checks without altering Pi's token estimator or compaction behavior.
