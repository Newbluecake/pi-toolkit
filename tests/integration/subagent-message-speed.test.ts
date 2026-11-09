// @vitest-environment happy-dom
/** Real child extension → public provider proof → pre-terminal seal → persisted run reader → drawer. */
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { createRunTranscripts } from "../../src/web-hub/agent/run-transcript.js";
import { expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { stream } from "@earendil-works/pi-ai/api/openai-responses";
import type { Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { wireChildSession } from "../../src/child/wire.js";
import { readSettingsNoMigrate } from "../../src/config/settings.js";
import { FakeClock } from "../../src/core/clock.js";
import { DEFAULT_BUDGET } from "../../src/core/deadline.js";
import { MemoryRunStore } from "../../src/core/store.js";
import { RuntimeRunner, BasicEffectInterpreter } from "../../src/runtime/runner.js";
import { PiSessionDriver, PiSessionHandle, type SessionDriver } from "../../src/runtime/session-driver.js";
import { SingleSlotPool } from "../../src/runtime/slot-pool.js";
import { EscalatingReaper } from "../../src/runtime/reaper.js";
import { createRunFileReader } from "../../src/web-hub/hub/run-file-reader.js";
import { initialState, reduce } from "../../src/web-hub/ui/src/logic/state.js";
import RunTranscript from "../../src/web-hub/ui/src/components/drawer/RunTranscript.vue";
import type { AgentState } from "../../src/web-hub/ui/src/types.js";

it.each([
  [true, true],
  [true, false],
  [false, true],
])(
  "child installed=%s, drawer already open=%s: live and terminal metadata agree",
  async (installed, alreadyOpen) => {
    const root = mkdtempSync(join(tmpdir(), "child-speed-b2-"));
    const manager = SessionManager.create(root, join(root, "sessions"));
    const settingsManager = SettingsManager.inMemory({
      cacheWarming: "off",
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const model: Model<"openai-responses"> = {
      id: "fake-b2",
      name: "fake-b2",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://b2.invalid/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 1000, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 10000,
      maxTokens: 100,
    };
    let mono = 0;
    let publicMid: string | undefined;
    let appendAtTurn: string | null = null;
    let sealedLeaf: string | null = null;
    let fetches = 0;
    let sawRaw = 0;
    let finalMessage: unknown;
    let releaseTurnEnd!: () => void;
    const turnEndGate = new Promise<void>((resolve) => {
      releaseTurnEnd = resolve;
    });
    let messageObserved!: () => void;
    const observed = new Promise<void>((resolve) => {
      messageObserved = resolve;
    });
    const toolkit = readSettingsNoMigrate(join(root, "absent.json"));
    toolkit.webHub.enabled = true;
    toolkit.cacheTtl.keepalive = false;
    toolkit.compact.enabled = false;
    toolkit.fast.enabled = false;
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir: join(root, "agent"),
      settingsManager,
      noExtensions: true,
      noContextFiles: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      systemPrompt: "Isolated child speed fixture.",
      extensionFactories: [
        (pi) => {
          pi.on("message_update", (e) => {
            if (e.assistantMessageEvent.type === "text_delta") mono += 500;
          });
          pi.on("provider_stream_event", () => {
            sawRaw++;
          });
          pi.on("turn_end", async () => {
            if (alreadyOpen) await turnEndGate; // hold tools/turn completion AFTER public message_end
          });
          if (installed)
            wireChildSession(pi, toolkit, undefined, {
              monotonicNow: () => mono,
              secureRecheckForWrite: () => undefined,
            });
          // Registered AFTER production child handler: actual metadata leaf is already committed.
          pi.on("turn_end", (e) => {
            publicMid = e.messageEntryId;
            finalMessage = e.message;
            appendAtTurn = manager.getLeafId();
          });
        },
      ],
    });
    const runtime = {
      streamSimple: (m: Model<"openai-responses">, c: Parameters<typeof stream>[1], o: Parameters<typeof stream>[2]) =>
        stream(m, c, {
          ...o,
          apiKey: "fake-not-secret",
          maxRetries: 0,
          fetch: async () => {
            fetches++;
            const events = [
              { type: "response.created", response: { id: "resp_b2", status: "in_progress" } },
              {
                type: "response.output_item.added",
                output_index: 0,
                item: { type: "message", id: "msg_b2", role: "assistant", status: "in_progress", content: [] },
              },
              {
                type: "response.content_part.added",
                output_index: 0,
                content_index: 0,
                part: { type: "output_text", text: "", annotations: [] },
              },
              { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "hello " },
              { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "child" },
              {
                type: "response.completed",
                response: {
                  id: "resp_b2",
                  status: "completed",
                  usage: { input_tokens: 2, output_tokens: 10, total_tokens: 12 },
                  output: [],
                },
              },
            ];
            return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
              headers: { "content-type": "text/event-stream" },
            });
          },
        }),
      getAuth: async () => undefined,
      hasConfiguredAuth: () => true,
      checkAuth: async () => ({ ok: true }),
      isUsingOAuth: () => false,
      isUsingSubscription: () => false,
      getError: () => undefined,
      refresh: async () => undefined,
      getAvailableSnapshot: () => [model],
      getModel: () => model,
    };
    const fence = vi.spyOn(net.Socket.prototype, "connect").mockImplementation(() => {
      throw new Error("real socket forbidden");
    });
    const reader = createRunFileReader();
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    let wrapper: ReturnType<typeof mount> | undefined;
    let rt: ReturnType<typeof createRunTranscripts> | undefined;
    try {
      await loader.reload();
      expect(loader.getExtensions().errors).toEqual([]);
      ({ session } = await createAgentSession({
        cwd: root,
        agentDir: join(root, "agent"),
        modelRuntime: runtime as never,
        model,
        sessionManager: manager,
        settingsManager,
        resourceLoader: loader,
        tools: [],
      }));
      await session.bindExtensions({ mode: "rpc" });
      const handle = new PiSessionHandle(session);
      const realDriver = new PiSessionDriver();
      const driver: SessionDriver = {
        create: async () => handle,
        bind: (h, onEvent) => realDriver.bind(h, onEvent),
        onLateArrival() {},
      };
      const clock = new FakeClock();
      const runner = new RuntimeRunner({
        clock,
        driver,
        pool: new SingleSlotPool(clock, 1),
        store: new MemoryRunStore(),
        watchdog: { arm() {}, disarm() {}, tick() {} },
        reaper: new EscalatingReaper(clock),
        effects: new BasicEffectInterpreter(),
        emit() {},
        deliver() {},
        sealSession: () => {
          sealedLeaf = manager.getLeafId();
          return undefined;
        },
      });
      if (alreadyOpen) {
        let liveState = [
          {
            event: "agents",
            data: [
              {
                agentKey: "A",
                kind: "tui",
                pid: 1,
                cwd: root,
                state: "live",
                pluginVersion: "1",
                outdated: false,
                prompts: [],
              },
            ],
          },
          { event: "subscribing", data: { agentKey: "A", clientId: "c1" } },
          { event: "history", data: { agentKey: "A", entries: [], tailMessages: [], fromSeq: 0, hasMore: false } },
          { event: "run_select", data: { agentKey: "A", runId: "r_b2" } },
          { event: "run_subscribing", data: { agentKey: "A", runId: "r_b2", at: 100, retries: 0 } },
          {
            event: "run_history",
            data: {
              agentKey: "A",
              runId: "r_b2",
              entries: [],
              tailMessages: [],
              fromSeq: 1,
              hasMore: false,
              terminal: false,
              live: true,
              status: "running",
            },
          },
        ].reduce((state, msg) => reduce(state, msg), initialState(null));
        wrapper = mount(RunTranscript, {
          props: { agent: liveState.agents.get("A") as unknown as AgentState, now: 5000 },
          attachTo: document.body,
        });
        rt = createRunTranscripts({
          port: () => ({
            info: () => ({ status: "running", terminal: false }),
            branch: () => handle.getBranchEntries(),
            observe: (_id, l) => ({ kind: "attached", detach: handle.observe(l.onEvent) }),
          }),
          enabled: () => true,
          now: () => 5000,
          setTimer: () => ({ cancel() {} }),
          trySend: (f) => {
            if (f.t === "run_ev") {
              liveState = reduce(liveState, { event: "run_ev", data: { ...f, agentKey: "A" } });
              void wrapper!.setProps({ agent: liveState.agents.get("A") as unknown as AgentState });
              if (f.e.type === "message_end" && f.e.message?.role === "assistant") messageObserved();
            }
            return "written";
          },
        });
        rt.onWatch("r_b2", true);
      }
      const running = runner.run({ runId: "r_b2", prompt: "synthetic child request" }, DEFAULT_BUDGET);
      if (alreadyOpen) {
        await observed;
        await nextTick();
        expect(wrapper!.text()).toContain("hello child");
        expect(wrapper!.text().includes("20.0 tokens/s")).toBe(installed);
        expect(appendAtTurn).toBeNull();
        expect(
          manager.getBranch().filter((e) => e.type === "custom" && e.customType === "subagent:web-msg-speed"),
        ).toHaveLength(0);
        wrapper!.unmount();
        wrapper = undefined;
        rt!.resetForSession();
        releaseTurnEnd();
      }
      const outcome = await running;
      expect(outcome.status).toBe("completed");
      expect(fetches).toBe(1);
      expect(sawRaw).toBeGreaterThan(0);
      expect(publicMid).toBeTruthy();
      expect(finalMessage).not.toHaveProperty("piToolkitGeneration");
      expect(outcome.diag.finalLeafId).toBe(sealedLeaf);
      expect(sealedLeaf).toBe(appendAtTurn);
      const branch = manager.getBranch(sealedLeaf!);
      const metadata = branch.filter((e) => e.type === "custom" && e.customType === "subagent:web-msg-speed");
      expect(metadata).toHaveLength(installed ? 1 : 0);
      if (installed) {
        expect(metadata[0]).toMatchObject({
          id: sealedLeaf,
          parentId: publicMid,
          data: { piToolkitGeneration: { v: 1, mid: publicMid, tokens: 10, genMs: 500, deltaCount: 2 } },
        });
        expect(sealedLeaf).not.toBe(publicMid);
      }
      // A reap-time append is too late for the fixed terminal leaf and must not be read.
      manager.appendCustomEntry("fixture:post-seal", { ignored: true });
      const page = await reader.read(manager.getSessionFile()!, outcome.diag.finalLeafId!, {
        limit: 100,
        maxBytes: 100000,
        deadlineAt: Date.now() + 5000,
      });
      expect(page.ok).toBe(true);
      if (!page.ok) throw new Error(page.reason);
      expect(page.entries.some((e) => e.customType === "fixture:post-seal")).toBe(false);
      expect(page.entries.filter((e) => e.customType === "subagent:web-msg-speed")).toHaveLength(installed ? 1 : 0);
      const reload = () =>
        [
          {
            event: "agents",
            data: [
              {
                agentKey: "A",
                kind: "tui",
                pid: 1,
                cwd: root,
                state: "live",
                pluginVersion: "1",
                outdated: false,
                prompts: [],
              },
            ],
          },
          { event: "subscribing", data: { agentKey: "A", clientId: "c1" } },
          { event: "history", data: { agentKey: "A", entries: [], tailMessages: [], fromSeq: 0, hasMore: false } },
          { event: "run_select", data: { agentKey: "A", runId: "r_b2" } },
          { event: "run_subscribing", data: { agentKey: "A", runId: "r_b2", at: 100, retries: 0 } },
          {
            event: "run_history",
            data: {
              agentKey: "A",
              runId: "r_b2",
              entries: page.entries,
              tailMessages: [],
              fromSeq: 0,
              hasMore: page.hasMore,
              terminal: true,
              live: false,
              status: "completed",
            },
          },
        ].reduce((s, msg) => reduce(s, msg), initialState(null));
      for (let i = 0; i < 2; i++) {
        const state = reload();
        const agent = state.agents.get("A") as unknown as AgentState;
        expect(agent.runTx?.generation?.get(publicMid!)).toEqual(
          installed ? { v: 1, tokens: 10, genMs: 500, deltaCount: 2 } : undefined,
        );
        wrapper = mount(RunTranscript, { props: { agent, now: 5000 }, attachTo: document.body });
        expect(wrapper.text()).toContain("hello child");
        expect(wrapper.text().includes("20.0 tokens/s")).toBe(installed);
        expect(wrapper.text()).toContain("$0.0100");
        wrapper.unmount();
        wrapper = undefined;
      }
      expect(JSON.stringify(manager.buildSessionContext())).not.toContain("piToolkitGeneration");
    } finally {
      releaseTurnEnd();
      rt?.resetForSession();
      wrapper?.unmount();
      reader.dispose();
      session?.dispose();
      fence.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  },
  20000,
);
