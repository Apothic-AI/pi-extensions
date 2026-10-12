---
"@signalridge/pi-herdr-state": patch
---

Fence queued and polled state reports against invalidated SDK contexts and stop all timers owned by a retired session before publication. Carry ownership through default socket connects, writes and retries, destroying retired sockets and keeping quit release separately scoped. Check live TUI eligibility for report and independent quit-release owners before socket writes or retries, even while an earlier session handler is awaited.
