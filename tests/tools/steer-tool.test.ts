import { describe, expect, it } from "vitest";
import type { Text } from "@earendil-works/pi-tui";
import { Value } from "@sinclair/typebox/value";
import { createSteerTool, frameSteerReply, SteerToolParams } from "../../src/tools/steer-tool.js";
import type { QueryService } from "../../src/service/query-service.js";
import type { RunSnapshot, RunStatus } from "../../src/core/types.js";

const query = (steer: QueryService["steer"], get: QueryService["get"] = () => undefined): QueryService => ({
  get,
  list: () => [],
  wait: async () => ({ ok: false, reason: "unknown_run" }),
  waitAll: async () => ({ settled: [], pending: [] }),
  steer,
  stop: async () => false,
});

/** Minimal snapshot — the tool only reads .status and .diag.external. */
const snapshot = (status: RunStatus, external = false) =>
  ({
    runId: "r9",
    generation: 1,
    status,
    phase: "run",
    deadlines: {},
    diag: external ? { external: { provider: "droid" } } : {},
    updatedAt: 0,
  }) as RunSnapshot;

describe("tools/steer-tool: renderCall (TUI call card)", () => {
  // Bare-minimum Theme stand-in (same convention as agent-tool.test.ts).
  const theme = { fg: (_color: string, t: string) => t, bold: (t: string) => t };
  const ctx = (lastComponent?: unknown) => ({ lastComponent, state: {} });

  it("renders the target run_id and a one-line instruction preview", () => {
    const tool = createSteerTool({ query: query(async () => ({ ok: true })) });
    const comp = tool.renderCall!(
      { run_id: "r9", text: "focus on the\n  quota module first" },
      theme as never,
      ctx() as never,
    );
    const out = (comp as Text).render(120).join("\n");
    expect(out).toContain("Steer Subagent: r9");
    expect(out).toContain("focus on the quota module first"); // whitespace collapsed to one line
  });

  it("clips long previews and tolerates partial streaming args", () => {
    const tool = createSteerTool({ query: query(async () => ({ ok: true })) });
    const long = "x".repeat(200);
    const clipped = (tool.renderCall!({ run_id: "r9", text: long }, theme as never, ctx() as never) as Text)
      .render(300)
      .join("\n");
    expect(clipped).toContain("…");
    expect(clipped).not.toContain("x".repeat(100));
    const streaming = (tool.renderCall!({}, theme as never, ctx() as never) as Text).render(120).join("\n");
    expect(streaming).toContain("Steer Subagent:");
  });
});

describe("tools/steer-tool: reply param schema", () => {
  it("accepts none/ack/report and omission, rejects anything else", () => {
    expect(Value.Check(SteerToolParams, { run_id: "r9", text: "go" })).toBe(true);
    for (const reply of ["none", "ack", "report"])
      expect(Value.Check(SteerToolParams, { run_id: "r9", text: "go", reply })).toBe(true);
    expect(Value.Check(SteerToolParams, { run_id: "r9", text: "go", reply: "bogus" })).toBe(false);
    expect(Value.Check(SteerToolParams, { run_id: "r9", text: "go", reply: "ACK" })).toBe(false);
  });
});

describe("tools/steer-tool: reply framing (fabric on)", () => {
  const captured = () => {
    let sent: string | undefined;
    const tool = createSteerTool({
      query: query(async (_id, text) => {
        sent = text;
        return { ok: true };
      }),
      fabricEnabled: () => true,
    });
    return { tool, sent: () => sent };
  };

  it("ack wraps the text with a kind-finding reply instruction", async () => {
    const { tool, sent } = captured();
    const out = await tool.execute("t1", { run_id: "r9", text: "pivot to the parser first", reply: "ack" });
    const framed = sent();
    expect(framed).toBeDefined();
    expect(framed!.startsWith("[主会话 steer · 需回复]")).toBe(true);
    expect(framed).toContain("message_agent");
    expect(framed).toContain('to: "root", kind: "finding"');
    expect(framed).toContain("已收到 + 你将如何调整");
    expect(framed).toContain("回复后继续当前任务");
    expect(framed).toContain("主会话指令：\npivot to the parser first");
    expect(out.content[0]).toMatchObject({ type: "text" });
    expect((out.content[0] as { text: string }).text).toContain("subagent:fabric");
    expect((out.content[0] as { text: string }).text).toContain("end your turn");
    expect(out.details).toEqual({ ok: true, runId: "r9", reply: "ack", replyFramed: true });
  });

  it("report asks for the four-field ≤10-line progress report", async () => {
    const { tool, sent } = captured();
    await tool.execute("t1", { run_id: "r9", text: "status?", reply: "report" });
    const framed = sent()!;
    expect(framed.startsWith("[主会话 steer · 需进度报告]")).toBe(true);
    expect(framed).toContain('to: "root", kind: "finding"');
    expect(framed).toContain("不超过 10 行");
    for (const field of ["已完成", "正在进行", "阻塞项", "ETA"]) expect(framed).toContain(field);
    expect(framed).toContain("主会话指令：\nstatus?");
  });

  it("both framings mention the per-run finding quota (replies can be dropped)", () => {
    for (const reply of ["ack", "report"] as const) {
      const framed = frameSteerReply("x", reply);
      expect(framed).toContain("配额");
      expect(framed).toContain("超限会被丢弃");
    }
  });
});

