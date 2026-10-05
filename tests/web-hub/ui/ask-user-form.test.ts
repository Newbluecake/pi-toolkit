// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { mount } from "@vue/test-utils";
import { computed, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import AskUserForm from "../../../src/web-hub/ui/src/components/dialog/AskUserForm.vue";
import {
  CONTROL_ENV,
  CONTROL_VIEW,
  dialogDraftKey,
  type ControlEnv,
  type ControlView,
} from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import type { AgentState } from "../../../src/web-hub/ui/src/types.js";

/**
 * `dialog/AskUserForm.vue` + `dialog/AskUserQuestion.vue` (control-plan.md v2.1 §5.5/§7.4 —
 * C5): single vs multi-question (tabs), option radio/checkbox + description + context, Other
 * free text, submit gating on `dialogComplete`, two-step cancel, drafts keyed
 * `(agentKey, epoch, dialogId)` (§3.5), and the suspended hub-restart state (readonly, Submit
 * disabled, draft preserved).
 */

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  vi.useRealTimers();
  for (const w of mounted.splice(0)) w.unmount();
});

const SINGLE = {
  dialogId: "ask:tc-single-1",
  source: "ask_user",
  toolCallId: "tc-single-1",
  questions: [
    {
      question: "Which implementation plan should I take?",
      context: "Plan A rewrites the module; plan B patches it in place.",
      options: [
        { label: "Plan A — rewrite", description: "Cleaner result, larger diff" },
        { label: "Plan B — patch", description: "Minimal diff" },
      ],
    },
  ],
  allowCancel: true,
  openedAt: 1,
};

const MULTI = {
  dialogId: "ask:tc-multi-1",
  source: "ask_user",
  toolCallId: "tc-multi-1",
  questions: [
    {
      question: "Roll out to which environment first?",
      header: "Env",
      options: [{ label: "staging" }, { label: "canary" }],
    },
    {
      question: "Which checks gate the rollout?",
      header: "Gates",
      multiSelect: true,
      options: [{ label: "unit + integration green" }, { label: "visual matrix green" }],
    },
    {
      question: "Anything else?",
      context: "Free text is fine.",
      options: [{ label: "nothing — proceed" }],
      allowOther: true,
    },
  ],
  allowCancel: true,
  openedAt: 2,
};

function fakeEnv(): ControlEnv {
  return { authMode: "token", plaintext: false, dialogDrafts: new Map(), noticeExpanded: ref(false) };
}

function fakeView(): ControlView {
  const agent = ref({ dialogs: { epoch: "epoch-1", open: [], closed: [] } } as unknown as AgentState);
  return {
    agentKey: "agent-a",
    control: null,
    enabled: computed(() => true),
    readonlyReason: computed(() => null),
    agent: computed(() => agent.value),
    busy: computed(() => true),
    commands: computed(() => []),
    commandsEnabled: computed(() => false),
    sending: computed(() => false),
    queueItems: computed(() => []),
    isWebMessage: () => false,
  };
}

function mountForm(dialog: unknown, opts: { suspended?: boolean; env?: ControlEnv; attachTo?: Element } = {}) {
  const wrapper = mount(AskUserForm, {
    props: { dialog, suspended: opts.suspended ?? false },
    attachTo: opts.attachTo,
    global: {
      provide: {
        [CONTROL_VIEW as symbol]: fakeView(),
        [CONTROL_ENV as symbol]: opts.env ?? fakeEnv(),
      },
    },
  });
  mounted.push(wrapper);
  return wrapper;
}

