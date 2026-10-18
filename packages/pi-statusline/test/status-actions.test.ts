import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import {
  discoverStatusActions,
  openStatusAction,
  parseStatusActionSnapshot,
  STATUS_ACTION_OPEN,
  STATUS_ACTION_QUERY,
  type StatusActionDescriptor,
  type StatusActionQuery,
  type StatusActionSnapshot,
} from "../src/status-actions.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  assert.equal(vi.getTimerCount(), 0, "all protocol timers must be cleaned up");
  vi.useRealTimers();
});
function busFixture() {
  const listeners = new Map<string, Set<(value: unknown) => void>>();
  const emitted: Array<{ channel: string; value: unknown }> = [];
  const bus = {
    on(channel: string, handler: (value: unknown) => void) {
      const handlers = listeners.get(channel) ?? new Set();
      handlers.add(handler);
      listeners.set(channel, handlers);
      return () => {
        handlers.delete(handler);
        if (!handlers.size) listeners.delete(channel);
      };
    },
    emit(channel: string, value: unknown) {
      emitted.push({ channel, value });
      for (const handler of [...(listeners.get(channel) ?? [])]) handler(value);
    },
  };
  return { bus, listeners, emitted };
}
function snapshot(overrides: Partial<StatusActionSnapshot> = {}): StatusActionSnapshot {
  return {
    version: 1,
    providerId: "owner",
    surfaceId: "surface",
    sessionId: "session",
    entries: [{ statusKey: "state", actionId: "detail", label: "Owner detail" }],
    ...overrides,
  };
}
const reply = (data: unknown) => ({ success: true, data });
const descriptor: StatusActionDescriptor = {
  providerId: "owner",
  surfaceId: "surface",
  sessionId: "session",
  statusKey: "state",
  actionId: "detail",
  label: "Owner detail",
};

test("snapshot validation copies exact own data fields and enforces all bounds", () => {
  assert.deepEqual(parseStatusActionSnapshot(reply(snapshot()), "session"), snapshot());
  const malformed: unknown[] = [
    null,
    [],
    {},
    { success: false, data: snapshot() },
    { ...reply(snapshot()), extra: true },
    reply({ ...snapshot(), version: 2 }),
    reply({ ...snapshot(), sessionId: "another" }),
    reply({ ...snapshot(), providerId: "" }),
    reply({ ...snapshot(), providerId: "x".repeat(129) }),
    reply({ ...snapshot(), surfaceId: "x".repeat(129) }),
    reply({ ...snapshot(), entries: {} }),
    reply(snapshot({ entries: Array(65).fill({ statusKey: "s", actionId: "a", label: "l" }) })),
    reply(snapshot({ entries: [{ ...descriptor }] })),
    reply(snapshot({ entries: [{ statusKey: "x".repeat(513), actionId: "a", label: "l" }] })),
    reply(snapshot({ entries: [{ statusKey: "s", actionId: "x".repeat(129), label: "l" }] })),
    reply(snapshot({ entries: [{ statusKey: "s", actionId: "a", label: "x".repeat(513) }] })),
    reply(snapshot({ entries: [{ statusKey: "s", actionId: "a", label: "" }] })),
    reply(
      snapshot({
        entries: [
          { statusKey: "s", actionId: "a", label: "l" },
          { statusKey: "s", actionId: "b", label: "l" },
        ],
      }),
    ),
    reply(
      snapshot({
        entries: [
          { statusKey: "s", actionId: "a", label: "l" },
          { statusKey: "t", actionId: "a", label: "l" },
        ],
      }),
    ),
    reply(Object.assign(Object.create({ inherited: true }), snapshot())),
    Object.assign(Object.create({ inherited: true }), reply(snapshot())),
    reply({ ...snapshot(), [Symbol("unknown")]: true }),
  ];
  for (const value of malformed) assert.equal(parseStatusActionSnapshot(value, "session"), undefined);
  assert.ok(
    parseStatusActionSnapshot(
      reply(
        snapshot({
          providerId: "x".repeat(128),
          surfaceId: "y".repeat(128),
          entries: [{ statusKey: "s".repeat(512), actionId: "a".repeat(128), label: "l".repeat(512) }],
        }),
      ),
      "session",
    ),
  );
  assert.ok(parseStatusActionSnapshot(reply(snapshot({ entries: [] })), "session"));
  assert.equal(parseStatusActionSnapshot(reply(snapshot({ sessionId: "x".repeat(129) })), "x".repeat(129)), undefined);
});

