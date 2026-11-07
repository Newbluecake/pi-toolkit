// #36 P4 (arch r5 §4.1) — the v3 memory tool: five commands, whole-block
// CAS, metadata inherit+override, the E_* matrix, #26 direct-write semantics,
// and the v2-side E_BLOCKS_DIR drift guard. Per-test tmpdir + paths
// injection (same style as tool-v2.test.ts); never the real
// ~/.pi/agent/memory.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS, type MemorySettings } from "../../src/config/settings.js";
import { memoryDirFor, type MemoryPaths } from "../../src/memory/paths.js";
import { createMemoryToolV3, type MemoryToolV3Deps } from "../../src/memory/tool-v3.js";
import { createMemoryToolV2 } from "../../src/memory/tool-v2.js";
import { blockToEntry } from "../../src/memory/blocks/adapter.js";
import { parseBlockFile } from "../../src/memory/blocks/format.js";
import { computeRev } from "../../src/memory/blocks/rev.js";
import { MemoryError } from "../../src/memory/paths.js";
import { writeBlocksDir, blockRaw, type BlockSpec } from "./blocks/helpers.js";
import { readDiagLines } from "../../src/memory/jev/diag-log.js";
import { entryHash } from "../../src/memory/jev/entries.js";

const tmpRoots: string[] = [];
/** exec()'s default ctx cwd — set by fixture() (the harness always execs
 *  against the most recently built fixture; explicit ctx overrides). */
