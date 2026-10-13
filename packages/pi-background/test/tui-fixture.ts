import type { ExtensionUIContext, KeybindingsManager as HostKeybindings, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, KeybindingsManager, type Terminal, TuiAltScreen, TuiMainScreen } from "@earendil-works/pi-tui";
import { vi } from "vitest";

/** Public custom-UI contract backed by Pi's actual regular/fullscreen renderers. */
export function nativeUIFixture(fullscreen = true) {
  let input: (data: string) => void = () => {};
  let resize: () => void = () => {};
  let output = "";
  let component: (Component & { dispose?(): void }) | undefined;
  const terminal = {
    columns: 100,
    rows: 16,
    kittyProtocolActive: false,
    start: (onInput, onResize) => {
      input = onInput;
      resize = onResize;
    },
    stop: () => {},
    drainInput: async () => {},
    write: (data) => {
      output += data;
    },
    moveBy: () => {},
    hideCursor: () => {},
    showCursor: () => {},
    clearLine: () => {},
    clearFromCursor: () => {},
    clearScreen: () => {},
    setTitle: () => {},
    setProgress: () => {},
  } satisfies Terminal;
  const tui = fullscreen ? new TuiAltScreen(terminal) : new TuiMainScreen(terminal);
  const theme = { fg: (_color: string, text: string) => text } as unknown as Theme;
  const custom: ExtensionUIContext["custom"] = (factory) =>
    new Promise((resolve, reject) => {
      const previous = tui.getFocusedComponent();
      let finished = false;
      const done = (value: Parameters<typeof resolve>[0]) => {
        if (finished) return;
        finished = true;
        component?.dispose?.();
        if (component) tui.removeChild(component);
        component = undefined;
        tui.setFocus(previous);
        tui.requestRender();
        resolve(value);
      };
      Promise.resolve(factory(tui, theme, new KeybindingsManager({}) as unknown as HostKeybindings, done)).then(
        (created) => {
          if (finished) {
            created.dispose?.();
            return;
          }
          component = created;
          tui.addChild(created);
          tui.setFocus(created);
          tui.requestRender();
        },
        reject,
      );
    });
  const customSpy = vi.fn(custom);
  const ui = {
    custom: customSpy,
    setStatus: vi.fn(),
    notify: vi.fn(),
    theme,
  } as unknown as ExtensionUIContext;
  tui.start();
  return {
    tui,
    terminal,
    theme,
    ui,
    custom: customSpy,
    key: (data: string) => {
      input(data);
      tui.renderNow();
    },
    resize: (columns: number, rows: number) => {
      terminal.columns = columns;
      terminal.rows = rows;
      resize();
      tui.renderNow();
    },
    render: () => {
      tui.renderNow();
      return component?.render(terminal.columns) ?? [];
    },
    component: () => component,
    output: () => output,
    dispose: () => {
      component?.dispose?.();
      tui.stop();
    },
  };
}