test("malformed envelopes, snapshots, entries and arrays never invoke getters", () => {
  let gets = 0;
  const getter = () => {
    gets++;
    throw new Error("must not run");
  };
  for (const field of ["success", "data"]) {
    const value = reply(snapshot());
    Object.defineProperty(value, field, { get: getter });
    assert.equal(parseStatusActionSnapshot(value, "session"), undefined);
  }
  for (const field of ["version", "providerId", "surfaceId", "sessionId", "entries"]) {
    const value = snapshot();
    Object.defineProperty(value, field, { get: getter });
    assert.equal(parseStatusActionSnapshot(reply(value), "session"), undefined);
  }
  for (const field of ["statusKey", "actionId", "label"]) {
    const value = snapshot();
    Object.defineProperty(value.entries[0], field, { get: getter });
    assert.equal(parseStatusActionSnapshot(reply(value), "session"), undefined);
  }
  const array = snapshot().entries;
  Object.defineProperty(array, "0", { get: getter });
  assert.equal(parseStatusActionSnapshot(reply(snapshot({ entries: array })), "session"), undefined);
  assert.equal(parseStatusActionSnapshot(reply(snapshot({ entries: new Array(1) })), "session"), undefined);
  const extraArray = snapshot().entries;
  Object.defineProperty(extraArray, "extra", { get: getter });
  assert.equal(parseStatusActionSnapshot(reply(snapshot({ entries: extraArray })), "session"), undefined);
  const inherited = Object.create({ statusKey: "s", actionId: "a", label: "l" });
  assert.equal(parseStatusActionSnapshot(reply(snapshot({ entries: [inherited] })), "session"), undefined);
  assert.equal(gets, 0);
});

test.each(["provider-first", "consumer-first"])(
  "explicit discovery works with %s load order and synchronous replies",
  async (order) => {
    const fixture = busFixture();
    const controller = new AbortController();
    const register = () =>
      fixture.bus.on(STATUS_ACTION_QUERY, (value) => {
        const request = value as StatusActionQuery;
        assert.deepEqual(Object.keys(request), ["version", "requestId", "sessionId"]);
        fixture.bus.emit(`${STATUS_ACTION_QUERY}:reply:${request.requestId}`, reply(snapshot()));
      });
    // Consumer creation allocates no subscription; providers can load on either side.
    const query = () => discoverStatusActions(fixture.bus, "session", controller.signal);
    const cleanup =
      order === "provider-first"
        ? register()
        : (() => {
            query;
            return register();
          })();
    const pending = query();
    await vi.advanceTimersByTimeAsync(49);
    assert.equal(fixture.listeners.size, 2);
    await vi.advanceTimersByTimeAsync(1);
    assert.deepEqual(await pending, [descriptor]);
    cleanup();
    assert.equal(fixture.listeners.size, 0);
  },
);

test("discovery handles absent, exact repeated, conflicting surfaces/snapshots and duplicate status owners", async () => {
  const fixture = busFixture();
  const controller = new AbortController();
  let pending = discoverStatusActions(fixture.bus, "session", controller.signal);
  await vi.advanceTimersByTimeAsync(50);
  assert.deepEqual(await pending, []);
  let payloads: StatusActionSnapshot[] = [snapshot(), snapshot()];
  const cleanup = fixture.bus.on(STATUS_ACTION_QUERY, (value) => {
    for (const payload of payloads)
      fixture.bus.emit(`${STATUS_ACTION_QUERY}:reply:${(value as StatusActionQuery).requestId}`, reply(payload));
  });
  pending = discoverStatusActions(fixture.bus, "session", controller.signal);
  await vi.advanceTimersByTimeAsync(50);
  assert.deepEqual(await pending, [descriptor]);
  for (const conflict of [
    snapshot({ surfaceId: "other" }),
    snapshot({ entries: [] }),
    snapshot({ providerId: "other" }),
  ]) {
    payloads = [snapshot(), conflict];
    pending = discoverStatusActions(fixture.bus, "session", controller.signal);
    await vi.advanceTimersByTimeAsync(50);
    assert.deepEqual(await pending, []);
  }
  cleanup();
  assert.equal(fixture.listeners.size, 0);
});

