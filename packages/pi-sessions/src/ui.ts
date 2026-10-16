import type { ExtensionContext, KeybindingsManager, SessionInfo, Theme } from "@earendil-works/pi-coding-agent";
import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  CURSOR_MARKER,
  Editor,
  type Focusable,
  getKeybindings,
  Input,
  Key,
  matchesKey,
  type OverlayHandle,
  sliceByColumn,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { SafeInput } from "./input.js";
import type { Owner } from "./ownership.js";
import { label, plain, ROW_LIMIT, redact } from "./text.js";

type Surface = { tui: TUI; theme: Theme; keys: KeybindingsManager };
export type SessionRow = Pick<SessionInfo, "id" | "path" | "cwd" | "name" | "messageCount"> & { modified: string };
export function rowsFrom(sessions: readonly SessionInfo[]): SessionRow[] {
  return sessions
    .filter((s) => s.id.length <= 4096 && s.path.length <= 8192 && s.cwd.length <= 8192)
    .slice(0, ROW_LIMIT)
    .map((s) => ({
      id: s.id,
      path: s.path,
      cwd: s.cwd,
      name: label(redact(s.name ?? s.firstMessage)),
      messageCount: s.messageCount,
      modified: s.modified.toISOString(),
    }));
}
export function rowKey(row: Pick<SessionRow, "id" | "path">): string {
  return `${row.id}\0${row.path}`;
}

/** Renderer output only: inputs must be plain BEFORE entering native components.
 * Keep just native software-cursor inverse/reset and the IME position marker,
 * never arbitrary SGR, OSC, erase or cursor-motion instructions. */
