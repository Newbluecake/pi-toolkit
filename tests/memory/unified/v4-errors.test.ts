import { symlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryError, memoryDirFor } from "../../../src/memory/paths.js";
import { readCorpus } from "../../../src/memory/blocks/store.js";
import { projectError, PROJECT_ERROR_MESSAGES } from "../../../src/memory/unified/errors.js";
import { createMemoryToolV4 } from "../../../src/memory/unified/tool.js";
import { createMemoryDispatcher } from "../../../src/memory/unified/dispatcher.js";
import { harness, snapshot } from "./helpers.js";
import * as memoryLock from "../../../src/memory/lock.js";
import * as blockStore from "../../../src/memory/blocks/store.js";
import { createMemoryToolV3 } from "../../../src/memory/tool-v3.js";
import { createJevWritePort } from "../../../src/memory/jev/write-port.js";
import { EntryIndex } from "../../../src/memory/jev/entries.js";
import { mergeTaxonomy } from "../../../src/memory/jev/taxonomy.js";
const close: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  close.splice(0).forEach((fn) => fn());
});

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

it("maps only explicitly typed metadata refusals, without inferring from their message", () => {
  const originalMessage = "refused: malformed comment";
  const cause = new Error("internal cause must not be serialized");
  const error = new MemoryError(originalMessage, { code: "E_META_INVALID", cause });
  expect(error.cause).toBe(cause);
  expect(projectError(error)).toEqual({
    code: "E_META_INVALID",
    message: "invalid project memory inline metadata",
    originalCode: "E_META_INVALID",
    originalMessage,
  });
  expect(projectError(new MemoryError(originalMessage))).toEqual({
    code: "E_INTERNAL",
    message: "project memory operation failed",
    originalMessage,
  });
  expect(projectError(Object.assign(new Error(originalMessage), { code: "E_META_INVALID" }))).toEqual({
    code: "E_INTERNAL",
    message: "project memory operation failed",
    originalMessage,
  });
});

it.each(["create", "update"] as const)(
  "%s inline syntax failures are E_META_INVALID before locks/store, with no partial block",
  async (command) => {
    const h = harness();
    close.push(h.close);
    if (command === "update")
      await h.call({ command: "create", topic: "fact", text: "<!-- mem user -->\noriginal user order" });
    const blocks = join(memoryDirFor(h.dir, h.projectDeps.paths), "blocks");
    const current = readCorpus(blocks).blocks[0];
    const params = command === "create" ? { command, topic: "fact" } : { command, path: "fact.001", rev: current!.rev };
    const before = snapshot(h.dir);
    const lock = vi.spyOn(memoryLock, "withMemoryDirLock");
    const create = vi.spyOn(blockStore, "createBlockLocked");
    const replace = vi.spyOn(blockStore, "replaceBlockLocked");
    h.projectDeps.onAfterWrite.mockClear();
    for (const [text, detail] of [
      ["<!-- mem authority=user -->\nnew body", 'unknown key "authority"'],
      ["<!-- mem expires=soon -->\nnew body", "not a valid"],
      ["<!-- mem user user -->\nnew body", "duplicate key"],
      ["<!-- mem user", "unterminated inline comment"],
    ]) {
      const result = await h.registeredCall({ ...params, text });
      expect(result).toMatchObject({
        ok: false,
        code: "E_META_INVALID",
        originalCode: "E_META_INVALID",
        message: "invalid project memory inline metadata",
      });
      expect(result.originalMessage).toContain(detail);
      expect(snapshot(h.dir)).toEqual(before);
      await expect(h.v3.execute("old", { ...params, text }, undefined, undefined, h.ctx)).rejects.toMatchObject({
        code: "E_META_INVALID",
        message: result.originalMessage,
      });
      expect(snapshot(h.dir)).toEqual(before);
    }
    expect(lock).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(h.projectDeps.onAfterWrite).not.toHaveBeenCalled();
    expect(h.select).not.toHaveBeenCalled();
  },
);

it.each(["create", "update"] as const)(
  "%s real Jev checkInline refusal also keeps its typed metadata code",
  async (command) => {
    const h = harness();
    close.push(h.close);
    if (command === "update")
      await h.call({ command: "create", topic: "fact", text: "<!-- mem user -->\noriginal user order" });
    const blocks = join(memoryDirFor(h.dir, h.projectDeps.paths), "blocks");
    const current = readCorpus(blocks).blocks[0];
    const ask = vi.fn(async () => {
      throw new Error("unexpected classifier request");
    });
    const taxonomy = mergeTaxonomy();
    if (!taxonomy.ok) throw new Error(taxonomy.error);
    const port = createJevWritePort({
      client: {
        status: () => ({ kind: "off", reason: "disabled" }),
        ask,
        probe: async () => ({ kind: "off", reason: "disabled" }),
      },
      entryIndex: new EntryIndex(),
      dirFor: () => memoryDirFor(h.dir, h.projectDeps.paths),
      taxonomyFor: () => taxonomy.taxonomy,
      now: () => 0,
    });
    const checkInline = vi.spyOn(port, "checkInline");
    const v3 = createMemoryToolV3({ ...h.projectDeps, jev: port });
    const v4 = createMemoryToolV4({
      child: false,
      scopesOn: false,
      currentScoped: () => undefined,
      project: {
        run: (id, params, signal, ctx: typeof h.ctx) => v3.execute(id, params, signal, undefined, ctx),
        inspect: h.projectInspect,
      },
    });
    const params = {
      ...(command === "create" ? { command, topic: "fact" } : { command, path: "fact.001", rev: current!.rev }),
      text: "- first line valid\n- second entry <!-- mem authority=user -->",
    };
    const before = snapshot(h.dir);
    const lock = vi.spyOn(memoryLock, "withMemoryDirLock");
    h.projectDeps.onAfterWrite.mockClear();
    const result = await v4.execute("actual-jevgate", params, undefined, undefined, h.ctx);
    const failure = JSON.parse(result.content[0]!.text);
    expect(failure).toMatchObject({
      ok: false,
      code: "E_META_INVALID",
      originalCode: "E_META_INVALID",
      message: "invalid project memory inline metadata",
    });
    expect(failure.originalMessage).toContain('would introduce inline-comment errors — unknown key "authority"');
    expect(checkInline).toHaveBeenCalledOnce();
    expect(ask).not.toHaveBeenCalled();
    expect(lock).not.toHaveBeenCalled();
    expect(h.projectDeps.onAfterWrite).not.toHaveBeenCalled();
    expect(snapshot(h.dir)).toEqual(before);
  },
);

it("legal first-line user/lesson markers persist the intended authority through create and update", async () => {
  const h = harness();
  close.push(h.close);
  const blocks = join(memoryDirFor(h.dir, h.projectDeps.paths), "blocks");
  await h.call({ command: "create", topic: "fact", text: "<!-- mem user -->\nuser order" });
  const created = readCorpus(blocks).blocks[0]!;
  expect(created.meta.authority).toBe("user");
  expect(created.body).toBe("user order");
  expect(created.raw).toContain("authority: user");
  await h.call({ command: "update", path: created.id, rev: created.rev, text: "<!-- mem user -->\nrevised order" });
  const updated = readCorpus(blocks).blocks[0]!;
  expect(updated.meta.authority).toBe("user");
  expect(updated.body).toBe("revised order");
  await h.call({ command: "create", topic: "fact", text: "<!-- mem lesson -->\nagent experience" });
  const lesson = readCorpus(blocks).blocks.find((b) => b.id !== created.id)!;
  expect(lesson.meta.authority).toBe("agent");
  expect(lesson.body).toBe("agent experience");
});
