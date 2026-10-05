// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { computed, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import DetailDock from "../../../src/web-hub/ui/src/components/detail/DetailDock.vue";
import {
  CONTROL_ENV,
  CONTROL_VIEW,
  HUB_CTX,
  type ControlView,
} from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import { CONTROL_CTX } from "../../../src/web-hub/ui/src/composables/useControl.js";
import type { AgentState, ControlHandle, HubHandle } from "../../../src/web-hub/ui/src/types.js";

/**
 * `detail/DetailDock.vue` @文件补全 send expansion (file-mention): `@<absolute path>` tokens
 * under the session cwd get their text fetched through the hub preview transport and appended
 * as an attachment-style block; the send NEVER blocks or fails on a bad token — failed /
 * image / unfetchable tokens keep their verbatim text (console note only, no hint text in the
 * prompt); without a scope (no transport / no session / no caps / path outside cwd) the text
 * goes out byte-identical.
 */

vi.stubGlobal("matchMedia", (query: string) => ({
  matches: false,
  media: query,
  addEventListener: () => {},
  removeEventListener: () => {},
}));

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
  for (const w of mounted.splice(0)) w.unmount();
});

interface Call {
  method: string;
  args: readonly unknown[];
}

function fakeControl(): { control: ControlHandle; calls: Call[] } {
  const calls: Call[] = [];
  const invoke =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return Promise.resolve({ ok: true as const });
    };
  return {
    calls,
    control: {
      sendPrompt: invoke("sendPrompt") as ControlHandle["sendPrompt"],
      abort: invoke("abort") as ControlHandle["abort"],
      steerSub: invoke("steerSub") as ControlHandle["steerSub"],
      stopSub: invoke("stopSub") as ControlHandle["stopSub"],
      answerDialog: invoke("answerDialog") as ControlHandle["answerDialog"],
      cancelDialog: invoke("cancelDialog") as ControlHandle["cancelDialog"],
      runCommand: invoke("runCommand") as ControlHandle["runCommand"],
      query: invoke("query"),
      retry: invoke("retry"),
      discard: invoke("discard") as unknown as (agentKey: string, id: string) => void,
      draft: () => "",
      setDraft: () => {},
    },
  };
}

type PreviewFetch = (
  req: { agentKey: string; sessionId: string; path: string },
  opts: { signal: AbortSignal; maxPixels: number },
) => Promise<unknown>;

interface DockOpts {
  cwd?: string | null;
  preview?: PreviewFetch | undefined;
  hubCaps?: readonly string[] | undefined;
}

function mountDock(o: DockOpts = {}) {
  const { control, calls } = fakeControl();
  const agent = ref({
    pendingCtl: [],
    queue: [],
    prompts: [],
    fleet: [],
    session: o.cwd === undefined ? undefined : { sessionId: "s1", cwd: o.cwd },
  } as unknown as AgentState);
  const view: ControlView = {
    agentKey: "agent-a",
    control,
    enabled: computed(() => true),
    readonlyReason: computed(() => null),
    agent: computed(() => agent.value),
    busy: computed(() => false),
    commands: computed(() => []),
    commandsEnabled: computed(() => false),
    sending: computed(() => false),
    queueItems: computed(() => []),
    isWebMessage: () => false,
  };
  const hub: HubHandle = {
    state: ref({
      hub: { caps: o.hubCaps ?? ["cmd.v1", "preview.v1"] },
      selected: "agent-a",
      agents: new Map(),
    }) as never,
    dispatch: () => {},
    ...(o.preview === undefined ? {} : { preview: { fetch: o.preview } }),
  };
  const wrapper = mount(DetailDock, {
    props: { following: true, newCount: 0 },
    global: {
      provide: {
        [CONTROL_VIEW as symbol]: view,
        [CONTROL_CTX as symbol]: { agentKey: "agent-a", control, enabled: true },
        [HUB_CTX as symbol]: hub,
        [CONTROL_ENV as symbol]: {
          authMode: "token",
          plaintext: false,
          dialogDrafts: new Map(),
          noticeExpanded: ref(false),
        },
      },
    },
  });
  mounted.push(wrapper);
  return { wrapper, calls };
}