export function safeLines(lines: string[], width: number): string[] {
  const columns = Math.max(1, width);
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return lines
    .flatMap((line) => line.split("\n"))
    .map((line) => {
      const safe = line
        // biome-ignore lint/suspicious/noControlCharactersInRegex: exact renderer-owned SGR and public IME marker allowlist
        .split(/(\x1b\[(?:0|7|27)m|\x1b_pi:c\x07)/u)
        .map((part, i) => {
          if (i % 2) return part;
          // A terminal cannot display a two-column glyph in one column. Substitute
          // only the rendered glyph, never the underlying editable value.
          return [...segmenter.segment(plain(part))]
            .map(({ segment }) => (visibleWidth(segment) > columns ? "?" : segment))
            .join("");
        })
        .join("");
      const marker = safe.indexOf(CURSOR_MARKER);
      if (marker < 0) return truncateToWidth(safe, columns, "");
      const before = safe.slice(0, marker);
      const after = safe.slice(marker + CURSOR_MARKER.length);
      // Keep the insertion cell in bounds, including at width=1 and at EOL.
      const start = Math.max(0, visibleWidth(before) - columns + 1);
      const left = sliceByColumn(before, start, columns - 1, true);
      return left + CURSOR_MARKER + truncateToWidth(after, columns - visibleWidth(left), "");
    });
}

function help(text: string, width: number): string[] {
  return wrapTextWithAnsi(plain(text), Math.max(1, width));
}

function resizeNotice(width: number, rows: number): string[] {
  return safeLines(["Resize to review; Enter disabled", "Esc cancel"].slice(0, Math.max(1, rows)), width);
}

class SafeComponent implements Component, Focusable {
  constructor(private readonly child: Component & Partial<Focusable>) {}
  get focused(): boolean {
    return this.child.focused ?? false;
  }
  set focused(value: boolean) {
    this.child.focused = value;
  }
  render(width: number): string[] {
    return safeLines(this.child.render(Math.max(1, width)), width);
  }
  handleInput(data: string): void {
    this.child.handleInput?.(data);
  }
  invalidate(): void {
    this.child.invalidate();
  }
}

/** Never mount a native custom dialog. In Pi 1.0.4 native completion pops the
 * top overlay (possibly foreign), or restores an old main-editor draft.
 * Complete the public factory synchronously to acquire its public TUI, then
 * use only manually owned OverlayHandles. No host fields are read or patched. */
async function surface(owner: Owner<ExtensionContext>): Promise<Surface> {
  return owner.wait(
    owner.ctx.ui.custom<Surface>(
      (tui, theme, keys, done) => {
        // Native done() pops the current top overlay even before it mounts its
        // component. Supply a synchronous, noncapturing sentinel so this cannot
        // pop a pre-existing foreign overlay. No asynchronous gap is permitted.
        const sentinel = { render: () => [], invalidate() {} };
        tui.showOverlay(sentinel, { nonCapturing: true });
        done({ tui, theme, keys });
        return sentinel;
      },
      { overlay: true },
    ),
  );
}

async function modal<T>(
  owner: Owner<ExtensionContext>,
  build: (s: Surface, done: (result: T | undefined) => void) => Component & Partial<Focusable>,
): Promise<T | undefined> {
  const s = await surface(owner);
  owner.check();
  let handle: OverlayHandle | undefined;
  let abort!: () => void;
  return new Promise<T | undefined>((resolve) => {
    let closed = false;
    const close = (result: T | undefined) => {
      if (closed) return;
      closed = true;
      owner.signal.removeEventListener("abort", abort);
      handle?.hide(); // This overlay belongs to us, not to ui.custom().
      resolve(result);
    };
    abort = () => close(undefined);
    owner.signal.addEventListener("abort", abort, { once: true });
    const component = new SafeComponent(build(s, close));
    // Full-terminal bounds make terminal.rows the actual overlay row budget.
    // Each component reserves its own controls before laying out content.
    if (!closed) handle = s.tui.showOverlay(component, { width: "100%", maxHeight: "100%", anchor: "top-left" });
  });
}

class Choice implements Component, Focusable {
  focused = false;
  private selected = 0;
  private scroll = 0;
  private pageSize = 8;
  private lastLineCount = 0;
  private ready = true;
  constructor(
    private readonly title: string,
    private readonly options: string[],
    private readonly done: (value: string | undefined) => void,
    private readonly renderAgain: () => void,
    private readonly terminalRows: () => number,
    private readonly terminalColumns: () => number,
  ) {}
  invalidate(): void {}
  render(width: number): string[] {
    const controls = help("Enter accept · Esc cancel\n↑↓ choose · PgUp/PgDn scroll", width);
    const rows = Math.max(1, this.terminalRows());
    const available = rows - this.options.length - controls.length;
    this.pageSize = Math.max(1, available);
    this.ready = width >= 12 && available >= 1;
    if (!this.ready) return resizeNotice(width, rows);
    const wrapped = wrapTextWithAnsi(plain(this.title), Math.max(1, width));
    this.lastLineCount = wrapped.length;
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, wrapped.length - this.pageSize)));
    return safeLines(
      [
        ...wrapped.slice(this.scroll, this.scroll + this.pageSize),
        ...this.options.map((s, i) => `${i === this.selected ? ">" : " "} ${plain(s)}`),
        ...controls,
      ],
      width,
    );
  }
  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) this.done(undefined);
    else if (matchesKey(data, Key.enter)) {
      this.render(this.terminalColumns()); // resize may precede the scheduled host render
      if (this.ready) this.done(this.options[this.selected]);
    } else if (matchesKey(data, Key.up))
      this.selected = (this.selected + this.options.length - 1) % this.options.length;
    else if (matchesKey(data, Key.down)) this.selected = (this.selected + 1) % this.options.length;
    else if (matchesKey(data, Key.pageUp)) this.scroll = Math.max(0, this.scroll - this.pageSize);
    else if (matchesKey(data, Key.pageDown))
      this.scroll = Math.min(Math.max(0, this.lastLineCount - this.pageSize), this.scroll + this.pageSize);
    this.renderAgain();
  }
}

