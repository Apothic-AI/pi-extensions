---
"@signalridge/pi-ask-user-question": patch
---

Keep Other answers and option payloads separate from sanitized display copies while respecting native editor submit transformations. Reject oversized responses explicitly, and settle host-completion and overflow-notification failures as structured UI errors while retaining collected answers and distinguishing cancellation/abort.