let lastCwd = "/nowhere";
afterEach(() => {
  for (const d of tmpRoots.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Fixture {
  tmp: string;
  cwd: string;
  paths: MemoryPaths;
  memDir: string;
  realDir: string;
}

function fixture(specs: readonly BlockSpec[] = []): Fixture {
  const tmp = mkdtempSync(join(tmpdir(), "pi-mem-toolv3-"));
  tmpRoots.push(tmp);
  const cwd = join(tmp, "proj");
  mkdirSync(cwd, { recursive: true });
  const paths = { memoryRoot: join(tmp, "mem"), ccProjectsRoot: join(tmp, "cc") };
  const memDir = memoryDirFor(cwd, paths);
  const realDir = specs.length > 0 ? writeBlocksDir(memDir, specs) : join(memDir, "blocks");
  lastCwd = cwd;
  return { tmp, cwd, paths, memDir, realDir };
}

function ctx(cwd: string, opts: { hasUI?: boolean; notify?: (m: string, l?: string) => void } = {}): ExtensionContext {
  return {
    mode: opts.hasUI === false ? "rpc" : "tui",
    hasUI: opts.hasUI !== false,
    cwd,
    ui: { notify: opts.notify ?? (() => {}) },
  } as unknown as ExtensionContext;
}

function makeTool(
  fx: Fixture,
  over: { settings?: Partial<MemorySettings>; isChildSession?: boolean; onAfterWrite?: () => void } = {},
) {
  const onAfterWrite = over.onAfterWrite ?? (() => {});
  const tool = createMemoryToolV3({
    settings: { ...DEFAULT_SETTINGS.memory, layout: "blocks", ...over.settings },
    isChildSession: over.isChildSession ?? false,
    onAfterWrite,
    paths: fx.paths,
  });
  return { tool, onAfterWrite };
}

type V3Tool = ReturnType<typeof createMemoryToolV3>;

async function exec(tool: V3Tool, params: Record<string, unknown>, c: ExtensionContext = ctx(lastCwd)) {
  return (await tool.execute("call-1", params, undefined, undefined, c)) as {
    content: { type: string; text: string }[];
  };
}

function textOf(result: { content: { type: string; text: string }[] }): string {
  return result.content.map((c) => c.text).join("\n");
}

async function execErr(tool: V3Tool, params: Record<string, unknown>, c?: ExtensionContext): Promise<string> {
  try {
    await exec(tool, params, c);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected an error");
}

function block(fx: Fixture, id: string) {
  const parsed = parseBlockFile(`${id}.md`, readFileSync(join(fx.realDir, `${id}.md`), "utf8"));
  if ("stray" in parsed) throw new Error(`${id} is a stray`);
  return parsed;
}

const flush = async (n = 6): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

// ───────────────────── V01/V02: sizes + whole-block CAS ─────────────────────

describe("v3 create/update/delete basics", () => {
  test("create writes a block; 1024B body passes, 1025B fails E_TOO_LARGE (V01)", async () => {
    const fx = fixture();
    const { tool } = makeTool(fx);
    const ok = textOf(await exec(tool, { command: "create", topic: "quota", text: "- " + "x".repeat(1022) }));
    expect(ok).toContain("created quota.001 (topic quota) · rev ");
    expect(existsSync(join(fx.realDir, "quota.001.md"))).toBe(true);
    const err = await execErr(tool, { command: "create", topic: "quota", text: "- " + "x".repeat(1023) });
    expect(err).toContain("E_TOO_LARGE: block body is 1025B > 1024B — split it into several blocks");
  });

  test("byte counting is UTF-8 and excludes the inline comment", async () => {
    const fx = fixture();
    const { tool } = makeTool(fx);
    // 300 CJK chars = 900B body + a comment; the comment is not metered.
    const body = "- 规则".repeat(120);
    const res = textOf(
      await exec(tool, { command: "create", topic: "gen", text: `${body} <!-- mem user expires=2030-01-01 -->` }),
    );
    expect(res).toContain("created gen.001");
    const meta = block(fx, "gen.001").meta;
    expect(meta.authority).toBe("user");
    expect(meta.expires).toBe("2030-01-01");
    // the raw body in the file has no comment left (serializeBlock refuses it)
    expect(readFileSync(join(fx.realDir, "gen.001.md"), "utf8")).not.toContain("<!-- mem");
  });

  test("update is a whole-block replace with version+1 and a new rev (V02)", async () => {
    const fx = fixture([{ id: "quota.001", body: "- old fact" }]);
    const { tool } = makeTool(fx);
    const before = block(fx, "quota.001");
    const res = textOf(await exec(tool, { command: "update", path: "quota.001", rev: before.rev, text: "- new fact" }));
    expect(res).toContain(`updated quota.001 · rev ${block(fx, "quota.001").rev} (was ${before.rev})`);
    const after = block(fx, "quota.001");
    expect(after.meta.version).toBe(before.meta.version + 1);
    expect(after.body).toBe("- new fact");
    expect(after.rev).not.toBe(before.rev);
  });

  test("update accepts path aliases (id / id.md / /memories/id.md)", async () => {
    const fx = fixture([{ id: "quota.001", body: "- old" }]);
    const { tool } = makeTool(fx);
    const rev = block(fx, "quota.001").rev;
    const a = textOf(await exec(tool, { command: "update", path: "quota.001.md", rev, text: "- a" }));
    expect(a).toContain("updated quota.001");
    const rev2 = block(fx, "quota.001").rev;
    const b = textOf(await exec(tool, { command: "update", path: "/memories/quota.001.md", rev: rev2, text: "- b" }));
    expect(b).toContain("updated quota.001");
  });

  test("delete soft-deletes to blocks/.trash and reports the restore id", async () => {
    const fx = fixture([{ id: "quota.001", body: "- fact" }]);
    const { tool } = makeTool(fx);
    const res = textOf(await exec(tool, { command: "delete", path: "quota.001" }));
    expect(res).toContain("deleted quota.001 → .trash (restore: /mem restore --trash");
    expect(existsSync(join(fx.realDir, "quota.001.md"))).toBe(false);
    const trash = join(fx.realDir, ".trash");
    expect(existsSync(trash)).toBe(true);
  });
});

// ───────────────────── V02: the E_* matrix ─────────────────────

describe("v3 error matrix", () => {
  test("E_REV_REQUIRED: update without rev names the current rev", async () => {
    const fx = fixture([{ id: "quota.001", body: "- fact" }]);
    const { tool } = makeTool(fx);
    const err = await execErr(tool, { command: "update", path: "quota.001", text: "- x" });
    expect(err).toContain("E_REV_REQUIRED: update requires rev — current rev ");
  });

  test("E_CONFLICT: hand-edited bytes changed the rev after view", async () => {
    const fx = fixture([{ id: "quota.001", body: "- original" }]);
    const { tool } = makeTool(fx);
    const stale = block(fx, "quota.001").rev;
    writeFileSync(join(fx.realDir, "quota.001.md"), blockRaw({ id: "quota.001", body: "- hand edited" }));
    const err = await execErr(tool, { command: "update", path: "quota.001", rev: stale, text: "- model edit" });
    expect(err).toContain("E_CONFLICT: current rev ");
    expect(err).toContain("- hand edited");
    expect(err).toContain("merge and retry update with the current rev");
  });

  test("E_CONFLICT: concurrent update (second writer's rev is stale)", async () => {
    const fx = fixture([{ id: "quota.001", body: "- v1" }]);
    const { tool } = makeTool(fx);
    const rev1 = block(fx, "quota.001").rev;
    await exec(tool, { command: "update", path: "quota.001", rev: rev1, text: "- v2" });
    const err = await execErr(tool, { command: "update", path: "quota.001", rev: rev1, text: "- v2-again" });
    expect(err).toContain("E_CONFLICT");
    expect(block(fx, "quota.001").body).toBe("- v2");
  });

  test("E_TOO_LARGE: a migration-exempt oversize block still cannot stay oversize via update (V14)", async () => {
    const fx = fixture([{ id: "big.001", body: "x".repeat(1100), allowOversize: true }]);
    const { tool } = makeTool(fx);
    const rev = block(fx, "big.001").rev;
    const err = await execErr(tool, { command: "update", path: "big.001", rev, text: "y".repeat(1100) });
    expect(err).toContain("E_TOO_LARGE");
    // but shrinking it is the fix
    const ok = textOf(await exec(tool, { command: "update", path: "big.001", rev, text: "y".repeat(500) }));
    expect(ok).toContain("updated big.001");
  });

  test("E_UNMIGRATED: write commands on a files directory refuse with the migrate hint", async () => {
    const fx = fixture();
    mkdirSync(fx.memDir, { recursive: true });
    writeFileSync(join(fx.memDir, "core.md"), "---\nsource: agent\n---\n\n- legacy\n");
    const { tool } = makeTool(fx);
    for (const params of [
      { command: "create", topic: "a", text: "- x" },
      { command: "update", path: "a.001", rev: "1-x", text: "- x" },
      { command: "delete", path: "a.001" },
    ]) {
      expect(await execErr(tool, params)).toContain("E_UNMIGRATED");
    }
  });

  test("E_READONLY: child sessions cannot write by default (original copy preserved)", async () => {
    const fx = fixture([{ id: "quota.001", body: "- f" }]);
    const { tool } = makeTool(fx, { isChildSession: true });
    const err = await execErr(tool, { command: "create", topic: "x", text: "- x" }, ctx(fx.cwd));
    expect(err).toContain(
      "E_READONLY: child sessions are read-only for memory by default; enable memory.allowWriteInChildSessions to allow writes",
    );
    // read-only ops still work
    const view = textOf(await exec(tool, { command: "view", path: "quota.001" }, ctx(fx.cwd)));
    expect(view).toContain("#### quota.001");
  });

  test("E_BAD_TOPIC: non-canonical topics refuse with the canonical form", async () => {
    const fx = fixture();
    const { tool } = makeTool(fx);
    const err = await execErr(tool, { command: "create", topic: "My_Topic", text: "- x" });
    expect(err).toContain("E_BAD_TOPIC");
    expect(err).toContain(`"my-topic"`);
  });

  test("E_BAD_PATH / E_NOT_FOUND", async () => {
    const fx = fixture([{ id: "quota.001", body: "- f" }]);
    const { tool } = makeTool(fx);
    expect(await execErr(tool, { command: "update", path: "../escape", rev: "1-x", text: "- x" })).toContain(
      "E_BAD_PATH",
    );
    expect(await execErr(tool, { command: "update", path: "quota.009", rev: "1-x", text: "- x" })).toContain(
      "E_NOT_FOUND: block quota.009 does not exist",
    );
    expect(await execErr(tool, { command: "view", path: "quota.009" })).toContain("E_NOT_FOUND");
    expect(await execErr(tool, { command: "view", path: "no-such-topic" })).toContain("E_NOT_FOUND");
  });
});

// ───────────────────── V03: old commands are refused, never translated ─────────────────────

describe("v3 unsupported commands (host rejection + execute rejection are two paths)", () => {
  test("schema: the parameters enum rejects str_replace before execute (host path)", async () => {
    const { MemoryToolParamsV3 } = await import("../../src/memory/tool-surface.js");
    const { Value } = await import("typebox/value");
    expect(Value.Check(MemoryToolParamsV3, { command: "str_replace" })).toBe(false);
    expect(Value.Check(MemoryToolParamsV3, { command: "view" })).toBe(true);
    // extra properties pass typebox's default-tolerant objects → reach execute
    expect(Value.Check(MemoryToolParamsV3, { action: "write" })).toBe(true);
  });

  test.each(["insert", "str_replace", "rename", "write", "append"])(
    "E_UNSUPPORTED_COMMAND for command:%s with the block replacement recipe",
    async (cmd) => {
      const fx = fixture();
      const { tool } = makeTool(fx);
      const err = await execErr(tool, { command: cmd, path: "quota.001", old_str: "a" });
      expect(err).toContain(`E_UNSUPPORTED_COMMAND: "${cmd}" is not available: memory is block-based`);
      expect(err).toContain("view <id> for rev, then update path rev text (whole block ≤1024B)");
    },
  );

  test.each(["write", "append"])('E_UNSUPPORTED_COMMAND for action:"%s" (extra property path)', async (a) => {
    const fx = fixture();
    const { tool } = makeTool(fx);
    const err = await execErr(tool, { action: a, name: "core.md", content: "- x" });
    expect(err).toContain(`E_UNSUPPORTED_COMMAND: "action:${a}" is not available`);
  });

  test('action:"list" and command:"list" are treated as view', async () => {
    const fx = fixture([{ id: "quota.001", body: "- f" }]);
    const { tool } = makeTool(fx);
    const a = textOf(await exec(tool, { action: "list" }));
    expect(a).toContain("topics: 1 · blocks: 1 · global: 0");
    const b = textOf(await exec(tool, { command: "list" }));
    expect(b).toContain("topics: 1");
  });

  test("every execute-level rejection logs unsupported:<cmd> to the diag ring (fail-soft)", async () => {
    const fx = fixture([{ id: "quota.001", body: "- f" }]);
    const { tool } = makeTool(fx);
    await execErr(tool, { command: "str_replace", path: "quota.001", old_str: "a", new_str: "b" });
    await execErr(tool, { action: "append", name: "core.md", content: "- x" });
    await flush();
    const lines = readDiagLines(fx.memDir, 10).map((r) => r.line);
    expect(lines).toContain("unsupported:str_replace");
    expect(lines).toContain("unsupported:append");
  });

  test("v2 against a blocks directory: E_BLOCKS_DIR for block-path writes; root legacy writes stay open (V32 drift)", async () => {
    const fx = fixture([{ id: "quota.001", body: "- f" }]);
    const v2 = createMemoryToolV2({
      settings: { ...DEFAULT_SETTINGS.memory },
      isChildSession: false,
      onAfterWrite: () => {},
      paths: fx.paths,
    });
    for (const params of [
      { command: "str_replace", path: "blocks/quota.001.md", old_str: "- f", new_str: "b" },
      { command: "create", path: "blocks/new.md", file_text: "- x" },
      { command: "delete", path: "blocks/quota.001.md" },
      { action: "append", name: "blocks/quota.001.md", content: "x" },
    ]) {
      let message = "";
      try {
        await v2.execute("c", params, undefined, undefined, ctx(fx.cwd));
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain("E_BLOCKS_DIR");
    }
    // the block file itself is untouched…
    expect(readFileSync(join(fx.realDir, "quota.001.md"), "utf8")).toContain("- f");
    // …while a ROOT legacy write still lands (pre-reload writer ⇒ drift)
    writeFileSync(join(fx.memDir, "core.md"), "---\nsource: agent\n---\n\n- root\n");
    const out = textOf(
      (await v2.execute(
        "c",
        { action: "append", name: "core.md", content: "- drift" },
        undefined,
        undefined,
        ctx(fx.cwd),
      )) as never,
    );
    expect(out).toContain("appended to core.md");
    expect(readFileSync(join(fx.memDir, "core.md"), "utf8")).toContain("- drift");
  });
});

// ───────────────────── V11: metadata merge = inherit + override ─────────────────────

describe("v3 metadata merge (§4.1.4)", () => {
  test("omitting mem user does NOT demote a user rule", async () => {
    const fx = fixture([{ id: "gen.001", authority: "user", scope: "global", body: "- 用户令一条" }]);
    const { tool } = makeTool(fx);
    const rev = block(fx, "gen.001").rev;
    await exec(tool, { command: "update", path: "gen.001", rev, text: "- 用户令一条（改写正文，注释没写）" });
    const after = block(fx, "gen.001");
    expect(after.meta.authority).toBe("user");
    expect(after.meta.scope).toBe("global");
  });

  test("omitting scope keeps global; nothing EVER auto-promotes topic → global", async () => {
    const fx = fixture([
      { id: "gen.001", authority: "user", scope: "global", body: "- global rule" },
      { id: "gen.002", authority: "user", scope: "topic", body: "- decision" },
    ]);
    const { tool } = makeTool(fx);
    await exec(tool, { command: "update", path: "gen.001", rev: block(fx, "gen.001").rev, text: "- global rule v2" });
    expect(block(fx, "gen.001").meta.scope).toBe("global");
    // a topic user rule rewritten without scope stays topic…
    await exec(tool, { command: "update", path: "gen.002", rev: block(fx, "gen.002").rev, text: "- decision v2" });
    expect(block(fx, "gen.002").meta.scope ?? "topic").toBe("topic");
    // …and a brand-new user rule without scope is topic by default
    await exec(tool, { command: "create", topic: "gen", text: "- new user rule <!-- mem user -->" });
    expect(block(fx, "gen.003").meta.scope).toBeUndefined();
  });

  test("explicit scope=global works; explicit scope=topic demotes (a #26 change)", async () => {
    const fx = fixture([
      { id: "gen.001", authority: "user", scope: "topic", body: "- decision" },
      { id: "gen.002", authority: "user", scope: "global", body: "- standing" },
    ]);
    const { tool } = makeTool(fx);
    const res = textOf(
      await exec(tool, {
        command: "update",
        path: "gen.001",
        rev: block(fx, "gen.001").rev,
        text: "- decision <!-- mem user scope=global -->",
      }),
    );
    expect(block(fx, "gen.001").meta.scope).toBe("global");
    // promotion happens VIA a whole-block rewrite of a user rule — still a
    // #26 rewrite (voided echo + notify), while demotion is its own variant
    const res2 = textOf(
      await exec(tool, {
        command: "update",
        path: "gen.002",
        rev: block(fx, "gen.002").rev,
        text: "- standing <!-- mem user scope=topic -->",
      }),
    );
    expect(block(fx, "gen.002").meta.scope).toBe("topic");
    expect(res2).toContain("voided user rule: gen.002 (global → topic)");
  });

  test("expires=none clears an inherited expiry; expires=YYYY-MM-DD overrides it", async () => {
    const fx = fixture([{ id: "gen.001", authority: "agent", expires: "2030-01-01", body: "- fact" }]);
    const { tool } = makeTool(fx);
    await exec(tool, {
      command: "update",
      path: "gen.001",
      rev: block(fx, "gen.001").rev,
      text: "- fact <!-- mem expires=none -->",
    });
    expect(block(fx, "gen.001").meta.expires).toBeUndefined();
    await exec(tool, {
      command: "update",
      path: "gen.001",
      rev: block(fx, "gen.001").rev,
      text: "- fact <!-- mem expires=2031-06-01 -->",
    });
    expect(block(fx, "gen.001").meta.expires).toBe("2031-06-01");
    // and omitting expires keeps the inherited value
    await exec(tool, { command: "update", path: "gen.001", rev: block(fx, "gen.001").rev, text: "- fact v2" });
    expect(block(fx, "gen.001").meta.expires).toBe("2031-06-01");
  });

  test("mem lesson explicitly demotes user → agent (a #26 change with voided echo)", async () => {
    const fx = fixture([{ id: "gen.001", authority: "user", scope: "global", body: "- 用户令" }]);
    const { tool } = makeTool(fx);
    const res = textOf(
      await exec(tool, {
        command: "update",
        path: "gen.001",
        rev: block(fx, "gen.001").rev,
        text: "- 用户令 <!-- mem lesson -->",
      }),
    );
    expect(block(fx, "gen.001").meta.authority).toBe("agent");
    expect(res).toContain("voided user rule: gen.001 (demoted to agent)");
  });

  test("scope= on an agent block is ignored (server rule: scope is user-only)", async () => {
    const fx = fixture();
    const { tool } = makeTool(fx);
    await exec(tool, { command: "create", topic: "gen", text: "- fact <!-- mem lesson scope=global -->" });
    expect(block(fx, "gen.001").meta.authority).toBe("agent");
    expect(block(fx, "gen.001").meta.scope).toBeUndefined();
  });

  test("server-owned keys in the comment are ignored and echoed, not errors", async () => {
    const fx = fixture();
    const { tool } = makeTool(fx);
    const res = textOf(
      await exec(tool, {
        command: "create",
        topic: "gen",
        text: "- fact <!-- mem user rev=9 version=3 created=2020-01-01 -->",
      }),
    );
    expect(res).toContain("ignored: rev, version, created (server-owned)");
    expect(block(fx, "gen.001").meta.authority).toBe("user");
    expect(block(fx, "gen.001").meta.version).toBe(1);
  });

  test("inline-comment errors reject the write (bad expires, unknown key)", async () => {
    const fx = fixture();
    const { tool } = makeTool(fx);
    expect(await execErr(tool, { command: "create", topic: "gen", text: "- x <!-- mem expires=soon -->" })).toContain(
      "refused: the inline comment has errors",
    );
    expect(await execErr(tool, { command: "create", topic: "gen", text: "- x <!-- mem bogus=1 -->" })).toContain(
      "refused: the inline comment has errors",
    );
  });
});

// ───────────────────── V22: state snapshot advice (agent only) ─────────────────────

describe("v3 state snapshot echo (§5.3)", () => {
  test("agent block matching a snapshot pattern: strong advice, write succeeds", async () => {
    const fx = fixture();
    const { tool } = makeTool(fx);
    const res = textOf(await exec(tool, { command: "create", topic: "work", text: "- run r_abc123 正在跑，进度 2/5" }));
    expect(res).toContain("created work.001");
    expect(res).toContain("state snapshot: run id / progress — add expires=YYYY-MM-DD or until");
  });

  test("agent block WITH an expiry: no snapshot advice", async () => {
    const fx = fixture();
    const { tool } = makeTool(fx);
    const res = textOf(
      await exec(tool, {
        command: "create",
        topic: "work",
        text: "- run r_abc123 正在跑 <!-- mem expires=2026-12-31 -->",
      }),
    );
    expect(res).not.toContain("state snapshot:");
  });

  test("user blocks NEVER get the snapshot advice (用户令豁免)", async () => {
    const fx = fixture();
    const { tool } = makeTool(fx);
    const res = textOf(await exec(tool, { command: "create", topic: "work", text: "- 进度 2/5 <!-- mem user -->" }));
    expect(res).toContain("created work.001");
    expect(res).not.toContain("state snapshot:");
  });

  test("durable agent facts get no advice", async () => {
    const fx = fixture();
    const { tool } = makeTool(fx);
    const res = textOf(await exec(tool, { command: "create", topic: "work", text: "- always run tests before push" }));
    expect(res).not.toContain("state snapshot:");
  });
});

// ───────────────────── #29: #26 direct-write domain in v3 ─────────────────────

describe("v3 #26 user-rule changes: direct write, voided echo, TUI warning, no confirm", () => {
  test("rewriting a user rule: voided echo + one warning notify", async () => {
    const fx = fixture([{ id: "gen.001", authority: "user", scope: "global", body: "- 用户令" }]);
    const notifications: { message: string; level?: string }[] = [];
    const { tool } = makeTool(fx);
    const c = ctx(fx.cwd, { notify: (m, l) => notifications.push({ message: m, ...(l ? { level: l } : {}) }) });
    const res = textOf(
      await exec(tool, { command: "update", path: "gen.001", rev: block(fx, "gen.001").rev, text: "- 用户令 v2" }, c),
    );
    expect(res).toContain("voided user rule: gen.001");
    expect(block(fx, "gen.001").body).toBe("- 用户令 v2");
    expect(notifications).toEqual([
      { message: "agent 改动了用户令 gen.001（已直接写入，未经确认）", level: "warning" },
    ]);
  });

  test("deleting a user rule: delete-kind notify + voided echo", async () => {
    const fx = fixture([{ id: "gen.001", authority: "user", scope: "global", body: "- 用户令" }]);
    const notifications: string[] = [];
    const { tool } = makeTool(fx);
    const res = textOf(
      await exec(tool, { command: "delete", path: "gen.001" }, ctx(fx.cwd, { notify: (m) => notifications.push(m) })),
    );
    expect(res).toContain("deleted gen.001 → .trash");
    expect(res).toContain("voided user rule: gen.001");
    expect(notifications).toEqual(["agent 删除了用户令 gen.001（块已移入 .trash，可用 /mem restore --trash 找回）"]);
  });

  test("creating a user rule is NOT a #26 change (no voided echo, no notify)", async () => {
    const fx = fixture();
    const notifications: string[] = [];
    const { tool } = makeTool(fx);
    const res = textOf(
      await exec(
        tool,
        { command: "create", topic: "gen", text: "- 新用户令 <!-- mem user -->" },
        ctx(fx.cwd, { notify: (m) => notifications.push(m) }),
      ),
    );
    expect(res).toContain("created gen.001");
    expect(res).not.toContain("voided user rule");
    expect(notifications).toEqual([]);
  });

  test("agent-block edits notify nobody", async () => {
    const fx = fixture([{ id: "gen.001", authority: "agent", body: "- fact" }]);
    const notifications: string[] = [];
    const { tool } = makeTool(fx);
    await exec(
      tool,
      { command: "update", path: "gen.001", rev: block(fx, "gen.001").rev, text: "- fact v2" },
      ctx(fx.cwd, { notify: (m) => notifications.push(m) }),
    );
    expect(notifications).toEqual([]);
  });

  test("an aborted commit signal stops a user-rule write before disk", async () => {
    const fx = fixture([{ id: "gen.001", authority: "user", scope: "global", body: "- 用户令" }]);
    const { tool } = makeTool(fx, {
      settings: {},
    });
    const controller = new AbortController();
    controller.abort();
    const toolDef = tool as unknown as {
      execute: (id: string, p: unknown, s: AbortSignal, u: unknown, c: unknown) => Promise<unknown>;
    };
    let message = "";
    try {
      await toolDef.execute(
        "call-1",
        { command: "update", path: "gen.001", rev: block(fx, "gen.001").rev, text: "- x" },
        controller.signal,
        undefined,
        ctx(fx.cwd),
      );
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("aborted before commit");
    expect(block(fx, "gen.001").body).toBe("- 用户令");
  });
});

// ───────────────────── view / search shapes (§4.1.2) ─────────────────────

describe("v3 view and search", () => {
  test("view (no path): headline, budget line, topic table with counts", async () => {
    const fx = fixture([
      { id: "general.001", authority: "user", scope: "global", body: "- 常驻规则" },
      { id: "general.002", authority: "user", body: "- 决策记录" },
      { id: "quota.001", authority: "agent", body: "- agent fact" },
      { id: "quota.002", authority: "agent", expires: "2026-01-01", body: "- expired fact" },
      { id: "old.001", supersededBy: "quota.001", body: "- superseded stub" },
    ]);
    const { tool } = makeTool(fx);
    const res = textOf(await exec(tool, { command: "view" }));
    expect(res).toContain("topics: 3 · blocks: 4 · global: 1");
    expect(res).toMatch(/resident 0\.\dk\/2\.0k · index 0\.\dk\/2\.0k/);
    expect(res).toContain("- general");
    expect(res).toContain("· 2 blocks");
    expect(res).toContain("· 1 decisions");
    expect(res).toContain("· 1 expired");
    expect(res).toContain("· 1 superseded");
  });

  test("view <id>: full header (created/updated/supersededBy) + body", async () => {
    const fx = fixture([
      { id: "quota.001", authority: "user", scope: "global", audience: "main", expires: "2030-01-01", body: "- rule" },
      { id: "old.001", supersededBy: "quota.001", body: "- old" },
    ]);
    const { tool } = makeTool(fx);
    const res = textOf(await exec(tool, { command: "view", path: "quota.001" }));
    expect(res).toContain(`#### quota.001 · rev ${block(fx, "quota.001").rev} · user · global · audience main`);
    expect(res).toContain("· expires 2030-01-01");
    expect(res).toContain("· created 2026-01-01 · updated 2026-01-02");
    expect(res).toContain("- rule");
    const old = textOf(await exec(tool, { command: "view", path: "old.001" }));
    expect(old).toContain("· superseded by quota.001");
  });

  test("view <topic>: summary line, active blocks grouped by section, superseded stubs", async () => {
    const fx = fixture([
      { id: "quota.001", section: "windows", body: "- a" },
      { id: "quota.002", section: "windows", body: "- b" },
      { id: "quota.003", body: "- no section" },
      { id: "quota.004", supersededBy: "quota.001", body: "- gone" },
    ]);
    const { tool } = makeTool(fx);
    const res = textOf(await exec(tool, { command: "view", path: "quota" }));
    expect(res).toContain("topic quota — sections: windows");
    expect(res.indexOf("## windows")).toBeGreaterThan(-1);
    expect(res).toContain("#### quota.001 · rev");
    expect(res).toContain("#### quota.004 · superseded by quota.001 (not injected)");
  });

  test("search: id · rev + hit line over active blocks", async () => {
    const fx = fixture([
      { id: "quota.001", body: "- the release checklist matters" },
      { id: "quota.002", supersededBy: "quota.001", body: "- release checklist OLD" },
    ]);
    const { tool } = makeTool(fx);
    const res = textOf(await exec(tool, { command: "search", query: "release checklist" }));
    expect(res).toContain(`quota.001 · rev ${block(fx, "quota.001").rev} › L1: - the release checklist matters`);
    expect(res).not.toContain("quota.002");
    expect(textOf(await exec(tool, { command: "search", query: "zzz-nomatch" }))).toContain("no matches");
  });

  test("delete of a block others were superseded by leaves a stay-superseded note", async () => {
    const fx = fixture([
      { id: "new.001", body: "- replacement" },
      { id: "old.001", supersededBy: "new.001", body: "- superseded" },
    ]);
    const { tool } = makeTool(fx);
    const res = textOf(await exec(tool, { command: "delete", path: "new.001" }));
    expect(res).toContain("note: 1 block(s) superseded by new.001 stay superseded: old.001");
  });
});

// ───────────────────── fresh-directory creation (§3.4) ─────────────────────

describe("v3 first write on an absent directory", () => {
  test("create builds blocks/ with a source:fresh marker", async () => {
    const fx = fixture();
    const { tool } = makeTool(fx);
    const res = textOf(await exec(tool, { command: "create", topic: "gen", text: "- first" }));
    expect(res).toContain("created gen.001");
    const marker = JSON.parse(readFileSync(join(fx.realDir, ".layout.json"), "utf8")) as { v: number; source: string };
    expect(marker.v).toBe(1);
    expect(marker.source).toBe("fresh");
  });

  test("view on an absent directory stays a hint, never an error", async () => {
    const fx = fixture();
    const { tool } = makeTool(fx);
    const res = textOf(await exec(tool, { command: "view" }));
    expect(res).toContain("No block memory for");
  });
});

// ───────────────────── adapter sanity reused by the write path ─────────────────────

describe("v3 write path blockToEntry/rev invariants", () => {
  test("rev = computeRev(version, raw); entry hash keys the sidecar", () => {
    const fx = fixture([{ id: "quota.001", body: "- fact" }]);
    const b = block(fx, "quota.001");
    expect(b.rev).toBe(computeRev(b.meta.version, b.raw));
    const entry = blockToEntry(b, "2026-11-06");
    expect(entry.file).toBe("quota.001.md");
    expect(entry.hash).toBe(entryHash(entry.body));
    expect(entry.block?.id).toBe("quota.001");
    expect(entry).not.toHaveProperty("heading"); // heading only on MemEntry.heading
  });
});

// ───────────────────── 修复轮（verifier r_RSEVG6HT）─────────────────────

describe("v3 fix-round additions", () => {
  test("until=none clears an inherited event expiry end-to-end", async () => {
    const fx = fixture([{ id: "gen.001", authority: "agent", until: "release shipped", body: "- fact" }]);
    const { tool } = makeTool(fx);
    expect(block(fx, "gen.001").meta.until).toBe("release shipped");
    await exec(tool, {
      command: "update",
      path: "gen.001",
      rev: block(fx, "gen.001").rev,
      text: "- fact <!-- mem until=none -->",
    });
    expect(block(fx, "gen.001").meta.until).toBeUndefined();
    // and omitting until keeps an inherited one
    await exec(tool, {
      command: "update",
      path: "gen.001",
      rev: block(fx, "gen.001").rev,
      text: '- fact v2 <!-- mem until="later" -->',
    });
    expect(block(fx, "gen.001").meta.until).toBe("later");
    await exec(tool, { command: "update", path: "gen.001", rev: block(fx, "gen.001").rev, text: "- fact v3" });
    expect(block(fx, "gen.001").meta.until).toBe("later");
  });

  test("a global write shows the resident line within budget (not only over budget)", async () => {
    const fx = fixture([{ id: "gen.001", authority: "user", scope: "global", body: "- rule" }]);
    const { tool } = makeTool(fx);
    const res = textOf(
      await exec(tool, {
        command: "update",
        path: "gen.001",
        rev: block(fx, "gen.001").rev,
        text: "- rule v2 <!-- mem user scope=global -->",
      }),
    );
    expect(res).toMatch(/resident: 0\.\dk\/2\.0k$/m);
    expect(res).not.toContain("over budget");
    // a topic write within budget shows NO resident line
    const res2 = textOf(
      await exec(tool, {
        command: "update",
        path: "gen.001",
        rev: block(fx, "gen.001").rev,
        text: "- decision <!-- mem user scope=topic -->",
      }),
    );
    expect(res2).not.toMatch(/^resident:/m);
  });

  test("audience echo fires on main-session evidence without an explicit audience", async () => {
    const fx = fixture();
    const { tool } = makeTool(fx);
    const res = textOf(await exec(tool, { command: "create", topic: "gen", text: "- 派发前先在主会话确认预算" }));
    expect(res).toContain("audience: looks main-session-only (主会话) — add audience=main if so");
    // explicit audience suppresses the suggestion
    const res2 = textOf(
      await exec(tool, { command: "create", topic: "gen", text: "- 派发规则 <!-- mem audience=all -->" }),
    );
    expect(res2).not.toContain("audience:");
    // no evidence word ⇒ no suggestion
    const res3 = textOf(await exec(tool, { command: "create", topic: "gen", text: "- plain fact" }));
    expect(res3).not.toContain("audience:");
  });

  test("normalizeV3 notes surface in the echo (ignored v2-era fields + recipe)", async () => {
    const fx = fixture([{ id: "gen.001", authority: "agent", body: "- fact" }]);
    const { tool } = makeTool(fx);
    const res = textOf(
      await exec(tool, {
        command: "view",
        path: "gen.001",
        old_str: "stale",
        new_str: "x",
        file_text: "leftover",
      }),
    );
    expect(res).toContain("note: ignored params: old_str, new_str, file_text");
    const res2 = textOf(
      await exec(tool, {
        command: "update",
        path: "gen.001",
        rev: block(fx, "gen.001").rev,
        text: "- fact v2",
        old_str: "x",
      }),
    );
    expect(res2).toContain("note: ignored params: old_str");
    expect(res2).toContain("updated gen.001");
  });

  test("a refusing gate blocks every write op with E_WRITE_GATE and nothing lands on disk", async () => {
    const fx = fixture([{ id: "gen.001", authority: "agent", body: "- fact" }]);
    const refuse = { check: () => ({ ok: false as const, reason: "locked" as const }), capture: () => {} };
    const tool = createMemoryToolV3({
      settings: { ...DEFAULT_SETTINGS.memory, layout: "blocks" },
      isChildSession: false,
      onAfterWrite: () => {},
      paths: fx.paths,
      writeGate: refuse,
    });
    const before = readFileSync(join(fx.realDir, "gen.001.md"), "utf8");
    expect(
      await execErr(tool, { command: "update", path: "gen.001", rev: block(fx, "gen.001").rev, text: "- x" }),
    ).toContain("E_WRITE_GATE: memory write refused (locked)");
    expect(await execErr(tool, { command: "delete", path: "gen.001" })).toContain("E_WRITE_GATE");
    expect(readFileSync(join(fx.realDir, "gen.001.md"), "utf8")).toBe(before);
  });

  test("absent-directory create uses bootstrap when present (and capture follows)", async () => {
    const fx = fixture();
    const calls: string[] = [];
    const gate = {
      check: (dir: string) => {
        calls.push(`check:${dir === fx.memDir ? "captured-ok" : "pre"}`);
        return { ok: true as const };
      },
      capture: (dir: string) => {
        calls.push(`capture:${dir === fx.memDir}`);
      },
      bootstrap: (dir: string) => {
        calls.push(`bootstrap:${dir === fx.memDir}`);
        return { ok: true as const };
      },
    };
    const tool = createMemoryToolV3({
      settings: { ...DEFAULT_SETTINGS.memory, layout: "blocks" },
      isChildSession: false,
      onAfterWrite: () => {},
      paths: fx.paths,
      writeGate: gate,
    });
    const res = textOf(await exec(tool, { command: "create", topic: "gen", text: "- first" }));
    expect(res).toContain("created gen.001");
    expect(calls[0]).toBe(`bootstrap:${true}`);
    expect(calls).toContain(`capture:${true}`);
    // the store's in-lock ops re-checked through the gate
    expect(calls.filter((c) => c.startsWith("check:")).length).toBeGreaterThan(0);
    expect(existsSync(join(fx.realDir, "gen.001.md"))).toBe(true);
  });

  test("a refusing bootstrap blocks the absent-directory create before any mkdir", async () => {
    const fx = fixture();
    const refuse = {
      check: () => ({ ok: false as const, reason: "identity-changed" as const }),
      capture: () => {},
      bootstrap: () => ({ ok: false as const, reason: "unmounted" as const }),
    };
    const tool = createMemoryToolV3({
      settings: { ...DEFAULT_SETTINGS.memory, layout: "blocks" },
      isChildSession: false,
      onAfterWrite: () => {},
      paths: fx.paths,
      writeGate: refuse,
    });
    expect(await execErr(tool, { command: "create", topic: "gen", text: "- first" })).toContain(
      "E_WRITE_GATE: memory write refused (unmounted)",
    );
    expect(existsSync(fx.memDir)).toBe(false); // no substitute dir in the clear
  });

  test("gates without bootstrap keep the check() semantics (old gate implementations unchanged)", async () => {
    const fx = fixture();
    let checked = 0;
    const legacyGate = {
      check: () => {
        checked += 1;
        return { ok: true as const };
      },
      capture: () => {},
    };
    const tool = createMemoryToolV3({
      settings: { ...DEFAULT_SETTINGS.memory, layout: "blocks" },
      isChildSession: false,
      onAfterWrite: () => {},
      paths: fx.paths,
      writeGate: legacyGate,
    });
    const res = textOf(await exec(tool, { command: "create", topic: "gen", text: "- first" }));
    expect(res).toContain("created gen.001");
    expect(checked).toBeGreaterThan(0);
  });
});