export class Picker implements Component, Focusable {
  private readonly input = new Input({ prompt: "" });
  private readonly safeInput = new SafeInput(({ kind, data }) => this.handleSafeInput(data, kind === "paste"));
  private ready = true;
  private lastWidth = 80;
  private rows: SessionRow[] = [];
  private selectedKey: string | undefined;
  private progress = "Loading sessions… Escape cancels";
  private _focused = false;
  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }
  constructor(
    private readonly done: (row: SessionRow | undefined) => void,
    private readonly renderAgain: () => void,
    private readonly terminalRows: () => number = () => 24,
    private readonly terminalColumns: () => number = () => this.lastWidth,
  ) {}
  invalidate(): void {
    this.input.invalidate();
  }
  update(rows: SessionRow[], loaded: number, total: number, complete = false): void {
    this.rows = rows;
    this.progress = `${complete ? "Ready" : "Loading"}: ${loaded}/${total}; showing at most ${ROW_LIMIT}`;
    if (!this.rows.some((row) => rowKey(row) === this.selectedKey))
      this.selectedKey = this.filtered()[0] && rowKey(this.filtered()[0]);
    this.renderAgain();
  }
  private filtered(): SessionRow[] {
    const query = plain(this.input.getValue()).toLocaleLowerCase();
    return this.rows.filter((row) => `${row.name} ${row.id} ${row.cwd}`.toLocaleLowerCase().includes(query));
  }
  render(width: number): string[] {
    this.lastWidth = width;
    const filtered = this.filtered();
    const index = Math.max(
      0,
      filtered.findIndex((r) => rowKey(r) === this.selectedKey),
    );
    const controls = help("Enter preview · Esc cancel\nType filter · ↑↓ select", width);
    const rows = Math.max(1, this.terminalRows());
    const pageSize = rows - 3 - controls.length;
    this.ready = width >= 12 && pageSize >= 1;
    if (!this.ready) return resizeNotice(width, rows);
    const start = Math.max(0, Math.min(index - Math.floor(pageSize / 2), filtered.length - pageSize));
    return safeLines(
      [
        "Sessions (history and workspace metadata only)",
        this.progress,
        ...this.input.render(Math.max(1, width)),
        ...filtered
          .slice(start, start + pageSize)
          .map((r) =>
            plain(`${rowKey(r) === this.selectedKey ? ">" : " "} ${r.name || "Untitled"} · ${r.id} · ${r.cwd}`).replace(
              /\n/gu,
              " ",
            ),
          ),
        ...controls,
      ],
      width,
    );
  }
  handleInput(data: string): void {
    this.safeInput.handleInput(data);
  }
  private handleSafeInput(data: string, paste: boolean): void {
    if (!paste && (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")))) {
      this.done(undefined);
      return;
    }
    const filtered = this.filtered();
    const index = Math.max(
      0,
      filtered.findIndex((r) => rowKey(r) === this.selectedKey),
    );
    if (!paste && matchesKey(data, Key.enter)) {
      this.render(this.terminalColumns());
      if (this.ready) this.done(filtered.find((r) => rowKey(r) === this.selectedKey));
      return;
    }
    if (!paste && (matchesKey(data, Key.up) || matchesKey(data, Key.down))) {
      const next = filtered[Math.max(0, Math.min(filtered.length - 1, index + (matchesKey(data, Key.up) ? -1 : 1)))];
      this.selectedKey = next && rowKey(next);
    } else {
      this.input.handleInput(data);
      const next = this.filtered();
      if (!next.some((r) => rowKey(r) === this.selectedKey)) this.selectedKey = next[0] && rowKey(next[0]);
    }
    this.renderAgain();
  }
}

/** Compact composition of the public Editor, not ExtensionEditorComponent's
 * dialog chrome (which has no row budget). No private editor/TUI state needed.
 * The native viewport owns wrapping, scrolling, IME, undo and keybindings. */
