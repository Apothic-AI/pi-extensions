---
"@signalridge/pi-worktree": patch
---

Bound stdin Git cancellation and timeout cleanup with owned TERM-to-KILL escalation and a final confirmation deadline. Retain every concurrent unconfirmed handle per cwd/argv key and refuse equivalent replacements while any failed owner remains live; one late exit cannot release another owner's lease. Release retained handle leases on late actual exit without requiring a retry, and preserve captured output and signal-failure diagnostics through GitWorktreeError wrapping.
