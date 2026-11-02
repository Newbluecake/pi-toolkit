// headless-confirm plan (docs/dev/memory/headless-confirm/plan.md): the jev
// user-order guards' remote/web confirm card — the arbitration race (TUI ⟂
// web on createDialogRace), the lifecycle (tool signal + session signal,
// cancel checkpoints before and inside the lock), the sensitive-content
// protection (no entry body/heading on the wire), the CAS contract (a
// confirmed write still revalidates its baseline), and the off path
// (no port ⇒ legacy local confirm, byte-identical call shape).

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { hostname } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS, type MemorySettings } from "../../src/config/settings.js";
import { memoryDirFor, type MemoryPaths } from "../../src/memory/paths.js";
import { createMemoryToolV2, type MemoryToolV2Deps } from "../../src/memory/tool-v2.js";
import { createJevWritePort } from "../../src/memory/jev/write-port.js";
import { EntryIndex } from "../../src/memory/jev/entries.js";
import { mergeTaxonomy } from "../../src/memory/jev/taxonomy.js";
import { lockCreate } from "../../src/memory/safe-fs.js";
import type { AskUserRemotePort, AskUserRemoteSession, RemoteOutcome } from "../../src/ask-user/remote.js";
import type { JevClient, JevStatus, JevWritePort } from "../../src/memory/jev/contracts.js";

const REFUSE = "用户未确认";

interface Fixture {
  tmp: string;
  cwd: string;
  paths: MemoryPaths;
  memDir: string;
}

const tmpRoots: string[] = [];

function fixture(): Fixture {
  const tmp = mkdtempSync(join(tmpdir(), "pi-mem-headless-"));
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
  vi.useRealTimers();
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

/** Real guard port (real touchedUserEntries pairing) with a scriptable
 *  confirmTimeoutMs, over an always-partial client. */
function realPort(fx: Fixture, confirmTimeoutMs = 60_000): JevWritePort {
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
    confirmTimeoutMs,
    now: () => Date.parse("2026-10-31T00:00:00Z"),
  });
}

/** A hand-controllable `ui.confirm`: records every call, resolves only when
 *  the test says so, and mimics the TUI's "aborted ⇒ false" behavior. */
function controlledConfirm() {
  const calls: { title: string; message: string; timeout?: number; signal?: AbortSignal }[] = [];
  const pending: Array<(v: boolean) => void> = [];
  const confirm = (title: string, message: string, opts?: { timeout?: number; signal?: AbortSignal }) => {
    calls.push({ title, message, timeout: opts?.timeout, signal: opts?.signal });
    return new Promise<boolean>((resolve) => {
      opts?.signal?.addEventListener("abort", () => resolve(false), { once: true });
      pending.push(resolve);
    });
  };
  return {
    confirm,
    calls,
    resolveNext(v: boolean) {
      const r = pending.shift();
      r?.(v);
    },
    get pendingCount() {
      return pending.length;
    },
  };
}

/** Fake AskUserRemotePort recording every open/close and letting the test
 *  deliver web answers/cancels synchronously (the way the real bridge does). */
function fakeRemotePort(over: { open?: "undefined" | "throw" } = {}) {
  const opens: { toolCallId: string; question: string; header: string; options: string[]; allowCancel: boolean }[] = [];
  const closes: { by: string; outcome: string }[] = [];
  let deliver: ((o: RemoteOutcome) => boolean) | undefined;
  let currentHeader = "h";
  const port: AskUserRemotePort = {
    open(req) {
      const q = req.questions[0]!;
      currentHeader = q.header;
      opens.push({
        toolCallId: req.toolCallId,
        question: q.question,
        header: q.header,
        options: q.options.map((o) => o.label),
        allowCancel: req.allowCancel,
      });
      if (over.open === "undefined") return undefined;
      if (over.open === "throw") throw new Error("hub gone");
      const session: AskUserRemoteSession = {
        setOnRemote(fn) {
          deliver = fn;
        },
        close(by, outcome) {
          closes.push({ by, outcome });
        },
      };
      return session;
    },
  };
  return {
    port,
    opens,
    closes,
    webAnswer(label: string): boolean {
      return deliver ? deliver({ kind: "answer", answers: { [currentHeader]: label }, origin: "web" }) : false;
    },
    webCancel(): boolean {
      return deliver ? deliver({ kind: "cancel", origin: "web" }) : false;
    },
    get hasListener() {
      return deliver !== undefined;
    },
  };
}

