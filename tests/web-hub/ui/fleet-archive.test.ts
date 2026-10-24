/**
 * web-hub archive plan — UI pure view-logic (archiveView.ts): narrowing the loose status slot,
 * per-kind partitioning, and the bash summary's archived-segment counting inputs. Component
 * behavior (fold/buttons/toast) is pinned by the drawer/tree component tests' helpers; these
 * pure functions are the seam the components consume.
 */
import { describe, expect, it } from "vitest";
import type { FleetRowWire } from "@protocol/messages.js";
import {
  archivedOf,
  archiveSetOf,
  partitionArchived,
} from "../../../src/web-hub/ui/src/components/fleet/archiveView.js";

function agentOf(status: Record<string, unknown> | undefined) {
  return { status } as unknown as Parameters<typeof archivedOf>[0];
}

const row = (runId: string, terminal = false): FleetRowWire =>
  ({ runId, terminal, status: terminal ? "completed" : "running" }) as unknown as FleetRowWire;

describe("archivedOf (status slot narrowing)", () => {
  it("returns undefined for absent/empty/malformed slots (pre-feature byte shape)", () => {
    expect(archivedOf(agentOf(undefined))).toBeUndefined();
    expect(archivedOf(agentOf({}))).toBeUndefined();
    expect(archivedOf(agentOf({ archived: null }))).toBeUndefined();
    expect(archivedOf(agentOf({ archived: { rev: 1, entries: [] } }))).toBeUndefined();
    expect(archivedOf(agentOf({ archived: "junk" }))).toBeUndefined();
  });

  it("returns the wire when entries exist", () => {
    const wire = { rev: 2, entries: [{ kind: "run" as const, id: "r1", at: 1, auto: true as const }] };
    expect(archivedOf(agentOf({ archived: wire }))).toEqual(wire);
  });
});

describe("archiveSetOf + partitionArchived", () => {
  const wire = {
    rev: 1,
    entries: [
      { kind: "run" as const, id: "r1", at: 1, auto: true as const },
      { kind: "run" as const, id: "r2", at: 2 },
      { kind: "bash" as const, id: "b1", at: 3 },
    ],
  };

  it("splits per kind and keeps wire order in both halves", () => {
    const runs = archiveSetOf(wire, "run");
    expect(runs.get("r1")?.auto).toBe(true);
    expect(runs.get("r2")?.auto).toBeUndefined();
    const p = partitionArchived([row("r3"), row("r1"), row("r2")], runs);
    expect(p.live.map((r) => r.runId)).toEqual(["r3"]);
    expect(p.archivedRows.map((r) => r.runId)).toEqual(["r1", "r2"]);
  });

  it("an archived id missing from the wire appears in neither half", () => {
    const p = partitionArchived([row("rX")], archiveSetOf(wire, "run"));
    expect(p.live.map((r) => r.runId)).toEqual(["rX"]);
    expect(p.archivedRows).toHaveLength(0);
  });

  it("empty set ⇒ everything live (byte-identical tree input)", () => {
    const rows = [row("r1"), row("r2")];
    expect(partitionArchived(rows, archiveSetOf(undefined, "run")).live).toEqual(rows);
  });
});