describe("AskUserForm.vue — structure (§7.4)", () => {
  it("single question renders directly (no tabs), with context, options + descriptions, Other", () => {
    const w = mountForm(SINGLE);
    expect(w.find("[data-question-tab]").exists()).toBe(false);
    expect(w.text()).toContain("Which implementation plan");
    expect(w.find(".ask-context").text()).toContain("Plan A rewrites");
    expect(w.findAll(".ask-option")).toHaveLength(3); // 2 options + Other
    expect(w.text()).toContain("Cleaner result, larger diff");
    expect(w.find("[data-other]").exists()).toBe(true);
    expect(w.text()).toContain("first answer wins");
  });

  it("multi-question renders one header tab per question; all questions stay mounted", async () => {
    const w = mountForm(MULTI);
    const tabs = w.findAll("[data-question-tab]");
    expect(tabs.map((x) => x.text())).toEqual(["Env", "Gates", "Question 3"]);
    expect(w.findAll(".ask-question")).toHaveLength(3);
    expect(w.findAll(".ask-question")[1]!.attributes("style")).toContain("display: none");
    await tabs[1]!.trigger("click");
    expect(w.findAll(".ask-question")[1]!.attributes("style") ?? "").not.toContain("display: none");
  });

  it("multiSelect questions use checkboxes, single-select radios", async () => {
    const w = mountForm(MULTI);
    expect(w.findAll(".ask-question")[0]!.findAll("input[type='radio']")).toHaveLength(2);
    const tabs = w.findAll("[data-question-tab]");
    await tabs[1]!.trigger("click");
    expect(w.findAll(".ask-question")[1]!.findAll("input[type='checkbox']")).toHaveLength(2);
  });
});

describe("AskUserForm.vue — submit gating + payload (§7.4)", () => {
  it("Submit stays disabled until every question has an answer; payload = buildDialogAnswers", async () => {
    const w = mountForm(MULTI);
    expect(w.find("[data-submit]").attributes("disabled")).toBeDefined();
    await w.findAll(".ask-question")[0]!.find("input[type='radio']").setValue(true);
    expect(w.find("[data-submit]").attributes("disabled")).toBeDefined();
    const tabs = w.findAll("[data-question-tab]");
    await tabs[1]!.trigger("click");
    await w.findAll(".ask-question")[1]!.findAll("input[type='checkbox']")[0]!.setValue(true);
    await tabs[2]!.trigger("click");
    await w.findAll(".ask-question")[2]!.find("input[type='radio']").setValue(true);
    expect(w.find("[data-submit]").attributes("disabled")).toBeUndefined();
    await w.find("[data-submit]").trigger("click");
    expect(w.emitted("answer")).toEqual([
      [
        [
          { selected: ["staging"], other: null },
          { selected: ["unit + integration green"], other: null },
          { selected: ["nothing — proceed"], other: null },
        ],
      ],
    ]);
  });

  it("Other text alone completes a question", async () => {
    const w = mountForm(SINGLE);
    await w.find(".ask-other-input").setValue("  plan C, actually ");
    expect(w.find("[data-submit]").attributes("disabled")).toBeUndefined();
    await w.find("[data-submit]").trigger("click");
    expect(w.emitted("answer")).toEqual([[[{ selected: [], other: "  plan C, actually " }]]]);
  });

  it("allowCancel ⇒ two-step cancel (arm → emit), Esc disarms", async () => {
    const w = mountForm(SINGLE);
    const btn = w.findAll(".ask-actions button")[1]!;
    await btn.trigger("click");
    expect(w.emitted("cancel")).toBeUndefined();
    expect(btn.attributes("data-armed")).toBe("true");
    await btn.trigger("keydown", { key: "Escape" });
    expect(btn.attributes("data-armed")).toBeUndefined();
    await btn.trigger("click");
    await btn.trigger("click");
    expect(w.emitted("cancel")).toHaveLength(1);
  });
});

/**
 * Regression coverage for the 2026-10-05 field report ("web-hub LAN user ticks every option on
 * a multiSelect question, tool result keeps only the first"). Investigation across
 * onToggle/setSelected (AskUserQuestion.vue), buildDialogAnswers (@logic/control.js),
 * answer-codec.ts and dialogs.ts's encodeAnswers found every layer consistent for this exact
 * shape; these tests pin the full click → emitted-payload path (plus the accfix-N1 live-
 * `questions` identity-refresh case, the closest real mechanism to "the dialog was briefly
 * re-rendered mid-fill") so a future regression along this path fails loudly.
 */