function makeTool(
  fx: Fixture,
  over: {
    jev?: JevWritePort;
    remote?: () => AskUserRemotePort | undefined;
    sessionSignal?: () => AbortSignal | undefined;
  } = {},
) {
  const tool = createMemoryToolV2({
    settings: DEFAULT_SETTINGS.memory,
    isChildSession: false,
    onAfterWrite: () => {},
    paths: fx.paths,
    ...(over.jev === undefined ? {} : { jev: over.jev }),
    ...(over.remote === undefined ? {} : { remote: over.remote }),
    ...(over.sessionSignal === undefined ? {} : { sessionSignal: over.sessionSignal }),
  } satisfies MemoryToolV2Deps);
  return { tool };
}

function fakeCtx(
  cwd: string,
  over: {
    mode?: string;
    confirm?: (title: string, message: string, opts?: { timeout?: number; signal?: AbortSignal }) => Promise<boolean>;
    hasUI?: boolean;
  } = {},
): ExtensionContext {
  const ctx = {
    mode: over.mode ?? "tui",
    hasUI: over.hasUI ?? true,
    cwd,
    ui: {
      notify: () => {},
      confirm:
        over.confirm ??
        (async () => {
          return true;
        }),
    },
    modelRegistry: FAKE_REGISTRY,
  } as unknown as ExtensionContext;
  return ctx;
}

async function exec(
  tool: ReturnType<typeof createMemoryToolV2>,
  params: Record<string, unknown>,
  ctx: ExtensionContext,
  o: { toolCallId?: string; signal?: AbortSignal } = {},
) {
  return (await tool.execute(o.toolCallId ?? "call-1", params as never, o.signal, undefined, ctx)) as {
    content: { type: string; text: string }[];
  };
}

function textOf(result: { content: { type: string; text: string }[] }): string {
  return result.content.map((c) => c.text).join("\n");
}

/** The classic guard-triggering file: one user-order entry (hand-written ⇒
 *  default user authority) that a str_replace would edit. */
const GUARD_FILE = "## Rules\n\n- 用户令一条\n";

// ───────────────────────── off path: no port ⇒ byte-identical legacy confirm ─────────────────────────

describe("off path (plan §wire/golden: getter 无 port ⇒ 现有路径逐字节不变)", () => {
  test("no remote dep ⇒ legacy local call shape verbatim (title/body/timeout, no signal)", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "core.md", GUARD_FILE);
    const ui = controlledConfirm();
    const { tool } = makeTool(fx, { jev: realPort(fx, 1234) });
    const p = exec(
      tool,
      { command: "str_replace", path: "core.md", old_str: "用户令", new_str: "改掉" },
      fakeCtx(fx.cwd, { confirm: ui.confirm }),
    );
    ui.resolveNext(true);
    await p;
    // Exact legacy call shape: same title, same body (entry first lines INCLUDED —
    // own terminal), same timeout, and opts carries no signal.
    expect(ui.calls).toHaveLength(1);
    expect(ui.calls[0]!.title).toBe("agent 请求修改用户令");
    expect(ui.calls[0]!.timeout).toBe(1234);
    expect(ui.calls[0]!.signal).toBeUndefined();
    expect(ui.calls[0]!.message).toContain("core.md 中 1 条用户令将被删改：");
    expect(ui.calls[0]!.message).toContain("用户令一条");
    expect(ui.calls[0]!.message).toContain("确认后本次写入才会提交；取消则本次写入被拒绝。");
  });

  test("remote getter returning undefined ⇒ same legacy local path", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "core.md", GUARD_FILE);
    const ui = controlledConfirm();
    const remote = fakeRemotePort();
    const { tool } = makeTool(fx, { jev: realPort(fx), remote: () => undefined });
    const p = exec(
      tool,
      { command: "str_replace", path: "core.md", old_str: "用户令", new_str: "改掉" },
      fakeCtx(fx.cwd, { confirm: ui.confirm }),
    );
    ui.resolveNext(false);
    await expect(p).rejects.toThrow(REFUSE);
    expect(ui.calls).toHaveLength(1);
    expect(ui.calls[0]!.signal).toBeUndefined();
    expect(remote.opens).toHaveLength(0);
  });
});

// ───────────────────────── arbitration race (plan Major #4) ─────────────────────────

