import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Keybinding, KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import { type JobManager, type JobSnapshot, LIMITS, type Stream } from "./contracts.js";
import { terminalText } from "./terminal-text.js";

// Bound untrusted input before terminal measurement/wrapping, independently of retention.
export const UI_LOG_BYTES = 64 * 1024;
type Utilities = Pick<
  typeof import("@earendil-works/pi-tui"),
  "matchesKey" | "isKeyRepeat" | "isKeyRelease" | "truncateToWidth" | "wrapTextWithAnsi" | "visibleWidth" | "Key"
>;

export interface TaskUIRuntime {
  manager: JobManager;
  live(): boolean;
  cancel(id: string): void;
  mount(close: () => void): () => void;
}

function plain(text: string, bytes: number = LIMITS.lineBytes, tail = false): string {
  let buffer = Buffer.from(text);
  if (buffer.length > bytes) {
    if (tail) {
      let start = buffer.length - bytes;
      while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
      buffer = buffer.subarray(start);
    } else {
      let end = bytes;
      while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
      buffer = buffer.subarray(0, end);
    }
  }
  return terminalText(buffer.toString("utf8")).replaceAll("\t", " ");
}

function label(text: string): string {
  return plain(text).replaceAll("\n", " ");
}

function elapsed(job: JobSnapshot): string {
  const seconds = Math.max(0, Math.floor(((job.endedAt ?? Date.now()) - job.startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

/** One explicit interaction; no processes, timers, or subscriptions in construction. */
export class BackgroundView implements Component {
  private disposed = false;
  private release: (() => void) | undefined;
  private unsubscribe: (() => void) | undefined;
  private selected: string | undefined;
  private selectedIndex = 0;
  private selectionCleared = false;
  private listOffset = 0;
  private topId: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private screen: "list" | "details" | "logs";
  private detailOffset = 0;
  // Keep the unrounded source position across successive width changes.
  private detailAnchor = 0;
  private detailLayout: { id: string; width: number; text: string; rows: string[]; starts: number[] } | undefined;
  private stream: Stream | "both" = "both";
  private follow = true;
  private offset = 0;
  private pageSize = 1;
  private logRows: string[] = [];
  private logText = "";
  // One bounded, sanitized snapshot; never infer positions by matching live duplicate lines.
  private pausedText: string | undefined;
  private pausedAnchor = 0;
  private rowStarts: number[] = [];
  private cache: { id: string; width: number; stream: string } | undefined;
  private confirmation: { action: "stop" | "clear"; id: string } | undefined;
  private busy: string | undefined;
  private error: string | undefined;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly utils: Utilities,
    private readonly runtime: TaskUIRuntime,
    private readonly done: () => void,
    id?: string,
    private readonly keys?: Pick<KeybindingsManager, "matches" | "getKeys">,
  ) {
    this.selected = id;
    this.screen = id ? "logs" : "list";
  }

  mount(): void {
    if (this.disposed || this.unsubscribe || !this.valid()) return;
    this.release = this.runtime.mount(() => this.close());
    try {
      this.unsubscribe = this.runtime.manager.subscribe(() => {
        if (!this.valid()) return;
        if (this.follow) this.invalidate();
        // Pi coalesces chunk bursts; never send a model message for output.
        this.refreshTimer();
        this.tui.requestRender();
      });
      this.refreshTimer();
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  private refreshTimer(): void {
    const needed =
      !this.disposed &&
      this.unsubscribe !== undefined &&
      this.runtime.manager
        .list()
        .some(
          (job) =>
            job.endedAt === undefined &&
            (this.screen === "list" || (this.screen === "details" && job.id === this.selected)),
        );
    if (!needed) {
      if (this.timer !== undefined) clearInterval(this.timer);
      this.timer = undefined;
    } else if (this.timer === undefined) {
      // Elapsed labels only: no log reads, model turns, or focus changes.
      this.timer = setInterval(() => {
        if (this.valid()) this.tui.requestRender();
      }, 1000);
      this.timer.unref?.();
    }
  }

  private valid(): boolean {
    if (this.disposed) return false;
    if (this.runtime.live()) return true;
    this.close();
    return false;
  }

  close(): void {
    if (this.disposed) return;
    this.dispose();
    this.done();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.detailLayout = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.release?.();
    this.release = undefined;
    this.confirmation = undefined;
    this.logRows = [];
    this.logText = "";
    this.pausedText = undefined;
    this.rowStarts = [];
    this.cache = undefined;
  }

  invalidate(): void {
    this.cache = undefined;
  }

  private resumeLogs(): void {
    this.follow = true;
    this.pausedText = undefined;
    this.invalidate();
  }

  private pauseLogs(): void {
    if (!this.follow) return;
    this.follow = false;
    this.pausedText = this.logText;
    this.pausedAnchor = this.rowStarts[this.offset] ?? 0;
  }

  private wrapText(text: string, width: number): { rows: string[]; starts: number[] } {
    let rows: string[];
    let starts: number[];
    if (width === 1) {
      // A wide grapheme cannot occupy one cell. Show an explicit '?' placeholder,
      // one grapheme per row, rather than clipping it together with its neighbors.
      rows = [];
      starts = [];
      const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
      let lineStart = 0;
      for (const line of text.split("\n")) {
        if (!line) {
          rows.push("");
          starts.push(lineStart);
        }
        for (const { segment, index } of segmenter.segment(line)) {
          rows.push(this.utils.visibleWidth(segment) > 1 ? "?" : segment);
          starts.push(lineStart + index);
        }
        lineStart += line.length + 1;
      }
    } else {
      rows = this.utils.wrapTextWithAnsi(text, width);
      let cursor = 0;
      starts = rows.map((row) => {
        // Sequential positions within an immutable snapshot, not a live-text search.
        const start = row ? text.indexOf(row, cursor) : cursor;
        const position = start >= 0 ? start : cursor;
        cursor = position + row.length;
        if (text[cursor] === "\n") cursor++;
        return position;
      });
    }
    return { rows, starts };
  }

  private jobs(): JobSnapshot[] {
    const jobs = this.runtime.manager.list();
    const index = jobs.findIndex((job) => job.id === this.selected);
    const top = jobs.findIndex((job) => job.id === this.topId);
    if (top >= 0) this.listOffset = top;
    if (index >= 0) this.selectedIndex = index;
    else if (this.selected !== undefined) {
      // Never reinterpret a pending activation as targeting the adjacent retained job.
      this.selected = undefined;
      this.selectedIndex = -1;
      this.selectionCleared = true;
      this.screen = "list";
      this.confirmation = undefined;
      this.error = "Selected job was removed; navigate to select again.";
      this.detailLayout = undefined;
      this.offset = 0;
      this.resumeLogs();
      this.refreshTimer();
    } else if (!this.selectionCleared) {
      this.selectedIndex = 0;
      this.selected = jobs[0]?.id;
    }
    return jobs;
  }

  private inputAction(
    data: string,
  ): "up" | "down" | "pageUp" | "pageDown" | "confirm" | "cancel" | "home" | "end" | undefined {
    const { matchesKey, Key } = this.utils;
    // Escape always leaves even the smallest viewport. Configured ownership wins
    // over fixed action letters and fallback arrows, as in the native selectors.
    if (matchesKey(data, Key.escape)) return "cancel";
    const bindings = [
      ["tui.select.cancel", "cancel", Key.escape],
      ["tui.select.confirm", "confirm", Key.enter],
      ["tui.select.up", "up", Key.up],
      ["tui.select.down", "down", Key.down],
      ["tui.select.pageUp", "pageUp", Key.pageUp],
      ["tui.select.pageDown", "pageDown", Key.pageDown],
    ] as const;
    for (const [binding, action] of bindings) if (this.keys?.matches(data, binding)) return action;
    for (const [, action, fallback] of bindings) if (matchesKey(data, fallback)) return action;
    if (matchesKey(data, Key.home)) return "home";
    if (matchesKey(data, Key.end)) return "end";
    return undefined;
  }

  private keyHelp(binding: Keybinding, fallback: string): string {
    const key = this.keys?.getKeys(binding)[0] ?? fallback;
    const labels: Record<string, string> = {
      up: "↑",
      down: "↓",
      enter: "Enter",
      escape: "Esc",
      pageUp: "PgUp",
      pageDown: "PgDn",
    };
    return label(labels[key] ?? key);
  }

  handleInput(data: string): void {
    if (!this.valid() || this.utils.isKeyRelease(data)) return;
    const { matchesKey: key } = this.utils;
    const jobs = this.jobs();
    if (this.confirmation) {
      const captured = this.confirmation;
      this.confirmation = undefined;
      if (key(data, "y") && !this.utils.isKeyRepeat(data)) void this.act(captured);
      // Neither repeating x/d nor Enter can confirm. Other keys cancel, not navigate.
      if (this.valid()) this.tui.requestRender();
      return;
    }
    const action = this.inputAction(data);
    if (action === "cancel") {
      if (this.screen === "logs") this.screen = "details";
      else if (this.screen === "details") this.screen = "list";
      else this.close();
      this.error = undefined;
    } else if (!this.busy) {
      const job = jobs.find((item) => item.id === this.selected);
      if (!action && key(data, "x") && job && job.endedAt === undefined && !this.utils.isKeyRepeat(data)) {
        this.confirmation = { action: "stop", id: job.id };
      } else if (!action && key(data, "d") && job && job.endedAt !== undefined && !this.utils.isKeyRepeat(data)) {
        this.confirmation = { action: "clear", id: job.id };
      } else if (action === "confirm" && job && this.screen === "list" && !this.utils.isKeyRepeat(data)) {
        this.screen = "details";
        this.detailOffset = 0;
        this.detailAnchor = 0;
        this.detailLayout = undefined;
      } else if (
        job &&
        this.screen === "details" &&
        (action === "confirm" || (!action && key(data, "l"))) &&
        !this.utils.isKeyRepeat(data)
      ) {
        this.screen = "logs";
        this.offset = 0;
        this.resumeLogs();
      } else if (!action && this.screen === "logs" && key(data, "s")) {
        this.stream = this.stream === "both" ? "stdout" : this.stream === "stdout" ? "stderr" : "both";
        this.offset = 0;
        this.resumeLogs();
      } else if (!action && this.screen === "logs" && key(data, "f")) {
        if (this.follow) this.pauseLogs();
        else this.resumeLogs();
      } else {
        let delta = 0;
        if (action === "up") delta = -1;
        else if (action === "down") delta = 1;
        else if (action === "pageUp") delta = -this.pageSize;
        else if (action === "pageDown") delta = this.pageSize;
        const movement = delta !== 0 || action === "home" || action === "end";
        if (this.screen === "list" && movement) {
          if (action === "home") this.selectedIndex = 0;
          else if (action === "end") this.selectedIndex = jobs.length - 1;
          else this.selectedIndex += delta;
          this.selectedIndex = Math.max(0, Math.min(jobs.length - 1, this.selectedIndex));
          this.selected = jobs[this.selectedIndex]?.id;
          this.selectionCleared = false;
          this.error = undefined;
        } else if (this.screen === "details" && movement) {
          const last = Math.max(0, (this.detailLayout?.rows.length ?? 1) - this.pageSize);
          this.detailOffset =
            action === "home" ? 0 : action === "end" ? last : Math.max(0, Math.min(last, this.detailOffset + delta));
          this.detailAnchor = this.detailLayout?.starts[this.detailOffset] ?? 0;
        } else if (this.screen === "logs" && action === "end") {
          this.resumeLogs();
        } else if (this.screen === "logs" && movement) {
          this.pauseLogs();
          const last = Math.max(0, this.logRows.length - 1);
          this.offset = action === "home" ? 0 : Math.max(0, Math.min(last, this.offset + delta));
          this.pausedAnchor = this.rowStarts[this.offset] ?? 0;
        }
      }
    }
    if (this.valid()) {
      this.refreshTimer();
      this.tui.requestRender();
    }
  }

  private async act(captured: { action: "stop" | "clear"; id: string }): Promise<void> {
    if (!this.valid() || this.busy) return;
    this.busy = captured.id;
    this.error = undefined;
    try {
      const job = this.runtime.manager.get(captured.id);
      if (captured.action === "stop") {
        if (job.endedAt !== undefined) throw new Error("Job already finished; inspect its exit or clear it.");
        this.runtime.cancel(captured.id);
        await this.runtime.manager.stop(captured.id);
      } else {
        if (job.endedAt === undefined)
          throw new Error("Job has not finished; wait for confirmed exit before clearing.");
        this.runtime.manager.clear(captured.id);
        this.runtime.cancel(captured.id);
      }
      if (!this.valid()) return;
      this.invalidate();
    } catch (error) {
      if (!this.valid()) return;
      this.error = `Action failed: ${label(error instanceof Error ? error.message : String(error))}. Try again.`;
    } finally {
      this.busy = undefined;
      if (this.valid()) this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    if (!this.valid()) return [];
    const height = Math.max(1, Math.floor(this.tui.terminal.rows));
    const columns = Math.max(0, Math.floor(width));
    if (!columns) return [];
    const jobs = this.jobs();
    const job = jobs.find((item) => item.id === this.selected);
    const running = jobs.filter((item) => item.endedAt === undefined).length;
    const headers =
      this.screen === "list"
        ? [`Background tasks · ${running} running / ${jobs.length - running} done`, ""]
        : [`Background ${this.screen} · ${job?.status ?? "unavailable"} · ${label(job?.description ?? "")}`, ""];
    const confirm = this.keyHelp("tui.select.confirm", "enter");
    const cancel = this.keyHelp("tui.select.cancel", "escape");
    const movement = `${this.keyHelp("tui.select.up", "up")}/${this.keyHelp("tui.select.down", "down")} Home/End ${this.keyHelp("tui.select.pageUp", "pageUp")}/${this.keyHelp("tui.select.pageDown", "pageDown")}`;
    const logsKey = `${confirm}${this.inputAction("l") ? "" : "/l"}`;
    const controls = [this.inputAction("x") ? "" : "x stop", this.inputAction("d") ? "" : "d clear"].filter(Boolean);
    const help = [
      `${movement}${this.screen === "list" ? "" : " scroll"}`,
      ...(this.screen === "list"
        ? [`${confirm} details`]
        : this.screen === "details"
          ? [`${logsKey} logs`]
          : [this.inputAction("f") ? "" : "f follow", this.inputAction("s") ? "" : "s stream"]),
      ...controls,
      `${cancel} ${this.screen === "list" ? "close" : this.screen === "details" ? "tasks" : "details"}`,
    ]
      .filter(Boolean)
      .join(" · ");
    const footer = this.confirmation
      ? `${this.confirmation.action === "stop" ? "Stop" : "Clear"} ${label(this.confirmation.id)}? · y confirms · other keys cancel`
      : this.busy
        ? `Waiting for confirmed stop: ${label(this.busy)} · Esc back/close`
        : (this.error ?? help);
    // Wrap controls/confirmation instead of silently hiding the last actions at 40 columns.
    // Tiny terminals retain one footer cell and an escapable content area.
    const footerGroups: string[] = [];
    for (const group of footer.split(" · ")) {
      const last = footerGroups.at(-1);
      if (last && this.utils.visibleWidth(`${last} · ${group}`) <= columns) {
        footerGroups[footerGroups.length - 1] = `${last} · ${group}`;
      } else footerGroups.push(...this.utils.wrapTextWithAnsi(group, Math.max(1, columns)));
    }
    const footers = (columns < 20 ? [footer] : footerGroups).slice(0, Math.max(1, height - 1));
    const headerBudget = Math.min(headers.length, Math.max(0, height - footers.length - 1));
    this.pageSize = Math.max(1, height - headerBudget - footers.length);
    let rows: string[];
    if (this.screen === "logs" && job) {
      if (
        !this.cache ||
        this.cache.id !== job.id ||
        this.cache.width !== columns ||
        this.cache.stream !== this.stream
      ) {
        this.logText =
          this.pausedText ?? plain(this.runtime.manager.logs(job.id, 1000, this.stream).text, UI_LOG_BYTES, true);
        const wrapped = this.wrapText(this.logText, columns);
        this.logRows = wrapped.rows;
        this.rowStarts = wrapped.starts;
        if (!this.follow) {
          // Keep the same source position through wrapping changes (including repeated text).
          this.offset = Math.max(0, this.rowStarts.length - 1);
          while (this.offset > 0 && this.rowStarts[this.offset] > this.pausedAnchor) this.offset--;
        }
        this.cache = { id: job.id, width: columns, stream: this.stream };
      }
      const last = Math.max(0, this.logRows.length - this.pageSize);
      // A paused anchor stays at the top even if resize leaves blank space below it.
      this.offset = this.follow ? last : Math.min(this.offset, Math.max(0, this.logRows.length - 1));
      rows = this.logRows.slice(this.offset, this.offset + this.pageSize);
      headers[1] = `Stream: ${this.stream} · ${this.follow ? "following tail" : "scroll paused snapshot (End/f refresh)"} · dropped=${job.droppedBytes} · lines ${this.offset + 1}-${Math.min(this.logRows.length, this.offset + this.pageSize)}/${this.logRows.length} · tail ≤1000 lines/${UI_LOG_BYTES / 1024} KiB${columns === 1 ? " · wide glyphs shown as ?; resize to read" : ""}`;
    } else if (this.screen === "details" && job) {
      const text = [
        `Logs: ${logsKey} opens stdout/stderr`,
        `Description: ${plain(job.description)}`,
        `ID: ${plain(job.id)}`,
        `Command: ${plain(job.command)}`,
        `Cwd: ${plain(job.cwd)}`,
        `Status: ${job.status} · elapsed ${elapsed(job)}`,
        `Exit: ${job.exitCode ?? "-"} · signal: ${label(job.signal ?? "-")}`,
        `Dropped: ${job.droppedBytes} bytes`,
        ...(job.error ? [`Error: ${plain(job.error)}`] : []),
      ].join("\n");
      const previous = this.detailLayout;
      let layout = previous;
      if (!layout || layout.id !== job.id || layout.width !== columns || layout.text !== text) {
        const wrapped = this.wrapText(text, columns);
        if (previous?.id === job.id && previous.width !== columns) {
          this.detailOffset = Math.max(0, wrapped.starts.length - 1);
          while (this.detailOffset > 0 && wrapped.starts[this.detailOffset] > this.detailAnchor) this.detailOffset--;
        }
        layout = { id: job.id, width: columns, text, ...wrapped };
      }
      this.detailLayout = layout;
      this.detailOffset = Math.max(0, Math.min(this.detailOffset, layout.rows.length - 1));
      rows = layout.rows.slice(this.detailOffset, this.detailOffset + this.pageSize);
      headers[1] = `Lines ${this.detailOffset + 1}-${Math.min(layout.rows.length, this.detailOffset + this.pageSize)}/${layout.rows.length} · ↑${this.detailOffset} ↓${Math.max(0, layout.rows.length - this.detailOffset - this.pageSize)}`;
    } else {
      this.listOffset = Math.max(0, Math.min(this.listOffset, jobs.length - 1));
      if (this.selectedIndex >= 0 && this.selectedIndex < this.listOffset) this.listOffset = this.selectedIndex;
      if (this.selectedIndex >= this.listOffset + this.pageSize)
        this.listOffset = this.selectedIndex - this.pageSize + 1;
      this.topId = jobs[this.listOffset]?.id;
      const end = Math.min(jobs.length, this.listOffset + this.pageSize);
      headers[1] = `Jobs ${jobs.length ? this.listOffset + 1 : 0}-${end}/${jobs.length} · selected ${job ? this.selectedIndex + 1 : 0} · ↑${this.listOffset} ↓${jobs.length - end}`;
      rows = jobs.slice(this.listOffset, end).map((item) => {
        const row = `${item.id === this.selected ? ">" : " "} ${item.status} ${elapsed(item)} ${label(item.description)} · ${label(item.id).slice(0, 8)}`;
        return item.id === this.selected ? this.theme.fg("accent", row) : row;
      });
      if (!jobs.length) rows = ["No background jobs. Start with bash_background or monitor."];
    }
    if (height === 1) return [this.utils.truncateToWidth(footers[0] ?? `${cancel} back`, columns, "")];
    const lines = [...headers.slice(0, headerBudget).map((line) => this.theme.fg("accent", line)), ...rows];
    lines.push(
      ...footers.map((line) => this.theme.fg(this.confirmation ? "warning" : this.error ? "error" : "dim", line)),
    );
    return lines.slice(0, height).map((line) => this.utils.truncateToWidth(line, columns, ""));
  }
}

export async function showBackgroundUI(ctx: ExtensionContext, runtime: TaskUIRuntime, id?: string): Promise<void> {
  if (ctx.mode !== "tui" || !ctx.hasUI) return;
  // TUI-only host dependency: headless/RPC commands never load the renderer.
  const utilities = await import("@earendil-works/pi-tui");
  if (ctx.mode !== "tui" || !ctx.hasUI || !runtime.live()) return;
  if (id) runtime.manager.get(id);
  let view: BackgroundView | undefined;
  try {
    await ctx.ui.custom<void>(
      (tui, theme, keys, done) => {
        view = new BackgroundView(tui, theme, utilities, runtime, () => done(), id, keys);
        view.mount();
        return view;
      },
      { overlay: true, overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%", margin: 0 } },
    );
  } finally {
    view?.dispose();
  }
}
