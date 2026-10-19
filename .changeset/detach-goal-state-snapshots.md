---
"@signalridge/pi-goal": patch
---

Detach serialized Goal state from mutable runtime objects before appending native session metadata. Goal accounting, status, safety counters, queued objectives, wait records, and pending queue actions must not retroactively modify earlier session entries through shared references. This prevents false ancestry and ownership failures in observers such as Todo without relaxing their integrity checks, changing persisted shapes, resetting budgets, or automatically resuming stopped work. Already affected in-memory sessions should be safely closed and resumed from persisted history after updating; reloading extension code alone does not reconstruct old native entries.