describe("tools/steer-tool: reply degrade + verbatim default", () => {
  it("omitted reply and reply none deliver the text verbatim, byte-identical result", async () => {
    for (const params of [
      { run_id: "r9", text: "raw text" },
      { run_id: "r9", text: "raw text", reply: "none" as const },
    ]) {
      let sent: string | undefined;
      const tool = createSteerTool({
        query: query(async (_id, text) => {
          sent = text;
          return { ok: true };
        }),
        fabricEnabled: () => true, // even with fabric on: none ⇒ never framed
      });
      const out = await tool.execute("t1", params);
      expect(sent).toBe("raw text");
      expect(out.content).toEqual([{ type: "text", text: "Sent follow-up instruction to run r9." }]);
      expect(out.details).toEqual({ ok: true, runId: "r9" });
    }
  });

  it("fabric off ⇒ verbatim delivery + result note", async () => {
    let sent: string | undefined;
    const tool = createSteerTool({
      query: query(async (_id, text) => {
        sent = text;
        return { ok: true };
      }),
      fabricEnabled: () => false,
    });
    const out = await tool.execute("t1", { run_id: "r9", text: "hello", reply: "ack" });
    expect(sent).toBe("hello");
    const text = (out.content[0] as { text: string }).text;
    expect(text).toContain("reply 不可用：fabric 未启用，已按普通 steer 送达");
    expect(text).toContain("不会收到回复消息");
    expect(out.details).toEqual({ ok: true, runId: "r9", reply: "ack", replyFramed: false });
  });

  it("external-agent target (no message_agent) ⇒ verbatim delivery + result note", async () => {
    let sent: string | undefined;
    const tool = createSteerTool({
      query: query(
        async (_id, text) => {
          sent = text;
          return { ok: true };
        },
        () => snapshot("running", true),
      ),
      fabricEnabled: () => true,
    });
    const out = await tool.execute("t1", { run_id: "r9", text: "hello", reply: "report" });
    expect(sent).toBe("hello");
    expect((out.content[0] as { text: string }).text).toContain(
      "reply 不可用：目标为外部 agent run（无 message_agent），已按普通 steer 送达",
    );
  });

  it("nested target (grandchild of the main session) ⇒ verbatim delivery + result note", async () => {
    let sent: string | undefined;
    const tool = createSteerTool({
      query: query(
        async (_id, text) => {
          sent = text;
          return { ok: true };
        },
        () => ({ ...snapshot("running"), parentRunId: "r1" }) as RunSnapshot,
      ),
      fabricEnabled: () => true,
    });
    const out = await tool.execute("t1", { run_id: "r9", text: "hello", reply: "ack" });
    expect(sent).toBe("hello");
    expect((out.content[0] as { text: string }).text).toContain("reply 不可用：目标不是主会话的直接子 agent");
    expect(out.details).toEqual({ ok: true, runId: "r9", reply: "ack", replyFramed: false });
  });
});

describe("tools/steer-tool: terminal-target error keeps the resume hint", () => {
  it("not_running on a terminal run points at Agent({ resume })", async () => {
    const tool = createSteerTool({
      query: query(
        async () => ({ ok: false, reason: "not_running" }),
        () => snapshot("completed"),
      ),
      fabricEnabled: () => true,
    });
    await expect(tool.execute("t1", { run_id: "r9", text: "hi", reply: "ack" })).rejects.toThrow(
      'run r9 is not currently running (status: completed); it has finished and cannot be steered — use Agent({ resume: "r9" }) to continue its session in a new run instead',
    );
  });

  it("not_running for an unknown run keeps today's bare error (no resume hint)", async () => {
    const tool = createSteerTool({ query: query(async () => ({ ok: false, reason: "not_running" })) });
    await expect(tool.execute("t1", { run_id: "r9", text: "hi" })).rejects.toThrow("run r9 is not currently running");
  });
});