test("ambiguous surfaces cannot make another provider's overlapping status claim appear unique", async () => {
  for (const reversed of [false, true]) {
    const fixture = busFixture();
    const payloads = [
      snapshot(),
      snapshot({ providerId: "conflict", entries: [{ statusKey: "other", actionId: "other", label: "Other" }] }),
      snapshot({ providerId: "conflict", surfaceId: "replacement" }),
      snapshot({ providerId: "safe", entries: [{ statusKey: "safe", actionId: "safe", label: "Safe" }] }),
    ];
    if (reversed) payloads.reverse();
    const cleanup = fixture.bus.on(STATUS_ACTION_QUERY, (value) => {
      for (const data of payloads)
        fixture.bus.emit(`${STATUS_ACTION_QUERY}:reply:${(value as StatusActionQuery).requestId}`, reply(data));
    });
    const pending = discoverStatusActions(fixture.bus, "session", new AbortController().signal);
    await vi.advanceTimersByTimeAsync(50);
    assert.deepEqual(
      (await pending).map((action) => action.statusKey),
      ["safe"],
    );
    cleanup();
    assert.equal(fixture.listeners.size, 0);
  }
});

test("conflicting snapshots cannot grow the status-claim ledger without bounds", async () => {
  const fixture = busFixture();
  const cleanup = fixture.bus.on(STATUS_ACTION_QUERY, (value) => {
    for (let index = 0; index < 65; index++)
      fixture.bus.emit(
        `${STATUS_ACTION_QUERY}:reply:${(value as StatusActionQuery).requestId}`,
        reply(
          snapshot({
            entries: [{ statusKey: `key-${index}`, actionId: "detail", label: "Detail" }],
          }),
        ),
      );
  });
  const pending = discoverStatusActions(fixture.bus, "session", new AbortController().signal);
  await vi.advanceTimersByTimeAsync(50);
  assert.deepEqual(await pending, []);
  cleanup();
  assert.equal(fixture.listeners.size, 0);
});

test.each(["providers", "entries"])("discovery fails closed on aggregate %s overflow", async (bound) => {
  const fixture = busFixture();
  const cleanup = fixture.bus.on(STATUS_ACTION_QUERY, (value) => {
    for (let i = 0; i < (bound === "providers" ? 33 : 2); i++) {
      const entries = Array.from({ length: bound === "entries" ? 33 : 1 }, (_, j) => ({
        statusKey: `s-${i}-${j}`,
        actionId: `a-${j}`,
        label: "detail",
      }));
      fixture.bus.emit(
        `${STATUS_ACTION_QUERY}:reply:${(value as StatusActionQuery).requestId}`,
        reply(snapshot({ providerId: `p-${i}`, entries })),
      );
    }
  });
  const pending = discoverStatusActions(fixture.bus, "session", new AbortController().signal);
  await vi.advanceTimersByTimeAsync(50);
  assert.deepEqual(await pending, []);
  cleanup();
  assert.equal(fixture.listeners.size, 0);
});