describe("edit guard × TUI/web race", () => {
  test("TUI wins: local approve commits, late web approve is a no-op, session closed by us", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "core.md", GUARD_FILE);
    const ui = controlledConfirm();
    const remote = fakeRemotePort();
    const { tool } = makeTool(fx, { jev: realPort(fx), remote: () => remote.port });
    const p = exec(
      tool,
      { command: "str_replace", path: "core.md", old_str: "用户令", new_str: "改掉" },
      fakeCtx(fx.cwd, { confirm: ui.confirm }),
    );
    await vi.waitFor(() => expect(remote.hasListener).toBe(true));
    ui.resolveNext(true); // TUI answers first
    await p;
    expect(readFileSync(join(fx.memDir, "core.md"), "utf8")).toContain("改掉");
    expect(remote.closes).toEqual([{ by: "tui", outcome: "answered" }]);
    // The late web answer loses arbitration: claim() already taken.
    expect(remote.webAnswer("确认执行")).toBe(false);
    expect(readFileSync(join(fx.memDir, "core.md"), "utf8")).toContain("改掉");
  });

  test("web wins: web approve commits, local dialog aborted, bridge-side close (no close from us)", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "core.md", GUARD_FILE);
    const ui = controlledConfirm();
    const remote = fakeRemotePort();
    const { tool } = makeTool(fx, { jev: realPort(fx), remote: () => remote.port });
    const p = exec(
      tool,
      { command: "str_replace", path: "core.md", old_str: "用户令", new_str: "改掉" },
      fakeCtx(fx.cwd, { confirm: ui.confirm }),
    );
    await vi.waitFor(() => expect(remote.hasListener).toBe(true));
    expect(remote.webAnswer("确认执行")).toBe(true);
    await p;
    expect(readFileSync(join(fx.memDir, "core.md"), "utf8")).toContain("改掉");
    // web-win close belongs to the bridge — we must NOT close again.
    expect(remote.closes).toEqual([]);
    // The local dialog got its abort signal.
    expect(ui.calls[0]!.signal?.aborted).toBe(true);
  });

  test("conflicting answers: first claim wins (local decline refuses; late web approve rejected)", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "core.md", GUARD_FILE);
    const ui = controlledConfirm();
    const remote = fakeRemotePort();
    const { tool } = makeTool(fx, { jev: realPort(fx), remote: () => remote.port });
    const p = exec(
      tool,
      { command: "str_replace", path: "core.md", old_str: "用户令", new_str: "改掉" },
      fakeCtx(fx.cwd, { confirm: ui.confirm }),
    );
    await vi.waitFor(() => expect(remote.hasListener).toBe(true));
    ui.resolveNext(false); // user declines locally
    await expect(p).rejects.toThrow(REFUSE);
    expect(readFileSync(join(fx.memDir, "core.md"), "utf8")).toBe(GUARD_FILE);
    expect(remote.closes).toEqual([{ by: "tui", outcome: "cancelled" }]);
    expect(remote.webAnswer("确认执行")).toBe(false);
  });

  test("web decline label refuses; web cancel outcome refuses; unknown value refuses", async () => {
    for (const mode of ["decline", "cancel", "unknown"] as const) {
      const fx = fixture();
      writeFile(fx.memDir, "core.md", GUARD_FILE);
      const ui = controlledConfirm();
      const remote = fakeRemotePort();
      const { tool } = makeTool(fx, { jev: realPort(fx), remote: () => remote.port });
      const p = exec(
        tool,
        { command: "str_replace", path: "core.md", old_str: "用户令", new_str: "改掉" },
        fakeCtx(fx.cwd, { mode: "rpc", confirm: ui.confirm }),
      );
      await vi.waitFor(() => expect(remote.hasListener).toBe(true));
      const ok =
        mode === "decline"
          ? remote.webAnswer("取消")
          : mode === "cancel"
            ? remote.webCancel()
            : remote.webAnswer("随便什么未知值");
      expect(ok).toBe(true); // delivered — but must NOT approve
      await expect(p).rejects.toThrow(REFUSE);
      expect(readFileSync(join(fx.memDir, "core.md"), "utf8")).toBe(GUARD_FILE);
    }
  });

  test("timeout refuses, closes the card, and a late web approve is rejected", async () => {
    vi.useFakeTimers();
    const fx = fixture();
    writeFile(fx.memDir, "core.md", GUARD_FILE);
    const ui = controlledConfirm();
    const remote = fakeRemotePort();
    const { tool } = makeTool(fx, { jev: realPort(fx, 60_000), remote: () => remote.port });
    const p = exec(
      tool,
      { command: "str_replace", path: "core.md", old_str: "用户令", new_str: "改掉" },
      fakeCtx(fx.cwd, { confirm: ui.confirm }),
    );
    await vi.waitFor(() => expect(remote.hasListener).toBe(true));
    vi.advanceTimersByTime(60_000);
    await expect(p).rejects.toThrow(REFUSE);
    expect(readFileSync(join(fx.memDir, "core.md"), "utf8")).toBe(GUARD_FILE);
    expect(remote.closes).toEqual([{ by: "abort", outcome: "aborted" }]);
    expect(ui.calls[0]!.signal?.aborted).toBe(true);
    expect(remote.webAnswer("确认执行")).toBe(false);
  });
});

