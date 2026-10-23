import assert from "node:assert/strict";
import { CustomEditor, type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { TuiMainScreen } from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import history from "../src/index.js";

const constructed = vi.hoisted(() => vi.fn());
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    CustomEditor: class extends actual.CustomEditor {
      constructor(...args: ConstructorParameters<typeof actual.CustomEditor>) {
        super(...args);
        constructed(args);
      }
    },
  };
});

test("history embeds native working status only when it creates the fallback editor", async () => {
  vi.spyOn(SessionManager, "list").mockResolvedValue([]);
  const tui = new TuiMainScreen({ rows: 40, columns: 100 } as never);
  vi.spyOn(tui, "requestRender").mockImplementation(() => {});
  const theme = { borderColor: (text: string) => text };
  const kb = { matches: () => false } as never;
  type Factory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
  for (const inherited of [false, true]) {
    const editor = new CustomEditor(tui, theme, kb);
    editor.setText("current draft");
    const previousFactory = vi.fn(() => editor);
    constructed.mockClear();
    let factory: Factory | undefined;
    const handlers = new Map<string, (event: never, context: ExtensionContext) => void>();
    const ctx = {
      mode: "tui",
      hasUI: true,
      cwd: "/test",
      sessionManager: { getSessionDir: () => undefined },
      ui: {
        getEditorComponent: () => (inherited ? previousFactory : undefined),
        setEditorComponent(next: Factory) {
          factory = next;
        },
      },
    } as unknown as ExtensionContext;
    history({
      on: (name: string, handler: (event: never, context: ExtensionContext) => void) => handlers.set(name, handler),
      registerShortcut() {},
    } as never);
    handlers.get("session_start")?.({} as never, ctx);
    assert.ok(factory);
    const active = factory(tui, theme, kb);
    if (inherited) {
      assert.equal(active, editor);
      assert.equal(active.getText(), "current draft");
      assert.deepEqual(previousFactory.mock.calls, [[tui, theme, kb]]);
      assert.equal(constructed.mock.calls.length, 0);
    } else {
      assert.equal(constructed.mock.calls.length, 1);
      assert.deepEqual(constructed.mock.calls[0]?.[0]?.[3], { embedWorkingStatus: true });
    }
    handlers.get("session_shutdown")?.({} as never, ctx);
  }
});