const MULTI_RECOMMENDED = {
  dialogId: "ask:tc-multi-reco",
  source: "ask_user",
  toolCallId: "tc-multi-reco",
  questions: [
    {
      question: "以下推荐项都同意吗？",
      header: "其他",
      multiSelect: true,
      options: [
        { label: "(Recommended) 删离线 TUI 卡片不发信号" },
        { label: "(Recommended) 停掉自动刷新" },
        { label: "(Recommended) 清空队列" },
      ],
    },
  ],
  allowCancel: true,
  openedAt: 1,
};
const MULTI_RECOMMENDED_LABELS = MULTI_RECOMMENDED.questions[0]!.options.map((o) => o.label);

describe("AskUserForm.vue — multiSelect ticks all survive to submit (field report regression)", () => {
  it("ticking every option on a 3-option multiSelect question keeps all 3 in the emitted payload", async () => {
    const w = mountForm(MULTI_RECOMMENDED);
    const boxes = w.findAll("input[type='checkbox']");
    expect(boxes).toHaveLength(3);
    for (const box of boxes) await box.setValue(true);
    expect(w.find("[data-submit]").attributes("disabled")).toBeUndefined();
    await w.find("[data-submit]").trigger("click");
    expect(w.emitted("answer")).toEqual([[[{ selected: MULTI_RECOMMENDED_LABELS, other: null }]]]);
  });

  it(
    "keeps already-ticked boxes and accepts further ticks after the dialog's questions array is" +
      " replaced mid-fill (same dialogId, new object identities — e.g. a hub reconnect republish)",
    async () => {
      const w = mountForm(structuredClone(MULTI_RECOMMENDED));
      let boxes = w.findAll("input[type='checkbox']");
      await boxes[0]!.setValue(true);
      await w.setProps({ dialog: structuredClone(MULTI_RECOMMENDED) });
      boxes = w.findAll("input[type='checkbox']");
      await boxes[1]!.setValue(true);
      await boxes[2]!.setValue(true);
      await w.find("[data-submit]").trigger("click");
      expect(w.emitted("answer")).toEqual([[[{ selected: MULTI_RECOMMENDED_LABELS, other: null }]]]);
    },
  );
});

describe("AskUserForm.vue — drafts (§3.5) + suspended (v2.1)", () => {
  it("selections persist into CONTROL_ENV.dialogDrafts under (agentKey, epoch, dialogId)", async () => {
    const env = fakeEnv();
    const w = mountForm(SINGLE, { env });
    await w.findAll(".ask-question")[0]!.find("input[type='radio']").setValue(true);
    const key = dialogDraftKey("agent-a", "epoch-1", "ask:tc-single-1");
    expect(env.dialogDrafts.get(key)).toEqual([{ selected: ["Plan A — rewrite"], other: null }]);
    // a fresh mount (agent switch and back) restores the draft
    w.unmount();
    const w2 = mountForm(SINGLE, { env });
    expect(w2.find("[data-submit]").attributes("disabled")).toBeUndefined();
  });

  it("a different epoch ⇒ a different draft key (no stale resurrection)", async () => {
    const env = fakeEnv();
    const w = mountForm(SINGLE, { env });
    await w.findAll(".ask-question")[0]!.find("input[type='radio']").setValue(true);
    expect(env.dialogDrafts.get(dialogDraftKey("agent-a", "epoch-2", "ask:tc-single-1"))).toBeUndefined();
  });

  it("submit clears the draft", async () => {
    const env = fakeEnv();
    const w = mountForm(SINGLE, { env });
    await w.findAll(".ask-question")[0]!.find("input[type='radio']").setValue(true);
    await w.find("[data-submit]").trigger("click");
    expect(env.dialogDrafts.size).toBe(0);
  });

  it("suspended: readonly fieldset, Submit disabled, draft preserved, suspended copy shown", async () => {
    const env = fakeEnv();
    const w = mountForm(SINGLE, { env, suspended: false });
    await w.findAll(".ask-question")[0]!.find("input[type='radio']").setValue(true);
    expect(env.dialogDrafts.size).toBe(1);
    await w.setProps({ suspended: true }); // hub starts restarting AFTER the draft exists
    expect(w.find(".ask-suspended").exists()).toBe(true);
    expect(w.find(".ask-suspended").text()).toContain("terminal");
    expect(w.find("[data-submit]").attributes("disabled")).toBeDefined();
    expect(w.find("fieldset").attributes("disabled")).toBeDefined();
    await w.find("[data-submit]").trigger("click", { force: true });
    expect(w.emitted("answer")).toBeUndefined();
    expect(env.dialogDrafts.size).toBe(1); // draft kept for the post-restart recovery
  });

  it("suspended blocks answer edits", async () => {
    const env = fakeEnv();
    const w = mountForm(SINGLE, { env, suspended: true });
    await w.findAll(".ask-question")[0]!.find("input[type='radio']").setValue(true);
    expect(env.dialogDrafts.size).toBe(0);
  });
});

