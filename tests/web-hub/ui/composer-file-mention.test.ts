// @vitest-environment happy-dom
import { mount } from "@vue/test-utils";
import { computed, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Composer from "../../../src/web-hub/ui/src/components/control/Composer.vue";
import { CONTROL_VIEW, type ControlView } from "../../../src/web-hub/ui/src/components/control/controlContext.js";
import { CONTROL_CTX } from "../../../src/web-hub/ui/src/composables/useControl.js";
import type { AgentState, ControlHandle } from "../../../src/web-hub/ui/src/types.js";

/**
 * `control/Composer.vue` @文件补全 (file-mention): the `@` panel's FILE zone — debounced
 * (~200ms) `GET /api/files/search` once ≥1 character is typed, relative path displayed,
 * picking inserts `@<absolute path> `. The two-zone panel opens when EITHER zone has rows
 * (running sub-agents OR file hits — the task-#11 "never pops empty" rule generalized to
 * both-empty), keyboard navigation is CONTINUOUS across zones, and any file-search failure
 * (network/401) silently degrades to the sub-agent zone only.
 */

function stubMatchMedia(matches: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

beforeEach(() => {
  stubMatchMedia(false);
  window.localStorage.clear();
});

function fakeControl(): ControlHandle & { drafts: Map<string, string> } {
  const drafts = new Map<string, string>();
  const noop = () => Promise.resolve({ ok: true as const });
  return {
    drafts,
    sendPrompt: noop as ControlHandle["sendPrompt"],
    abort: noop as ControlHandle["abort"],
    steerSub: noop as ControlHandle["steerSub"],
    stopSub: noop as ControlHandle["stopSub"],
    answerDialog: noop as ControlHandle["answerDialog"],
    cancelDialog: noop as ControlHandle["cancelDialog"],
    runCommand: noop as ControlHandle["runCommand"],
    query: noop,
    retry: noop,
    discard: () => {},
    draft: (k) => drafts.get(k) ?? "",
    setDraft: (k, t) => void drafts.set(k, t),
  };
}

const RUNNING: readonly unknown[] = [{ runId: "r1", label: "bot", status: "running", terminal: false }];

interface MountOpts {
  fleet?: readonly unknown[];
  fetchImpl?: typeof fetch;
  session?: Record<string, unknown>;
}

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
  for (const w of mounted.splice(0)) w.unmount();
});