test.each(["query", "open"])(
  "%s abort cleans subscriptions/timers; late replies and already-aborted requests do nothing",
  async (kind) => {
    const fixture = busFixture();
    const controller = new AbortController();
    const pending =
      kind === "query"
        ? discoverStatusActions(fixture.bus, "session", controller.signal)
        : openStatusAction(fixture.bus, descriptor, controller.signal);
    const request = fixture.emitted[0]?.value as { requestId: string };
    controller.abort();
    assert.deepEqual(await pending, kind === "query" ? [] : false);
    assert.equal(fixture.listeners.size, 0);
    assert.equal(vi.getTimerCount(), 0);
    fixture.bus.emit(
      `${kind === "query" ? STATUS_ACTION_QUERY : STATUS_ACTION_OPEN}:reply:${request.requestId}`,
      reply(kind === "query" ? snapshot() : { accepted: true }),
    );
    const emits = fixture.emitted.length;
    await discoverStatusActions(fixture.bus, "session", controller.signal);
    await openStatusAction(fixture.bus, descriptor, controller.signal);
    assert.equal(fixture.emitted.length, emits);
  },
);

test("open uses the exact selected descriptor, listens before emit, and accepts admission only", async () => {
  const fixture = busFixture();
  const cleanup = fixture.bus.on(STATUS_ACTION_OPEN, (value) => {
    const request = value as Record<string, unknown>;
    assert.deepEqual(request, {
      version: 1,
      requestId: request.requestId,
      providerId: "owner",
      surfaceId: "surface",
      sessionId: "session",
      actionId: "detail",
    });
    fixture.bus.emit(`${STATUS_ACTION_OPEN}:reply:${request.requestId}`, reply({ accepted: true }));
  });
  assert.equal(await openStatusAction(fixture.bus, descriptor, new AbortController().signal), true);
  cleanup();
  assert.equal(fixture.listeners.size, 0);
});

test.each(["query", "open"])("%s rechecks a live owner before accepting late replies", async (kind) => {
  const fixture = busFixture();
  let current = true;
  const signal = new AbortController().signal;
  const pending =
    kind === "query"
      ? discoverStatusActions(fixture.bus, "session", signal, () => current)
      : openStatusAction(fixture.bus, descriptor, signal, () => current);
  const request = fixture.emitted[0]?.value as StatusActionQuery;
  current = false;
  fixture.bus.emit(
    `${kind === "query" ? STATUS_ACTION_QUERY : STATUS_ACTION_OPEN}:reply:${request.requestId}`,
    reply(kind === "query" ? snapshot() : { accepted: true }),
  );
  assert.deepEqual(await pending, kind === "query" ? [] : false);
  assert.equal(fixture.listeners.size, 0);
});

test.each(["query", "open"])("%s settles even if unsubscribe throws", async (kind) => {
  const fixture = busFixture();
  const bus = {
    ...fixture.bus,
    on(channel: string, handler: (data: unknown) => void) {
      const unsubscribe = fixture.bus.on(channel, handler);
      return () => {
        unsubscribe();
        throw new Error("cleanup fault");
      };
    },
  };
  const controller = new AbortController();
  const pending =
    kind === "query"
      ? discoverStatusActions(bus, "session", controller.signal)
      : openStatusAction(bus, descriptor, controller.signal);
  controller.abort();
  assert.deepEqual(await pending, kind === "query" ? [] : false);
  assert.equal(fixture.listeners.size, 0);
});

test("open ignores all malformed/getter/error replies and times out at two seconds", async () => {
  const fixture = busFixture();
  let gets = 0;
  const getter = {
    get accepted() {
      gets++;
      return true;
    },
  };
  const cleanup = fixture.bus.on(STATUS_ACTION_OPEN, (value) => {
    const channel = `${STATUS_ACTION_OPEN}:reply:${(value as StatusActionQuery).requestId}`;
    for (const payload of [
      null,
      {},
      { success: false, error: "\x1b[31muntrusted" },
      reply({ accepted: false }),
      reply({ accepted: true, extra: true }),
      reply(getter),
      Object.assign(Object.create({ success: true }), { data: { accepted: true } }),
    ])
      fixture.bus.emit(channel, payload);
  });
  const pending = openStatusAction(fixture.bus, descriptor, new AbortController().signal);
  await vi.advanceTimersByTimeAsync(1999);
  assert.equal(fixture.listeners.size, 2);
  await vi.advanceTimersByTimeAsync(1);
  assert.equal(await pending, false);
  assert.equal(gets, 0);
  cleanup();
  assert.equal(fixture.listeners.size, 0);
});
