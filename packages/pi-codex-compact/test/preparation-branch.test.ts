import assert from "node:assert/strict";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { PreparationBranchFence } from "../src/preparation-branch.js";

function source(): SessionEntry[] {
  return ["root", "middle", "tip"].map((id, index, ids) => ({
    type: "custom",
    customType: "original-record",
    id,
    parentId: ids[index - 1] ?? null,
    timestamp: "2026-01-01T00:00:00.000Z",
  }));
}

function goal(id = "goal-1", parentId: string | null = "tip"): SessionEntry {
  return { type: "custom", customType: "goal-state", id, parentId, timestamp: "2026-01-01T00:00:00.000Z" };
}

test("preparation fence keeps only source IDs and never reads message bodies or Goal data", () => {
  const original = source();
  Object.defineProperty(original[0], "data", { get: () => assert.fail("must not read original data") });
  const fence = new PreparationBranchFence(original);
  assert.deepEqual(Object.values(fence), [["root", "middle", "tip"]]);
  const live = [...original, goal(), goal("goal-2", "goal-1")];
  for (const entry of live.slice(original.length)) {
    Object.defineProperty(entry, "data", { get: () => assert.fail("must not read Goal data") });
  }
  assert.equal(fence.matches(original, "tip"), true);
  assert.equal(fence.matches(live, "goal-2"), true);
  original.splice(0);
  assert.equal(fence.matches(live, "goal-2"), true, "source array is not retained");
  assert.equal(new PreparationBranchFence([]).matches([], null), true);
  assert.equal(new PreparationBranchFence([]).matches([goal("goal-1", null)], "goal-1"), true);
});

for (const type of [
  "message",
  "custom_message",
  "context_edit",
  "system",
  "model_change",
  "thinking_level_change",
  "compaction",
  "branch_summary",
  "label",
  "session_info",
  "unknown",
]) {
  test(`preparation fence rejects appended ${type}, even beside Goal bookkeeping`, () => {
    const original = source();
    const appended = { ...goal("other", "goal-1"), type } as SessionEntry;
    assert.equal(new PreparationBranchFence(original).matches([...original, goal(), appended], "other"), false);
  });
}

for (const customType of ["unknown", "pi.virtual-model-state", "Goal-state", "goal-state ", ""]) {
  test(`preparation fence rejects non-Goal custom type ${JSON.stringify(customType)}`, () => {
    const original = source();
    const appended = { ...goal("other", "goal-1"), customType };
    assert.equal(new PreparationBranchFence(original).matches([...original, goal(), appended], "other"), false);
  });
}

for (const [name, records] of [
  ["empty ID", [goal("")]],
  ["non-string ID", [{ ...goal(), id: 42 }]],
  ["reused original ID", [goal("root")]],
  ["reused appended ID", [goal(), goal("goal-1", "goal-1")]],
  ["first wrong parent", [goal("goal-1", "middle")]],
  ["first null parent", [goal("goal-1", null)]],
  ["later wrong parent", [goal(), goal("goal-2", "tip")]],
] as const) {
  test(`preparation fence rejects ${name}`, () => {
    const original = source();
    const live = [...original, ...records] as SessionEntry[];
    assert.equal(new PreparationBranchFence(original).matches(live, live.at(-1)?.id ?? null), false);
  });
}

for (const shape of ["sibling", "truncated", "reordered", "missing middle", "stale leaf", "null leaf"] as const) {
  test(`preparation fence rejects ${shape} with Goal bookkeeping`, () => {
    const original = source();
    const fence = new PreparationBranchFence(original);
    let live = [...original, goal()];
    let leaf: string | null = "goal-1";
    if (shape === "sibling") live = [original[0], original[1], goal("sibling", "middle"), goal("goal-1", "sibling")];
    if (shape === "truncated") live = [original[0], goal("goal-1", "root")];
    if (shape === "reordered") live = [original[1], original[0], original[2], goal()];
    if (shape === "missing middle") live = [original[0], original[2], goal()];
    if (shape === "stale leaf") leaf = "tip";
    if (shape === "null leaf") leaf = null;
    assert.equal(fence.matches(live, leaf), false);
  });
}
