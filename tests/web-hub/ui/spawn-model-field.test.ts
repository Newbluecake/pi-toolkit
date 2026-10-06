// @vitest-environment happy-dom
/**
 * `spawn/SpawnModelField.vue` (web-hub-spawn default-model plan F2, D6/D7) — the DirPicker's
 * presentation-only 「本次模型」 input: label + placeholder (hub default / pi default),
 * `<datalist>` options straight from props, `update:modelValue` on typing, and the live
 * invalid state (`isSpawnModelRef` — the hub's own `parseSpawnModelRef` gate; `""` is the
 * pi-default tri-state, never invalid). All behavior wiring (cap gate, initial value,
 * submit, restore) is pinned in `dir-picker.test.ts`; this file pins the component itself.
 */
import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import SpawnModelField from "../../../src/web-hub/ui/src/components/spawn/SpawnModelField.vue";

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount();
  document.body.innerHTML = "";
});

const OPTIONS = [
  { provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus 4.5" },
  { provider: "openai", id: "gpt-5" },
] as const;

function mountField(props: { modelValue: string; defaultModel: string | null; disabled?: boolean }) {
  const wrapper = mount(SpawnModelField, {
    props: { options: [...OPTIONS], ...props },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  return wrapper;
}

function input(): HTMLInputElement {
  const el = document.body.querySelector<HTMLInputElement>("#spawn-model");
  if (el === null) throw new Error("#spawn-model not found");
  return el;
}

describe("SpawnModelField.vue (default-model plan F2)", () => {
  it("renders the label and lists the datalist options (provider/id values, name as text)", () => {
    mountField({ modelValue: "", defaultModel: null });
    expect(document.body.querySelector("label")!.textContent).toBe("Model (this session only)");
    const options = Array.from(document.body.querySelectorAll("#spawn-model-options option"));
    expect(options.map((o) => o.getAttribute("value"))).toEqual(["anthropic/claude-opus-4-5", "openai/gpt-5"]);
    expect(options[0]!.textContent).toContain("Claude Opus 4.5");
    expect(options[1]!.textContent).toContain("openai/gpt-5"); // no name ⇒ ref as text
  });

  it("placeholder shows the hub default when one is set", () => {
    mountField({ modelValue: "", defaultModel: "anthropic/claude-opus-4-5" });
    expect(input().placeholder).toBe("Default: anthropic/claude-opus-4-5");
  });

  it("placeholder falls back to the 「pi 默认」 text when there is no hub default", () => {
    mountField({ modelValue: "", defaultModel: null });
    expect(input().placeholder).toBe("provider/id — empty means pi's own default");
  });

  it("typing emits update:modelValue with the raw value", async () => {
    const w = mountField({ modelValue: "", defaultModel: null });
    input().value = "openai/gpt-5";
    input().dispatchEvent(new Event("input", { bubbles: true }));
    await flushPromises();
    expect(w.emitted("update:modelValue")).toEqual([["openai/gpt-5"]]);
  });

  it.each([
    ["noslash", true], // no provider/id split
    ["-x/y", true], // leading-dash provider (flag-confusion guard)
    ["a b/c", true], // whitespace
    ["openai/gpt-5", false],
    ["openrouter/openai/gpt-4o:extended", false], // id may carry `/` and `:`
    ["", false], // the explicit pi-default tri-state is never invalid
  ])("modelValue %j ⇒ invalid=%s", async (value, invalid) => {
    mountField({ modelValue: value, defaultModel: null });
    await flushPromises();
    expect(input().getAttribute("aria-invalid")).toBe(invalid ? "true" : null);
    const warn = document.body.querySelector(".spawn-model-warn");
    if (invalid) {
      expect(warn).not.toBeNull();
      expect(warn!.textContent).toContain("Not a valid provider/id");
      expect(warn!.getAttribute("role")).toBe("alert");
    } else {
      expect(warn).toBeNull();
    }
  });

  it("disabled prop disables the input", () => {
    mountField({ modelValue: "", defaultModel: null, disabled: true });
    expect(input().disabled).toBe(true);
  });
});
