---
"@signalridge/pi-statusline": patch
---

Retire captured footer timers, subscriptions and pending refreshes when SDK disposal invalidates their context, without touching replacement UI or allowing a cleanup fault to strand resources. Check live mode/UI eligibility in retained callbacks and retire outgoing ownership before the extension's headless session handler runs and suppress ambient status and settings notifications outside TUI mode even with retained UI transports.
