/**
 * web-hub-cmd-history plan §4.9 (A1) — `/webhub status`'s cmd-history line.
 * Pure formatting, English compact tokens (AGENTS.md UI-text rule), mirrors cmd-args-status.ts.
 */
import { describe, expect, it } from "vitest";
import { formatCmdHistoryStatusLines, cmdHistoryStatusLevel } from "../../../src/web-hub/agent/cmd-history-status.js";

describe("formatCmdHistoryStatusLines", () => {
  it("off ⇒ the single confirmation line, nothing else", () => {
    expect(
      formatCmdHistoryStatusLines({
        enabled: false,
        hubCaps: undefined,
        counters: { appended: 0, skipped: 0, failed: 0 },
      }),
    ).toEqual(["cmd-history: off"]);
    expect(
      formatCmdHistoryStatusLines({
        enabled: false,
        hubCaps: ["cmd.history.v1"],
        counters: { appended: 9, skipped: 1, failed: 2 },
      }),
    ).toEqual(["cmd-history: off"]);
  });

  it("on + no live link ⇒ hub-cap n/a", () => {
    expect(
      formatCmdHistoryStatusLines({
        enabled: true,
        hubCaps: undefined,
        counters: { appended: 0, skipped: 0, failed: 0 },
      }),
    ).toEqual(["cmd-history: on · hub-cap n/a · appended 0 · skipped 0 · failed 0"]);
  });

  it("on + live hub with the cap ⇒ hub-cap on", () => {
    expect(
      formatCmdHistoryStatusLines({
        enabled: true,
        hubCaps: ["cmd.args.v1", "cmd.history.v1"],
        counters: { appended: 3, skipped: 1, failed: 0 },
      }),
    ).toEqual(["cmd-history: on · hub-cap on · appended 3 · skipped 1 · failed 0"]);
  });

  it("on + live hub WITHOUT the cap ⇒ hub-cap off (old hub, or restart pending)", () => {
    const lines = formatCmdHistoryStatusLines({
      enabled: true,
      hubCaps: ["cmd.args.v1"],
      counters: { appended: 1, skipped: 0, failed: 0 },
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^cmd-history: on · hub-cap off /);
  });
});

describe("cmdHistoryStatusLevel", () => {
  it("only a live link lacking the cap is a warning; off/n/a are info", () => {
    expect(cmdHistoryStatusLevel(undefined)).toBe("info");
    expect(cmdHistoryStatusLevel("cmd-history: off")).toBe("info");
    expect(cmdHistoryStatusLevel("cmd-history: on · hub-cap n/a · appended 0 · skipped 0 · failed 0")).toBe("info");
    expect(cmdHistoryStatusLevel("cmd-history: on · hub-cap on · appended 0 · skipped 0 · failed 0")).toBe("info");
    expect(
      cmdHistoryStatusLevel(
        "cmd-history: on · hub-cap off (old hub, or /webhub restart pending) · appended 0 · skipped 0 · failed 0",
      ),
    ).toBe("warning");
  });
});
