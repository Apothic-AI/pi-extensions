---
"@signalridge/pi-codex-compact": patch
---

Fix offline-reproduced remote compaction protocol mismatches: normalize fragmented CRLF delimiters only on the successful provider-consumed SSE branch while inspecting original bounded bytes, accept the response.done completion alias, and reject unsuccessful terminal statuses and explicit incomplete events promptly with source cancellation. Preserve exactly-one bounded opaque item validation, abort ownership, deadlines, and existing retries.

Recognize only the exact structured context_window_exceeded / context_length_exceeded wire codes in allowed error-event positions as the fixed remote_context_window_exceeded diagnostic. Unknown codes and arbitrary error text remain generic and private; this adds observability, not overflow recovery.

After validated prior-checkpoint projection, reproduce Pi's resolved canonical system head when the public API is available so later additive tool declarations retain the ordinary request's exact wire layout. Preserve original canonical transcript guards, first-compaction and legacy behavior, and frozen wire validation.

These fixes are demonstrated by offline fixtures and do not establish the cause of an unknown live incident. No extra model round, new retry, checkpoint migration, or relaxed consent/loadout guard is introduced.
