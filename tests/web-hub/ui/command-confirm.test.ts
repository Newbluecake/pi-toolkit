// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import CommandConfirm from "../../../src/web-hub/ui/src/components/control/CommandConfirm.vue";
import { resetLangForTests, setLangOverride } from "../../../src/web-hub/ui/src/composables/useI18n.js";
import { MESSAGES } from "../../../src/web-hub/ui/src/i18n/index.js";

/**
 * `control/CommandConfirm.vue` — 2026-10-20 redesign (user ruling + approved mock
 * ~/pwh-preview/cmdconfirm/cmd-confirm.png): ONE click on 执行 confirms (no arm/4s-revert
 * step), Enter = confirm / Esc = cancel, auto-focus 执行 unless focus is inside the composer,
 * danger variant for session-replacing commands, i18n descriptions only (the server's raw
 * `message` is never rendered), buttons wrap to a right-aligned second row on phones. The
 * end-to-end re-issue with `confirm:true` is covered by `detail-dock.test.ts`.
 */

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  resetLangForTests();
  for (const w of mounted.splice(0)) w.unmount();
  document.body.innerHTML = "";
});

function mountConfirm(props: { name: string; args?: string; message?: string } = { name: "reload", args: "" }) {
  const wrapper = mount(CommandConfirm, { props: { args: "", ...props }, attachTo: document.body });
  mounted.push(wrapper);
  return wrapper;
}

