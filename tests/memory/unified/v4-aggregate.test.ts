import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createMemoryToolV4 } from "../../../src/memory/unified/tool.js";
import { scopedFailure } from "../../../src/memory/scopes/error-messages.js";
import { memoryDirFor } from "../../../src/memory/paths.js";
import { harness } from "./helpers.js";
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((close) => close()));
function setup(options: Parameters<typeof harness>[0] = {}) {
  const h = harness(options);
  cleanups.push(h.close);
  return h;
}

it("returns the full getter-error JSON, preserving successful project and empty Hub", async () => {
  const h = setup();
  h.projectInspect.mockReturnValue({
    status: { state: "ok" },
    group: { kind: "listing", text: "PROJECT LISTING\nquota: 1 block" },
  });
  h.human();
  const created = (await h.call({ command: "create", scope: "hub", topic: "fact", text: "initialize" })) as {
    id: string;
    rev: string;
  };
  expect(created).toMatchObject({ ok: true });
  expect(await h.call({ command: "delete", scope: "hub", id: created.id, rev: created.rev })).toMatchObject({
    ok: true,
  });
  h.breakBranch(new Error("getBranch failed: broken branch"));
  expect(JSON.parse(JSON.stringify(await h.call({ command: "view", scope: "all" })))).toEqual({
    ok: true,
    partial: true,
    scopeStatus: {
      project: { state: "ok" },
      session: {
        state: "error",
        code: "E_INTERNAL",
        message: "session memory read failed",
        originalMessage: "getBranch failed: broken branch",
      },
      hub: { state: "empty" },
    },
    groups: {
      project: { kind: "listing", text: "PROJECT LISTING\nquota: 1 block" },
      hub: { kind: "items", items: [] },
    },
  });
});
it("keeps absent and successful empty groups, without partial", async () => {
  const h = setup();
  const result = await h.call({ command: "view", scope: "all" });
  expect(result).toEqual({
    ok: true,
    partial: false,
    scopeStatus: { project: { state: "absent" }, session: { state: "empty" }, hub: { state: "absent" } },
    groups: {
      project: { kind: "listing", text: `No block memory for ${h.dir} yet.` },
      session: { kind: "items", items: [] },
      hub: { kind: "items", items: [] },
    },
  });
  expect(h.append).not.toHaveBeenCalled();
});
it.each(["branch", "leaf", "file"] as const)("a throwing %s getter is error, never poisoned", async (getter) => {
  const h = setup();
  const error = new Error(`${getter} getter failed`);
  if (getter === "branch") h.breakBranch(error);
  else if (getter === "leaf") h.breakLeaf(error);
  else h.breakFile(error);
  const result = await h.call({ command: "search", scope: "all", query: "fact" });
  expect(result).toMatchObject({
    partial: true,
    scopeStatus: {
      session: {
        state: "error",
        code: "E_INTERNAL",
        message: "session memory read failed",
        originalMessage: error.message,
      },
    },
  });
  expect(result).toHaveProperty("groups.project", { kind: "hits", hits: [] });
  expect(result).toHaveProperty("groups.hub", { kind: "hits", hits: [] });
  expect(result).not.toHaveProperty("groups.session");
});
it("observed session persistence poison omits its entire group", async () => {
  const h = setup();
  h.failAppend();
  expect(await h.call({ command: "create", scope: "session", text: "body must never leak" })).toMatchObject({
    ok: false,
    code: "E_PERSIST_UNKNOWN",
  });
  const result = await h.call({ command: "view", scope: "all" });
  expect(result).toMatchObject({
    partial: true,
    scopeStatus: { session: { state: "poisoned", code: "E_PERSIST_UNKNOWN" } },
  });
  expect(result).not.toHaveProperty("groups.session");
  expect(JSON.stringify(result)).not.toContain("body must never leak");
});
it("inert Hub is a failed group, never items:[] or leaked metadata", async () => {
  const h = setup();
  h.human();
  expect(await h.call({ command: "create", scope: "hub", topic: "private", text: "hidden-body" })).toMatchObject({
    ok: true,
  });
  chmodSync(join(h.dir, "hub-state", "hub-memory"), 0o755);
  const result = await h.call({ command: "view", scope: "all" });
  expect(result).toMatchObject({ partial: true, scopeStatus: { hub: { state: "inert", code: "E_NAMESPACE" } } });
  expect(result).not.toHaveProperty("groups.hub");
  const status = (result as { scopeStatus: object }).scopeStatus;
  for (const forbidden of ["hidden-body", "private.001", "grant", '"rev"', '"id"'])
    expect(JSON.stringify(status)).not.toContain(forbidden);
});
it("ordinary Hub exceptions become error rather than namespace inert", async () => {
  const h = setup();
  vi.spyOn(h.hub.management, "status").mockImplementation(() => {
    throw new Error("hub read exploded");
  });
  const result = await h.call({ command: "view", scope: "all" });
  expect(result).toMatchObject({
    partial: true,
    scopeStatus: {
      hub: {
        state: "error",
        code: "E_INTERNAL",
        message: "hub memory read failed",
        originalMessage: "hub read exploded",
      },
    },
  });
  expect(result).not.toHaveProperty("groups.hub");
});
it("disabled gates never touch stores, including child Hub and scopes-off", async () => {
  const h = setup({ child: true });
  const hubStatus = vi.spyOn(h.hub.management, "status");
  expect(await h.call({ command: "view", scope: "all" })).toMatchObject({
    partial: true,
    scopeStatus: { hub: { state: "disabled" } },
    groups: { session: { kind: "items", items: [] } },
  });
  expect(hubStatus).not.toHaveBeenCalled();
  const off = setup({ scopesOn: false });
  expect(await off.call({ command: "search", scope: "all", query: "x" })).toMatchObject({
    partial: true,
    scopeStatus: { session: { state: "disabled" }, hub: { state: "disabled" } },
  });
  expect(off.currentScoped).not.toHaveBeenCalled();
  expect(off.getBranch).not.toHaveBeenCalled();
});
it("scoped resolver errors are isolated; the other groups still execute", async () => {
  const h = setup();
  let resolves = 0;
  const v4 = createMemoryToolV4({
    child: false,
    scopesOn: true,
    project: { run: h.projectRun, inspect: h.projectInspect },
    currentScoped: () => {
      if (++resolves === 1) throw new Error("owner getter failed");
      return h.alias;
    },
  });
  const result = await v4.run("test", { command: "view", scope: "all" }, undefined, h.ctx);
  expect(result).toMatchObject({
    partial: true,
    scopeStatus: { session: { state: "error", originalMessage: "owner getter failed" }, hub: { state: "absent" } },
    groups: { hub: { kind: "items", items: [] } },
  });
  expect(result).not.toHaveProperty("groups.session");
});
it("read gate failure uses a sanitized status and skips both store read ports", () => {
  const h = setup();
  const status = vi.spyOn(h.hub.management, "status");
  const disabled = { ...h.scopedDeps, capability: () => "locked" as const };
  // The new read port is independently usable without executing the old alias.
  return import("../../../src/memory/unified/read.js").then(({ inspectScopedMemory }) => {
    for (const scope of ["session", "hub"] as const) {
      const result =
        scope === "session"
          ? inspectScopedMemory(disabled, "session", { command: "view" })
          : inspectScopedMemory(disabled, "hub", { command: "view" });
      expect(result).toEqual({
        status: { state: "disabled", code: "E_WRITE_GATE", message: scopedFailure("E_WRITE_GATE").message },
      });
    }
    expect(status).not.toHaveBeenCalled();
    expect(h.getBranch).not.toHaveBeenCalled();
  });
});

it("files awaiting blocks migration preserve the original no-blocks listing verbatim", async () => {
  const h = setup();
  const dir = memoryDirFor(h.dir, h.projectDeps.paths);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "core.md"), "legacy body");
  const old = await h.v3.execute("old", { command: "view" }, undefined, undefined, h.ctx);
  const text = old.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
  expect(text).toContain("run /mem migrate");
  expect(await h.call({ command: "view", scope: "all" })).toMatchObject({
    partial: false,
    scopeStatus: { project: { state: "absent" } },
    groups: { project: { kind: "listing", text } },
  });
});