// ───────────────────────── rpc: web-only channel ─────────────────────────

describe("rpc mode", () => {
  test("web approve commits and ctx.ui.confirm is NEVER called (count 0)", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "core.md", GUARD_FILE);
    const ui = controlledConfirm();
    const remote = fakeRemotePort();
    const { tool } = makeTool(fx, { jev: realPort(fx), remote: () => remote.port });
    const p = exec(
      tool,
      { command: "str_replace", path: "core.md", old_str: "用户令", new_str: "改掉" },
      fakeCtx(fx.cwd, { mode: "rpc", confirm: ui.confirm }),
    );
    await vi.waitFor(() => expect(remote.hasListener).toBe(true));
    expect(remote.webAnswer("确认执行")).toBe(true);
    await p;
    expect(readFileSync(join(fx.memDir, "core.md"), "utf8")).toContain("改掉");
    expect(ui.calls).toHaveLength(0);
  });

  test("rpc timeout: zero confirm calls, refuse, file untouched", async () => {
    vi.useFakeTimers();
    const fx = fixture();
    writeFile(fx.memDir, "core.md", GUARD_FILE);
    const ui = controlledConfirm();
    const remote = fakeRemotePort();
    const { tool } = makeTool(fx, { jev: realPort(fx, 60_000), remote: () => remote.port });
    const p = exec(
      tool,
      { command: "str_replace", path: "core.md", old_str: "用户令", new_str: "改掉" },
      fakeCtx(fx.cwd, { mode: "rpc", confirm: ui.confirm }),
    );
    await vi.waitFor(() => expect(remote.hasListener).toBe(true));
    vi.advanceTimersByTime(60_000);
    await expect(p).rejects.toThrow(REFUSE);
    expect(ui.calls).toHaveLength(0);
    expect(readFileSync(join(fx.memDir, "core.md"), "utf8")).toBe(GUARD_FILE);
  });

  test("port present but open() undefined ⇒ TUI falls back to local confirm, rpc refuses with zero confirm calls", async () => {
    for (const mode of ["tui", "rpc"] as const) {
      const fx = fixture();
      writeFile(fx.memDir, "core.md", GUARD_FILE);
      const ui = controlledConfirm();
      const remote = fakeRemotePort({ open: "undefined" });
      const { tool } = makeTool(fx, { jev: realPort(fx), remote: () => remote.port });
      const p = exec(
        tool,
        { command: "str_replace", path: "core.md", old_str: "用户令", new_str: "改掉" },
        fakeCtx(fx.cwd, { mode, confirm: ui.confirm }),
      );
      if (mode === "tui") {
        await vi.waitFor(() => expect(ui.pendingCount).toBe(1));
        ui.resolveNext(true);
        await p;
        expect(readFileSync(join(fx.memDir, "core.md"), "utf8")).toContain("改掉");
      } else {
        await expect(p).rejects.toThrow(REFUSE);
        expect(ui.calls).toHaveLength(0);
        expect(readFileSync(join(fx.memDir, "core.md"), "utf8")).toBe(GUARD_FILE);
      }
    }
  });

  test("port present but open() throws ⇒ same two-way degrade", async () => {
    for (const mode of ["tui", "rpc"] as const) {
      const fx = fixture();
      writeFile(fx.memDir, "core.md", GUARD_FILE);
      const ui = controlledConfirm();
      const remote = fakeRemotePort({ open: "throw" });
      const { tool } = makeTool(fx, { jev: realPort(fx), remote: () => remote.port });
      const p = exec(
        tool,
        { command: "str_replace", path: "core.md", old_str: "用户令", new_str: "改掉" },
        fakeCtx(fx.cwd, { mode, confirm: ui.confirm }),
      );
      if (mode === "tui") {
        await vi.waitFor(() => expect(ui.pendingCount).toBe(1));
        ui.resolveNext(true);
        await p;
        expect(readFileSync(join(fx.memDir, "core.md"), "utf8")).toContain("改掉");
      } else {
        await expect(p).rejects.toThrow(REFUSE);
        expect(ui.calls).toHaveLength(0);
      }
    }
  });
});

// ───────────────────────── delete guard ─────────────────────────

