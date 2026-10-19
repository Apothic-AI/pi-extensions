---
"@signalridge/pi-subagents": patch
---

Retain worktree contents and Git registration when preservation fails, verify directory removal and deregistration before reporting cleanup success, and replace destructive recovery advice with inspection and save guidance. Report the preservation branch if removal is refused. Preserve missing-checkout registrations for detached HEAD, reflog, and index recovery, using metadata-only Git recovery locks across shutdown, reload, and later pruning, including when execution or descendant pins prevent checkout cleanup. Preserve existing locks, report lock failures, and defer all global orphan pruning while any worktree cleanup remains unresolved. Quote recovery paths literally so shell metacharacters cannot execute.
