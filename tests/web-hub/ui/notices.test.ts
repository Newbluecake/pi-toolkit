// @vitest-environment happy-dom
/**
 * `NoticeBanner.vue` / `NoticeStack.vue` (ui-design.md §10, vue-plan.md v2.1 §3.2, §5.2 — P3).
 * Persistent notices render as a collapsible-but-never-dismissible `<details>`
 * (`notice-compact`); everything else is a plain banner whose action button dispatches
 * `action(notice.id)`.
 */
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import NoticeBanner from "../../../src/web-hub/ui/src/components/shell/NoticeBanner.vue";
import NoticeStack from "../../../src/web-hub/ui/src/components/shell/NoticeStack.vue";
import type { Notice } from "../../../src/web-hub/ui/src/types.js";

describe("NoticeBanner.vue (vue-plan.md v2.1 §3.2, §5.2)", () => {
  it("renders a persistent notice as a collapsible <details> with no dismiss control", () => {
    const notice: Notice = {
      id: "initial-password",
      tone: "warn",
      title: "Change the initial password soon.",
      body: "The hub still accepts the password generated at setup.",
      persistent: true,
    };
    const wrapper = mount(NoticeBanner, { props: { notice } });
    expect(wrapper.find("details.notice-compact").exists()).toBe(true);
    expect(wrapper.find("summary").text()).toContain("Change the initial password soon.");
    expect(wrapper.find("button").exists()).toBe(false);
    expect(wrapper.find(".notice-more").text()).toBe("The hub still accepts the password generated at setup.");
  });

  it("renders a non-persistent notice as a plain banner with role=alert for danger tone", () => {
    const notice: Notice = { id: "session-expired", tone: "danger", title: "Session expired.", persistent: false };
    const wrapper = mount(NoticeBanner, { props: { notice } });
    expect(wrapper.find("div.notice.notice--danger").attributes("role")).toBe("alert");
  });

  it("a warn/info tone uses role=status", () => {
    const notice: Notice = { id: "reconnecting", tone: "warn", title: "Connection lost.", persistent: false };
    const wrapper = mount(NoticeBanner, { props: { notice } });
    expect(wrapper.find("div.notice").attributes("role")).toBe("status");
  });

  it("clicking the action button emits action(notice.id)", async () => {
    const notice: Notice = {
      id: "history-error",
      tone: "danger",
      title: "History unavailable.",
      action: { label: "Retry" },
      persistent: false,
    };
    const wrapper = mount(NoticeBanner, { props: { notice } });
    const btn = wrapper.find("button.notice-action");
    expect(btn.text()).toBe("Retry");
    await btn.trigger("click");
    expect(wrapper.emitted("action")).toEqual([["history-error"]]);
  });
});

describe("NoticeStack.vue (vue-plan.md v2.1 §3.2, §5.2)", () => {
  it("renders one banner per notice and forwards action events", async () => {
    const notices: Notice[] = [
      { id: "a", tone: "warn", title: "A", persistent: true },
      { id: "b", tone: "danger", title: "B", action: { label: "Retry" }, persistent: false },
    ];
    const wrapper = mount(NoticeStack, { props: { notices } });
    expect(wrapper.findAll(".notice")).toHaveLength(2);
    await wrapper.find("button.notice-action").trigger("click");
    expect(wrapper.emitted("action")).toEqual([["b"]]);
  });

  it("renders nothing (an empty .banners) when there are no notices", () => {
    const wrapper = mount(NoticeStack, { props: { notices: [] } });
    expect(wrapper.find(".banners").exists()).toBe(true);
    expect(wrapper.findAll(".notice")).toHaveLength(0);
  });
});

/**
 * `detail/agentNotices.ts` §5.6 横幅去重 (control-plan.md v2.1 — C5 追加): a prompt attributed
 * (via `dialogId`, K8) to an OPEN ask_user dialog must NOT feed the "Waiting on a dialog in the
 * terminal" banner — the web answer form replaces it; unattributed prompts (other extension
 * dialogs) keep the banner unchanged.
 */
import { buildAgentNotices } from "../../../src/web-hub/ui/src/components/detail/agentNotices.js";
import { useI18n } from "../../../src/web-hub/ui/src/composables/useI18n.js";
import type { AgentState } from "../../../src/web-hub/ui/src/types.js";

describe("agentNotices §5.6 dialog-banner dedup (C5)", () => {
  const { t } = useI18n(["en-US"]);
  const base = {
    key: "agent-a",
    card: {},
    down: false,
    prompts: [],
    fleet: [],
    items: [],
    uid: 0,
    lastSeq: 0,
    streaming: null,
    tools: [],
    history: "loaded",
    hasMore: false,
    paging: false,
    needsResync: false,
    sub: null,
  } as const;

  function agentWith(prompts: readonly unknown[], dialogs?: unknown): AgentState {
    return {
      ...base,
      prompts: prompts as AgentState["prompts"],
      ...(dialogs !== undefined ? { dialogs } : {}),
    } as unknown as AgentState;
  }

  it("an open-dialog-attributed prompt produces NO waiting banner", () => {
    const notices = buildAgentNotices(
      agentWith([{ kind: "custom", title: "ask_user", since: 1, dialogId: "ask:tc-1" }], {
        epoch: "e1",
        open: [{ dialogId: "ask:tc-1" }],
        closed: [],
      }),
      t,
    );
    expect(notices).toEqual([]);
  });

  it("a prompt whose dialogId is not open (or has none) keeps the banner", () => {
    const unattributed = buildAgentNotices(agentWith([{ kind: "custom", title: "picker", since: 1 }]), t);
    expect(unattributed).toHaveLength(1);
    expect(unattributed[0]!.id).toBe("agent-waiting");
    const closedOnly = buildAgentNotices(
      agentWith([{ kind: "custom", title: "ask_user", since: 1, dialogId: "ask:tc-1" }], {
        epoch: "e1",
        open: [],
        closed: [{ dialogId: "ask:tc-1" }],
      }),
      t,
    );
    expect(closedOnly).toHaveLength(1);
  });

  it("mixed prompts: the banner counts only the unattributed ones", () => {
    const notices = buildAgentNotices(
      agentWith(
        [
          { kind: "custom", title: "ask_user", since: 1, dialogId: "ask:tc-1" },
          { kind: "custom", title: "resume picker", since: 2 },
        ],
        { epoch: "e1", open: [{ dialogId: "ask:tc-1" }], closed: [] },
      ),
      t,
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]!.body).toContain("resume picker");
    expect(notices[0]!.body).not.toContain("+1");
  });
});