describe("delete guard × remote card", () => {
  function agentFile(): string {
    // agent-frontmatter file carrying ONE inline user order — the only shape
    // whose delete needs the confirm (agent-default entries are not guarded).
    return `${AGENT_FM}## Rules\n\n- 用户令一条 <!-- mem user -->\n`;
  }

  test("web approve deletes (into trash); decline keeps the file", async () => {
    for (const approve of [true, false]) {
      const fx = fixture();
      writeFile(fx.memDir, "n.md", agentFile());
      const ui = controlledConfirm();
      const remote = fakeRemotePort();
      const { tool } = makeTool(fx, { jev: realPort(fx), remote: () => remote.port });
      const p = exec(tool, { command: "delete", path: "n.md" }, fakeCtx(fx.cwd, { mode: "rpc", confirm: ui.confirm }));
      await vi.waitFor(() => expect(remote.hasListener).toBe(true));
      expect(remote.webAnswer(approve ? "确认执行" : "取消")).toBe(true);
      if (approve) {
        const out = textOf(await p);
        expect(out).toContain("deleted n.md");
        expect(existsSync(join(fx.memDir, "n.md"))).toBe(false);
      } else {
        await expect(p).rejects.toThrow(REFUSE);
        expect(existsSync(join(fx.memDir, "n.md"))).toBe(true);
      }
    }
  });

  test("rpc + open undefined ⇒ refuse, zero confirm calls, file intact", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "n.md", agentFile());
    const ui = controlledConfirm();
    const remote = fakeRemotePort({ open: "undefined" });
    const { tool } = makeTool(fx, { jev: realPort(fx), remote: () => remote.port });
    await expect(
      exec(tool, { command: "delete", path: "n.md" }, fakeCtx(fx.cwd, { mode: "rpc", confirm: ui.confirm })),
    ).rejects.toThrow(REFUSE);
    expect(ui.calls).toHaveLength(0);
    expect(existsSync(join(fx.memDir, "n.md"))).toBe(true);
  });

  test("timeout refuses the delete", async () => {
    vi.useFakeTimers();
    const fx = fixture();
    writeFile(fx.memDir, "n.md", agentFile());
    const ui = controlledConfirm();
    const remote = fakeRemotePort();
    const { tool } = makeTool(fx, { jev: realPort(fx, 60_000), remote: () => remote.port });
    const p = exec(tool, { command: "delete", path: "n.md" }, fakeCtx(fx.cwd, { mode: "rpc", confirm: ui.confirm }));
    await vi.waitFor(() => expect(remote.hasListener).toBe(true));
    vi.advanceTimersByTime(60_000);
    await expect(p).rejects.toThrow(REFUSE);
    expect(existsSync(join(fx.memDir, "n.md"))).toBe(true);
    expect(remote.closes).toEqual([{ by: "abort", outcome: "aborted" }]);
  });
});

// ───────────────────────── sensitive-content protection (Blocker #1) ─────────────────────────

describe("remote card never carries entry content", () => {
  test("private/secret/plain mixed touched set: body, heading and markers absent from the wire", async () => {
    const fx = fixture();
    const body = [
      "## 敏感标题区",
      "",
      "- 普通用户令一条",
      "- 机密令牌 SECRET-XYZ-123 不得外发",
      "- 私有内容 PRIVATE-TOKEN-ABC",
      "",
    ].join("\n");
    writeFile(fx.memDir, "core.md", body); // hand-written ⇒ every entry is a user order
    const ui = controlledConfirm();
    const remote = fakeRemotePort();
    const { tool } = makeTool(fx, { jev: realPort(fx), remote: () => remote.port });
    const p = exec(
      tool,
      {
        command: "str_replace",
        path: "core.md",
        old_str: "普通用户令一条\n- 机密令牌 SECRET-XYZ-123 不得外发\n- 私有内容 PRIVATE-TOKEN-ABC",
        new_str: "全部改掉",
      },
      fakeCtx(fx.cwd, { mode: "rpc", confirm: ui.confirm }),
    );
    await vi.waitFor(() => expect(remote.opens).toHaveLength(1));
    const q = remote.opens[0]!.question;
    // No entry body, no secret token, no private marker, no heading.
    expect(q).not.toContain("SECRET-XYZ-123");
    expect(q).not.toContain("PRIVATE-TOKEN-ABC");
    expect(q).not.toContain("private");
    expect(q).not.toContain("敏感标题区");
    expect(q).not.toContain("用户令一条");
    // But the file name and the touched count ARE there, and the touched set
    // was NOT trimmed to dodge the guard (all three entries counted).
    expect(q).toContain("core.md");
    expect(q).toContain("3 条用户令将被删改");
    expect(q).toMatch(/#\d+（L\d+-L\d+）/);
    // Single-select, two options, timeout hint present.
    expect(remote.opens[0]!.options).toHaveLength(2);
    expect(q).toContain("秒");
    remote.webCancel();
    await expect(p).rejects.toThrow(REFUSE);
    expect(readFileSync(join(fx.memDir, "core.md"), "utf8")).toBe(body);
  });

  test("the LOCAL dialog keeps its legacy body (own terminal — content allowed there)", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "core.md", GUARD_FILE);
    const ui = controlledConfirm();
    const remote = fakeRemotePort();
    const { tool } = makeTool(fx, { jev: realPort(fx), remote: () => remote.port });
    const p = exec(
      tool,
      { command: "str_replace", path: "core.md", old_str: "用户令", new_str: "改掉" },
      fakeCtx(fx.cwd, { confirm: ui.confirm }),
    );
    await vi.waitFor(() => expect(ui.pendingCount).toBe(1));
    expect(ui.calls[0]!.message).toContain("用户令一条");
    ui.resolveNext(true);
    await p;
  });
});

