import { describe, expect, it } from "vitest";
import { QUOTA_CUSTOM_TYPE } from "../../src/quota/hook.js";
import { LOAD_CUSTOM_TYPE } from "../../src/sysload/hook.js";
import { COMPACT_HINT_CUSTOM_TYPE, USAGE_TICK_CUSTOM_TYPE } from "../../src/compact-hint/threshold.js";
import { WORKFLOW_NOTIFICATION_TYPE } from "../../src/adapters/workflow-notice.js";
import { TIMEOUT_NOTICE_TYPE } from "../../src/delivery/deadline-notice.js";
import { XS_REPLY_NOTICE_TYPE } from "../../src/fabric/xs/reply-notice.js";
import { SESSION_MENTION_SENT_CUSTOM_TYPE } from "../../src/mention/session.js";
import { SWITCH_NOTICE_CUSTOM_TYPE } from "../../src/context-switch/child.js";
import {
  TOOLKIT_LABELLED_CUSTOM_TYPES,
  renderToolkitMessage,
  toolkitLabel,
} from "../../src/ui/toolkit-message-renderer.js";

const theme = {
  fg: (_c: string, s: string) => s,
  bg: (_c: string, s: string) => s,
  bold: (s: string) => s,
  italic: (s: string) => s,
  underline: (s: string) => s,
  strikethrough: (s: string) => s,
} as never;

describe("toolkit message renderer", () => {
  it("rewrites the label but keeps body", () => {
    const c = renderToolkitMessage(
      { role: "custom", customType: "subagent:usage-tick", content: "hello body", display: true } as never,
      { expanded: false, outputPad: 1 },
      theme,
    );
    const out = c!.render(80).join("\n");
    expect(out).toContain("[toolkit:usage-tick]");
    expect(out).not.toContain("subagent:");
    expect(out).toContain("hello body");
  });

  it("handles block content and falls back (undefined) without customType", () => {
    const c = renderToolkitMessage(
      { customType: "subagent:quota", content: [{ type: "text", text: "A" }, { type: "image" }] } as never,
      { expanded: true, outputPad: 0 },
      theme,
    );
    expect(c!.render(40).join("\n")).toContain("A");
    expect(renderToolkitMessage({ content: "x" } as never, { expanded: false, outputPad: 1 }, theme)).toBeUndefined();
  });

  it("toolkitLabel only rewrites the subagent: prefix", () => {
    expect(toolkitLabel("subagent:quota")).toBe("toolkit:quota");
    expect(toolkitLabel("bash-job:notification")).toBe("bash-job:notification");
  });

  it("registration list covers every visible subagent:* type", () => {
    for (const t of [
      QUOTA_CUSTOM_TYPE,
      LOAD_CUSTOM_TYPE,
      COMPACT_HINT_CUSTOM_TYPE,
      USAGE_TICK_CUSTOM_TYPE,
      WORKFLOW_NOTIFICATION_TYPE,
      TIMEOUT_NOTICE_TYPE,
      XS_REPLY_NOTICE_TYPE,
      SESSION_MENTION_SENT_CUSTOM_TYPE,
      SWITCH_NOTICE_CUSTOM_TYPE,
      "subagent:notification",
      "subagent:mention-error",
    ]) {
      expect(TOOLKIT_LABELLED_CUSTOM_TYPES).toContain(t);
    }
  });
});