describe("CommandConfirm.vue (2026-10-20 redesign)", () => {
  it("ONE click on 执行 emits confirm; 取消 emits cancel", async () => {
    const w = mountConfirm();
    expect(w.find(".command-confirm-run").attributes("data-armed")).toBeUndefined();
    await w.find(".command-confirm-run").trigger("click");
    expect(w.emitted("confirm")).toHaveLength(1);
    expect(w.emitted("cancel")).toBeUndefined();

    const w2 = mountConfirm();
    await w2.find(".command-confirm-cancel").trigger("click");
    expect(w2.emitted("cancel")).toHaveLength(1);
    expect(w2.emitted("confirm")).toBeUndefined();
  });

  it("Enter in the bar confirms; Esc cancels; Enter on 取消 does NOT confirm", async () => {
    const w = mountConfirm();
    await w.trigger("keydown", { key: "Enter" });
    expect(w.emitted("confirm")).toHaveLength(1);

    const w2 = mountConfirm();
    await w2.find(".command-confirm-cancel").trigger("keydown", { key: "Enter" });
    expect(w2.emitted("confirm")).toBeUndefined();
    expect(w2.emitted("cancel")).toBeUndefined(); // native button click, not the bar handler
    await w2.trigger("keydown", { key: "Escape" });
    expect(w2.emitted("cancel")).toHaveLength(1);
  });

  it("focus on 执行 + keydown Enter ⇒ exactly ONE confirm (no native-click double fire)", async () => {
    const w = mountConfirm();
    const run = w.find(".command-confirm-run");
    (run.element as HTMLElement).focus();
    expect(document.activeElement).toBe(run.element);
    await run.trigger("keydown", { key: "Enter" });
    expect(w.emitted("confirm")).toHaveLength(1);
  });

  it("restores focus to the pre-bar element on cancel/confirm, composer textarea as fallback", async () => {
    // Pre-bar focus inside the composer: never stolen, handed back on cancel.
    const composer = document.createElement("div");
    composer.className = "composer";
    const textarea = document.createElement("textarea");
    composer.appendChild(textarea);
    document.body.appendChild(composer);
    textarea.focus();
    const w = mountConfirm();
    await w.find(".command-confirm-cancel").trigger("click");
    expect(document.activeElement).toBe(textarea);
    w.unmount();

    // Pre-bar element gone by confirm time ⇒ focus falls back to the composer textarea.
    const transient = document.createElement("button");
    document.body.appendChild(transient);
    transient.focus();
    const w2 = mountConfirm();
    expect(document.activeElement).toBe(w2.find(".command-confirm-run").element); // stolen (not composer)
    transient.remove();
    await w2.find(".command-confirm-run").trigger("click");
    expect(document.activeElement).toBe(textarea);
    w2.unmount();
  });

  it("auto-focuses 执行 on appear, but never steals focus from the composer textarea", async () => {
    const w = mountConfirm();
    expect(document.activeElement).toBe(w.find(".command-confirm-run").element);
    w.unmount();

    const composer = document.createElement("div");
    composer.className = "composer";
    const textarea = document.createElement("textarea");
    composer.appendChild(textarea);
    document.body.appendChild(composer);
    textarea.focus();
    const w2 = mountConfirm();
    expect(document.activeElement).toBe(textarea);
    expect(document.activeElement).not.toBe(w2.find(".command-confirm-run").element);
  });

  it("danger variant (red accent + red 执行) for session-replacing commands; primary otherwise", () => {
    for (const name of ["new", "clear", "resume", "fork"]) {
      const w = mountConfirm({ name, args: name === "resume" ? "__pick {}" : "" });
      expect(w.find(".command-confirm").classes()).toContain("danger");
      expect(w.find(".command-confirm-run").classes()).toContain("btn-danger");
      expect(w.find(".command-confirm-run").classes()).not.toContain("btn-primary");
    }
    const w = mountConfirm({ name: "reload", args: "" });
    expect(w.find(".command-confirm").classes()).not.toContain("danger");
    expect(w.find(".command-confirm-run").classes()).toContain("btn-primary");
    expect(w.find(".command-confirm-run").classes()).not.toContain("btn-danger");
  });

  it("never renders the server's raw message; the description comes from the i18n map", () => {
    const w = mountConfirm({
      name: "reload",
      args: "",
      message: "/reload requires confirmation — this changes the session. Resend with confirm:true to proceed.",
    });
    expect(w.text()).not.toContain("requires confirmation");
    expect(w.text()).not.toContain("confirm:true");
    expect(w.find(".command-confirm-desc").text()).toBe(MESSAGES.en.control!["cmdDesc.reload"]);
    // Unknown command ⇒ generic line, still no raw message.
    const w2 = mountConfirm({ name: "some-plugin-cmd", args: "x", message: "RAW SERVER TEXT" });
    expect(w2.text()).not.toContain("RAW SERVER TEXT");
    expect(w2.find(".command-confirm-desc").text()).toBe(MESSAGES.en.control!["cmdDesc.generic"]);
  });

  it("zh rendering: title 执行 /cmd？ + per-command zh description", () => {
    setLangOverride("zh");
    const w = mountConfirm({ name: "new", args: "" });
    expect(w.find(".command-confirm-title").text()).toContain("执行");
    expect(w.find(".command-confirm-title").text()).toContain("？");
    expect(w.find(".command-confirm-code").text()).toBe("/new");
    expect(w.find(".command-confirm-desc").text()).toBe("开一个新会话，当前会话的对话不会带过去。");
    expect(w.find(".command-confirm-run").text()).toBe("执行");
    expect(w.find(".command-confirm-cancel").text()).toBe("取消");
  });

  it("i18n parity: every cmdDesc.* key exists in zh and en with real (non-key) text", () => {
    const enDict = MESSAGES.en.control!;
    const zhDict = MESSAGES.zh.control!;
    const keys = Object.keys(enDict).filter((k) => k.startsWith("cmdDesc."));
    expect(keys.length).toBeGreaterThanOrEqual(16);
    for (const k of keys) {
      expect(zhDict[k], `${k} missing in zh`).toBeTypeOf("string");
      expect(enDict[k]).not.toBe(k);
      expect(zhDict[k]).not.toBe(k);
    }
  });

  it("command chip includes args; actions container carries the phone-wrap class", () => {
    const w = mountConfirm({ name: "agent", args: "settings set x y" });
    expect(w.find(".command-confirm-code").text()).toBe("/agent settings set x y");
    // Description carries the full text in `title` (the phone media query clamps it to 2 lines).
    const desc = w.find(".command-confirm-desc");
    expect(desc.attributes("title")).toBe(desc.text());
    // `.command-confirm-actions` is the element control.css wraps to a second right-aligned
    // row under `@media (max-width: 767px)` (mock's 手机 pane).
    const actions = w.find(".command-confirm-actions");
    expect(actions.exists()).toBe(true);
    expect(actions.find(".command-confirm-cancel").exists()).toBe(true);
    expect(actions.find(".command-confirm-run").exists()).toBe(true);
  });
});