/** Composer emits `send` → DetailDock.onSend (async expansion) → sendPrompt. */
async function send(wrapper: ReturnType<typeof mount>, text: string): Promise<void> {
  wrapper.findComponent({ name: "Composer" }).vm.$emit("send", text, "steer");
  for (let i = 0; i < 25; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

const CWD = "/home/u/repo";

function textOut(calls: readonly Call[]): string {
  const prompt = calls.find((c) => c.method === "sendPrompt");
  return prompt?.args[1] as string;
}

const okText =
  (text: string): PreviewFetch =>
  async () => ({ ok: true, kind: "text", text, size: text.length });

describe("DetailDock @文件补全 send expansion", () => {
  it("a cwd token's text is fetched and appended as the file-reference block", async () => {
    const fetchImpl = vi.fn(okText("FILE-CONTENT"));
    const { wrapper, calls } = mountDock({ cwd: CWD, preview: fetchImpl });
    await send(wrapper, `look at @${CWD}/a.md please`);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      { agentKey: "agent-a", sessionId: "s1", path: `${CWD}/a.md` },
      expect.anything(),
    );
    const out = textOut(calls);
    expect(out).toContain(`look at @${CWD}/a.md please`); // body verbatim
    expect(out).toContain("[web-hub file references] The user referenced 1 local file(s)");
    expect(out).toContain(`--- ${CWD}/a.md (12 B) ---\nFILE-CONTENT`);
    expect(calls[0]!.args[2]).toBe("steer");
  });

  it("image tokens never fetch (path text is model-readable)", async () => {
    const fetchImpl = vi.fn();
    const { wrapper, calls } = mountDock({ cwd: CWD, preview: fetchImpl });
    await send(wrapper, `shot: @${CWD}/img.png`);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(textOut(calls)).toBe(`shot: @${CWD}/img.png`); // unchanged
  });

  it("a failed fetch keeps the token verbatim — the send still goes out", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 404, error: "E_NOT_FOUND" }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { wrapper, calls } = mountDock({ cwd: CWD, preview: fetchImpl });
    await send(wrapper, `a @${CWD}/gone.ts b`);
    expect(textOut(calls)).toBe(`a @${CWD}/gone.ts b`);
    expect(warn).toHaveBeenCalled(); // console note only — nothing in the prompt
    expect(textOut(calls)).not.toContain("not inlined");
  });

  it("a fetch that returns non-text (image/binary) is skipped the same way", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, kind: "image", mime: "image/png" }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { wrapper, calls } = mountDock({ cwd: CWD, preview: fetchImpl });
    await send(wrapper, `x @${CWD}/odd.bin y`);
    expect(textOut(calls)).toBe(`x @${CWD}/odd.bin y`);
  });

  it("tokens outside the session cwd are not tokens at all", async () => {
    const fetchImpl = vi.fn();
    const { wrapper, calls } = mountDock({ cwd: CWD, preview: fetchImpl });
    await send(wrapper, `see @/etc/passwd and @/home/u/other/x.ts`);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(textOut(calls)).toBe(`see @/etc/passwd and @/home/u/other/x.ts`);
  });

  it("no transport / no session / no caps ⇒ text goes out byte-identical", async () => {
    const fetchImpl = vi.fn(okText("X"));
    const noTransport = mountDock({ cwd: CWD }); // preview undefined
    await send(noTransport.wrapper, `@${CWD}/a.md`);
    expect(textOut(noTransport.calls)).toBe(`@${CWD}/a.md`);
    expect(fetchImpl).not.toHaveBeenCalled();

    const noSession = mountDock({ preview: fetchImpl }); // session undefined
    await send(noSession.wrapper, `@${CWD}/a.md`);
    expect(textOut(noSession.calls)).toBe(`@${CWD}/a.md`);

    const noCaps = mountDock({ cwd: CWD, preview: fetchImpl, hubCaps: ["cmd.v1"] });
    await send(noCaps.wrapper, `@${CWD}/a.md`);
    expect(textOut(noCaps.calls)).toBe(`@${CWD}/a.md`);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("cwd === null (rootless session) never expands", async () => {
    const fetchImpl = vi.fn();
    const { wrapper, calls } = mountDock({ cwd: null, preview: fetchImpl });
    await send(wrapper, `@/any/where.ts`);
    expect(textOut(calls)).toBe(`@/any/where.ts`);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("multiple tokens fetch in parallel, inline in first-occurrence order; steer routing untouched", async () => {
    const fetchImpl = vi.fn(async (req: { path: string }) =>
      req.path.endsWith("b.ts")
        ? { ok: true, kind: "text", text: "B", size: 1 }
        : { ok: true, kind: "text", text: "A", size: 1 },
    );
    const { wrapper, calls } = mountDock({ cwd: CWD, preview: fetchImpl });
    await send(wrapper, `@${CWD}/b.ts then @${CWD}/a.ts`);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const out = textOut(calls);
    expect(out.indexOf("--- " + CWD + "/b.ts")).toBeLessThan(out.indexOf("--- " + CWD + "/a.ts"));
    expect(out).toContain("The user referenced 2 local file(s)");
  });

  it("a text WITHOUT tokens needs no scope at all and sends unchanged", async () => {
    const { wrapper, calls } = mountDock({}); // no session, no preview
    await send(wrapper, "plain message");
    expect(textOut(calls)).toBe("plain message");
  });
});
