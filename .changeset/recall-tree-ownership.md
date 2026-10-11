---
"@signalridge/pi-recall": patch
---

Invalidate pending Recall interactions after committed session tree navigation, checking live branch ownership before callback mutations and canonical storage publication even when an earlier tree handler delays event delivery. Ordinary branch appends and cancelled navigation remain usable; delayed stale selections cannot save retired-branch messages or replace the current draft with a stale quote. Guard canonical permission repair during load/save/delete after awaited file inspection, and avoid a redundant pathname chmod after atomic replacement. Strictly decode UTF-8 and validate complete JSONL before permission repair so invalid canonical bytes and modes remain unchanged. Use the shared custom-editor adapter to preserve observable pre-completion destination writes without replaying over later writers.