class ReviewEditor implements Component, Focusable {
  private readonly editor: Editor;
  private ready = true;
  private collapsed = false;
  private beforeInput: string | undefined;
  private inputChanges: string[] | undefined;
  private readonly safeInput = new SafeInput(({ kind, data }) => this.handleSafeInput(data, kind === "paste"));
  get focused(): boolean {
    return this.editor.focused;
  }
  set focused(value: boolean) {
    this.editor.focused = value;
  }
  constructor(
    private readonly surface: Surface,
    private readonly title: string,
    prefill: string,
    private readonly done: (value: string | undefined) => void,
  ) {
    this.editor = new Editor(surface.tui, {
      borderColor: (text) => text,
      selectList: getSelectListTheme(),
    });
    this.editor.setText(plain(prefill));
    this.editor.onChange = () => this.inputChanges?.push(this.editor.getExpandedText());
    this.editor.onSubmit = () => {
      // Native submission emits its final onChange("") after any escape-key
      // edit (e.g. remapped backslash+Enter), then calls onSubmit with trimmed
      // text. Keep the last pre-clear expanded document, not the stale input
      // snapshot or the trimmed callback. All observation uses public APIs.
      const changes = this.inputChanges;
      const text = changes && changes.length > 1 ? changes[changes.length - 2] : this.beforeInput;
      if (text === undefined) return;
      if (this.collapsed) {
        // Large native pastes are atomic markers. First Enter expands into a
        // reviewable document, never approves text hidden behind that marker.
        this.editor.setText(text);
        this.collapsed = false;
        surface.tui.requestRender();
      } else if (this.ready) this.done(text);
    };
  }
  invalidate(): void {
    this.editor.invalidate();
  }
  render(width: number): string[] {
    const keys = getKeybindings();
    const controls = help(
      `${keys.getKeys("tui.input.submit").join("/")} ${this.collapsed ? "expand paste" : "accept"} · ${keys.getKeys("tui.select.cancel").join("/")} cancel\n${keys.getKeys("tui.input.newLine").join("/")} newline · ↑↓/PgUp/PgDn move`,
      width,
    );
    const rows = Math.max(1, this.surface.tui.terminal.rows);
    // Pi 1.0.4's public Editor renders at most max(5, floor(rows*.3))
    // content rows and two scroll borders. Reserve that whole viewport, one
    // title row and all essential controls; never slice native render output.
    const viewport = Math.max(5, Math.floor(rows * 0.3)) + 2;
    this.ready = width >= 12 && viewport + 1 + controls.length <= rows;
    if (!this.ready) return resizeNotice(width, rows);
    return safeLines([plain(this.title).replace(/\n/gu, " "), ...this.editor.render(width), ...controls], width);
  }
  handleInput(data: string): void {
    this.safeInput.handleInput(data);
  }
  private handleSafeInput(data: string, paste: boolean): void {
    const keys = getKeybindings();
    if (!paste && keys.matches(data, "tui.select.cancel")) {
      this.done(undefined);
      return;
    }
    // Keep the review inside its owned overlay; never launch an external editor.
    if (!paste && this.surface.keys.matches(data, "app.editor.external")) return;
    this.render(this.surface.tui.terminal.columns);
    // Let the native editor resolve newline-vs-submit precedence, including
    // backslash+Enter and remapped keys, but never clear hidden/unreviewed text.
    this.editor.disableSubmit = !this.ready;
    this.beforeInput = this.editor.getExpandedText();
    this.inputChanges = [];
    this.collapsed = this.editor.getText() !== this.beforeInput;
    try {
      this.editor.handleInput(data);
    } finally {
      this.beforeInput = undefined;
      this.inputChanges = undefined;
    }
    this.collapsed = this.editor.getText() !== this.editor.getExpandedText();
    this.surface.tui.requestRender();
  }
}

