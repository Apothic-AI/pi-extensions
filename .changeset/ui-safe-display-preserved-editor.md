---
"@signalridge/pi-ui": minor
---

Add the pure `sanitizeDisplayText` display-copy helper and opt-in `withPreservedCustomEditor` context adapter. Neutralize untrusted terminal/bidi controls before styling, and preserve editor writes across custom UI draft restoration without overwriting observable later destination writers. Document the public API's cancellation, pending-work, text-equality, and session-retirement limitations.
