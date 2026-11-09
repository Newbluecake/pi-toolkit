import { afterEach, describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { MemoryToolParamsV4 } from "../../../src/memory/unified/surface.js";
import { normalizeMemoryV4 } from "../../../src/memory/unified/normalize.js";
import { harness, snapshot } from "./helpers.js";
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((close) => close()));

it("publishes exactly the closed v4 fields with only command required", () => {
  expect(Object.keys(MemoryToolParamsV4.properties)).toEqual([
    "command",
    "scope",
    "path",
    "id",
    "text",
    "rev",
    "query",
    "topic",
    "from",
    "authority",
  ]);
  expect(MemoryToolParamsV4.required).toEqual(["command"]);
  expect(MemoryToolParamsV4.additionalProperties).toBe(false);
  expect(MemoryToolParamsV4.properties.scope.default).toBe("project");
  expect(Value.Check(MemoryToolParamsV4, { command: "view" })).toBe(true);
  for (const p of [
    {},
    { op: "view", storageScope: "session" },
    { command: "view", storageScope: "session" },
    { command: "view", extra: true },
    { command: "view", scope: "global" },
  ])
    expect(Value.Check(MemoryToolParamsV4, p)).toBe(false);
  expect(normalizeMemoryV4({ command: "view" })).toEqual({ ok: true, call: { command: "view", scope: "project" } });
  expect(normalizeMemoryV4({ op: "view", storageScope: "session" }, { alias: true })).toEqual({
    ok: true,
    call: { command: "view", scope: "session" },
  });
  expect(normalizeMemoryV4({ op: "view" }, { alias: true })).toMatchObject({ ok: false, code: "E_SCOPE_DISABLED" });
  expect(normalizeMemoryV4({ op: "view", storageScope: "all" }, { alias: true })).toMatchObject({
    ok: false,
    code: "E_SCOPE_DISABLED",
  });
  expect(normalizeMemoryV4({ op: "search", storageScope: "session" }, { alias: true })).toMatchObject({
    ok: false,
    code: "E_META_INVALID",
  });
  expect(normalizeMemoryV4({ op: "view", storageScope: "session" })).toMatchObject({
    ok: false,
    code: "E_META_INVALID",
  });
});
it.each([
  { command: "view", op: "view" },
  { command: "view", op: "delete" },
  { command: "view", scope: "session", storageScope: "session" },
  { command: "view", scope: "session", storageScope: "hub" },
])("rejects conflicts instead of silently selecting one: %j", (params) => {
  for (const alias of [true, false])
    expect(normalizeMemoryV4(params, { alias })).toMatchObject({ ok: false, code: "E_META_INVALID" });
});

const allForbidden = ["path", "id", "text", "rev", "topic", "from", "authority"];
describe("all preflight", () => {
  it("rejects every forbidden field/write and missing query before any port or approval", async () => {
    const h = harness();
    cleanups.push(h.close);
    const before = snapshot(h.dir),
      branch = h.manager.getBranch();
    const cases: object[] = [
      ...["create", "update", "delete"].map((command) => ({
        command,
        scope: "all",
        topic: "topic",
        text: "never",
        path: "topic.001",
        id: "n1",
        rev: "deadbeef",
      })),
      { command: "search", scope: "all" },
      { command: "search", scope: "all", query: "" },
      { command: "view", scope: "all", query: "never" },
      ...["view", "search"].flatMap((command) =>
        allForbidden.map((field) => ({
          command,
          scope: "all",
          ...(command === "search" ? { query: "x" } : {}),
          [field]: field === "authority" ? "agent" : "",
        })),
      ),
    ];
    for (const input of cases) expect(await h.call(input)).toMatchObject({ ok: false, code: "E_META_INVALID" });
    expect(h.projectRun).not.toHaveBeenCalled();
    expect(h.projectInspect).not.toHaveBeenCalled();
    expect(h.currentScoped).not.toHaveBeenCalled();
    expect(h.getBranch).not.toHaveBeenCalled();
    expect(h.select).not.toHaveBeenCalled();
    expect(h.append).not.toHaveBeenCalled();
    expect(snapshot(h.dir)).toEqual(before);
    expect(h.manager.getBranch()).toEqual(branch);
  });
});
it.each([
  [{ command: "view", path: "p", id: "n1" }, "E_META_INVALID"],
  [{ command: "view", scope: "session", path: "p" }, "E_META_INVALID"],
  [{ command: "view", scope: "project", from: "session:n1" }, "E_META_INVALID"],
  [{ command: "create", scope: "session", id: "", text: "x" }, "E_META_INVALID"],
  [{ command: "create", scope: "hub", rev: "", topic: "fact", text: "x" }, "E_META_INVALID"],
  [{ command: "update", scope: "session", id: "n1", text: "x" }, "E_REV_REQUIRED"],
  [{ command: "delete", scope: "hub", id: "fact.001" }, "E_REV_REQUIRED"],
  [{ command: "create", scope: "session", text: "x", topic: "fact" }, "E_META_INVALID"],
  [{ command: "create", scope: "hub", text: "x" }, "E_META_INVALID"],
  [{ command: "create", scope: "session", text: "x", from: "nope" }, "E_FROM_INVALID"],
])("validates field/scope rules: %j", (params, code) =>
  expect(normalizeMemoryV4(params)).toMatchObject({ ok: false, code }),
);
it("child authority precedes every other validation and every scope", async () => {
  const h = harness({ child: true });
  cleanups.push(h.close);
  for (const authority of ["agent", "user", "bad"])
    for (const scope of ["session", "hub", "project", "all"])
      expect(
        await h.call({ command: "create", op: "delete", scope, storageScope: "hub", authority, unknown: true }),
      ).toMatchObject({ ok: false, code: "E_CHILD_AUTHORITY" });
  expect(h.currentScoped).not.toHaveBeenCalled();
  expect(h.projectRun).not.toHaveBeenCalled();
  expect(h.select).not.toHaveBeenCalled();
});