// ───────────────────────── lifecycle & cancellation (Major #2/#3) ─────────────────────────

describe("tool signal & session signal", () => {
  test("tool abort while waiting on the card ⇒ REFUSE, card closed, late web approve rejected, file untouched", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "core.md", GUARD_FILE);
    const ui = controlledConfirm();
    const remote = fakeRemotePort();
    const ctrl = new AbortController();
    const { tool } = makeTool(fx, { jev: realPort(fx), remote: () => remote.port });
    const p = exec(
      tool,
      { command: "str_replace", path: "core.md", old_str: "用户令", new_str: "改掉" },
      fakeCtx(fx.cwd, { confirm: ui.confirm }),
      { signal: ctrl.signal },
    );
    await vi.waitFor(() => expect(remote.hasListener).toBe(true));
    ctrl.abort();
    await expect(p).rejects.toThrow(REFUSE);
    expect(remote.closes).toEqual([{ by: "abort", outcome: "aborted" }]);
    expect(ui.calls[0]!.signal?.aborted).toBe(true);
    expect(remote.webAnswer("确认执行")).toBe(false);
    // A late local approve is equally dead.
    ui.resolveNext(true);
    await Promise.resolve();
    expect(readFileSync(join(fx.memDir, "core.md"), "utf8")).toBe(GUARD_FILE);
  });

  test("session (reload/shutdown) abort while waiting ⇒ REFUSE", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "core.md", GUARD_FILE);
    const ui = controlledConfirm();
    const remote = fakeRemotePort();
    const session = new AbortController();
    const { tool } = makeTool(fx, {
      jev: realPort(fx),
      remote: () => remote.port,
      sessionSignal: () => session.signal,
    });
    const p = exec(
      tool,
      { command: "str_replace", path: "core.md", old_str: "用户令", new_str: "改掉" },
      fakeCtx(fx.cwd, { confirm: ui.confirm }),
    );
    await vi.waitFor(() => expect(remote.hasListener).toBe(true));
    session.abort(); // simulated /reload or shutdown
    await expect(p).rejects.toThrow(REFUSE);
    expect(readFileSync(join(fx.memDir, "core.md"), "utf8")).toBe(GUARD_FILE);
    expect(remote.closes).toEqual([{ by: "abort", outcome: "aborted" }]);
  });

  test("abort landing right after the web approve ⇒ REFUSE at the post-confirm checkpoint (cancel wins)", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "core.md", GUARD_FILE);
    const ui = controlledConfirm();
    const remote = fakeRemotePort();
    const ctrl = new AbortController();
    const { tool } = makeTool(fx, { jev: realPort(fx), remote: () => remote.port });
    const p = exec(
      tool,
      { command: "str_replace", path: "core.md", old_str: "用户令", new_str: "改掉" },
      fakeCtx(fx.cwd, { mode: "rpc", confirm: ui.confirm }),
      { signal: ctrl.signal },
    );
    await vi.waitFor(() => expect(remote.hasListener).toBe(true));
    expect(remote.webAnswer("确认执行")).toBe(true); // the card DID approve synchronously…
    ctrl.abort(); // …but the tool abort lands before the commit checkpoint
    await expect(p).rejects.toThrow(REFUSE);
    expect(readFileSync(join(fx.memDir, "core.md"), "utf8")).toBe(GUARD_FILE);
  });

  test("already-aborted tool signal never opens a card", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "core.md", GUARD_FILE);
    const ui = controlledConfirm();
    const remote = fakeRemotePort();
    const ctrl = new AbortController();
    ctrl.abort();
    const { tool } = makeTool(fx, { jev: realPort(fx), remote: () => remote.port });
    await expect(
      exec(
        tool,
        { command: "str_replace", path: "core.md", old_str: "用户令", new_str: "改掉" },
        fakeCtx(fx.cwd, { confirm: ui.confirm }),
        { signal: ctrl.signal },
      ),
    ).rejects.toThrow(REFUSE);
    expect(remote.opens).toHaveLength(0);
    expect(ui.calls).toHaveLength(0);
  });

  test("cancel checkpoint after the confirm: session abort landing between approve and commit ⇒ REFUSE, nothing on disk", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "core.md", GUARD_FILE);
    const session = new AbortController();
    // The local confirm approves, but the session signal fires in the same
    // microtask chain — before the guard's post-confirm checkpoint passes.
    const confirm = (): Promise<boolean> =>
      new Promise((resolve) => {
        queueMicrotask(() => {
          resolve(true);
          session.abort(); // lands BEFORE the awaited continuation runs
        });
      });
    const remote = fakeRemotePort();
    const { tool } = makeTool(fx, {
      jev: realPort(fx),
      remote: () => remote.port,
      sessionSignal: () => session.signal,
    });
    await expect(
      exec(
        tool,
        { command: "str_replace", path: "core.md", old_str: "用户令", new_str: "改掉" },
        fakeCtx(fx.cwd, { confirm }),
      ),
    ).rejects.toThrow(REFUSE);
    expect(readFileSync(join(fx.memDir, "core.md"), "utf8")).toBe(GUARD_FILE);
  });

  test("cancel checkpoint inside the lock: abort while waiting for the directory lock ⇒ REFUSE, nothing on disk", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "core.md", GUARD_FILE);
    const ui = controlledConfirm();
    const remote = fakeRemotePort();
    const ctrl = new AbortController();
    // Hold the memory dir lock from the outside with a live foreign owner.
    expect(lockCreate(fx.memDir, { pid: process.pid, host: hostname(), at: Date.now() })).toBe(true);
    const { tool } = makeTool(fx, { jev: realPort(fx), remote: () => remote.port });
    const p = exec(
      tool,
      { command: "str_replace", path: "core.md", old_str: "用户令", new_str: "改掉" },
      fakeCtx(fx.cwd, { confirm: ui.confirm }),
      { signal: ctrl.signal },
    );
    await vi.waitFor(() => expect(ui.pendingCount).toBe(1));
    ui.resolveNext(true); // approved…
    // …then the tool is aborted while doStrReplace retries the held lock.
    await new Promise((r) => setTimeout(r, 60));
    ctrl.abort();
    // Release the lock; the write proceeds into the lock and must refuse at
    // the in-lock checkpoint (NOT touch the file).
    rmSync(join(fx.memDir, ".lock"), { force: true });
    await expect(p).rejects.toThrow(REFUSE);
    expect(readFileSync(join(fx.memDir, "core.md"), "utf8")).toBe(GUARD_FILE);
  }, 15_000);
});