function mountComposer(opts: MountOpts = {}) {
  const agent = ref({
    pendingCtl: [],
    fleet: opts.fleet ?? RUNNING,
    ...(opts.session === undefined ? {} : { session: opts.session }),
  } as unknown as AgentState);
  const view: ControlView = {
    agentKey: "agent-a",
    control: null,
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
  const fetchImpl = opts.fetchImpl;
  if (fetchImpl !== undefined) vi.stubGlobal("fetch", fetchImpl);
  const ctx = { agentKey: "agent-a", control: fakeControl(), enabled: true };
  const wrapper = mount(Composer, {
    props: { enabled: true, busy: false },
    attachTo: document.body,
    global: { provide: { [CONTROL_VIEW as symbol]: view, [CONTROL_CTX as symbol]: ctx } },
  });
  mounted.push(wrapper);
  return wrapper;
}

async function type(wrapper: ReturnType<typeof mount>, value: string): Promise<void> {
  const ta = wrapper.find("textarea");
  await ta.setValue(value);
  (ta.element as HTMLTextAreaElement).setSelectionRange(value.length, value.length);
  await ta.trigger("input");
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Debounce is 200ms — wait past it plus a microtask settle. */
const settle = async (): Promise<void> => {
  await sleep(240);
  await Promise.resolve();
};

function jsonResponse(results: Array<{ path: string; rel: string }>): Response {
  return new Response(JSON.stringify({ ok: true, results, partial: false }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const PANEL = ".mention-panel";
const FILE_ITEM = ".mention-item.mention-file";

describe("Composer @文件补全 (file-mention)", () => {
  it("≥1 char: debounced fetch renders the file zone (relative path); zone header labels it", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain("/api/files/search?agentKey=agent-a&q=rea&limit=20");
      return jsonResponse([{ path: "/home/u/repo/README.md", rel: "README.md" }]);
    });
    const w = mountComposer({ fleet: [], fetchImpl, session: { sessionId: "s1", cwd: "/home/u/repo" } });
    await type(w, "@rea");
    expect(w.find(PANEL).exists()).toBe(false); // debounce not elapsed, no agents
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(w.find(PANEL).exists()).toBe(true);
    expect(w.find(".mention-zone").text()).toBe("Files");
    expect(w.find(FILE_ITEM).text()).toBe("README.md");
  });

  it("picking a file inserts `@<absolute path> ` and closes the panel", async () => {
    const w = mountComposer({
      fleet: [],
      fetchImpl: async () => jsonResponse([{ path: "/home/u/repo/README.md", rel: "README.md" }]),
      session: { sessionId: "s1", cwd: "/home/u/repo" },
    });
    await type(w, "@rea");
    await settle();
    await w.find(FILE_ITEM).trigger("click");
    expect((w.find("textarea").element as HTMLTextAreaElement).value).toBe("@/home/u/repo/README.md ");
    expect(w.find(PANEL).exists()).toBe(false);
  });

  it("keyboard navigation is CONTINUOUS across the two zones; Enter picks the file row", async () => {
    const w = mountComposer({
      fleet: RUNNING,
      fetchImpl: async () => jsonResponse([{ path: "/home/u/repo/README.md", rel: "README.md" }]),
      session: { sessionId: "s1", cwd: "/home/u/repo" },
    });
    await type(w, "@r"); // agent "bot" doesn't prefix-match "r"; README does
    await settle();
    // agent zone filtered to [] — the file row is the only one
    expect(w.findAll(".mention-item:not(.mention-file)")).toHaveLength(0);
    await w.find("textarea").trigger("keydown", { key: "Enter" });
    expect((w.find("textarea").element as HTMLTextAreaElement).value).toBe("@/home/u/repo/README.md ");
  });

  it("arrows walk agents then files; ArrowUp from the agent row lands on the file row", async () => {
    const w = mountComposer({
      fleet: RUNNING,
      fetchImpl: async () => jsonResponse([{ path: "/home/u/repo/README.md", rel: "README.md" }]),
      session: { sessionId: "s1", cwd: "/home/u/repo" },
    });
    await type(w, "@"); // bare @: agents listed, no fetch (files need ≥1 char)
    await settle();
    expect(w.findAll(".mention-item:not(.mention-file)")).toHaveLength(1);
    expect(w.findAll(FILE_ITEM)).toHaveLength(0);
    await type(w, "@b"); // "bot" matches; fetch returns README
    await settle();
    const rows = w.findAll(".mention-item");
    expect(rows).toHaveLength(2); // agent + file
    await w.find("textarea").trigger("keydown", { key: "ArrowDown" }); // 0 → 1 (the file row)
    await w.find("textarea").trigger("keydown", { key: "Enter" });
    expect((w.find("textarea").element as HTMLTextAreaElement).value).toBe("@/home/u/repo/README.md ");
  });

  it("bare `@` never fetches (files need ≥1 character)", async () => {
    const fetchImpl = vi.fn();
    const w = mountComposer({ fleet: RUNNING, fetchImpl, session: { sessionId: "s1", cwd: "/x" } });
    await type(w, "@");
    await settle();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(w.find(PANEL).exists()).toBe(true); // agent zone still lists
  });

  it("fetch failure (network) ⇒ silent degrade: no file zone, panel follows the agent zone", async () => {
    const w = mountComposer({
      fleet: RUNNING,
      fetchImpl: async () => {
        throw new TypeError("network down");
      },
      session: { sessionId: "s1", cwd: "/x" },
    });
    await type(w, "@rea");
    await settle();
    expect(w.find(PANEL).exists()).toBe(true); // agent zone ("bot" doesn't match, empty line)
    expect(w.find(FILE_ITEM).exists()).toBe(false);
    expect(w.find(".mention-empty").exists()).toBe(true);
  });

  it("fetch 401 ⇒ silent degrade (no throw, no file rows)", async () => {
    const w = mountComposer({
      fleet: [],
      fetchImpl: async () => new Response(JSON.stringify({ error: "E_AUTH" }), { status: 401 }),
      session: { sessionId: "s1", cwd: "/x" },
    });
    await type(w, "@rea");
    await settle();
    expect(w.find(PANEL).exists()).toBe(false); // both zones empty ⇒ never pops
  });

  it("both zones empty ⇒ the panel never pops (task-#11 rule, generalized)", async () => {
    const w = mountComposer({
      fleet: [],
      fetchImpl: async () => jsonResponse([]),
      session: { sessionId: "s1", cwd: "/x" },
    });
    await type(w, "@zzz");
    await settle();
    expect(w.find(PANEL).exists()).toBe(false);
  });

  it("a stale response never lands: typing past an in-flight fetch aborts it, only the latest renders", async () => {
    const w = mountComposer({
      fleet: [],
      fetchImpl: async (url: string) => {
        if (url.includes("q=re&")) {
          await sleep(80); // the "@re" answer is slow — the user already typed "@rea"
          return jsonResponse([{ path: "/r/re-old.ts", rel: "re-old.ts" }]);
        }
        return jsonResponse([{ path: "/r/README.md", rel: "README.md" }]);
      },
      session: { sessionId: "s1", cwd: "/r" },
    });
    await type(w, "@re");
    await sleep(230); // fetch#1 is issued and inside its 80ms delay
    await type(w, "@rea"); // aborts #1 (seq guard + signal), schedules #2
    await settle();
    await sleep(100);
    expect(w.find(FILE_ITEM).text()).toBe("README.md"); // not re-old.ts
    expect(w.findAll(FILE_ITEM)).toHaveLength(1);
  });

  it("no live session ⇒ no fetch at all (the hub would answer 409)", async () => {
    const fetchImpl = vi.fn();
    const w = mountComposer({ fleet: [], fetchImpl }); // agent.session undefined
    await type(w, "@rea");
    await settle();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("closing the token resets the file zone (armed latch cleared)", async () => {
    const w = mountComposer({
      fleet: [],
      fetchImpl: async () => jsonResponse([{ path: "/r/README.md", rel: "README.md" }]),
      session: { sessionId: "s1", cwd: "/r" },
    });
    await type(w, "@rea");
    await settle();
    expect(w.find(PANEL).exists()).toBe(true);
    await type(w, "@read me "); // token closed by the space
    expect(w.find(PANEL).exists()).toBe(false);
    await type(w, "@read me @zzz"); // no NEW line-initial token (task-#11 line-initial rule)
    await settle();
    expect(w.find(PANEL).exists()).toBe(false);
  });
});
