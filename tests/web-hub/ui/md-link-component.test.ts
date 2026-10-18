// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { computed, ref, type Ref } from "vue";
import { describe, expect, it, vi } from "vitest";
import MdInline from "../../../src/web-hub/ui/src/components/transcript/MdInline.vue";
import PreviewText from "../../../src/web-hub/ui/src/components/preview/PreviewText.vue";
import {
  PATH_REFERENCES_SUSPENDED,
  PREVIEW_CTX,
} from "../../../src/web-hub/ui/src/components/preview/previewContext.js";
import { parseMarkdown } from "../../../src/web-hub/ui/src/logic/markdown.js";
import type { PreviewHandle, PreviewPathScope, PreviewView } from "../../../src/web-hub/ui/src/types.js";

function ctx(scope: PreviewPathScope | null) {
  const open = vi.fn();
  const handle: PreviewHandle = {
    view: ref<PreviewView>({ phase: "closed" }) as Ref<PreviewView>,
    scope: ref(scope),
    open,
    close: vi.fn(),
    retry: vi.fn(),
    dispose: vi.fn(),
  };
  return { open, provide: { [PREVIEW_CTX as symbol]: { handle, plaintext: false } } };
}
const SC: PreviewPathScope = { agentKey: "A", sessionId: "s", cwd: "/p", uploads: false, abs: true, dirs: true };
const nodes = (md: string) => (parseMarkdown(md)[0] as { children: never[] }).children;

describe("markdown path links", () => {
  it("transcript: resolves against scope.cwd and opens", async () => {
    const { open, provide } = ctx(SC);
    const w = mount(MdInline, { props: { nodes: nodes("see [arch](../dev/a.md#x)") }, global: { provide } });
    const el = w.get(".path-ref");
    expect(el.text()).toBe("arch");
    await el.trigger("click");
    expect(open).toHaveBeenCalledWith({ path: "/dev/a.md" });
    expect(w.text()).not.toContain("](");
  });
  it("directory target opens with dir:true", async () => {
    const { open, provide } = ctx(SC);
    const w = mount(MdInline, { props: { nodes: nodes("[d](sub/dir/)") }, global: { provide } });
    await w.get(".path-ref").trigger("keydown", { key: "Enter" });
    expect(open).toHaveBeenCalledWith({ path: "/p/sub/dir", dir: true });
  });
  it("file preview: resolves against the previewed file's directory", async () => {
    const { open, provide } = ctx(SC);
    const w = mount(PreviewText, {
      props: {
        text: "[arch](../dev/web-hub/arch.md)",
        truncated: false,
        filename: "web-hub.md",
        path: "/r/docs/guide/web-hub.md",
      },
      global: { provide },
    });
    await w.get(".path-ref").trigger("click");
    expect(open).toHaveBeenCalledWith({ path: "/r/docs/dev/web-hub/arch.md" });
  });
  it("no scope / fragment / mailto ⇒ plain text, no raw syntax, not clickable", () => {
    for (const [md, scope] of [
      ["[arch](./a.md)", null],
      ["[arch](#frag)", SC],
      ["[arch](mailto:a@b.c)", SC],
      ["[arch](javascript:x)", SC],
    ] as const) {
      const { provide } = ctx(scope);
      const w = mount(MdInline, { props: { nodes: nodes(md) }, global: { provide } });
      expect(w.text()).toBe("arch");
      expect(w.find(".path-ref").exists()).toBe(false);
      expect(w.find("a").exists()).toBe(false);
    }
  });
  it("a still-streaming message renders link text only; clickable once it settles", async () => {
    const { open, provide } = ctx(SC);
    const streaming = ref(true);
    const w = mount(MdInline, {
      props: { nodes: nodes("see [arch](./a.md)") },
      global: { provide: { ...provide, [PATH_REFERENCES_SUSPENDED as symbol]: computed(() => streaming.value) } },
    });
    expect(w.find(".path-ref").exists()).toBe(false);
    expect(w.text().replace(/\s+/g, "")).toBe("seearch");
    streaming.value = false;
    await w.vm.$nextTick();
    await w.get(".path-ref").trigger("keydown", { key: " " });
    expect(open).toHaveBeenCalledWith({ path: "/p/a.md" });
  });
  it("no ctx at all ⇒ text only", () => {
    expect(mount(MdInline, { props: { nodes: nodes("[x](./a.md)") } }).text()).toBe("x");
  });
});
