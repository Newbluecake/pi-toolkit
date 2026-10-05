/**
 * Repro for the field report (2026-10-05): a web-hub LAN user answers a multiSelect ask_user
 * question with every option ticked, but the tool result's `selected` only keeps the first one.
 * The report additionally implicates the interrupt → re-ask path (the call had been interrupted
 * by a background completion notice once before the user actually answered).
 *
 * This test drives the REAL `src/ask-user/index.ts` tool wired to the REAL
 * `src/web-hub/agent/dialogs.ts` DialogBridge (not a fake port/session, unlike
 * remote-race.test.ts / bg-harness's FakeSession) so the encode (dialogs.ts `answer()` →
 * `answer-codec.ts` `encodeAnswer`) → decode (`channel-handler.ts` `protoAnswersToResult` →
 * `decodeAnswer`) round trip runs for real, across a background interrupt + re-ask cycle.
 */
import { describe, expect, it } from "vitest";
import factory from "../../src/ask-user/index.js";
import { createDialogBridge } from "../../src/web-hub/agent/dialogs.js";
import { FakeClock, FakePort, flush, tuiContext } from "./bg-harness.js";

const QUESTIONS = [
  { header: "同步", question: "要不要同步？", options: [{ label: "Yes" }, { label: "No" }] },
  { header: "详情页", question: "详情页怎么处理？", options: [{ label: "A" }, { label: "B" }] },
  { header: "停不掉", question: "停不掉怎么办？", options: [{ label: "重启" }, { label: "忽略" }] },
  {
    header: "其他",
    question: "以下推荐项都同意吗？",
    multiSelect: true,
    options: [
      { label: "(Recommended) 删离线 TUI 卡片不发信号" },
      { label: "(Recommended) 停掉自动刷新" },
      { label: "(Recommended) 清空队列" },
    ],
  },
];
const PARAMS = { questions: QUESTIONS };
const Q4_KEY = "以下推荐项都同意吗？"; // protoAnswersToResult keys the result by question text
const Q4_OPTIONS = QUESTIONS[3]!.options.map((o) => o.label);

function harness() {
  let tool: { execute: (...args: any[]) => Promise<any> } | undefined;
  const port = new FakePort();
  const clock = new FakeClock();
  const bridge = createDialogBridge({ enabled: true, epoch: "e1", isAttached: () => true });
  const pi = {
    events: { emit: () => undefined },
    registerTool(definition: { execute: (...args: any[]) => Promise<any> }) {
      tool = definition;
    },
    getAllTools: () => [{ name: "ask_user" }],
    setActiveTools: () => undefined,
    on: () => undefined,
    appendEntry: () => undefined,
    sendMessage: () => undefined,
  };
  factory(pi as never, {
    remote: () => bridge,
    background: () => port,
    interrupt: () => ({ enabled: true, delayMs: 1000, rpc: false }),
    clock,
  });
  if (tool === undefined) throw new Error("tool not registered");
  return { tool, port, clock, bridge };
}

describe("web-hub multiSelect answer survives a background interrupt + re-ask", () => {
  it("keeps every ticked option after one interrupt cycle", async () => {
    const h = harness();

    // --- first attempt: interrupted by a background completion before the user answers ---
    const c1 = tuiContext();
    const first = h.tool.execute("call-1", PARAMS, undefined, undefined, c1.ctx);
    await flush();
    expect(h.bridge.frame().open).toHaveLength(1);

    h.port.fire();
    h.clock.advance(1000);
    const r1 = await first;
    expect(r1.details.interrupted?.kind).toBe("background");
    expect(h.bridge.frame().open).toHaveLength(0);

    // --- second attempt: the model re-asks the identical questions ---
    const c2 = tuiContext();
    const second = h.tool.execute("call-2", PARAMS, undefined, undefined, c2.ctx);
    await flush();
    const open = h.bridge.frame().open;
    expect(open).toHaveLength(1);
    const dialogId = open[0]!.dialogId;
    const q4Wire = open[0]!.questions[3]!;
    expect(q4Wire.multiSelect).toBe(true);
    expect(q4Wire.header).toBe("其他");

    // --- the web user ticks every option on the multi-select question and submits ---
    const answerResult = h.bridge.answer(
      dialogId,
      [
        { selected: ["Yes"], other: null },
        { selected: ["A"], other: null },
        { selected: ["重启"], other: null },
        { selected: [...Q4_OPTIONS], other: null },
      ],
      "alice@10.0.0.5",
      "cmd-answer-1",
      "e1",
    );
    expect(answerResult).toEqual({ ok: true, data: { op: "dialog_answer" } });

    const r2 = await second;
    expect(r2.details.cancelled).toBe(false);
    const q4Answer = r2.details.answers[Q4_KEY];
    expect(q4Answer).toBeDefined();
    expect(new Set(q4Answer!.selected)).toEqual(new Set(Q4_OPTIONS));
    expect(q4Answer!.selected).toHaveLength(3);
  });

  it("keeps every ticked option with no prior interrupt (control case)", async () => {
    const h = harness();
    const c = tuiContext();
    const pending = h.tool.execute("call-1", PARAMS, undefined, undefined, c.ctx);
    await flush();
    const open = h.bridge.frame().open;
    const dialogId = open[0]!.dialogId;

    const answerResult = h.bridge.answer(
      dialogId,
      [
        { selected: ["Yes"], other: null },
        { selected: ["A"], other: null },
        { selected: ["重启"], other: null },
        { selected: [...Q4_OPTIONS], other: null },
      ],
      "alice@10.0.0.5",
      "cmd-answer-1",
      "e1",
    );
    expect(answerResult).toEqual({ ok: true, data: { op: "dialog_answer" } });

    const result = await pending;
    const q4Answer = result.details.answers[Q4_KEY];
    expect(q4Answer).toBeDefined();
    expect(q4Answer!.selected).toHaveLength(3);
  });
});
