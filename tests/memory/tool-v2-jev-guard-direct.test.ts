// #26 (no-user-guard-confirm plan §6): the user-order guard's direct-write
// form — no dialog, no remote card, no refusal by mode. A hit now goes:
// touched>0 plan (baseline + voided + noticeIds + commitSignal) → abort
// checkpoints (before and inside the lock) → commit → ONE warning notify on
// the main-session TUI. This file pins the failure/CAS/abort/sensitivity
// edges the rewritten tool-v2-jev.test.ts does not: A failures stay silent,
// B CAS binds a baseline not an outcome, C concurrent same-baseline writes
// commit exactly one, D/E abort checkpoints keep cancelled calls off disk
// (main session: tool ∪ session signal; child: tool only), F a throwing
// notify never fails the committed write, H sensitive headings/bodies stay
// out of the notify (the voided echo keeps them — known residual R-d), I the
// >10-entry fold line, J skip-path aborts never block and the child default
// read-only error is untouched.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { hostname } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS, type MemorySettings } from "../../src/config/settings.js";
import { memoryDirFor, type MemoryPaths } from "../../src/memory/paths.js";
import { createMemoryToolV2 } from "../../src/memory/tool-v2.js";
import { createJevWritePort } from "../../src/memory/jev/write-port.js";
import { EntryIndex } from "../../src/memory/jev/entries.js";
import { mergeTaxonomy } from "../../src/memory/jev/taxonomy.js";
import { lockCreate } from "../../src/memory/safe-fs.js";
import type { JevClient, JevStatus, JevWritePort } from "../../src/memory/jev/contracts.js";

const ABORTED = "aborted before commit; file unchanged";

interface Fixture {
  tmp: string;
  cwd: string;
  paths: MemoryPaths;
  memDir: string;
}

const tmpRoots: string[] = [];

function fixture(): Fixture {
  const tmp = mkdtempSync(join(tmpdir(), "pi-mem-direct-"));
  tmpRoots.push(tmp);
  const cwd = join(tmp, "proj");
  mkdirSync(cwd, { recursive: true });
  const paths = { memoryRoot: join(tmp, "mem"), ccProjectsRoot: join(tmp, "cc") };
  const memDir = memoryDirFor(cwd, paths);
  mkdirSync(memDir, { recursive: true });
  return { tmp, cwd, paths, memDir };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const d of tmpRoots.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeFile(dir: string, name: string, body: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body);
}

const AGENT_FM = "---\nsource: agent\nupdated: 2026-10-01T00:00:00.000Z\n---\n\n";

const FAKE_REGISTRY = {
  classify: () => {},
  getAvailableOfType: async () => [],
};

const PARTIAL: JevStatus = { kind: "partial", reason: "451", inactive: false };

/** Real guard port (real touchedUserEntries pairing) over an always-partial client. */
function realPort(fx: Fixture): JevWritePort {
  const client: JevClient = {
    status: () => PARTIAL,
    async ask() {
      return { ok: false, reason: "unavailable", detail: "down" };
    },
    async probe() {
      return PARTIAL;
    },
  };
  return createJevWritePort({
    client,
    entryIndex: new EntryIndex(),
    dirFor: (cwd) => memoryDirFor(cwd, fx.paths),
    taxonomyFor: () => mergeTaxonomy().taxonomy,
    now: () => Date.parse("2026-10-31T00:00:00Z"),
  });
}

interface NotifyCall {
  message: string;
  level?: string;
}

function makeTool(
  fx: Fixture,
  over: {
    settings?: Partial<MemorySettings>;
    isChildSession?: boolean;
    jev?: JevWritePort;
    sessionSignal?: () => AbortSignal | undefined;
    notifyRec?: NotifyCall[];
  } = {},
) {
  const tool = createMemoryToolV2({
    settings: { ...DEFAULT_SETTINGS.memory, ...over.settings },
    isChildSession: over.isChildSession ?? false,
    onAfterWrite: () => {},
    paths: fx.paths,
    ...(over.jev === undefined ? {} : { jev: over.jev }),
    ...(over.sessionSignal === undefined ? {} : { sessionSignal: over.sessionSignal }),
  });
  return { tool };
}

