// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { nextTick, ref, type Ref } from "vue";
import { describe, expect, it, vi } from "vitest";
import PathText from "../../../src/web-hub/ui/src/components/preview/PathText.vue";
import {
  PATH_REFERENCES_SUSPENDED,
  PREVIEW_CTX,
  type PreviewContext,
} from "../../../src/web-hub/ui/src/components/preview/previewContext.js";
import type { PreviewHandle, PreviewPathScope, PreviewView } from "../../../src/web-hub/ui/src/types.js";

/**
 * `PathText.vue` (web-hub-preview plan v3 §4.6, package PV5): segment rendering + the
 * DOM-equivalence rule — no ctx / `scope === null` / `noRefs` / SUSPENDED all render the
 * SAME DOM as today (bare text node, or bare `code.md-code` in code mode); clickable
 * segments are `span.path-ref[role=button][tabindex=0]` (or `code.md-code.path-ref`) and
 * open via click / Enter / Space with the `:line[:col]` suffix stripped from the request
 * path (display-only, §4.6 rule 3).
 */

const SCOPE: PreviewPathScope = { agentKey: "A", sessionId: "s1", cwd: "/p", uploads: true };

function makeHandle(scope: PreviewPathScope | null): { handle: PreviewHandle; open: ReturnType<typeof vi.fn> } {
  const open = vi.fn();
  const view = ref<PreviewView>({ phase: "closed" }) as Ref<PreviewView>;
  return {
    open,
    handle: {
      view,
      scope: ref(scope),
      open,
      close: vi.fn(),
      retry: vi.fn(),
      dispose: vi.fn(),
    },
  };
}

function ctxOf(handle: PreviewHandle): PreviewContext {
  return { handle, plaintext: false };
}

function mountInHost(
  props: { text: string; code?: boolean; noRefs?: boolean },
  provide: Record<symbol, unknown> = {},
): { html: () => string; textContent: () => string; wrapper: ReturnType<typeof mount> } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const wrapper = mount(PathText, { props, attachTo: host, global: { provide } });
  // VTU mounts into its own `<div data-v-app>` inside `host` — compare THAT element's
  // innerHTML / childNodes (the component itself adds no wrapper).
  const app = (): HTMLElement => host.firstElementChild as HTMLElement;
  return {
    html: () => app().innerHTML,
    textContent: () =>
      Array.from(app().childNodes)
        .map((n) => n.textContent ?? "")
        .join(""),
    wrapper,
  };
}

describe("PathText.vue — DOM equivalence (§4.6)", () => {
  it("no ctx: renders the input as bare text, no element nodes at all", () => {
    const { html } = mountInHost({ text: "open /p/src/a.ts here" });
    expect(html()).toBe("open /p/src/a.ts here");
  });

  it("ctx with scope === null: same DOM as no ctx", () => {
    const { handle } = makeHandle(null);
    const { html } = mountInHost({ text: "open /p/src/a.ts here" }, { [PREVIEW_CTX as symbol]: ctxOf(handle) });
    expect(html()).toBe("open /p/src/a.ts here");
  });

  it("noRefs: same DOM even with a live scope", () => {
    const { handle } = makeHandle(SCOPE);
    const { html } = mountInHost(
      { text: "open /p/src/a.ts here", noRefs: true },
      { [PREVIEW_CTX as symbol]: ctxOf(handle) },
    );
    expect(html()).toBe("open /p/src/a.ts here");
  });

  it("SUSPENDED: plain while streaming, re-scans once the flag flips back (§4.6 流式抑制)", async () => {
    const { handle } = makeHandle(SCOPE);
    const suspended = ref(true);
    const { html, wrapper } = mountInHost(
      { text: "open /p/src/a.ts here" },
      { [PREVIEW_CTX as symbol]: ctxOf(handle), [PATH_REFERENCES_SUSPENDED as symbol]: suspended },
    );
    expect(html()).toBe("open /p/src/a.ts here");
    suspended.value = false;
    await nextTick();
    expect(wrapper.findAll(".path-ref")).toHaveLength(1);
  });

  it("code mode without ctx: bare `code.md-code`, byte-identical to MdInline's current output", () => {
    const { html } = mountInHost({ text: "/p/src/a.ts", code: true });
    expect(html()).toBe('<code class="md-code">/p/src/a.ts</code>');
  });

  it("code mode with a non-path: bare `code.md-code` even with a live scope", () => {
    const { handle } = makeHandle(SCOPE);
    const { html } = mountInHost({ text: "not a path", code: true }, { [PREVIEW_CTX as symbol]: ctxOf(handle) });
    expect(html()).toBe('<code class="md-code">not a path</code>');
  });
});

