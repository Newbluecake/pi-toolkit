/** Merged task58 chain: real SDK public raw events → production speed wire/tap →
 * wire frames → production reducer/entries, and actual SessionManager branch projection →
 * fresh history snapshot. No provider sockets, user context discovery or invented final core.
 * Set PI_TOOLKIT_MESSAGE_SPEED_ARTIFACT to an owned /tmp JSON for the browser companion.
 */
import { expect, it, vi } from "vitest";
import net from "node:net";
import { writeFileSync } from "node:fs";
import { stream } from "@earendil-works/pi-ai/api/openai-responses";
import type { Model } from "@earendil-works/pi-ai";
import type { WireEvent } from "../../src/web-hub/protocol/messages.js";
import { createMessageSpeed } from "../../src/web-hub/agent/message-speed.js";
import { createEventTap } from "../../src/web-hub/agent/event-tap.js";
import { wireMessageSpeed } from "../../src/web-hub/agent/message-speed-wire.js";
import { projectSessionEntry } from "../../src/web-hub/protocol/keys.js";
import { initialState, reduce } from "../../src/web-hub/ui/src/logic/state.js";
import { buildTxEntries } from "../../src/web-hub/ui/src/components/transcript/entries.js";
import { formatTokenSpeed } from "../../src/web-hub/ui/src/format.js";
const model: Model<"openai-responses"> = {
  id: "fake-task58",
  name: "fake-task58",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://task58.invalid/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 1000, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 10000,
  maxTokens: 100,
};
const card = (sessionId: string) => ({
  agentKey: "A",
  kind: "tui",
  pid: 1,
  cwd: "/tmp/fixture",
  state: "live",
  pluginVersion: "1.0.0",
  outdated: false,
  prompts: [],
  session: {
    sessionId,
    sessionFile: "/tmp/fixture.jsonl",
    cwd: "/tmp/fixture",
    reason: "startup",
    leafId: null,
    mode: "tui",
  },
});
it("real SDK raw proof → live 20.0 tokens/s → exact public mids → refresh/delete/replace", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createAgentSession, DefaultResourceLoader, SettingsManager, SessionManager } =
    await import("@earendil-works/pi-coding-agent");
  let positive = true;
  const root = mkdtempSync(join(tmpdir(), "tokens58-p3b-sdk-"));
  const settings = SettingsManager.inMemory({
    cacheWarming: "off",
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const manager = SessionManager.inMemory(root);
  const emitted: WireEvent[] = [];
  let tapCleanup = () => {};
  const mids: string[] = [];
  const payloads: unknown[] = [];
  let time = 0;
  let current: import("@earendil-works/pi-coding-agent").ExtensionContext | undefined;
  let final: unknown;
  let turn: unknown;
  let publicIndex: unknown;
  let appendAtTurn = false;
  const ownerToken = {};
  const activationGeneration = {};
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: join(root, "agent"),
    settingsManager: settings,
    noExtensions: true,
    noContextFiles: true,
    systemPrompt: "Isolated speed integration fixture.",
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [
      (pi) => {
        const speed = createMessageSpeed({
          monotonicNow: () => time,
          currentOwner: () =>
            current === undefined
              ? undefined
              : { sessionId: manager.getSessionId(), sessionGeneration: 1, ownerToken, activationGeneration },
          getCurrentContext: () => current,
          sessionId: (c) => c.sessionManager.getSessionId(),
          secureRecheckForWrite: () => undefined,
          appendEntry: (type, data) => {
            pi.appendEntry(type, data);
            appendAtTurn = true;
          },
        });
        const tap = createEventTap((e) => emitted.push(e), {
          speed,
          now: () => 0,
          setTimer: () => ({ cancel() {} }),
        });
        tapCleanup = () => tap.dispose();
        const wire = wireMessageSpeed(pi, speed, () => true);
        pi.on("session_start", (_e, c) => {
          current = c;
        });
        for (const type of [
          "agent_start",
          "turn_start",
          "message_start",
          "message_update",
          "message_end",
          "turn_end",
          "agent_end",
        ] as const) {
          pi.on(type, (event, c) => {
            current = c;
            if (event.type === "turn_start") publicIndex = event.turnIndex;
            if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") time += 500;
            if (event.type === "message_end" && event.message.role === "assistant") final = event.message;
            if (event.type === "turn_end") {
              turn = event.message;
              mids.push(event.messageEntryId!);
              expect(appendAtTurn).toBe(false);
              expect(
                emitted.findLast((e) => e.type === "message_end" && e.message?.role === "assistant")?.message
                  ?.piToolkitGeneration,
              ).toEqual(positive ? { v: 1, tokens: 10, genMs: 500, deltaCount: 2 } : undefined);
            }
            wire.forward(tap, event as unknown as Record<string, unknown> & { type: string });
          });
        }
      },
    ],
  });
  const responseId = "resp_real_sdk_boundary";
  const events = [
    { type: "response.created", response: { id: responseId, status: "in_progress" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "msg_fake", role: "assistant", status: "in_progress", content: [] },
    },
    {
      type: "response.content_part.added",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "hello " },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "world" },
    {
      type: "response.completed",
      response: {
        id: responseId,
        status: "completed",
        usage: {
          input_tokens: 2,
          output_tokens: 10,
          total_tokens: 12,
          output_tokens_details: { reasoning_tokens: 0 },
        },
        output: [],
      },
    },
  ];
  let fetches = 0;
  const runtime = {
    streamSimple: (m: Model<"openai-responses">, c: Parameters<typeof stream>[1], o: Parameters<typeof stream>[2]) =>
      stream(m, c, {
        ...o,
        apiKey: "fake-not-secret",
        maxRetries: 0,
        fetch: async () => {
          fetches++;
          payloads.push(c);
          const scripted = structuredClone(events);
          for (const event of scripted) {
            if ("response" in event && event.response) event.response.id = `resp_integrated_${fetches}`;
            if (fetches === 3 && event.type === "response.completed")
              delete event.response!.usage!.output_tokens_details;
            if (fetches === 4 && event.type === "response.completed")
              delete (event.response!.usage as { output_tokens?: number }).output_tokens;
          }
          return new Response(scripted.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
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
  const socketFence = vi.spyOn(net.Socket.prototype, "connect").mockImplementation(() => {
    throw new Error("real socket forbidden in SDK fixture");
  });
  let session: import("@earendil-works/pi-coding-agent").AgentSession | undefined;
  try {
    await loader.reload();
    expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
    expect(loader.getExtensions().errors).toEqual([]);
    ({ session } = await createAgentSession({
      cwd: root,
      agentDir: join(root, "agent"),
      modelRuntime: runtime as never,
      model,
      sessionManager: manager,
      settingsManager: settings,
      resourceLoader: loader,
      tools: [],
    }));
    await session.bindExtensions({ mode: "rpc" });
    await session.prompt("synthetic fixture one");
    expect(fetches).toBe(1);
    expect(publicIndex).toBe(0);
    expect(final).toBe(turn);
    expect(appendAtTurn).toBe(true);
    // Actual public SessionManager entry between two identical assistant texts: no
    // neighbour/content association can bind either metadata record to this tool result.
    manager.appendMessage({
      role: "toolResult",
      toolCallId: "fixture-tool",
      toolName: "fixture",
      content: [{ type: "text", text: "interposed result" }],
      isError: false,
      timestamp: 1000,
    });
    appendAtTurn = false;
    await session.prompt("synthetic fixture two");
    expect(final).toBe(turn);
    expect(publicIndex).toBe(0); // next real agent loop restarts at zero
    expect(appendAtTurn).toBe(true);
    appendAtTurn = false;
    await session.prompt("synthetic missing reasoning detail fixture");
    expect(fetches).toBe(3);
    expect(appendAtTurn).toBe(true);
    appendAtTurn = false;
    positive = false;
    await session.prompt("synthetic raw-total-absent fixture");
    expect(fetches).toBe(4);
    expect(appendAtTurn).toBe(false);
    expect(new Set(mids).size).toBe(4);
    expect((final as { usage: { reasoning: number } }).usage.reasoning).toBe(0);
    const branch = manager.getBranch();
    const assistants = branch.filter((e) => e.type === "message" && e.message.role === "assistant");
    expect(assistants).toHaveLength(4);
    expect(assistants.map((e) => (e as any).message.content)).toEqual([
      [{ type: "text", text: "hello world" }],
      [{ type: "text", text: "hello world" }],
      [{ type: "text", text: "hello world" }],
      [{ type: "text", text: "hello world" }],
    ]);
    const toolIndex = branch.findIndex((e) => e.type === "message" && e.message.role === "toolResult");
    expect(toolIndex).toBeGreaterThan(branch.indexOf(assistants[0]!));
    expect(toolIndex).toBeLessThan(branch.indexOf(assistants[1]!));
    expect(JSON.stringify(assistants)).not.toContain("piToolkitGeneration");
    const metadata = branch.filter((e) => e.type === "custom" && e.customType === "subagent:web-msg-speed");
    expect(metadata.map((e) => (e as { data: any }).data.piToolkitGeneration.mid)).toEqual(mids.slice(0, 3));
    const ends = emitted.filter((e) => e.type === "message_end" && e.message?.role === "assistant");
    expect(ends).toHaveLength(4);
    expect(ends.slice(0, 3).map((e) => e.message!.piToolkitGeneration)).toEqual([
      { v: 1, tokens: 10, genMs: 500, deltaCount: 2 },
      { v: 1, tokens: 10, genMs: 500, deltaCount: 2 },
      { v: 1, tokens: 10, genMs: 500, deltaCount: 2 },
    ]);
    expect(ends[3]!.message!.piToolkitGeneration).toBeUndefined();
    expect(manager.buildSessionContext().messages.some((m) => JSON.stringify(m).includes("piToolkitGeneration"))).toBe(
      false,
    );
    expect(JSON.stringify(payloads)).not.toContain("piToolkitGeneration");
    const entries = branch.map(projectSessionEntry).filter((e) => e !== undefined);
    const frames = emitted.map((e, seq) => ({ event: "ev", data: { agentKey: "A", seq, e } }));
    const snapshot = (loaded: unknown[]) => ({
      event: "history",
      data: { agentKey: "A", entries: loaded, tailMessages: [], fromSeq: frames.length, hasMore: false },
    });
    const base = [
      { event: "agents", data: [card(manager.getSessionId())] },
      { event: "subscribing", data: { agentKey: "A", clientId: "isolated" } },
    ];
    const liveState = [...base, { ...snapshot([]), data: { ...snapshot([]).data, fromSeq: 0 } }, ...frames].reduce(
      reduce,
      initialState(null),
    );
    const views = (s: any) => buildTxEntries(s.agents.get("A")).entries.filter((e) => e.type === "assistant");
    expect(views(liveState).map((e) => formatTokenSpeed(e.assistant.generation))).toEqual([
      "20.0 tokens/s",
      "20.0 tokens/s",
      "20.0 tokens/s",
      "",
    ]);
    const restored = [...base, snapshot(entries)].reduce(reduce, initialState(null));
    expect(views(restored).map((e) => formatTokenSpeed(e.assistant.generation))).toEqual([
      "20.0 tokens/s",
      "20.0 tokens/s",
      "20.0 tokens/s",
      "",
    ]);
    expect(views(restored).map((e) => e.assistant.costUsd)).toEqual([0.01, 0.01, 0.01, 0]);
    const removed = entries.filter((e) => e.type !== "custom");
    const deleted = reduce(restored, snapshot(removed));
    expect(views(deleted).map((e) => e.assistant.generation)).toEqual([undefined, undefined, undefined, undefined]);
    const replaced = reduce(deleted, snapshot(entries));
    expect(views(replaced).map((e) => formatTokenSpeed(e.assistant.generation))).toEqual([
      "20.0 tokens/s",
      "20.0 tokens/s",
      "20.0 tokens/s",
      "",
    ]);
    if (process.env.PI_TOOLKIT_MESSAGE_SPEED_BROWSER) await browserChain({ base, frames, entries, removed, mids });
    if (process.env.PI_TOOLKIT_MESSAGE_SPEED_ARTIFACT)
      writeFileSync(
        process.env.PI_TOOLKIT_MESSAGE_SPEED_ARTIFACT,
        JSON.stringify({ base, frames, entries, removed, mids }, null, 2),
      );
  } finally {
    session?.dispose();
    tapCleanup();
    socketFence.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
}, 60000);

/** Opt-in real Chromium, using an ALREADY installed absolute Playwright entry (never npx/install).
 * Own Vite root/cache in /tmp; real production reducer, entries and TxAssistant SFC, NOT
 * a substitute renderer or the user's running App/hub. SDK sockets remain fenced above;
 * this browser can only request its own ephemeral loopback fixture server.
 */
async function browserChain(fixture: { base: any[]; frames: any[]; entries: any[]; removed: any[]; mids: string[] }) {
  const { mkdtempSync, writeFileSync, rmSync, symlinkSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { resolve, join } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const { createServer } = await import("vite");
  const { default: vue } = await import("@vitejs/plugin-vue");
  const { uiAliases } = await import("../../src/web-hub/ui/aliases.js");
  const root = mkdtempSync(join(tmpdir(), "tokens58-p3b-browser-"));
  const repo = process.cwd();
  const ui = `/@fs/${repo}/src/web-hub/ui/src`;
  let loaded: any[] = [];
  let fromSeq = 0;
  let browser: any;
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  const errors: string[] = [];
  try {
    symlinkSync(resolve(repo, "node_modules"), join(root, "node_modules"), "dir");
    writeFileSync(
      join(root, "index.html"),
      '<html><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',
    );
    writeFileSync(
      join(root, "fixture.js"),
      `
      import {createApp,h,shallowRef,nextTick} from 'vue';
      import {initialState,reduce} from '${ui}/logic/state.js';
      import {buildTxEntries} from '${ui}/components/transcript/entries.ts';
      import TxAssistant from '${ui}/components/transcript/TxAssistant.vue';
      import '${ui}/styles/tokens.css';
      import '${ui}/styles/base.css';
      import '${ui}/styles/primitives.css';
      import '${ui}/styles/transcript.css';
      import '${ui}/styles/avatar.css';
      const fixture = await (await fetch('/snapshot')).json();
      const state = shallowRef(fixture.base.reduce(reduce,initialState(null)));
      window.applyFrames = async frames => { state.value = frames.reduce(reduce,state.value); await nextTick(); };
      window.snapshot = async () => {
        const snap = await (await fetch('/snapshot')).json();
        await window.applyFrames([{event:'history',data:{agentKey:'A',entries:snap.entries,tailMessages:[],fromSeq:snap.fromSeq,hasMore:false}}]);
      };
      createApp({setup:()=>()=>h('main',buildTxEntries(state.value.agents.get('A')).entries
        .filter(e=>e.type==='assistant').map(e=>h(TxAssistant,{key:e.key,assistant:e.assistant,truncated:false}))) }).mount('#root');
      await window.snapshot();
      window.ready = true;
    `,
    );
    server = await createServer({
      configFile: false,
      root,
      cacheDir: join(root, "cache"),
      resolve: { alias: { ...uiAliases } },
      plugins: [
        vue(),
        {
          name: "isolated-speed-fixture",
          configureServer(s) {
            s.middlewares.use("/snapshot", (_req, res) => {
              res.setHeader("content-type", "application/json");
              res.end(JSON.stringify({ base: fixture.base, entries: loaded, fromSeq }));
            });
          },
        },
      ],
      server: { host: "127.0.0.1", port: 0, hmr: false, fs: { allow: [root, repo] } },
    });
    await server.listen();
    const address = server.httpServer!.address();
    if (!address || typeof address === "string") throw new Error("fixture address missing");
    const origin = `http://127.0.0.1:${address.port}`;
    const pw = await import(/* @vite-ignore */ pathToFileURL(process.env.PI_TOOLKIT_MESSAGE_SPEED_BROWSER!).href);
    browser = await (pw.chromium ?? pw.default.chromium).launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 767, height: 900 } });
    await context.route("**/*", (route: any) =>
      route
        .request()
        .url()
        .startsWith(origin + "/")
        ? route.continue()
        : route.abort(),
    );
    const page = await context.newPage();
    page.on("pageerror", (e: Error) => errors.push(e.message));
    const refresh = async () => {
      await page.goto(origin);
      await page.waitForFunction(() => window.ready === true);
    };
    const speeds = () => page.locator(".tx-speed").allTextContents();
    await refresh();
    expect(await speeds()).toEqual([]);
    await page.evaluate(async (frames) => {
      await window.applyFrames(frames);
    }, fixture.frames);
    expect(await speeds()).toEqual(["20.0 tokens/s", "20.0 tokens/s", "20.0 tokens/s"]);
    expect(await page.locator(".msg-meta span:not(.tx-speed)").allTextContents()).toEqual([
      "$0.0100",
      "$0.0100",
      "$0.0100",
      "$0",
    ]);
    loaded = fixture.entries;
    fromSeq = fixture.frames.length;
    await refresh(); // fresh document and reducer from actual projected SDK branch
    expect(await speeds()).toEqual(["20.0 tokens/s", "20.0 tokens/s", "20.0 tokens/s"]);
    loaded = fixture.removed;
    await page.evaluate(() => window.snapshot()); // replacing history removes custom metadata
    expect(await speeds()).toEqual([]);
    await refresh(); // deletion persists across a REAL browser refresh, no residual map
    expect(await speeds()).toEqual([]);
    expect(await page.locator(".msg-meta span").allTextContents()).toEqual(["$0.0100", "$0.0100", "$0.0100", "$0"]);
    loaded = fixture.entries;
    await page.evaluate(() => window.snapshot());
    expect(await speeds()).toEqual(["20.0 tokens/s", "20.0 tokens/s", "20.0 tokens/s"]);
    await refresh();
    expect(await speeds()).toEqual(["20.0 tokens/s", "20.0 tokens/s", "20.0 tokens/s"]);
    const geometry = await page
      .locator(".msg-meta")
      .first()
      .evaluate((el: Element) => {
        const spans = [...el.querySelectorAll("span")].map((e) => e.getBoundingClientRect());
        return { costRight: spans[0].right, speedLeft: spans[1].left };
      });
    expect(geometry.costRight).toBeLessThanOrEqual(geometry.speedLeft);
    expect(errors).toEqual([]);
    if (process.env.PI_TOOLKIT_MESSAGE_SPEED_SCREENSHOT)
      await page.screenshot({ path: process.env.PI_TOOLKIT_MESSAGE_SPEED_SCREENSHOT });
    console.log(
      "Chromium: SDK-derived live → real refresh → delete snapshot → refresh absent → replace → refresh restored; cost unchanged; viewport 767px",
    );
  } finally {
    await browser?.close();
    await server?.close();
    rmSync(root, { recursive: true, force: true });
  }
}