function ctx(
  cwd: string,
  over: { mode?: string; hasUI?: boolean; notifyRec?: NotifyCall[]; notifyThrows?: boolean } = {},
): ExtensionContext {
  const hasUI = over.hasUI ?? true;
  return {
    mode: over.mode ?? "tui",
    hasUI,
    cwd,
    ui: {
      notify: over.notifyThrows
        ? () => {
            throw new Error("notify channel gone");
          }
        : (message: string, level?: string) => {
            over.notifyRec?.push({ message, ...(level === undefined ? {} : { level }) });
          },
      confirm: async () => {
        throw new Error("ui.confirm must never be called after #26");
      },
      select: async () => {
        throw new Error("ui.select must never be called after #26");
      },
    },
    modelRegistry: FAKE_REGISTRY,
  } as unknown as ExtensionContext;
}

async function exec(
  tool: ReturnType<typeof createMemoryToolV2>,
  params: Record<string, unknown>,
  c: ExtensionContext,
  o: { toolCallId?: string; signal?: AbortSignal } = {},
) {
  return (await tool.execute(o.toolCallId ?? "call-1", params as never, o.signal, undefined, c)) as {
    content: { type: string; text: string }[];
  };
}

function textOf(result: { content: { type: string; text: string }[] }): string {
  return result.content.map((c) => c.text).join("\n");
}

/** Hand-written file (no frontmatter ⇒ every entry a user order). */
const GUARD_FILE = "## Rules\n\n- 用户令一条\n";

/** Hold the memory dir lock from the outside with a live foreign owner. */
function holdLock(fx: Fixture): void {
  expect(lockCreate(fx.memDir, { pid: process.pid, host: hostname(), at: Date.now() })).toBe(true);
}
function releaseLock(fx: Fixture): void {
  rmSync(join(fx.memDir, ".lock"), { force: true });
}

// ───────────────────────── A: failures stay silent ─────────────────────────

describe("A: failed writes never notify", () => {
  test("str_replace match failure: error out, notify 0, file unchanged", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "core.md", GUARD_FILE);
    const notify: NotifyCall[] = [];
    const { tool } = makeTool(fx, { jev: realPort(fx), notifyRec: notify });
    await expect(
      exec(
        tool,
        { command: "str_replace", path: "core.md", old_str: "不存在", new_str: "x" },
        ctx(fx.cwd, { notifyRec: notify }),
      ),
    ).rejects.toThrow(/old_str did not appear verbatim/);
    expect(notify).toHaveLength(0);
    expect(readFileSync(join(fx.memDir, "core.md"), "utf8")).toBe(GUARD_FILE);
  });

  test("hard limit exceeded on a user-entry file: refused, notify 0, file unchanged", async () => {
    const fx = fixture();
    const original = "## Rules\n\n- 用户令一条\n";
    writeFile(fx.memDir, "rules.md", original); // topic file (not core.md) ⇒ topicMaxBytes applies
    const notify: NotifyCall[] = [];
    const { tool } = makeTool(fx, {
      settings: { topicMaxBytes: 40 },
      jev: realPort(fx),
      notifyRec: notify,
    });
    await expect(
      exec(
        tool,
        { command: "append", path: "rules.md", content: "- 很长的新增内容让文件超过硬上限" },
        ctx(fx.cwd, { notifyRec: notify }),
      ),
    ).rejects.toThrow(/over the .* hard limit/);
    expect(notify).toHaveLength(0);
    expect(readFileSync(join(fx.memDir, "rules.md"), "utf8")).toBe(original);
  });

  test("hand-written write-overwrite refusal: notify 0, file unchanged", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "hand.md", GUARD_FILE);
    const notify: NotifyCall[] = [];
    const { tool } = makeTool(fx, { jev: realPort(fx), notifyRec: notify });
    await expect(
      exec(
        tool,
        { command: "write", path: "hand.md", file_text: "## S\n\n- 全新内容\n" },
        ctx(fx.cwd, { notifyRec: notify }),
      ),
    ).rejects.toThrow(/is user-authored/);
    expect(notify).toHaveLength(0);
    expect(readFileSync(join(fx.memDir, "hand.md"), "utf8")).toBe(GUARD_FILE);
  });

  test("hand-written delete refusal: notify 0, file still there", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "hand.md", GUARD_FILE);
    const notify: NotifyCall[] = [];
    const { tool } = makeTool(fx, { jev: realPort(fx), notifyRec: notify });
    await expect(
      exec(tool, { command: "delete", path: "hand.md" }, ctx(fx.cwd, { notifyRec: notify })),
    ).rejects.toThrow(/is user-authored/);
    expect(notify).toHaveLength(0);
    expect(existsSync(join(fx.memDir, "hand.md"))).toBe(true);
  });
});