// ───────────────────────── CAS contract (Major #5) ─────────────────────────

describe("confirmation binds a baseline, not an outcome", () => {
  test("unrelated same-file change while the card is open ⇒ changed-concurrently, concurrent version kept", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "core.md", GUARD_FILE);
    const ui = controlledConfirm();
    const remote = fakeRemotePort();
    const { tool } = makeTool(fx, { jev: realPort(fx), remote: () => remote.port });
    const p = exec(
      tool,
      { command: "str_replace", path: "core.md", old_str: "用户令", new_str: "改掉" },
      fakeCtx(fx.cwd, { mode: "rpc", confirm: ui.confirm }),
    );
    await vi.waitFor(() => expect(remote.hasListener).toBe(true));
    writeFileSync(join(fx.memDir, "core.md"), "## Rules\n\n- 用户令一条（别处已改）\n"); // concurrent writer
    expect(remote.webAnswer("确认执行")).toBe(true);
    await expect(p).rejects.toThrow(/changed concurrently/);
    expect(readFileSync(join(fx.memDir, "core.md"), "utf8")).toBe("## Rules\n\n- 用户令一条（别处已改）\n");
  });

  test("same-baseline competing approvals: exactly one commit, the loser refuses and the committed version survives", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "core.md", "## Rules\n\n- 用户令一条\n- 用户令二条\n");
    const ui = controlledConfirm();
    const remote = fakeRemotePort();
    const { tool } = makeTool(fx, { jev: realPort(fx), remote: () => remote.port });
    const p1 = exec(
      tool,
      { command: "str_replace", path: "core.md", old_str: "用户令一条", new_str: "第一处改" },
      fakeCtx(fx.cwd, { confirm: ui.confirm }),
      { toolCallId: "call-a" },
    );
    const p2 = exec(
      tool,
      { command: "str_replace", path: "core.md", old_str: "用户令二条", new_str: "第二处改" },
      fakeCtx(fx.cwd, { confirm: ui.confirm }),
      { toolCallId: "call-b" },
    );
    await vi.waitFor(() => expect(ui.pendingCount).toBe(2));
    ui.resolveNext(true); // first approval
    await p1;
    ui.resolveNext(true); // second approval — same file, stale baseline
    await expect(p2).rejects.toThrow(/changed concurrently/);
    const final = readFileSync(join(fx.memDir, "core.md"), "utf8");
    expect(final).toContain("第一处改");
    expect(final).not.toContain("第二处改");
  });

  test("delete-and-recreate while the card is open ⇒ conservative refusal, recreated version kept", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "core.md", GUARD_FILE);
    const ui = controlledConfirm();
    const remote = fakeRemotePort();
    const { tool } = makeTool(fx, { jev: realPort(fx), remote: () => remote.port });
    const p = exec(
      tool,
      { command: "str_replace", path: "core.md", old_str: "用户令", new_str: "改掉" },
      fakeCtx(fx.cwd, { mode: "rpc", confirm: ui.confirm }),
    );
    await vi.waitFor(() => expect(remote.hasListener).toBe(true));
    rmSync(join(fx.memDir, "core.md"));
    writeFile(fx.memDir, "core.md", "## Rules\n\n- 用户令一条（重建）\n");
    expect(remote.webAnswer("确认执行")).toBe(true);
    await expect(p).rejects.toThrow(/changed concurrently/);
    expect(readFileSync(join(fx.memDir, "core.md"), "utf8")).toBe("## Rules\n\n- 用户令一条（重建）\n");
  });
});