describe("PathText.vue — clickable refs", () => {
  it("renders span.path-ref[role=button][tabindex=0]; segments concatenate back to the input", () => {
    const { handle } = makeHandle(SCOPE);
    const text = "see /p/src/a.ts:12 and /p/b.md now";
    const { wrapper, textContent } = mountInHost({ text }, { [PREVIEW_CTX as symbol]: ctxOf(handle) });
    const refs = wrapper.findAll(".path-ref");
    expect(refs).toHaveLength(2);
    expect(refs[0]!.text()).toBe("/p/src/a.ts:12"); // :line[:col] stays in the DISPLAY text
    expect(refs[1]!.text()).toBe("/p/b.md");
    for (const r of refs) {
      expect(r.attributes("role")).toBe("button");
      expect(r.attributes("tabindex")).toBe("0");
      expect(r.element.tagName).toBe("SPAN");
    }
    // §4.6: every segment's text concatenates back to the EXACT input (no chars eaten).
    expect(textContent()).toBe(text);
  });

  it("click opens the preview with the :line suffix stripped from the request path", async () => {
    const { handle, open } = makeHandle(SCOPE);
    const { wrapper } = mountInHost({ text: "see /p/src/a.ts:12:3 now" }, { [PREVIEW_CTX as symbol]: ctxOf(handle) });
    await wrapper.get(".path-ref").trigger("click");
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith({ path: "/p/src/a.ts" });
  });

  it("Enter and Space open (role=button grammar); other keys do not", async () => {
    const { handle, open } = makeHandle(SCOPE);
    const { wrapper } = mountInHost({ text: "see /p/a.ts now" }, { [PREVIEW_CTX as symbol]: ctxOf(handle) });
    const refEl = wrapper.get(".path-ref");
    await refEl.trigger("keydown", { key: "Enter" });
    await refEl.trigger("keydown", { key: " " });
    await refEl.trigger("keydown", { key: "a" });
    expect(open).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenNthCalledWith(1, { path: "/p/a.ts" });
    expect(open).toHaveBeenNthCalledWith(2, { path: "/p/a.ts" });
  });

  it("code mode with a path: code.md-code.path-ref opens on click", async () => {
    const { handle, open } = makeHandle(SCOPE);
    const { wrapper } = mountInHost({ text: "/p/a.ts:7", code: true }, { [PREVIEW_CTX as symbol]: ctxOf(handle) });
    const el = wrapper.get("code.md-code.path-ref");
    expect(el.attributes("role")).toBe("button");
    await el.trigger("click");
    expect(open).toHaveBeenCalledWith({ path: "/p/a.ts" });
  });

  it("paths outside the cwd scope stay plain text (§4.6 rule 5)", () => {
    const { handle } = makeHandle(SCOPE);
    const { wrapper } = mountInHost(
      { text: "see /etc/passwd and /p/ok.ts" },
      { [PREVIEW_CTX as symbol]: ctxOf(handle) },
    );
    const refs = wrapper.findAll(".path-ref");
    expect(refs).toHaveLength(1);
    expect(refs[0]!.text()).toBe("/p/ok.ts");
  });
});