// ───────────────────────── B: CAS binds a baseline, not an outcome ─────────────────────────

describe("B: CAS through the lock window", () => {
  test("unrelated same-file change while waiting for the lock ⇒ changed-concurrently, concurrent version kept, notify 0", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "core.md", GUARD_FILE);
    const notify: NotifyCall[] = [];
    holdLock(fx);
    const { tool } = makeTool(fx, { jev: realPort(fx), notifyRec: notify });
    const p = exec(
      tool,
      { command: "str_replace", path: "core.md", old_str: "用户令", new_str: "改掉" },
      ctx(fx.cwd, { notifyRec: notify }),
    );
    p.catch(() => {});
    await new Promise((r) => setTimeout(r, 60));
    // concurrent writer touches text OUTSIDE old_str
    writeFileSync(join(fx.memDir, "core.md"), "## Rules\n\n- 用户令一条（别处已改）\n");
    releaseLock(fx);
    await expect(p).rejects.toThrow(/changed concurrently/);
    expect(readFileSync(join(fx.memDir, "core.md"), "utf8")).toBe("## Rules\n\n- 用户令一条（别处已改）\n");
    expect(notify).toHaveLength(0);
  }, 15_000);

  test("concurrent writer removes old_str entirely ⇒ MATCH error (checked before baseline), notify 0", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "core.md", GUARD_FILE);
    const notify: NotifyCall[] = [];
    holdLock(fx);
    const { tool } = makeTool(fx, { jev: realPort(fx), notifyRec: notify });
    const p = exec(
      tool,
      { command: "str_replace", path: "core.md", old_str: "用户令", new_str: "改掉" },
      ctx(fx.cwd, { notifyRec: notify }),
    );
    p.catch(() => {});
    await new Promise((r) => setTimeout(r, 60));
    writeFileSync(join(fx.memDir, "core.md"), "## Rules\n\n- 完全不同的内容\n"); // old_str gone
    releaseLock(fx);
    await expect(p).rejects.toThrow(/old_str did not appear verbatim/);
    expect(readFileSync(join(fx.memDir, "core.md"), "utf8")).toBe("## Rules\n\n- 完全不同的内容\n");
    expect(notify).toHaveLength(0);
  }, 15_000);

  test("delete: same-file change while waiting ⇒ changed-concurrently", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "agent.md", `${AGENT_FM}## S\n\n- 用户令一条 <!-- mem user -->\n`);
    const notify: NotifyCall[] = [];
    holdLock(fx);
    const { tool } = makeTool(fx, { jev: realPort(fx), notifyRec: notify });
    const p = exec(tool, { command: "delete", path: "agent.md" }, ctx(fx.cwd, { notifyRec: notify }));
    p.catch(() => {});
    await new Promise((r) => setTimeout(r, 60));
    writeFileSync(join(fx.memDir, "agent.md"), `${AGENT_FM}## S\n\n- 用户令一条（别处已改） <!-- mem user -->\n`);
    releaseLock(fx);
    await expect(p).rejects.toThrow(/changed concurrently/);
    expect(readFileSync(join(fx.memDir, "agent.md"), "utf8")).toContain("别处已改");
    expect(notify).toHaveLength(0);
  }, 15_000);

  test("delete: delete-and-recreate while waiting ⇒ conservative changed-concurrently, recreated version kept", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "agent.md", `${AGENT_FM}## S\n\n- 用户令一条 <!-- mem user -->\n`);
    const notify: NotifyCall[] = [];
    holdLock(fx);
    const { tool } = makeTool(fx, { jev: realPort(fx), notifyRec: notify });
    const p = exec(tool, { command: "delete", path: "agent.md" }, ctx(fx.cwd, { notifyRec: notify }));
    p.catch(() => {});
    await new Promise((r) => setTimeout(r, 60));
    rmSync(join(fx.memDir, "agent.md"));
    writeFile(fx.memDir, "agent.md", `${AGENT_FM}## S\n\n- 用户令一条（重建） <!-- mem user -->\n`);
    releaseLock(fx);
    await expect(p).rejects.toThrow(/changed concurrently/);
    expect(readFileSync(join(fx.memDir, "agent.md"), "utf8")).toContain("重建");
    expect(notify).toHaveLength(0);
  }, 15_000);
});

