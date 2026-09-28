import { describe, expect, it } from "vitest";
import { formatUiStatusLines } from "../../../src/web-hub/agent/ui-status.js";
import type { UiStatus } from "../../../src/web-hub/hub/ui-root.js";

const OPTS = { pkgDir: "/opt/pi-toolkit", version: "1.2.3", hasLocalDist: false };

describe("formatUiStatusLines (vue-plan.md v2.1 §2.3)", () => {
  it("ok: single info line with source/version/commit/builtAt", () => {
    const ui: UiStatus = {
      state: "ok",
      source: "package",
      version: "1.2.3",
      commit: "abc123def456",
      builtAt: "t1",
      candidates: [],
    };
    const lines = formatUiStatusLines(ui, OPTS);
    expect(lines).toEqual(["ui=ok source=package v1.2.3 commit=abc123def456 builtAt=t1"]);
  });

  it("ok via the external candidate: source=external in the line", () => {
    const ui: UiStatus = {
      state: "ok",
      source: "external",
      version: "1.2.3",
      commit: "unknown",
      builtAt: "t1",
      candidates: [],
    };
    const lines = formatUiStatusLines(ui, OPTS);
    expect(lines[0]).toContain("source=external");
  });

  it("unbuilt: a warning header, one line per rejected candidate, then both install methods", () => {
    const ui: UiStatus = {
      state: "unbuilt",
      candidates: [
        { kind: "package", dir: "/opt/pi-toolkit/dist/web-hub-ui", reason: "missing" },
        {
          kind: "external",
          dir: "/home/u/.pi/agent/web-hub-ui/1.2.3",
          reason: "version-mismatch",
          detail: "0.9.0 !== 1.2.3",
        },
      ],
    };
    const lines = formatUiStatusLines(ui, OPTS);
    expect(lines[0]).toMatch(/^warning/);
    expect(lines.some((l) => l.includes("package") && l.includes("missing"))).toBe(true);
    expect(lines.some((l) => l.includes("external") && l.includes("version-mismatch") && l.includes("0.9.0"))).toBe(
      true,
    );
    expect(lines.some((l) => l.includes("pi-toolkit-web-ui-1.2.3.zip"))).toBe(true);
    expect(lines.some((l) => l.includes("npm run build:web"))).toBe(true);
    expect(lines.some((l) => l.includes(OPTS.pkgDir))).toBe(true);
  });

  it("hub.json has no ui and no local dist: warns and still gives both install methods", () => {
    const lines = formatUiStatusLines(undefined, { ...OPTS, hasLocalDist: false });
    expect(lines[0]).toContain("hub 未上报 UI 状态");
    expect(lines.some((l) => l.includes("npm run build:web"))).toBe(true);
    expect(lines.some((l) => l.includes(".sha256"))).toBe(true);
  });

  it("hub.json has no ui but a local dist exists: no lines at all (nothing to warn about)", () => {
    const lines = formatUiStatusLines(undefined, { ...OPTS, hasLocalDist: true });
    expect(lines).toEqual([]);
  });

  it("the zip filename and release URL are derived from `version`", () => {
    const ui: UiStatus = { state: "unbuilt", candidates: [] };
    const lines = formatUiStatusLines(ui, { ...OPTS, version: "9.9.9" });
    expect(lines.some((l) => l.includes("pi-toolkit-web-ui-9.9.9.zip"))).toBe(true);
    expect(lines.some((l) => l.includes("v9.9.9"))).toBe(true);
  });
});
