import { describe, expect, it } from "vitest";
import { formatUiStatusLines } from "../../../src/web-hub/agent/ui-status.js";
import { statusLineText } from "../../../src/web-hub/agent/index.js";
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

// web-hub-steer-recall plan §4.7 step 14 (A6) / §9 (`ui-status.test.ts` +3) + arch §11.1:
// the held marker is the LITERAL `web held N` — the count replaces the state glyph, never the
// `web ● held N` variant the plan body once described. Without `extra` the rendering is
// byte-identical to the pre-feature marker (W4, also pinned by wiring.test.ts).
describe("statusLineText held marker (web-hub-steer-recall A6, arch §11.1)", () => {
  const view = { state: "live", attached: true } as Parameters<typeof statusLineText>[0];
  const theme = { fg: (c: string, t: string) => `<${c}>${t}</>` };

  it("held > 0 ⇒ the EXACT string `web held N` replaces the state glyph (not `web ● held N`)", () => {
    expect(statusLineText(view, undefined, { held: 2 })).toBe("web held 2");
    expect(statusLineText(view, undefined, { held: 1 })).toBe("web held 1");
    // the explicitly rejected variant (arch §11.1: 不用 `web ● held N` 变体)
    expect(statusLineText(view, undefined, { held: 2 })).not.toBe("web ● held 2");
    expect(statusLineText(view, undefined, { held: 2 })).not.toContain("●");
  });

  it("themed: dim label + state-coloured `held N`", () => {
    expect(statusLineText(view, theme, { held: 1 })).toBe("<dim>web</> <success>held 1</>");
    expect(statusLineText({ state: "backoff", attached: true } as never, theme, { held: 3 })).toBe(
      "<dim>web</> <error>held 3</>",
    );
    // no theme object at all ⇒ same plain literal
    expect(statusLineText(view, undefined, { held: 3 })).toBe("web held 3");
  });

  it("no extra / held 0 ⇒ byte-identical pre-feature rendering, and stop-marker lines never grow a count", () => {
    expect(statusLineText(view)).toBe("web ●");
    expect(statusLineText(view, theme)).toBe("<dim>web</> <success>●</>");
    expect(statusLineText(view, theme, {})).toBe("<dim>web</> <success>●</>");
    expect(statusLineText(view, theme, { held: 0 })).toBe("<dim>web</> <success>●</>");
    const stopped = { state: "live", attached: true, stopMarker: "stopped" } as never;
    expect(statusLineText(stopped, theme, { held: 4 })).toBe("<dim>web</> <error>stopped</>");
    expect(statusLineText(stopped, undefined, { held: 4 })).toBe("web stopped");
    expect(statusLineText({ state: "off", attached: false } as never, undefined, { held: 9 })).toBeUndefined();
  });
});