// ───────────────────────── C: concurrent same-baseline writes ─────────────────────────

describe("C: two writes on the same baseline commit exactly one", () => {
  test("exactly one commits, the loser CAS-fails, notify fires exactly once", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "core.md", "## Rules\n\n- 用户令一条\n- 用户令二条\n");
    const notify: NotifyCall[] = [];
    const { tool } = makeTool(fx, { jev: realPort(fx), notifyRec: notify });
    const p1 = exec(
      tool,
      { command: "str_replace", path: "core.md", old_str: "用户令一条", new_str: "第一处改" },
      ctx(fx.cwd, { notifyRec: notify }),
      { toolCallId: "call-a" },
    );
    const p2 = exec(
      tool,
      { command: "str_replace", path: "core.md", old_str: "用户令二条", new_str: "第二处改" },
      ctx(fx.cwd, { notifyRec: notify }),
      { toolCallId: "call-b" },
    );
    const results = await Promise.allSettled([p1, p2]);
    const rejected = results.filter((r) => r.status === "rejected").length;
    expect(rejected).toBe(1);
    const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(loser.reason)).toMatch(/changed concurrently/);
    const final = readFileSync(join(fx.memDir, "core.md"), "utf8");
    expect(final.includes("第一处改") !== final.includes("第二处改")).toBe(true);
    expect(notify).toHaveLength(1);
  });
});

// ───────────────────────── D: abort checkpoints (main session) ─────────────────────────

describe("D: main-session abort checkpoints (tool ∪ session signal)", () => {
  test("session signal pre-aborted ⇒ refused before the lock, file unchanged, notify 0", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "core.md", GUARD_FILE);
    const notify: NotifyCall[] = [];
    const session = new AbortController();
    session.abort();
    const { tool } = makeTool(fx, { jev: realPort(fx), sessionSignal: () => session.signal, notifyRec: notify });
    await expect(
      exec(
        tool,
        { command: "str_replace", path: "core.md", old_str: "用户令", new_str: "改掉" },
        ctx(fx.cwd, { notifyRec: notify }),
      ),
    ).rejects.toThrow(ABORTED);
    expect(readFileSync(join(fx.memDir, "core.md"), "utf8")).toBe(GUARD_FILE);
    expect(notify).toHaveLength(0);
  });

  test("tool signal pre-aborted ⇒ refused before the lock, file unchanged, notify 0", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "core.md", GUARD_FILE);
    const notify: NotifyCall[] = [];
    const ctrl = new AbortController();
    ctrl.abort();
    const { tool } = makeTool(fx, { jev: realPort(fx), notifyRec: notify });
    await expect(
      exec(
        tool,
        { command: "str_replace", path: "core.md", old_str: "用户令", new_str: "改掉" },
        ctx(fx.cwd, { notifyRec: notify }),
        { signal: ctrl.signal },
      ),
    ).rejects.toThrow(ABORTED);
    expect(readFileSync(join(fx.memDir, "core.md"), "utf8")).toBe(GUARD_FILE);
    expect(notify).toHaveLength(0);
  });

  test("session abort while waiting for the lock ⇒ refused inside the lock, file unchanged, notify 0", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "core.md", GUARD_FILE);
    const notify: NotifyCall[] = [];
    const session = new AbortController();
    holdLock(fx);
    const { tool } = makeTool(fx, { jev: realPort(fx), sessionSignal: () => session.signal, notifyRec: notify });
    const p = exec(
      tool,
      { command: "str_replace", path: "core.md", old_str: "用户令", new_str: "改掉" },
      ctx(fx.cwd, { notifyRec: notify }),
    );
    p.catch(() => {});
    await new Promise((r) => setTimeout(r, 60));
    session.abort(); // simulated /reload or shutdown during the lock wait
    releaseLock(fx);
    await expect(p).rejects.toThrow(ABORTED);
    expect(readFileSync(join(fx.memDir, "core.md"), "utf8")).toBe(GUARD_FILE);
    expect(notify).toHaveLength(0);
  }, 15_000);

  test("tool abort while waiting for the lock ⇒ refused inside the lock, file unchanged, notify 0", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "core.md", GUARD_FILE);
    const notify: NotifyCall[] = [];
    const ctrl = new AbortController();
    holdLock(fx);
    const { tool } = makeTool(fx, { jev: realPort(fx), notifyRec: notify });
    const p = exec(
      tool,
      { command: "str_replace", path: "core.md", old_str: "用户令", new_str: "改掉" },
      ctx(fx.cwd, { notifyRec: notify }),
      { signal: ctrl.signal },
    );
    p.catch(() => {});
    await new Promise((r) => setTimeout(r, 60));
    ctrl.abort();
    releaseLock(fx);
    await expect(p).rejects.toThrow(ABORTED);
    expect(readFileSync(join(fx.memDir, "core.md"), "utf8")).toBe(GUARD_FILE);
    expect(notify).toHaveLength(0);
  }, 15_000);
});

