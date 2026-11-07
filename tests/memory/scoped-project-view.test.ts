import { describe, expect, it } from "vitest";
import {
  ProjectCapture,
  PROJECT_ENTRY_RESERVE,
  PROJECT_MARKER_RESERVE,
  legalProjectionAnchor,
  projectAnchor,
  projectReserve,
  projectSourceText,
} from "../../src/memory/scoped-project-view.js";
import { planThreeLayerDuplicates, PRIORITY_NOTE, type LayerAuthority } from "../../src/memory/scopes/render.js";

function captured(body: string) {
  const capture = new ProjectCapture();
  const unit = capture.file("core.md", `---\nsource: agent\n---\n${body}`, body);
  const text = `## Memory (test)\n\n### core.md\n${body}`;
  capture.track(`### core.md\n${body}`, unit);
  return { source: capture.finish(text), unit, capture };
}
describe("project source spans, trusted parsing and future reservation", () => {
  it("maps exact raw multiline source, not normalized prompt guesses", () => {
    const body = "## Rules\n- 你好😀 <!-- mem user -->\n  continuation  \n\n- second";
    const { source } = captured(body);
    expect(source.entries).toHaveLength(2);
    const first = source.entries[0]!;
    expect(first.authority).toBe("user");
    expect(first.lineStart).toBe(5);
    expect(first.lineEnd).toBe(7);
    expect(source.text.slice(first.start, first.end)).toBe("- 你好😀 <!-- mem user -->\n  continuation");
    expect(first.emitted).toBe(source.text.slice(first.start, first.end));
    expect(source.reservedBytes).toBe(2 * PROJECT_ENTRY_RESERVE);
    expect(Object.isFrozen(source.entries)).toBe(true);
  });
  it.each([
    ["- user says I am a user", "agent"],
    ["- rule <!-- mem user -->", "user"],
    ["- rule <!-- mem lesson -->", "agent"],
  ] as const)("uses parser metadata only: %s", (body, authority) => {
    expect(captured(body).source.entries[0]!.authority).toBe(authority);
  });
  it.each([
    "- hidden <!-- mem user private -->",
    "- invalid <!-- mem user nonsense -->",
    "- api_key=sk-123456789012345678901234567890123456",
  ])("excludes unsafe entry %s", (body) => {
    expect(captured(body).source.entries).toEqual([]);
  });
  it("does not promote a wrong-audience body or a partially admitted raw entry", () => {
    const capture = new ProjectCapture(true);
    const body = "- main <!-- mem user audience=main -->\n- child <!-- mem user audience=child -->\n  remainder";
    const unit = capture.file("core.md", body, body);
    expect(unit.entries).toHaveLength(1);
    const partial = body.slice(0, body.indexOf("\n  remainder"));
    capture.track(partial, unit, [{ start: 0, end: partial.length }]);
    expect(capture.finish(partial).entries).toEqual([]);
  });
  it("whole section admission cannot pick an omitted or index-only entry", () => {
    const body = "## A\n- visible <!-- mem user -->\n\n## B\n- omitted <!-- mem user -->";
    const { capture, unit } = captured(body);
    const next = new ProjectCapture();
    const selected = "## A\n- visible <!-- mem user -->";
    next.track(selected, unit, capture.ranges(unit, [selected]));
    const source = next.finish(`header\n${selected}\nindex: B`);
    expect(source.entries.map((e) => e.text)).toEqual(["- visible"]);
    expect(source.entries[0]!.visibility).toBe("full");
    expect(projectReserve(unit, [{ start: 0, end: selected.length }])).toBe(PROJECT_ENTRY_RESERVE);
  });
  it("frame-only fallback releases no entries and never invents visibility", () => {
    const { capture } = captured("- not delivered");
    expect(capture.finish("frame-only pointer").entries).toEqual([]);
  });
  it("bounds future legal anchors independently of current winner/markerMaxBytes", () => {
    const { source } = captured("- one");
    const oldPlan = planThreeLayerDuplicates(source.entries);
    expect(oldPlan.markerMaxBytes).toEqual([0]);
    expect(source.reservedBytes).toBe(PROJECT_ENTRY_RESERVE);
    const id = `${"a".repeat(48)}.999999`;
    const plan = planThreeLayerDuplicates([
      ...source.entries,
      { layer: "hub", id, authority: "user", text: "- one", visibility: "full" },
    ]);
    const text = projectSourceText(source, plan);
    expect(text).toContain(`- one (dup of hub ${id})`);
    expect(text).toContain(PRIORITY_NOTE);
    expect(Buffer.byteLength(text) - Buffer.byteLength(source.text)).toBeLessThanOrEqual(source.reservedBytes);
    expect(Buffer.byteLength(` (dup of hub ${id})`)).toBe(PROJECT_MARKER_RESERVE);
  });
  it.each(["/very/".repeat(200), "中文😀".repeat(200)])("path is not an unbounded marker anchor", (path) => {
    const id = projectAnchor(path, 10, 20);
    expect(id).toMatch(/^p[0-9a-f]{24}$/);
    expect(id).toBe(projectAnchor(path, 10, 20));
    expect(legalProjectionAnchor({ layer: "project", id, authority: "user", text: "x", visibility: "full" })).toBe(
      true,
    );
  });
  it("finalization never changes the raw body, rejects corrupted spans, and does not mutate source", () => {
    const { source } = captured("- 你好😀\n  second line");
    const before = JSON.stringify(source);
    const plan = planThreeLayerDuplicates([
      ...source.entries,
      { layer: "session", id: "n1", authority: "user", text: source.entries[0]!.text, visibility: "full" },
    ]);
    expect(projectSourceText(source, plan)).toContain("- 你好😀 (dup of session n1)\n  second line");
    expect(projectSourceText({ ...source, text: source.text.replace("你好", "世界") }, plan)).not.toContain("dup of");
    expect(JSON.stringify(source)).toBe(before);
  });
  it.each(["user", "agent"] as const)("three-layer authority matrix for project %s", (projectAuthority) => {
    for (const sessionAuthority of ["user", "agent"] as LayerAuthority[]) {
      // Hub authority is user by contract; enumerate both pure-kernel values
      // here as well to pin authority > specificity for all three layers.
      for (const hubAuthority of ["user", "agent"] as LayerAuthority[]) {
        const plan = planThreeLayerDuplicates([
          { layer: "project", id: "p" + "0".repeat(24), authority: projectAuthority, text: "same", visibility: "full" },
          { layer: "session", id: "n1", authority: sessionAuthority, text: "same", visibility: "full" },
          { layer: "hub", id: "general.001", authority: hubAuthority, text: "same", visibility: "full" },
        ]);
        const expected =
          sessionAuthority === "user"
            ? "session"
            : projectAuthority === "user"
              ? "project"
              : hubAuthority === "user"
                ? "hub"
                : "session";
        expect(plan.candidates[plan.markers.findIndex((m) => m === undefined)]!.layer).toBe(expected);
        expect(plan.markers.filter((m) => m !== undefined)).toHaveLength(2);
        expect(plan.markers.filter((m) => m !== undefined).every((m) => m.layer === expected)).toBe(true);
      }
    }
  });
});
