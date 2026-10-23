import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Owns whole invocations, not just the current server in a multi-route call. */
export class LspSessionScope {
  #operations = new Map<AbortController, Promise<void>>();
  #closing?: Promise<void>;

  constructor(
    private readonly current: () => boolean = () => true,
    private previous?: LspSessionScope,
  ) {}

  async drainPrevious(): Promise<void> {
    const previous = this.previous;
    await previous?.close();
    if (this.previous === previous) this.previous = undefined;
  }

  isOpen() {
    return !this.#closing && this.current();
  }

  assertOpen() {
    if (!this.isOpen()) throw new Error("LSP session is closing; request aborted.");
  }

  context<T extends ExtensionContext>(ctx: T, retiring = false): T {
    const assertOwner = () => {
      if (retiring ? !this.current() : !this.isOpen()) throw new Error("LSP context retired.");
    };
    // Preserve lazy SDK getters. Check ownership BEFORE reaching an old getter,
    // and again after getters that may synchronously reenter lifecycle handlers.
    return Object.create(ctx, {
      statusOwner: { value: this },
      ui: {
        get: () => {
          assertOwner();
          const ui = ctx.ui;
          assertOwner();
          return Object.create(ui, {
            setStatus: {
              value: (key: string, value: string | undefined) => {
                assertOwner();
                if (ctx.mode !== "tui") return;
                assertOwner();
                ui.setStatus(key, value);
              },
            },
          });
        },
      },
      mode: {
        get: () => {
          assertOwner();
          return ctx.mode;
        },
      },
    });
  }

  async run<T>(caller: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.assertOpen();
    const controller = new AbortController();
    const abort = () => controller.abort(new Error("LSP request aborted."));
    let settle!: () => void;
    this.#operations.set(
      controller,
      new Promise<void>((resolve) => {
        settle = resolve;
      }),
    );
    caller?.addEventListener("abort", abort, { once: true });
    if (caller?.aborted) abort();
    try {
      controller.signal.throwIfAborted();
      const result = await operation(controller.signal);
      controller.signal.throwIfAborted();
      this.assertOpen();
      return result;
    } finally {
      caller?.removeEventListener("abort", abort);
      this.#operations.delete(controller);
      settle();
    }
  }

  close(): Promise<void> {
    if (!this.#closing) {
      // Publish retirement before abort listeners can replace/start a session.
      let priorSettled!: () => void;
      const prior = new Promise<void>((resolve) => {
        priorSettled = resolve;
      });
      this.#closing = Promise.allSettled([...this.#operations.values(), prior]).then(() => {});
      // A replacement can itself shut down while its predecessor is draining.
      // Retain that drain, without ever reaching forward to a newer scope.
      void this.drainPrevious().then(priorSettled);
      for (const controller of this.#operations.keys()) {
        controller.abort(new Error("LSP session is closing; request aborted."));
      }
    }
    return this.#closing;
  }
}