// ───────────────────────── E: child sessions use the tool signal only ─────────────────────────

describe("E: child-session abort (no sessionSignal handed over)", () => {
  test("tool abort while waiting for the lock ⇒ aborted before commit, nothing on disk", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "core.md", GUARD_FILE);
    const notify: NotifyCall[] = [];
    const ctrl = new AbortController();
    holdLock(fx);
    // production wiring: child sessions get NO sessionSignal (src/index.ts)
    const { tool } = makeTool(fx, {
      isChildSession: true,
      settings: { allowWriteInChildSessions: true },
      jev: realPort(fx),
      notifyRec: notify,
    });
    const p = exec(
      tool,
      { command: "str_replace", path: "core.md", old_str: "用户令", new_str: "改掉" },
      ctx(fx.cwd, { notifyRec: notify }),
      { signal: ctrl.signal },
    );
    p.catch(() => {});
    await new Promise((r) => setTimeout(r, 60));
    ctrl.abort();
    releaseLock(fx);
    await expect(p).rejects.toThrow(ABORTED);
    expect(readFileSync(join(fx.memDir, "core.md"), "utf8")).toBe(GUARD_FILE);
    expect(notify).toHaveLength(0); // child session: never notified anyway
  }, 15_000);
});

// ───────────────────────── F: notify robustness ─────────────────────────

describe("F: a throwing notify never fails the committed write", () => {
  test("notify throws ⇒ success text still returned, file written", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "core.md", GUARD_FILE);
    const { tool } = makeTool(fx, { jev: realPort(fx) });
    const out = textOf(
      await exec(
        tool,
        { command: "str_replace", path: "core.md", old_str: "用户令", new_str: "改掉" },
        ctx(fx.cwd, { notifyThrows: true }),
      ),
    );
    expect(out).toContain("edited core.md");
    expect(out).toContain("voided user rule: core.md › Rules #1");
    expect(readFileSync(join(fx.memDir, "core.md"), "utf8")).toContain("改掉");
  });
});

// ───────────────────────── H: sensitive content stays out of the notify ─────────────────────────

