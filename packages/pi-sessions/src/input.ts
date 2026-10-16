import { decodeKittyPrintable } from "@earendil-works/pi-tui";
import { plain } from "./text.js";

const START = "\x1b[200~";
const END = "\x1b[201~";
type Input = { kind: "key" | "paste"; data: string };

/** Sanitize text BEFORE native insertion: repairing an editor afterward moves
 * its cursor and pollutes native Undo. Keep bracketed paste atomic, even when
 * markers/escape sequences arrive in pieces. Never interpret pasted keys.
 * Only ambiguous start-marker prefixes need a short escape-key timeout. */
export class SafeInput {
  private prefix = "";
  private paste: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly dispatch: (input: Input) => void) {}

  handleInput(data: string): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    let pending = this.prefix + data;
    this.prefix = "";
    while (pending) {
      if (this.paste !== undefined) {
        this.paste += pending;
        const end = this.paste.indexOf(END);
        if (end < 0) return;
        // Normalize like the native Editor before stripping controls. Input
        // still applies its own single-line normalization to this safe paste.
        const text = plain(this.paste.slice(0, end).replace(/\r\n?/gu, "\n").replace(/\t/gu, "    "));
        pending = this.paste.slice(end + END.length);
        this.paste = undefined;
        if (text) this.dispatch({ kind: "paste", data: `${START}${text}${END}` });
        continue;
      }
      const start = pending.indexOf(START);
      if (start >= 0) {
        this.key(pending.slice(0, start));
        pending = pending.slice(start + START.length);
        this.paste = "";
        continue;
      }
      let prefixLength = Math.min(pending.length, START.length - 1);
      while (prefixLength && !START.startsWith(pending.slice(-prefixLength))) prefixLength--;
      this.key(pending.slice(0, pending.length - prefixLength));
      if (prefixLength) {
        this.prefix = pending.slice(-prefixLength);
        this.timer = setTimeout(() => {
          const key = this.prefix;
          this.prefix = "";
          this.timer = undefined;
          this.key(key);
        }, 30);
        this.timer.unref();
      }
      return;
    }
  }

  private key(data: string): void {
    if (!data) return;
    // Pi 1.0.4 publicly exports its Kitty decoder. For modifyOtherKeys, inspect
    // only codepoint safety; leave all decoding/key semantics to the native UI.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal key protocol
    const modified = /^\x1b\[27;\d+;(\d+)~$/u.exec(data);
    const codepoint = modified ? Number(modified[1]) : -1;
    const printable =
      decodeKittyPrintable(data) ??
      (codepoint >= 32 && codepoint <= 0x10ffff ? String.fromCodePoint(codepoint) : undefined);
    if (printable !== undefined) {
      // Preserve the original key sequence and native keybinding precedence,
      // while rejecting unsafe encoded printable characters before decoding.
      if (printable === "\x7f" || plain(printable) === printable) this.dispatch({ kind: "key", data });
    } else {
      // C0/escape keys belong to native key parsing, not text sanitization.
      // Ordinary Unicode/IME text is cleaned without changing native cursors.
      const text = data.charCodeAt(0) < 32 || data.charCodeAt(0) === 127 ? data : plain(data);
      if (text) this.dispatch({ kind: "key", data: text });
    }
  }
}
