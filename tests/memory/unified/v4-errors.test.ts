import { symlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { MemoryError, memoryDirFor } from "../../../src/memory/paths.js";
import { readCorpus } from "../../../src/memory/blocks/store.js";
import { projectError, PROJECT_ERROR_MESSAGES } from "../../../src/memory/unified/errors.js";
import { createMemoryToolV4 } from "../../../src/memory/unified/tool.js";
import { createMemoryDispatcher } from "../../../src/memory/unified/dispatcher.js";
import { harness } from "./helpers.js";
const close: (() => void)[] = [];
afterEach(() => close.splice(0).forEach((fn) => fn()));

it.each(Object.entries(PROJECT_ERROR_MESSAGES))(
  "maps declared MemoryError %s without losing guidance",
  async (code, message) => {
    const originalMessage = `${code}: current rev 2-actual-hash\nfull body\nmigrate/gate/retry guidance`;
    const error = new MemoryError(originalMessage);
    expect(projectError(error)).toEqual({ code, message, originalCode: code, originalMessage });
    const v4 = createMemoryToolV4({
      child: false,
      scopesOn: false,
      currentScoped: () => undefined,
      project: {
        run: async () => {
          throw error;
        },
        inspect: () => {
          throw error;
        },
      },
    });
    expect(await v4.run("test", { command: "view" }, undefined, undefined)).toEqual({
      ok: false,
      code,
      message,
      originalCode: code,
      originalMessage,
    });
    const old = createMemoryDispatcher({
      project: async () => {
        throw error;
      },
      currentScoped: () => undefined,
    });
    await expect(old.project()).rejects.toBe(error);
  },
);
it.each([
  [new MemoryError("E_BLOCK: original detail"), "E_BLOCK"],
  [new MemoryError("E_OTHER_2: numbered code"), "E_OTHER_2"],
  [new MemoryError("E_META: invalid metadata"), "E_META"],
  [new MemoryError("refused: malformed comment"), undefined],
  [new Error("disk read failed"), undefined],
  [new Error("E_NOT_FOUND: ordinary error, not a MemoryError"), undefined],
] as const)("maps undeclared/ordinary errors to E_INTERNAL, never E_PERSIST: %j", (error, originalCode) => {
  expect(projectError(error)).toEqual({
    code: "E_INTERNAL",
    message: "project memory operation failed",
    ...(originalCode ? { originalCode } : {}),
    originalMessage: error.message,
  });
});
it("only v4 structures actual v3 failures; old tool continues throwing complete conflict instructions", async () => {
  const h = harness();
  close.push(h.close);
  await h.call({ command: "create", topic: "fact", text: "actual body" });
  const params = { command: "update", path: "fact.001", rev: "stale", text: "overwrite" };
  const result = await h.call(params);
  expect(result).toMatchObject({ ok: false, code: "E_CONFLICT", originalCode: "E_CONFLICT" });
  const originalMessage = (result as { originalMessage: string }).originalMessage;
  expect(originalMessage).toContain("actual body\nmerge and retry update with the current rev");
  await expect(h.v3.execute("old", params, undefined, undefined, h.ctx)).rejects.toThrow(originalMessage);
});
it("observes real project corpus poison before readCorpus's unchanged fallback", async () => {
  const h = harness();
  close.push(h.close);
  await h.call({ command: "create", topic: "fact", text: "persisted body" });
  const blocks = join(memoryDirFor(h.dir, h.projectDeps.paths), "blocks");
  const before = readFileSync(join(blocks, "fact.001.md"), "utf8");
  symlinkSync(join(h.dir, "missing-archive"), join(blocks, "archive"));
  expect(readCorpus(blocks).blocks).toEqual([]); // old fallback still unchanged
  const result = await h.call({ command: "view", scope: "all" });
  expect(result).toMatchObject({
    partial: true,
    scopeStatus: { project: { state: "poisoned", code: "E_INTERNAL" } },
    groups: { session: { kind: "items", items: [] }, hub: { kind: "items", items: [] } },
  });
  expect(result).not.toHaveProperty("groups.project");
  expect(readFileSync(join(blocks, "fact.001.md"), "utf8")).toBe(before);
});
