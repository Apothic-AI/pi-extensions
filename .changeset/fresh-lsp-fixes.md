---
"@signalridge/pi-lsp": patch
---

Revalidate workspace containment, file identity, and snapshot bytes before writing LSP fixes so external saves, replacements, and escaping symlink retargets detected during code-action computation are preserved. Keep native mutation-queue serialization and document the remaining external-writer race.
