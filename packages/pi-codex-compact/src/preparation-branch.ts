import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** Raw source lineage only: never retain message bodies or inspect Goal data. */
export class PreparationBranchFence {
  private readonly sourceIds: readonly string[];

  constructor(branch: readonly SessionEntry[]) {
    this.sourceIds = branch.map((entry) => entry.id);
  }

  matches(branch: readonly SessionEntry[], leafId: string | null): boolean {
    if (branch.length < this.sourceIds.length || leafId !== (branch.at(-1)?.id ?? null)) return false;
    const seen = new Set(this.sourceIds);
    if (seen.size !== this.sourceIds.length) return false;
    for (let index = 0; index < this.sourceIds.length; index += 1) {
      if (branch[index].id !== this.sourceIds[index]) return false;
    }
    let tip = this.sourceIds.at(-1) ?? null;
    for (let index = this.sourceIds.length; index < branch.length; index += 1) {
      const entry = branch[index];
      if (
        entry.type !== "custom" ||
        entry.customType !== "goal-state" ||
        typeof entry.id !== "string" ||
        entry.id.length === 0 ||
        seen.has(entry.id) ||
        entry.parentId !== tip
      ) {
        return false;
      }
      seen.add(entry.id);
      tip = entry.id;
    }
    return true;
  }
}
