// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { ref, type Ref } from "vue";
import { describe, expect, it, vi } from "vitest";
import SessionInfo from "../../../src/web-hub/ui/src/components/detail/SessionInfo.vue";
import { PREVIEW_CTX, type PreviewContext } from "../../../src/web-hub/ui/src/components/preview/previewContext.js";
import type { PreviewHandle, PreviewPathScope, PreviewView } from "../../../src/web-hub/ui/src/types.js";

/** 2026-10-08 user ruling: the detail header's cwd value opens the directory preview. */

const CWD = "/home/dev/repo";
const session = { sessionId: "s1", cwd: CWD } as never;

function ctx(scope: PreviewPathScope | null): { provide: Record<symbol, unknown>; open: ReturnType<typeof vi.fn> } {
  const open = vi.fn();
  const handle: PreviewHandle = {
    view: ref<PreviewView>({ phase: "closed" }) as Ref<PreviewView>,
    scope: ref(scope),
    open,
    close: vi.fn(),
    retry: vi.fn(),
    dispose: vi.fn(),
  };
  const c: PreviewContext = { handle, plaintext: false };
  return { provide: { [PREVIEW_CTX as symbol]: c }, open };
}

describe("SessionInfo — cwd opens the directory preview", () => {
  it("with a dirs-capable preview scope the cwd renders as a path-ref that opens the directory", async () => {
    const { provide, open } = ctx({ agentKey: "A", sessionId: "s1", cwd: CWD, uploads: true, abs: true, dirs: true });
    const w = mount(SessionInfo, { props: { session }, global: { provide } });
    const ref_ = w.find("dl.kv dd .path-ref");
    expect(ref_.exists()).toBe(true);
    expect(ref_.text()).toBe(CWD);
    await ref_.trigger("click");
    expect(open).toHaveBeenCalledWith({ path: CWD });
  });

  it("without a preview scope the cwd stays plain text (pre-change DOM)", () => {
    const w = mount(SessionInfo, { props: { session } });
    const dd = w.find("dl.kv dd");
    expect(dd.text()).toBe(CWD);
    expect(dd.find(".path-ref").exists()).toBe(false);
  });
});
