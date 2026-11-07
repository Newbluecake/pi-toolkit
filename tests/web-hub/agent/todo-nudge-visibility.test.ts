// Task59 阶段A — todo nudge VISIBILITY on both ends (TUI + WebUI), plus the
// no-wake / no-self-loop guarantees that visibility must not break.
//
// Evidence-backed premises (read from the pi 1.5 SDK source, not guessed):
//  - TUI: interactive-mode.js `addMessageToChat` renders a custom message ONLY when
//    `message.display` is true, via `CustomMessageComponent` (default box + markdown body
//    when no extension renderer is registered for the customType). We instantiate the REAL
//    component from the installed SDK (relative node_modules path — the package exports map
//    has no deep subpath; precedent: tests/ask-user/loader.test.ts).
//  - WebUI: the transcript view model (`entries.ts` `itemEntry`) drops `display:false`
//    custom messages (except the date marker) and maps display:true ones to a `custom`
//    entry rendered by `TxCustom.vue` (mounted here with @vue/test-utils, not the full page).
//  - No wake: the nudge is sent `triggerTurn:false`; agent-session.js `sendCustomMessage`
//    only ever starts a run on a truthy `triggerTurn`. The message role is "custom"
//    (machine), never "user".
//  - No E1 self-loop: `message_start` fires regardless of display, but E1 matches only the
//    three completion customTypes — TODO_NUDGE_CUSTOM_TYPE is not one of them.
//
// Stage B (auto idle wake-up) is NOT implemented — nothing here may start a new turn.

// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { describe, expect, test } from "vitest";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { TODO_NUDGE_CUSTOM_TYPE, wireTodo } from "../../../src/todo/index.js";
import TxCustom from "../../../src/web-hub/ui/src/components/transcript/TxCustom.vue";
import { buildTxEntries } from "../../../src/web-hub/ui/src/components/transcript/entries.js";
import type { TranscriptSource } from "../../../src/web-hub/ui/src/contracts.js";
// Deep import through node_modules (exports map has no subpath) — see header.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — untyped JS dist module
import { CustomMessageComponent } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/custom-message.js";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error — untyped JS dist module
import * as themeModule from "../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyTool = ToolDefinition<any, any, any>;

interface SentMessage {
  message: { customType: string; content: string; display: boolean; details?: unknown };
  options: { triggerTurn: false };
}

function fakePi() {
  const tools = new Map<string, AnyTool>();
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const sent: SentMessage[] = [];
  const pi = {
    registerTool: (def: AnyTool) => tools.set(def.name, def),
    registerCommand: () => undefined,
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
    appendEntry: () => undefined,
    sendMessage: (message: SentMessage["message"], options: SentMessage["options"]) => sent.push({ message, options }),
  };
  return {
    pi: pi as unknown as ExtensionAPI,
    tools,
    handlers,
    sent,
    sendUserMessageCalls: [] as unknown[],
  };
}

function fakeCtx(): ExtensionContext {
  return {
    mode: "tui",
    hasUI: true,
    ui: { setStatus: () => undefined, setWidget: () => undefined, notify: () => undefined },
    sessionManager: { getBranch: () => [] },
  } as unknown as ExtensionContext;
}

const NUDGE = { enabled: true, graceTurns: 2, fallbackTurns: 20, cooldownTurns: 8 };

/** Real wiring → one actually-fired nudge message (fallback trigger, in_progress task). */
async function fireOneNudge(): Promise<SentMessage> {
  const host = fakePi();
  wireTodo(host.pi, {
    isChildSession: false,
    nudge: NUDGE,
    archive: { onCompact: false, afterTurns: 0 },
    sendMessage: host.pi.sendMessage,
  });
  const ctx = fakeCtx();
  await host.tools
    .get("TaskCreate")!
    .execute("c1", { subject: "Do the thing", description: "d" }, undefined, undefined, ctx);
  await host.tools.get("TaskUpdate")!.execute("c2", { taskId: "1", status: "in_progress" }, undefined, undefined, ctx);
  for (let i = 0; i < NUDGE.fallbackTurns; i++) host.handlers.get("turn_end")?.({}, ctx);
  expect(host.sent).toHaveLength(1);
  return host.sent[0]!;
}

