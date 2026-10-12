---
"@signalridge/pi-code-actions": patch
---

Own snippet subprocess trees through bounded cleanup on session retirement and normal completion. Retain a POSIX process-group supervisor through TERM/KILL escalation, use best-effort Windows taskkill tree cleanup, and document full-shell policy boundaries. Use Node on PATH for Bun/compiled-Bun hosts rather than evaluating the embedded Pi executable, report the Node prerequisite on launch failure, and bound supervisor readiness to 5 seconds without limiting snippet runtime or filtering inherited security options. Missing readiness or disconnected IPC fails the run and cleans up the owned supervisor. Capture stdout and stderr independently at 64 KiB per stream (128 KiB combined), keep draining after overflow, preserve independent UTF-8 decoding, and report per-stream truncation/loss only when output exceeds the capture limit.
