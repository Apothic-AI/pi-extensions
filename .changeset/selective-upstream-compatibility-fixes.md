---
"@signalridge/pi-statusline": patch
"@signalridge/pi-github-pr": patch
"@signalridge/pi-stamp": patch
"@signalridge/pi-input-history": patch
"@signalridge/pi-btw": patch
---

Selectively port upstream compatibility fixes while retaining local safety behavior:

- Honor live terminal color and hyperlink capabilities, and keep plain PR references inline without duplication.
- Bound timestamp formatter reuse and refresh resolved system locale/time-zone defaults after environment changes.
- Embed native working status only in the history extension's fallback editor.
- Give each side thread an independent provider session identity that survives in-memory follow-ups and resume.