describe("todo nudge visibility (Task59 阶段A): wiring", () => {
  test("the fired message is display:true AND triggerTurn:false (no new model turn)", async () => {
    const sent = await fireOneNudge();
    expect(sent.message.customType).toBe(TODO_NUDGE_CUSTOM_TYPE);
    expect(sent.message.display).toBe(true);
    expect(sent.options.triggerTurn).toBe(false);
    // The actionable-check copy is present (authorized-scope continuation, not just status nag).
    expect(sent.message.content).toContain("已授权");
    expect(sent.message.content).toContain("TaskUpdate");
    expect(sent.message.content).toContain("不要借本提醒启动排队中或未授权的任务");
  });

  test("message_start for the nudge's own customType never scores E1 evidence (no self-loop)", async () => {
    const host = fakePi();
    const { getTrackerSnapshot } = wireTodo(host.pi, {
      isChildSession: false,
      nudge: NUDGE,
      archive: { onCompact: false, afterTurns: 0 },
      sendMessage: host.pi.sendMessage,
    });
    host.handlers.get("message_start")?.(
      { message: { role: "custom", customType: TODO_NUDGE_CUSTOM_TYPE } },
      fakeCtx(),
    );
    expect(getTrackerSnapshot!().hasEvidence).toBe(false);
  });
});

describe("todo nudge visibility: TUI (real SDK CustomMessageComponent)", () => {
  test("a display:true nudge renders its body through the default custom-message box", async () => {
    const sent = await fireOneNudge();
    themeModule.initTheme("dark", false);
    const component = new CustomMessageComponent({
      role: "custom",
      customType: sent.message.customType,
      content: sent.message.content,
      display: true,
      details: sent.message.details,
      timestamp: 1,
    });
    const text = stripVTControlCharacters((component as any).render(80).join("\n"));
    expect(text).toContain("[subagent:todo-nudge]");
    expect(text).toContain("[todo] 自上次更新任务以来");
    expect(text).toContain("进行中：#1 Do the thing");
  });

  test("the machine-sent custom message is role 'custom', never user input", async () => {
    const sent = await fireOneNudge();
    // The SDK's sendCustomMessage builds { role: "custom", ... } from exactly this payload; a
    // custom role is renderer-only, the transcript never maps it to the user lane (below).
    expect(sent.message.customType).toBe(TODO_NUDGE_CUSTOM_TYPE);
    expect((sent.message as { role?: unknown }).role).not.toBe("user");
  });
});

describe("todo nudge visibility: WebUI (transcript projection + TxCustom mount)", () => {
  const liveItem = (display: boolean, content: string) => ({
    // what eventCore's messageItem(m, keys, `s:${seq}`) produces for a message_end
    id: "s:1",
    kind: "message",
    message: { role: "custom", customType: TODO_NUDGE_CUSTOM_TYPE, content, display, timestamp: 5 },
    truncated: false,
  });
  const source = (display: boolean, content: string): TranscriptSource =>
    ({
      key: "agent-a",
      items: [liveItem(display, content)],
      streaming: null,
      tools: [],
      history: "loaded",
      hasMore: false,
      paging: false,
    }) as unknown as TranscriptSource;

  test("display:true nudge appears as exactly ONE custom entry carrying the body", async () => {
    const sent = await fireOneNudge();
    const { entries } = buildTxEntries(source(true, sent.message.content));
    const customs = entries.filter((e) => e.type === "custom");
    expect(customs).toHaveLength(1);
    const entry = customs[0]!;
    expect(entry.customType).toBe(TODO_NUDGE_CUSTOM_TYPE);
    expect(entry.text).toContain("进行中：#1 Do the thing");
    expect(entry.text).toContain("已授权");
  });

  test("display:false (pre-Task59 shape) stays dropped by the same projection", () => {
    const { entries } = buildTxEntries(source(false, "old hidden nudge"));
    expect(entries.filter((e) => e.type === "custom")).toHaveLength(0);
  });

  test("TxCustom.vue renders the nudge body with the kind chip, not a user message", async () => {
    const sent = await fireOneNudge();
    const w = mount(TxCustom, {
      props: { customType: TODO_NUDGE_CUSTOM_TYPE, text: sent.message.content, truncated: false },
    });
    const text = w.text();
    // Chip shows the namespaced kind without the "subagent:" prefix.
    expect(text).toContain("todo-nudge");
    expect(text).toContain("[todo] 自上次更新任务以来");
    expect(text).toContain("进行中：#1 Do the thing");
    // "todo-nudge" is not a SUBAGENT_KINDS member → plain notice header, no 子代理 who label.
    expect(text).not.toContain("子代理");
    w.unmount();
  });
});