describe("AskUserForm.vue — restored dialog reference stays selectable (accfix-N1)", () => {
  it("props.dialog replaced in place (same dialogId, new questions array/items) still yields a stable radio group and a submittable form", async () => {
    // Mirrors a hub-restart/version-replace restore: the SAME mounted AskUserForm (dialogId
    // and epoch unchanged ⇒ AgentDetail's `:key` doesn't remount it) receives a brand new
    // `dialog` prop object whose `questions` array (and its item objects) are NEW references
    // with equal content — exactly what a fresh subscribe snapshot after a hub reconnect sends.
    const w = mountForm(SINGLE);
    const radioBefore = w.find("input[type='radio']");
    expect(radioBefore.attributes("name")).toBe("ask-q-0");

    const restored = {
      ...SINGLE,
      questions: SINGLE.questions.map((q) => ({ ...q, options: q.options.map((o) => ({ ...o })) })),
    };
    await w.setProps({ dialog: restored });

    // accfix-N1 regression: the OLD code kept a snapshot of the ORIGINAL `questions` array in
    // the ASK_FORM context, so `AskUserQuestion`'s `indexOf(props.question)` against the NEW
    // question object always returned -1 — `inputName` degenerated to `ask-q--1` and every
    // selection was silently dropped by `setSelected`'s `i < 0` guard, leaving Submit disabled
    // forever.
    const radioAfter = w.find("input[type='radio']");
    expect(radioAfter.attributes("name")).toBe("ask-q-0");

    await radioAfter.setValue(true);
    expect(w.find("[data-submit]").attributes("disabled")).toBeUndefined();
    await w.find("[data-submit]").trigger("click");
    expect(w.emitted("answer")).toEqual([[[{ selected: ["Plan A — rewrite"], other: null }]]]);
  });

  it("restored multi-question dialog: each question keeps its own distinct, matching index", async () => {
    const w = mountForm(MULTI);
    const restored = {
      ...MULTI,
      questions: MULTI.questions.map((q) => ({ ...q, options: q.options.map((o) => ({ ...o })) })),
    };
    await w.setProps({ dialog: restored });

    const tabs = w.findAll("[data-question-tab]");
    await w.findAll(".ask-question")[0]!.find("input[type='radio']").setValue(true);
    await tabs[1]!.trigger("click");
    await w.findAll(".ask-question")[1]!.findAll("input[type='checkbox']")[0]!.setValue(true);
    await tabs[2]!.trigger("click");
    await w.findAll(".ask-question")[2]!.find("input[type='radio']").setValue(true);

    expect(w.find("[data-submit]").attributes("disabled")).toBeUndefined();
    await w.find("[data-submit]").trigger("click");
    expect(w.emitted("answer")).toEqual([
      [
        [
          { selected: ["staging"], other: null },
          { selected: ["unit + integration green"], other: null },
          { selected: ["nothing — proceed"], other: null },
        ],
      ],
    ]);
  });
});

