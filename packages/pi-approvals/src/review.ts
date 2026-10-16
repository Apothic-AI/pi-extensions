import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  matchesKey,
  type OverlayHandle,
  Text,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { ApprovalOperation } from "@signalridge/pi-approval-core";

interface ReviewComponent extends Component {
  focused: boolean;
  reconcile(): void;
  dispose(): void;
}
export function createReviewComponent(
  tui: TUI,
  operation: ApprovalOperation,
  signal: AbortSignal,
  done: (approved: boolean) => void,
  canComplete: () => boolean = () => true,
): ReviewComponent {
  let offset = 0;
  let height = 1;
  let total = 1;
  let finished = false;
  let focused = false;
  let decision: boolean | undefined;
  const header = "APPROVAL REVIEW";
  const controls = "Ctrl+A approve | Esc deny";
  const scrolling = "Up/Down/PgUp/PgDn/Home/End scroll";
  const reconcile = () => {
    if (finished || decision === undefined || !canComplete()) return;
    finished = true;
    done(signal.aborted ? false : decision);
  };
  const finish = (value: boolean) => {
    if (finished) return;
    decision = signal.aborted ? false : value;
    reconcile();
    tui.requestRender();
  };
  const abort = () => finish(false);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) queueMicrotask(abort);
  return {
    get focused() {
      return focused;
    },
    set focused(value: boolean) {
      focused = value;
      // Native hideOverlay restores focus before its close callback finishes.
      // Complete only afterward, never pop the foreign overlay in that stack operation.
      if (value) queueMicrotask(reconcile);
    },
    reconcile,
    render(width: number) {
      width = Math.max(1, width);
      const rows = Math.max(1, tui.terminal.rows);
      const compact = width < 40 || rows < 6;
      let text = compact ? `${header}\n${controls}\n${scrolling}\n${operation.preview}` : operation.preview;
      // A double-width glyph cannot occupy a one-column terminal. Escape, don't clip it.
      if (width === 1)
        text = Array.from(text, (char) =>
          visibleWidth(char) > 1 ? `\\u{${char.codePointAt(0)?.toString(16)}}` : char,
        ).join("");
      const lines = new Text(text, 0, 0).render(width);
      height = compact ? rows : rows - 4;
      total = lines.length;
      offset = Math.min(offset, Math.max(0, total - height));
      const body = lines.slice(offset, offset + height);
      queueMicrotask(reconcile);
      if (compact) return body;
      while (body.length < height) body.push("");
      return [
        header,
        controls,
        ...body,
        scrolling,
        `Lines ${offset + 1}-${Math.min(total, offset + height)}/${total}`,
      ].map((line) => truncateToWidth(line, width, ""));
    },
    handleInput(data: string) {
      if (finished) return;
      if (signal.aborted) finish(false);
      else if (matchesKey(data, "ctrl+a")) finish(true);
      else if (matchesKey(data, "escape")) finish(false);
      else {
        if (matchesKey(data, "up")) offset = Math.max(0, offset - 1);
        if (matchesKey(data, "down")) offset += 1;
        if (matchesKey(data, "pageUp")) offset = Math.max(0, offset - Math.max(1, height - 1));
        if (matchesKey(data, "pageDown")) offset += Math.max(1, height - 1);
        if (matchesKey(data, "home")) offset = 0;
        if (matchesKey(data, "end")) offset = Math.max(0, total - height);
        tui.requestRender();
      }
    },
    invalidate() {},
    dispose() {
      finished = true;
      signal.removeEventListener("abort", abort);
    },
  };
}
/** Human command only. Native custom UI owns disposal; never hide its overlay directly. */
export async function confirmOperation(
  ctx: ExtensionContext,
  operation: ApprovalOperation,
  signal: AbortSignal,
): Promise<boolean> {
  if (!ctx.hasUI || signal.aborted) return false;
  if (ctx.mode === "rpc")
    return ctx.ui.confirm("Approve exactly this operation?", operation.preview, { signal, timeout: 60_000 });
  if (ctx.mode !== "tui") return false;
  let handle: OverlayHandle | undefined;
  let component: ReviewComponent | undefined;
  return ctx.ui.custom<boolean>(
    (tui, _theme, _keys, done) => {
      component = createReviewComponent(tui, operation, signal, done, () => handle?.isFocused() === true);
      return component;
    },
    {
      overlay: true,
      overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 },
      onHandle: (value) => {
        handle = value;
        // Also handles cancellation between factory creation and native overlay admission.
        queueMicrotask(() => component?.reconcile());
      },
    },
  );
}