// ───────────────────────── instance id (Minor #8) ─────────────────────────

describe("confirmation instance ids", () => {
  test("each tool call opens its own card id (memory:<toolCallId>)", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "core.md", GUARD_FILE);
    const ui = controlledConfirm();
    const remote = fakeRemotePort();
    const { tool } = makeTool(fx, { jev: realPort(fx), remote: () => remote.port });
    const p1 = exec(
      tool,
      { command: "str_replace", path: "core.md", old_str: "用户令", new_str: "a" },
      fakeCtx(fx.cwd, { confirm: ui.confirm }),
      { toolCallId: "tc-1" },
    );
    await vi.waitFor(() => expect(ui.pendingCount).toBe(1));
    ui.resolveNext(false);
    await expect(p1).rejects.toThrow(REFUSE);
    writeFile(fx.memDir, "core.md", GUARD_FILE);
    const p2 = exec(
      tool,
      { command: "str_replace", path: "core.md", old_str: "用户令", new_str: "b" },
      fakeCtx(fx.cwd, { confirm: ui.confirm }),
      { toolCallId: "tc-2" },
    );
    await vi.waitFor(() => expect(ui.pendingCount).toBe(1));
    ui.resolveNext(false);
    await expect(p2).rejects.toThrow(REFUSE);
    expect(remote.opens.map((o) => o.toolCallId)).toEqual(["memory:tc-1", "memory:tc-2"]);
  });
});

// ───────────────────────── print & child sessions stay hard-refused ─────────────────────────

describe("print / child / UI-less stay refused (no card either)", () => {
  test("print mode (UI-less) refuses before any card or dialog is opened", async () => {
    const fx = fixture();
    writeFile(fx.memDir, "core.md", GUARD_FILE);
    const ui = controlledConfirm();
    const remote = fakeRemotePort();
    const { tool } = makeTool(fx, { jev: realPort(fx), remote: () => remote.port });
    await expect(
      exec(
        tool,
        { command: "str_replace", path: "core.md", old_str: "用户令", new_str: "改掉" },
        fakeCtx(fx.cwd, { mode: "print", hasUI: false, confirm: ui.confirm }),
      ),
    ).rejects.toThrow(REFUSE);
    expect(readFileSync(join(fx.memDir, "core.md"), "utf8")).toBe(GUARD_FILE);
    expect(remote.opens).toHaveLength(0);
    expect(ui.calls).toHaveLength(0);
  });
});
