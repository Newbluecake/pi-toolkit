import { describe, expect, it } from "vitest";
import type {
  ConsultGuard,
  ConsultGuardCounters,
  ConsultGuardPreflight,
  ExpertRequestSnapshot,
  SessionSpec,
} from "../../src/core/types.js";

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type SnapshotShape = {
  tools: Record<string, unknown>[];
  systemSections: Record<string, string>;
  model?: { provider: string; id: string };
  thinkingLevel?: string;
  sourceSessionId: string;
  lastRequestUsage?: { input: number; cacheRead: number; cacheWrite: number };
};
type GuardShape = {
  preflight(session: unknown): ConsultGuardPreflight;
  install(session: unknown): void;
  counters(): ConsultGuardCounters;
};
const snapshotShapePinned: Same<ExpertRequestSnapshot, SnapshotShape> = true;
const guardShapePinned: Same<ConsultGuard, GuardShape> = true;

describe("consult preserve package A freeze surface", () => {
  it("keeps the snapshot and narrow guard shapes unchanged", () => {
    const spec: SessionSpec = {
      consultGuard: {
        preflight: () => ({ ok: true }),
        install: () => undefined,
        counters: () => ({ calls: 0, batches: 0, terminated: false, identity: 0, nested: 0, costAfterUsd: 0 }),
      },
    };
    expect(snapshotShapePinned).toBe(true);
    expect(guardShapePinned).toBe(true);
    expect(spec.consultGuard).toBeDefined();
  });
});
