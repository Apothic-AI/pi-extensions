---
"@signalridge/pi-lsp": patch
---

Match diagnostics and waiters across equivalent file URL encodings, including Windows drive casing, without changing non-file URI identity. Cancel and drain complete session-owned diagnostics and fix invocations during shutdown/replacement, prevent cancelled continuations and queued writes, and guard stale status contexts while preserving client leases and mutation freshness checks.
