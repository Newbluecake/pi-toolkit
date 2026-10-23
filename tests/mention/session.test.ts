import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createMentionRegistry } from "../../src/mention/registry.js";
import { installMentionInput, parseMention, routeMention } from "../../src/mention/mention.js";
import {
  bareNameFileConflict,
  createMentionSessionPort,
  parseSessionMention,
  routeSessionMention,
  safeParseSessionMention,
  sessionCompletionBare,
  type MentionSessionPort,
  type MentionSessionSendOutcome,
  type SessionMentionNotice,
} from "../../src/mention/session.js";
import type { XsDirectoryRow } from "../../src/fabric/xs/directory.js";
import type { RunSnapshot } from "../../src/core/types.js";

/**
 * fabric reply-plan §9.1/§9.3/§9.5/§9.6 (package M): @session mention syntax, routing and
 * notices, developed against a FAKE send port (the real sender is RX4, assembled by MW).
 */

const dir = mkdtempSync(join(tmpdir(), "pi-subagent-mention-session-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function row(ref: string, name?: string): XsDirectoryRow {
  return {
    ref,
    ...(name !== undefined ? { name } : {}),
    cwdLabel: "~/repo",
    kind: "main",
    receive: "wake",
    busy: false,
    lastActiveAgoS: 5,
  };
}

interface PortHarness {
  port: MentionSessionPort;
  sends: { target: string; message: string; options?: { expectReply?: boolean } }[];
  setOutcome(next: MentionSessionSendOutcome | ((call: number) => MentionSessionSendOutcome)): void;
  setJoined(joined: boolean): void;
  rows: XsDirectoryRow[];
  labels: Set<string>;
  cwd: string;
}

function portHarness(init?: { joined?: boolean; rows?: XsDirectoryRow[] }): PortHarness {
  const sends: PortHarness["sends"] = [];
  let outcome: MentionSessionSendOutcome | ((call: number) => MentionSessionSendOutcome) = {
    status: "sent",
    effect: "applied",
  };
  let joined = init?.joined ?? true;
  const rows = init?.rows ?? [row("ab12cd34", "builder"), row("ef9911aa")];
  const labels = new Set<string>();
  const port = createMentionSessionPort({
    joined: () => joined,
    isLabel: (name) => labels.has(name),
    cwd: () => dir,
    lookupExact: (name) => {
      const hits = rows.filter((r) => r.name === name || r.ref === name);
      return hits.length === 1 ? hits[0] : undefined;
    },
    send: async (target, message, options) => {
      sends.push({ target, message, ...(options !== undefined ? { options } : {}) });
      return typeof outcome === "function" ? outcome(sends.length) : outcome;
    },
  });
  return {
    port,
    sends,
    setOutcome(next) {
      outcome = next;
    },
    setJoined(next) {
      joined = next;
    },
    rows,
    labels,
    cwd: dir,
  };
}

const parseDeps = (h: PortHarness) => ({
  isLabel: (name: string) => h.labels.has(name),
  cwd: () => h.cwd,
  lookupExact: (name: string) => {
    const hits = h.rows.filter((r) => r.name === name || r.ref === name);
    return hits.length === 1 ? hits[0] : undefined;
  },
});

describe("§9.1 parseSessionMention — explicit form", () => {
  it("intercepts @session:<name|ref> with a message and hands the operand to resolve", () => {
    const h = portHarness();
    expect(parseSessionMention("@session:builder hello there", parseDeps(h))).toEqual({
      form: "explicit",
      target: "builder",
      message: "hello there",
      label: "builder",
    });
    expect(parseSessionMention("@session:ab12cd34 5m 进展如何", parseDeps(h))).toMatchObject({
      target: "ab12cd34",
      message: "5m 进展如何",
    });
  });

  it("needs a message — a bare @session:x with nothing after it passes through", () => {
    const h = portHarness();
    expect(parseSessionMention("@session:builder", parseDeps(h))).toBeUndefined();
    expect(parseSessionMention("@session:builder   ", parseDeps(h))).toBeUndefined();
  });

  it("never consults labels/files/cache — even weird operands are intercepted", () => {
    const h = portHarness();
    h.labels.add("builder");
    writeFileSync(join(dir, "explicit-operand-file"), "file");
    expect(parseSessionMention("@session:builder go", parseDeps(h))?.form).toBe("explicit");
    expect(parseSessionMention("@session:foo/bar go", parseDeps(h))?.target).toBe("foo/bar");
    expect(parseSessionMention("@session:explicit-operand-file go", parseDeps(h))?.form).toBe("explicit");
  });
});

describe("§9.1 parseSessionMention — bare form (all four conditions)", () => {
  it("intercepts a unique exact name/ref hit", () => {
    const h = portHarness();
    expect(parseSessionMention("@builder status?", parseDeps(h))).toEqual({
      form: "bare",
      target: "ab12cd34",
      message: "status?",
      label: "builder",
    });
    expect(parseSessionMention("@ef9911aa status?", parseDeps(h))).toMatchObject({
      target: "ef9911aa",
      label: "ef9911aa",
    });
  });

  it("① path-shaped names never match (dots/slashes/tilde/backslash/too long)", () => {
    const h = portHarness({ rows: [row("ab12cd34", "a.b")] });
    expect(parseSessionMention("@a.b hi", parseDeps(h))).toBeUndefined();
    expect(parseSessionMention("@src/file.ts hi", parseDeps(h))).toBeUndefined();
    expect(parseSessionMention("@a~b hi", parseDeps(h))).toBeUndefined();
    expect(parseSessionMention(`@${"x".repeat(65)} hi`, parseDeps(h))).toBeUndefined();
  });

  it("② a subagent label never addresses a session (subagent priority)", () => {
    const h = portHarness();
    h.labels.add("builder");
    expect(parseSessionMention("@builder hi", parseDeps(h))).toBeUndefined();
  });

  it("③ a real same-name file (or dir, or dangling symlink) wins — the input goes to pi", () => {
    const h = portHarness({ rows: [row("ab12cd34", "collide")] });
    writeFileSync(join(dir, "collide"), "file");
    expect(parseSessionMention("@collide hi", parseDeps(h))).toBeUndefined();
    mkdirSync(join(dir, "colddir"));
    const h2 = portHarness({ rows: [row("ab12cd34", "colddir")] });
    expect(parseSessionMention("@colddir hi", parseDeps(h2))).toBeUndefined();
    symlinkSync(join(dir, "nowhere-target"), join(dir, "dangling"));
    const h3 = portHarness({ rows: [row("ab12cd34", "dangling")] });
    expect(parseSessionMention("@dangling hi", parseDeps(h3))).toBeUndefined();
  });

  it("④ zero or 2+ cache hits pass through (staleness behaves the same, RR8)", () => {
    const h = portHarness();
    expect(parseSessionMention("@nobody hi", parseDeps(h))).toBeUndefined(); // 0 hits
    const h2 = portHarness({ rows: [row("ab12cd34", "dup"), row("ef9911aa", "dup")] });
    expect(parseSessionMention("@dup hi", parseDeps(h2))).toBeUndefined(); // 2 name hits
    const h3 = portHarness({ rows: [row("ab12cd34", "x"), row("x", undefined)] });
    expect(parseSessionMention("@x hi", parseDeps(h3))).toBeUndefined(); // name/ref cross hit
    const h4 = portHarness({ rows: [] }); // empty (or stale) cache
    expect(parseSessionMention("@builder hi", parseDeps(h4))).toBeUndefined();
  });
});

describe("§9.1 ③ bareNameFileConflict (r2 #12 — fail closed)", () => {
  it("undefined lstat (ENOENT) is the ONLY no-conflict result", () => {
    expect(bareNameFileConflict(dir, "definitely-not-here-xyz")).toBe(false);
  });
  it("existing file, dir, dangling symlink all conflict", () => {
    writeFileSync(join(dir, "exists-file"), "x");
    expect(bareNameFileConflict(dir, "exists-file")).toBe(true);
    expect(bareNameFileConflict(dir, "colddir")).toBe(true);
    expect(bareNameFileConflict(dir, "dangling")).toBe(true);
  });
  it("a throwing stat (EACCES/ENOTDIR/ELOOP) conflicts — released to pi", () => {
    writeFileSync(join(dir, "plainfile"), "x");
    // cwd itself contains a file component ⇒ ENOTDIR ⇒ throw ⇒ conflict
    expect(bareNameFileConflict(join(dir, "plainfile"), "whatever")).toBe(true);
  });

  it("cleanup probe: the shared tmpdir holds no stray builder-named entries", () => {
    expect(bareNameFileConflict(dir, "builder")).toBe(false);
  });
});

describe("§9.3 port factory & safe parse", () => {
  it("not joined ⇒ parse returns undefined even for the explicit form (live check)", () => {
    const h = portHarness({ joined: false });
    expect(h.port.parse("@session:builder hi")).toBeUndefined();
    expect(safeParseSessionMention(h.port, "@session:builder hi")).toBeUndefined();
    h.setJoined(true);
    expect(h.port.parse("@session:builder hi")?.form).toBe("explicit");
  });

  it("a throwing dep degrades to a pass-through, never a broken input path", () => {
    const throwing: MentionSessionPort = {
      parse: () => {
        throw new Error("membership unreadable");
      },
      send: async () => ({ status: "sent", effect: "applied" }),
    };
    expect(safeParseSessionMention(throwing, "@session:x hi")).toBeUndefined();
    expect(safeParseSessionMention(undefined, "@session:x hi")).toBeUndefined();
  });
});

describe("§9.5 sessionCompletionBare (insert-value rule)", () => {
  it("bare only when ①②③ + cache-unique all hold; every conflict forces the explicit ref", () => {
    const h = portHarness({ rows: [row("ab12cd34", "clean"), row("ef9911aa")] });
    const deps = parseDeps(h);
    expect(sessionCompletionBare(deps, "clean")).toBe(true);
    expect(sessionCompletionBare(deps, "ab12cd34")).toBe(true); // unique ref is fine too
    expect(sessionCompletionBare(deps, "a.b")).toBe(false); // ① shape
    expect(sessionCompletionBare(deps, "ef9911aa")).toBe(true); // control: other unique name
    h.labels.add("clean2");
    expect(sessionCompletionBare(parseDeps({ ...h, rows: [...h.rows, row("cc", "clean2")] }), "clean2")).toBe(false); // ② label
    writeFileSync(join(dir, "ef9911aa"), "file");
    expect(sessionCompletionBare(parseDeps(h), "ef9911aa")).toBe(false); // ③ file conflict
    expect(sessionCompletionBare(deps, "nobody")).toBe(false); // ④ not unique in cache
  });
});

describe("§9.3/§9.6 routeSessionMention", () => {
  it("success with expectReply: session result + sent notice (q… + 等待回复 ≤30m)", async () => {
    const h = portHarness();
    const now = 1_000_000;
    h.setOutcome({
      status: "sent",
      effect: "applied",
      requestId: "q0123456789abcdef01",
      replyDueAt: now + 1_800_000,
      to: { ref: "ab12cd34", name: "builder" },
    });
    const notices: SessionMentionNotice[] = [];
    const result = await routeSessionMention("@builder how are things?", {
      sessions: h.port,
      notifySession: (n) => notices.push(n),
      now: () => now,
    });
    expect(result).toEqual({
      handled: true,
      action: "session",
      target: "ab12cd34",
      requestId: "q0123456789abcdef01",
      effect: "applied",
    });
    expect(h.sends).toEqual([{ target: "ab12cd34", message: "how are things?" }]); // default expectReply
    expect(notices).toEqual([{ kind: "sent", message: "→ 已发给 builder（q0123456789abcdef01，等待回复 ≤30m）" }]);
  });

  it("explicit form routes with the operand verbatim", async () => {
    const h = portHarness();
    h.setOutcome({ status: "sent", effect: "applied", to: { ref: "zz" } });
    const result = await routeSessionMention("@session:who-is-this ping", { sessions: h.port });
    expect(result).toMatchObject({ action: "session", target: "who-is-this", effect: "applied" });
    expect(h.sends[0]).toEqual({ target: "who-is-this", message: "ping" });
  });

  it("reply_unsupported (pre-send) retries ONCE as a plain send and tells the user", async () => {
    const h = portHarness();
    h.setOutcome((call) =>
      call === 1
        ? { status: "reply_unsupported", effect: "none" }
        : { status: "sent", effect: "applied", to: { ref: "ab12cd34", name: "builder" } },
    );
    const notices: SessionMentionNotice[] = [];
    const result = await routeSessionMention("@builder hi", {
      sessions: h.port,
      notifySession: (n) => notices.push(n),
    });
    expect(h.sends).toHaveLength(2);
    expect(h.sends[1]).toMatchObject({ options: { expectReply: false } });
    expect(result).toEqual({ handled: true, action: "session", target: "ab12cd34", effect: "applied" });
    expect(notices).toEqual([{ kind: "sent", message: "→ 已发给 builder（对方不支持回复关联，已按普通消息发送）" }]);
  });

  it("maps §9.6's error table", async () => {
    const cases: Array<[MentionSessionSendOutcome, string]> = [
      [{ status: "no_target", effect: "none" }, "找不到会话 builder"],
      [{ status: "ambiguous", effect: "none" }, "有多个匹配 builder 的会话，请用 @session:<ref> 指定"],
      [{ status: "reply_quota", effect: "none", pendingReplies: 3 }, "已有 3 条回复尚未进入对话，请先查看后再发"],
      [{ status: "sent", effect: "none", reason: "rejected" }, "对方拒收（builder）"],
      [{ status: "sent", effect: "none", reason: "fenced:compaction" }, "未送达（fenced:compaction），可稍后重试"],
      [{ status: "error", effect: "none", reason: "client_deadline" }, "未送达（client_deadline），可稍后重试"],
      [{ status: "unanswered" as never, effect: "unknown", reason: "link_lost" }, "可能已送达（builder），不要重发"],
    ];
    for (const [outcome, text] of cases) {
      const h = portHarness();
      h.setOutcome(outcome);
      const notices: SessionMentionNotice[] = [];
      const result = await routeSessionMention("@builder hi", {
        sessions: h.port,
        notifySession: (n) => notices.push(n),
      });
      expect(result, text).toMatchObject({ action: "session", effect: outcome.effect });
      expect(notices, text).toEqual([{ kind: "error", message: text }]);
    }
  });

  it("a throwing send port degrades to a none-effect result plus an error notice", async () => {
    const port: MentionSessionPort = {
      parse: (text) => portHarness().port.parse(text),
      send: async () => {
        throw new Error("hub socket gone");
      },
    };
    const notices: SessionMentionNotice[] = [];
    const result = await routeSessionMention("@session:x hi", {
      sessions: port,
      notifySession: (n) => notices.push(n),
    });
    expect(result).toEqual({ handled: true, action: "session", target: "x", effect: "none" });
    expect(notices[0]?.message).toContain("未送达");
  });

  it("non-matches and absent ports pass through untouched", async () => {
    const h = portHarness();
    expect(await routeSessionMention("@nobody hi", { sessions: h.port })).toEqual({ handled: false });
    expect(await routeSessionMention("plain text", { sessions: h.port })).toEqual({ handled: false });
    expect(await routeSessionMention("@session:x hi", { sessions: undefined })).toEqual({ handled: false });
    expect(h.sends).toEqual([]);
  });
});

describe("routeMention integration (subagent priority, §9.1 rule 1)", () => {
  const snapshot = (status: RunSnapshot["status"]): RunSnapshot => ({
    runId: "run-1",
    generation: 1,
    status,
    phase: status === "running" ? "prompt_dispatch" : "settled",
    deadlines: { enqueuedAt: 0, deadlineAt: undefined, queueDeadlineAt: undefined },
    updatedAt: 1,
    diag: {
      createdAt: 0,
      phase: status === "running" ? "prompt_dispatch" : "settled",
      phaseEnteredAt: 0,
      pendingTools: 0,
      turns: 0,
      escalation: [],
      orphaned: false,
      generation: 1,
      degraded: [],
      staleInputs: 0,
      unkillable: [],
    },
  });

  it("a registered subagent label wins over a same-named session", async () => {
    const registry = createMentionRegistry();
    registry.register("builder", { runId: "run-1", type: "worker", parent: "root" });
    const h = portHarness(); // directory also has name "builder"
    const steer = vi.fn(async () => ({ ok: true as const }));
    const result = await routeMention("@builder inspect", {
      registry,
      query: { get: () => snapshot("running"), steer },
      spawn: { spawn: vi.fn() as never },
      sessions: h.port,
    });
    expect(result).toEqual({ handled: true, action: "steer", runId: "run-1" });
    expect(steer).toHaveBeenCalledTimes(1);
    expect(h.sends).toEqual([]); // the session branch was never reached
  });

  it("the session branch runs only after parseMention missed", async () => {
    const registry = createMentionRegistry(); // no labels
    const h = portHarness();
    h.setOutcome({ status: "sent", effect: "applied", requestId: "qaaaaaaaaaaaaaaaaaaa" });
    const result = await routeMention("@builder inspect", {
      registry,
      query: { get: () => snapshot("running"), steer: vi.fn() },
      spawn: { spawn: vi.fn() as never },
      sessions: h.port,
    });
    expect(result).toMatchObject({ action: "session", target: "ab12cd34" });
    expect(h.sends).toHaveLength(1);
  });

  it("parseMention itself is untouched: a label miss is still a miss", () => {
    const registry = createMentionRegistry();
    expect(parseMention("@builder hi", registry)).toBeUndefined(); // registry empty ⇒ no hit
  });

  it("installMentionInput renders §9.6 notices (display-only) and marks the input handled", async () => {
    const handlers: ((event: { type: "input"; text: string }) => Promise<unknown>)[] = [];
    const sent: unknown[] = [];
    const pi = {
      on: (_event: string, handler: (event: { type: "input"; text: string }) => Promise<unknown>) => {
        handlers.push(handler);
      },
      sendMessage: (message: unknown) => sent.push(message),
    };
    const h = portHarness();
    h.setOutcome({
      status: "sent",
      effect: "applied",
      requestId: "q0123456789abcdef01",
      replyDueAt: Date.now() + 1_800_000, // installMentionInput has no injected clock
      to: { ref: "ab12cd34", name: "builder" },
    });
    installMentionInput(pi, {
      registry: createMentionRegistry(),
      query: { get: () => snapshot("running"), steer: vi.fn() },
      spawn: { spawn: vi.fn() as never },
      sessions: h.port,
    });
    await expect(handlers[0]!({ type: "input", text: "@builder hi" })).resolves.toEqual({ action: "handled" });
    expect(sent).toEqual([
      {
        customType: "subagent:mention-session",
        content: "→ 已发给 builder（q0123456789abcdef01，等待回复 ≤30m）",
        display: true,
        details: { source: "mention-session" },
      },
    ]);
    // error variant rides subagent:mention-error with details.source mention-session
    const h2 = portHarness();
    h2.setOutcome({ status: "no_target", effect: "none" });
    const sent2: unknown[] = [];
    const pi2 = {
      on: (_e: string, handler: (event: { type: "input"; text: string }) => Promise<unknown>) => {
        handlers.push(handler);
      },
      sendMessage: (message: unknown) => sent2.push(message),
    };
    installMentionInput(pi2, {
      registry: createMentionRegistry(),
      query: { get: () => snapshot("running"), steer: vi.fn() },
      spawn: { spawn: vi.fn() as never },
      sessions: h2.port,
    });
    await handlers[1]!({ type: "input", text: "@builder hi" });
    expect(sent2).toEqual([
      {
        customType: "subagent:mention-error",
        content: "找不到会话 builder",
        display: true,
        details: { source: "mention-session" },
      },
    ]);
  });
});