export class HumanUI {
  constructor(readonly owner: Owner<ExtensionContext>) {}
  async confirm(title: string, message: string): Promise<boolean> {
    const { ctx } = this.owner;
    this.owner.check();
    if (ctx.mode === "rpc")
      return this.owner.wait(ctx.ui.confirm(label(title), plain(message), { signal: this.owner.signal }));
    const choice = await modal<string>(
      this.owner,
      (s, done) =>
        new Choice(
          `${plain(title)}\n${plain(message)}`,
          ["No", "Yes"],
          done,
          () => s.tui.requestRender(),
          () => s.tui.terminal.rows,
          () => s.tui.terminal.columns,
        ),
    );
    this.owner.check();
    return choice === "Yes";
  }
  async editor(title: string, prefill = ""): Promise<string | undefined> {
    const { ctx } = this.owner;
    this.owner.check();
    if (ctx.mode === "rpc") return this.owner.wait(ctx.ui.editor(label(title), plain(prefill)));
    const value = await modal<string>(this.owner, (s, done) => new ReviewEditor(s, label(title), plain(prefill), done));
    this.owner.check();
    return value;
  }
  async input(title: string): Promise<string | undefined> {
    const { ctx } = this.owner;
    if (ctx.mode === "rpc")
      return this.owner.wait(ctx.ui.input(label(title), undefined, { signal: this.owner.signal }));
    // Multi-line goal entry also supports IME and paste through Pi's native editor.
    return this.editor(title);
  }
  async loading<T>(title: string, run: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
    const { ctx } = this.owner;
    if (ctx.mode === "rpc") return this.owner.wait(run(this.owner.signal));
    let result: T | undefined;
    let failure: unknown;
    await modal<boolean>(this.owner, (_s, done) => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      this.owner.signal.addEventListener("abort", abort, { once: true });
      this.owner
        .wait(run(controller.signal))
        .then(
          (value) => {
            result = value;
            done(true);
          },
          (error: unknown) => {
            failure = error;
            done(false);
          },
        )
        .finally(() => this.owner.signal.removeEventListener("abort", abort));
      return {
        invalidate() {},
        render: (width) => safeLines([plain(title), "Escape cancels generation"], width),
        handleInput: (data) => {
          if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
            controller.abort();
            done(false);
          }
        },
      };
    });
    this.owner.check();
    if (failure) throw failure;
    return result;
  }
  async pick(
    load: (
      publish: (rows: SessionRow[], loaded: number, total: number, complete: boolean) => void,
      signal: AbortSignal,
    ) => Promise<SessionRow[]>,
  ): Promise<SessionRow | undefined> {
    const { ctx } = this.owner;
    if (ctx.mode === "rpc") {
      const rows = await this.owner.wait(load(() => {}, this.owner.signal));
      const filter = await this.input("Filter by session ID, name or workspace (empty shows all loaded rows)");
      if (filter === undefined) return;
      const query = plain(filter).toLocaleLowerCase();
      const filtered = rows.filter((r) => `${r.id} ${r.name} ${r.cwd}`.toLocaleLowerCase().includes(query));
      const options = filtered.map(
        (r, i) => `${i + 1}. ${label(r.name ?? "Untitled", 90)} · ${label(r.id, 80)} · ${label(r.cwd, 120)}`,
      );
      if (!options.length) return;
      const selected = await this.owner.wait(
        ctx.ui.select("Select a session to preview", options, { signal: this.owner.signal }),
      );
      return filtered[options.indexOf(selected ?? "")];
    }
    return modal<SessionRow>(this.owner, (s, done) => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      this.owner.signal.addEventListener("abort", abort, { once: true });
      const picker = new Picker(
        (row) => {
          controller.abort();
          done(row);
        },
        () => s.tui.requestRender(),
        () => s.tui.terminal.rows,
        () => s.tui.terminal.columns,
      );
      this.owner
        .wait(
          load((rows, loaded, total, complete) => {
            if (this.owner.current() && !controller.signal.aborted) picker.update(rows, loaded, total, complete);
          }, controller.signal),
        )
        .catch(() => {
          if (!controller.signal.aborted) done(undefined);
        })
        .finally(() => this.owner.signal.removeEventListener("abort", abort));
      return picker;
    });
  }
}

export function requireHuman(ctx: ExtensionContext): void {
  if (!ctx.hasUI || (ctx.mode !== "tui" && ctx.mode !== "rpc")) {
    throw new Error("/sessions and /handoff require TUI or dialog-capable RPC; unavailable in print/JSON mode.");
  }
}