describe("AskUserForm.vue — auto-advance on single-select (2026-10 mobile UX)", () => {
  function radioOf(w: ReturnType<typeof mountForm>, qi: number) {
    return w.findAll(".ask-question")[qi]!.find("input[type='radio']");
  }
  function checkboxesOf(w: ReturnType<typeof mountForm>, qi: number) {
    return w.findAll(".ask-question")[qi]!.findAll("input[type='checkbox']");
  }
  function activeIndex(w: ReturnType<typeof mountForm>): number {
    return w.findAll("[data-question-tab]").findIndex((b) => b.attributes("aria-selected") === "true");
  }

  it("a single-select pick on tab 0 jumps to the next unanswered tab (tab 1)", async () => {
    const w = mountForm(MULTI);
    expect(activeIndex(w)).toBe(0);
    await radioOf(w, 0).setValue(true);
    expect(activeIndex(w)).toBe(1);
  });

  it("skips an already-answered tab and wraps back to the start to find the next gap", async () => {
    const w = mountForm(MULTI);
    await radioOf(w, 0).setValue(true); // q0 answered → auto-advances to tab 1 (Gates)
    expect(activeIndex(w)).toBe(1);
    await checkboxesOf(w, 1)[0]!.setValue(true); // multiSelect: answered, but no auto-advance
    expect(activeIndex(w)).toBe(1);
    await w.findAll("[data-question-tab]")[2]!.trigger("click"); // manual move to q2 (last)
    await radioOf(w, 2).setValue(true); // q2 answered; q0 and q1 already answered → nothing left
    expect(activeIndex(w)).toBe(2); // stays put (every question already answered)
  });

  it("a multiSelect checkbox toggle never auto-advances", async () => {
    const w = mountForm(MULTI);
    await w.findAll("[data-question-tab]")[1]!.trigger("click");
    expect(activeIndex(w)).toBe(1);
    await checkboxesOf(w, 1)[0]!.setValue(true);
    expect(activeIndex(w)).toBe(1);
    await checkboxesOf(w, 1)[1]!.setValue(true);
    expect(activeIndex(w)).toBe(1);
  });

  it("typing free text into Other never auto-advances", async () => {
    const w = mountForm(MULTI);
    await w.findAll("[data-question-tab]")[2]!.trigger("click");
    expect(activeIndex(w)).toBe(2);
    await w.findAll(".ask-question")[2]!.find("[data-other]").setValue("custom answer");
    expect(activeIndex(w)).toBe(2);
  });

  it("once every question is answered, the tab stays put and focus moves to Submit", async () => {
    const w = mountForm(MULTI, { attachTo: document.body });
    await radioOf(w, 0).setValue(true); // → tab 1
    await checkboxesOf(w, 1)[0]!.setValue(true); // multiSelect: no auto-advance, still tab 1
    await w.findAll("[data-question-tab]")[2]!.trigger("click"); // manual → tab 2 (last unanswered)
    await radioOf(w, 2).setValue(true); // last answer — nothing left to advance to
    await vi.waitFor(() => expect(document.activeElement).toBe(w.find("[data-submit]").element));
    expect(activeIndex(w)).toBe(2);
  });

  it("single-question dialogs never try to switch tabs (no tabs exist)", async () => {
    const w = mountForm(SINGLE);
    await radioOf(w, 0).setValue(true);
    expect(w.find("[data-question-tab]").exists()).toBe(false);
    expect(w.find("[data-submit]").attributes("disabled")).toBeUndefined();
  });
});

describe("AskUserForm.vue — sticky submit/cancel dock (2026-10 mobile UX, structural only)", () => {
  it("renders `.ask-actions` as the form's own last child so a CSS sticky-footer rule can target it", () => {
    const w = mountForm(SINGLE);
    const form = w.find(".ask-user-form");
    const children = form.element.children;
    expect(children.length).toBeGreaterThan(0);
    expect(children[children.length - 1]!.className).toContain("ask-actions");
  });

  it("dialog.css: the form is its own bounded scrollport and the actions row sticks to its bottom", () => {
    const css = readFileSync(
      resolve(fileURLToPath(import.meta.url), "../../../../src/web-hub/ui/src/styles/dialog.css"),
      "utf8",
    );
    const formRule = /\.ask-user-form\s*\{[^}]*\}/.exec(css)?.[0] ?? "";
    expect(formRule).toMatch(/overflow-y:\s*auto/);
    expect(formRule).toMatch(/max-height:/);
    const actionsRule = /\.ask-actions\s*\{[^}]*\}/.exec(css)?.[0] ?? "";
    expect(actionsRule).toMatch(/position:\s*sticky/);
    expect(actionsRule).toMatch(/bottom:\s*0/);
    // must not go transparent over whatever scrolled underneath it
    expect(actionsRule).toMatch(/background:/);
  });
});