describe("H: the notify carries no heading/body content", () => {
  test("secret heading + private/secret/plain mix: notify bodyless, count complete, voided echo byte-unchanged", async () => {
    const fx = fixture();
    const body = [
      "## sk-SECRET123 标题区",
      "",
      "- 普通用户令一条",
      "- 机密令牌 SECRET-XYZ-123 不得外发 <!-- mem private -->",
      "- 私有内容 PRIVATE-TOKEN-ABC <!-- mem secret -->",
      "",
    ].join("\n");
    writeFile(fx.memDir, "core.md", body); // hand-written ⇒ every entry is a user order
    const notify: NotifyCall[] = [];
    const { tool } = makeTool(fx, { jev: realPort(fx), notifyRec: notify });
    const out = textOf(
      await exec(
        tool,
        {
          command: "str_replace",
          path: "core.md",
          old_str:
            "普通用户令一条\n- 机密令牌 SECRET-XYZ-123 不得外发 <!-- mem private -->\n- 私有内容 PRIVATE-TOKEN-ABC <!-- mem secret -->",
          new_str: "全部改掉",
        },
        ctx(fx.cwd, { notifyRec: notify }),
      ),
    );
    expect(notify).toHaveLength(1);
    const msg = notify[0]!.message;
    // no heading, no bodies, no private/secret markers — only ordinal+line ids
    expect(msg).not.toContain("sk-SECRET123");
    expect(msg).not.toContain("SECRET-XYZ-123");
    expect(msg).not.toContain("PRIVATE-TOKEN-ABC");
    expect(msg).not.toContain("private");
    expect(msg).not.toContain("secret");
    expect(msg).not.toContain("用户令一条");
    // {n} counts ALL touched entries (sensitive ones are not trimmed)
    expect(msg).toContain("core.md 中的 3 条用户令");
    expect(msg).toMatch(/- 条目 #\d+ \(L\d+-\d+\)/);
    // known residual (R-d): the voided ECHO keeps heading + bodies — byte-unchanged
    expect(out).toContain("voided user rule: core.md › sk-SECRET123 标题区 #1");
    expect(readFileSync(join(fx.memDir, "core.md"), "utf8")).toContain("全部改掉");
  });
});

// ───────────────────────── I: >10 entries fold ─────────────────────────

describe("I: the notify folds beyond 10 entries", () => {
  test("12 user entries via a provenance flip: 10 listed + fold line, verbatim", async () => {
    const fx = fixture();
    const entries = Array.from({ length: 12 }, (_, i) => `- 用户令第 ${i + 1} 条`).join("\n");
    writeFile(fx.memDir, "core.md", `## Rules\n\n${entries}\n`);
    const notify: NotifyCall[] = [];
    const { tool } = makeTool(fx, { jev: realPort(fx), notifyRec: notify });
    await exec(
      tool,
      { command: "insert", path: "core.md", insert_line: 0, insert_text: "---\nsource: agent\n---\n" },
      ctx(fx.cwd, { notifyRec: notify }),
    );
    expect(notify).toHaveLength(1);
    const msg = notify[0]!.message;
    const listed = msg.split("\n").filter((l) => l.startsWith("- 条目 "));
    expect(listed).toHaveLength(10);
    const lines = msg.split("\n");
    expect(lines[lines.length - 1]).toBe("- …另有 2 条（见工具结果）");
    expect(msg).toContain("core.md 中的 12 条用户令");
    expect(readFileSync(join(fx.memDir, "core.md"), "utf8")).toContain("source: agent");
  });
});

// ───────────────────────── J: regressions around the skip path ─────────────────────────

describe("J: skip-path and child-default regressions", () => {
  test("skip path (no user entries): an already-aborted signal does NOT block the write", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "n.md", `${AGENT_FM}## S\n\n- 普通经验\n`);
    const notify: NotifyCall[] = [];
    const ctrl = new AbortController();
    ctrl.abort();
    const { tool } = makeTool(fx, { jev: realPort(fx), notifyRec: notify });
    const out = textOf(
      await exec(
        tool,
        { command: "str_replace", path: "n.md", old_str: "普通经验", new_str: "改掉" },
        ctx(fx.cwd, { notifyRec: notify }),
        { signal: ctrl.signal },
      ),
    );
    expect(out).toContain("edited n.md");
    expect(readFileSync(join(fx.memDir, "n.md"), "utf8")).toContain("改掉");
    expect(notify).toHaveLength(0);
  });

  test("child session default (no write permission) keeps the read-only error", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "core.md", GUARD_FILE);
    const { tool } = makeTool(fx, { isChildSession: true, jev: realPort(fx) });
    await expect(
      exec(tool, { command: "str_replace", path: "core.md", old_str: "用户令", new_str: "改掉" }, ctx(fx.cwd)),
    ).rejects.toThrow(/child sessions are read-only for memory by default/);
    expect(readFileSync(join(fx.memDir, "core.md"), "utf8")).toBe(GUARD_FILE);
  });
});
