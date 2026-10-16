import { Editor, Input } from "@earendil-works/pi-tui";
import { expect, it, vi } from "vitest";
import { nativeTerminal } from "./native-terminal.js";

const attack = "X\x1b[31m\x1b]52;c;test\x07\u202e\x1b[2J";
for (const fullscreen of [false, true]) {
  const mode = fullscreen ? "fullscreen" : "regular";
  it(`${mode} sanitizes model-supplied edit prefill before native rendering and preserves unchanged state`, async () => {
    const f = await nativeTerminal(fullscreen);
    let running: Promise<void> | undefined;
    const inputs: string[] = [];
    const editors: string[] = [];
    const inputRender = Input.prototype.render;
    const editorRender = Editor.prototype.render;
    const inputSpy = vi.spyOn(Input.prototype, "render").mockImplementation(function (this: Input, width) {
      inputs.push(this.getValue());
      return inputRender.call(this, width);
    });
    const editorSpy = vi.spyOn(Editor.prototype, "render").mockImplementation(function (this: Editor, width) {
      editors.push(this.getExpandedText());
      return editorRender.call(this, width);
    });
    try {
      const before = f.store.mutate(f.ctx, {
        action: "add",
        baseRevision: 0,
        title: `${attack} task`,
        description: `${attack} description`,
      });
      running = f.command.run(f.ctx);
      await vi.waitFor(() => expect(f.lines().join("\n")).toContain("Session Todo"));
      f.key("e");
      await vi.waitFor(() => {
        f.lines();
        expect(inputs.length).toBeGreaterThan(0);
      });
      for (const unsafe of ["\x1b", "\u202e"]) expect(inputs.at(-1)).not.toContain(unsafe);
      f.key("\r");
      await vi.waitFor(() => expect(f.lines().join("\n")).toContain("Description (0-512"));
      for (const unsafe of ["\x1b", "\u202e"]) expect(editors.at(-1)).not.toContain(unsafe);
      f.key("\r");
      f.key("\x13");
      await vi.waitFor(() => expect(f.lines().join("\n")).toContain("Session Todo"));
      expect(f.store.read(f.ctx)).toEqual(before); // Inert display must not silently rewrite saved task data.
    } finally {
      inputSpy.mockRestore();
      editorSpy.mockRestore();
      f.command.retire();
      await running;
      await f.dispose();
    }
  });

  it(`${mode} preserves a valid title that displays empty on unchanged and description-only edits`, async () => {
    const f = await nativeTerminal(fullscreen);
    let running: Promise<void> | undefined;
    try {
      const before = f.store.mutate(f.ctx, { action: "add", baseRevision: 0, title: "\u202e", description: "before" });
      running = f.command.run(f.ctx);
      await vi.waitFor(() => expect(f.lines().join("\n")).toContain("Session Todo"));
      f.key("e");
      await vi.waitFor(() => expect(f.lines().join("\n")).toContain("Task title"));
      f.key("\r");
      f.key("\r");
      f.key("\r");
      await vi.waitFor(() => expect(f.lines().join("\n")).toContain("Session Todo"));
      expect(f.store.read(f.ctx)).toEqual(before);
      f.key("e");
      await vi.waitFor(() => expect(f.lines().join("\n")).toContain("Task title"));
      f.key("\r");
      f.key("\x01");
      f.key("\x0b");
      f.key("after");
      f.key("\x13");
      await vi.waitFor(() => expect(f.store.read(f.ctx).revision).toBe(2));
      expect(f.store.read(f.ctx).tasks[0]).toMatchObject({ title: "\u202e", description: "after" });
    } finally {
      f.command.retire();
      await running;
      await f.dispose();
    }
  });

  for (const field of ["title", "description"] as const) {
    it.each([false, true])(
      `${mode} ${field} unsafe paste split=%s keeps native insertion and Undo clean`,
      async (split) => {
        const f = await nativeTerminal(fullscreen);
        let running: Promise<void> | undefined;
        const inputValues: string[] = [];
        const editorValues: string[] = [];
        const inputRender = Input.prototype.render;
        const editorRender = Editor.prototype.render;
        const inputSpy = vi.spyOn(Input.prototype, "render").mockImplementation(function (this: Input, width) {
          inputValues.push(this.getValue());
          return inputRender.call(this, width);
        });
        const editorSpy = vi.spyOn(Editor.prototype, "render").mockImplementation(function (this: Editor, width) {
          editorValues.push(this.getExpandedText());
          return editorRender.call(this, width);
        });
        try {
          f.store.mutate(f.ctx, { action: "add", baseRevision: 0, title: "abcd", description: "abcd" });
          running = f.command.run(f.ctx);
          await vi.waitFor(() => expect(f.lines().join("\n")).toContain("Session Todo"));
          f.key("e");
          await vi.waitFor(() => expect(f.lines().join("\n")).toContain("Task title"));
          if (field === "description") f.key("\r");
          f.key("\x01");
          if (split)
            for (const chunk of ["\x1b[20", "0~X\x1b[31m\x1b]52;c;", "test\x07\u202e\x1b[2J\x1b[20", "1~"])
              f.key(chunk);
          else f.key(`\x1b[200~${attack}\x1b[201~`);
          f.key("Y");
          f.lines();
          const current = () => (field === "title" ? inputValues : editorValues).at(-1);
          expect(current()).toBe("XYabcd");
          f.key("\x1f");
          f.lines();
          expect(current()).toBe("Xabcd");
          f.key("\x1f");
          f.lines();
          expect(current()).toBe("abcd");
        } finally {
          inputSpy.mockRestore();
          editorSpy.mockRestore();
          f.command.retire();
          await running;
          await f.dispose();
        }
      },
    );
  }
}
