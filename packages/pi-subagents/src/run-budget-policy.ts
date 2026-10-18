import type { AgentSession } from "@earendil-works/pi-coding-agent";

export interface RunBudgets {
  maxTurns?: number;
  maxTokens?: number;
  maxToolCalls?: number;
}

// Session policy survives each prompt; counters and UI observers never do.
export const sessionBudgets = new WeakMap<AgentSession, RunBudgets>();
let defaultTurnPolicy: number | undefined;

export function getDefaultTurnPolicy(): number | undefined { return defaultTurnPolicy; }
export function setDefaultTurnPolicy(value: number | undefined): void { defaultTurnPolicy = value; }

/** Raw zero preserves authoritative unlimited policy across settings changes. */
export function selectResumeTurnPolicy(session: AgentSession, resolved?: number): number {
  if (resolved !== undefined) return resolved;
  const inherited = sessionBudgets.get(session);
  if (inherited) return inherited.maxTurns ?? 0;
  return defaultTurnPolicy ?? 0;
}
