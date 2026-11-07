/** P0 real-SDK local seams, NOT production Web dispatcher or memory wire integration. */
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

// Activation-local test implementation: no SDK InputEvent fields added and no ledger lookup.
async function fixture(run: (f: Awaited<ReturnType<typeof build>>) => Promise<void>) {
  const f = await build();
  try {
    await run(f);
  } finally {
    f.release();
    f.session.dispose();
    rmSync(f.root, { recursive: true, force: true });
  }
}
async function build() {
  const root = mkdtempSync(join(tmpdir(), "memory39-input-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  const sm = SessionManager.create(root, join(root, "sessions"));
  const settings = SettingsManager.create(root, agentDir);
  const owner = {};
  let epoch = 1,
    branchGen = 1,
    dispatchGen = 0;
  type Ticket = {
    owner: object;
    sid: string;
    epoch: number;
    branchGen: number;
    generation: number;
    nonce: object;
    originKind: "loopback" | "lan" | "feishu" | "unknown";
    used: boolean;
    candidate: boolean;
    admitted: boolean;
    revoked: boolean;
  };
  const scope = new AsyncLocalStorage<Ticket>();
  const trusted = new WeakSet<Ticket>();
  let api: ExtensionAPI, ctx: ExtensionContext;
  let active: Ticket | undefined;
  let gate: "initial" | "running" | "settled" = "initial";
  let locked = false,
    behavior = "continue",
    hold = false;
  let finish: (() => void) | undefined;
  let nested: Promise<void> | undefined;
  let atSettled: (() => void) | undefined;
  let afterIngress: (() => void) | undefined;
  const ingresses: { text: string; granted: boolean; behavior: unknown }[] = [];
  const starts: boolean[] = [],
    order: string[] = [],
    errors: string[] = [],
    requests: unknown[] = [];
  function revoke() {
    if (active) active.revoked = true;
    active = undefined;
  }
  const model = {
    id: "local",
    name: "local",
    api: "anthropic-messages",
    provider: "local",
    baseUrl: "http://invalid.local",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0 },
    contextWindow: 200000,
    maxTokens: 4096,
  };
  const runtime = {
    streamSimple(_m: unknown, context: unknown, options?: { signal?: AbortSignal }) {
      requests.push(context);
      const stream = createAssistantMessageEventStream();
      const done = () =>
        stream.push({
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "scripted local answer" }],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
            stopReason: "stop",
            timestamp: Date.now(),
          },
        } as never);
      if (hold) {
        hold = false;
        finish = done;
        options?.signal?.addEventListener("abort", done, { once: true });
      } else done();
      return stream;
    },
    getAuth: async () => undefined,
    hasConfiguredAuth: () => true,
    checkAuth: async () => ({ ok: true }),
    isUsingOAuth: () => false,
    getAvailableSnapshot: () => [model],
    getModel: () => model,
  };
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "Local capability fixture.",
    extensionFactories: [
      (pi: ExtensionAPI) => {
        api = pi;
        pi.on("session_start", (_event, context) => {
          ctx = context;
          revoke();
          epoch++;
          branchGen++;
          gate = "initial";
        });
        pi.on("session_shutdown", () => {
          revoke();
          epoch++;
          branchGen++;
        });
        // Equivalent secure-first order, with the trusted ingress before transform/reentry/handled.
        pi.on("input", () => {
          order.push("secure");
          if (locked) {
            revoke();
            return { action: "handled" };
          }
          return { action: "continue" };
        });
        pi.on("input", (event, context) => {
          ctx = context;
          order.push("ingress");
          revoke();
          const ticket = scope.getStore();
          const valid =
            event.source === "extension" &&
            ticket !== undefined &&
            trusted.has(ticket) &&
            (ticket.originKind === "loopback" || ticket.originKind === "lan") &&
            !ticket.used &&
            !ticket.revoked &&
            ticket.owner === owner &&
            ticket.sid === sm.getSessionId() &&
            ticket.epoch === epoch &&
            ticket.branchGen === branchGen &&
            ticket.generation === dispatchGen;
          if (ticket) ticket.used = true;
          if (valid) {
            ticket.candidate = ticket.admitted && event.streamingBehavior === undefined;
            active = ticket;
          }
          ingresses.push({ text: event.text, granted: !!valid && ticket.candidate, behavior: event.streamingBehavior });
          return { action: "continue" };
        });
        pi.on("input", async (event) => {
          order.push("later");
          await Promise.resolve();
          afterIngress?.();
          if (behavior === "transform") return { action: "transform", text: `${event.text} transformed` };
          if (behavior === "handled") return { action: "handled" };
          if (behavior === "throw") throw new Error("scripted input failure");
          if (behavior === "nested") {
            behavior = "continue";
            nested = session.sendUserMessage("nested untrusted");
            await nested;
          }
          return { action: "continue" };
        });
        pi.on("before_agent_start", () => {
          const ticket = scope.getStore();
          const granted =
            active === ticket && ticket !== undefined && ticket.candidate && !ticket.revoked && ticket.epoch === epoch;
          starts.push(granted);
          gate = "running";
        });
        pi.on("agent_settled", () => {
          revoke();
          gate = "settled";
          atSettled?.();
        });
      },
    ],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: root,
    agentDir,
    model: model as never,
    modelRuntime: runtime as never,
    sessionManager: sm,
    settingsManager: settings,
    resourceLoader: loader,
    tools: [],
  });
  // Public session_start initializes an initial-idle owner, without fabricating agent_settled.
  await session.bindExtensions({ mode: "rpc", shutdownHandler: async () => {} });
  function make(overrides: Partial<Ticket> = {}): Ticket {
    let admitted = false;
    try {
      admitted = gate !== "running" && ctx.isIdle() && !ctx.hasPendingMessages();
    } catch {
      /* fail closed */
    }
    const ticket: Ticket = {
      owner,
      sid: sm.getSessionId(),
      epoch,
      branchGen,
      generation: ++dispatchGen,
      nonce: {},
      originKind: "loopback",
      used: false,
      candidate: false,
      admitted,
      revoked: false,
      ...overrides,
    };
    trusted.add(ticket);
    return ticket;
  }
  async function send(text: string, options: { deliverAs?: "steer" | "followUp"; ticket?: Ticket } = {}) {
    const ticket = options.ticket ?? make();
    try {
      await scope.run(ticket, () => session.sendUserMessage(text, { deliverAs: options.deliverAs ?? "followUp" }));
    } finally {
      ticket.revoked = true;
    }
    return ticket;
  }
  return {
    root,
    session,
    sm,
    ingresses,
    starts,
    order,
    errors,
    requests,
    make,
    send,
    scope,
    api: () => api,
    context: () => ctx,
    setBehavior: (value: string) => {
      behavior = value;
    },
    setLocked: (value: boolean) => {
      locked = value;
    },
    invalidate: () => {
      revoke();
      epoch++;
      branchGen++;
      gate = "initial";
    },
    hold: () => {
      hold = true;
    },
    release: () => {
      finish?.();
      finish = undefined;
    },
    afterIngress: (fn: (() => void) | undefined) => {
      afterIngress = fn;
    },
    onSettled: (fn: (() => void) | undefined) => {
      atSettled = fn;
    },
    pending: () => finish !== undefined,
  };
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("fixture deadline");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2);
      timer.unref();
    });
  }
}

describe("C2/C3 real SDK trusted ingress local capability (not production wire)", () => {
  it("initial idle trusted Web scope survives await/transform, consumes once before later hooks", async () =>
    fixture(async (f) => {
      f.setBehavior("transform");
      const ticket = await f.send("same text");
      expect(f.order.slice(0, 3)).toEqual(["secure", "ingress", "later"]);
      expect(f.ingresses[0]?.granted).toBe(true);
      expect(f.starts).toEqual([true]);
      expect(JSON.stringify(f.requests)).toContain("same text transformed");
      expect(JSON.stringify(f.requests)).not.toContain("nonce");
      await f.send("same text", { ticket });
      expect(f.starts.at(-1)).toBe(false);
      await f.session.sendUserMessage("same text");
      expect(f.starts.at(-1)).toBe(false);
    }));

  it("real pi.sendUserMessage bridge retains ALS until input/start despite void return", async () =>
    fixture(async (f) => {
      const ticket = f.make();
      f.scope.run(ticket, () => f.api().sendUserMessage("bridge input"));
      await until(() => f.starts.length === 1 && !f.session.isStreaming);
      expect(f.ingresses[0]?.granted).toBe(true);
      expect(f.starts).toEqual([true]);
    }));

  it("handled, secure rejection and nested input never grant; SDK-swallowed unrelated throw preserves source", async () =>
    fixture(async (f) => {
      f.setBehavior("handled");
      await f.send("handled");
      expect(f.starts).toEqual([]);
      f.setLocked(true);
      await f.send("locked");
      expect(f.ingresses).toHaveLength(1);
      expect(f.starts).toEqual([]);
      f.setLocked(false);
      f.setBehavior("nested");
      await f.send("outer");
      expect(f.starts).toEqual([false, false]);
      f.setBehavior("throw");
      await f.send("throw");
      expect(f.errors).toEqual([]);
      expect(f.starts.at(-1)).toBe(true); // Root: no inaccessible onError dependency; exact approval is still required.
    }));

  it("owner/sid/branch/dispatch generation and reload/abort/new-input invalidation reject", async () =>
    fixture(async (f) => {
      for (const wrong of [
        { owner: {} },
        { sid: "other" },
        { branchGen: -1 },
        { generation: -1 },
        { epoch: -1 },
        { revoked: true },
      ]) {
        await f.send("same", { ticket: f.make(wrong) });
        expect(f.starts.at(-1)).toBe(false);
      }
      const old = f.make();
      f.invalidate();
      await f.send("same", { ticket: old });
      expect(f.starts.at(-1)).toBe(false);
      const superseded = f.make();
      f.make();
      await f.send("same", { ticket: superseded });
      expect(f.starts.at(-1)).toBe(false);
      const untrusted = { ...f.make(), nonce: {} };
      await f.send("same", { ticket: untrusted });
      expect(f.starts.at(-1)).toBe(false);
    }));

  it("concurrent same-text scopes cannot cross-grant or replay a superseded generation", async () =>
    fixture(async (f) => {
      const first = f.make();
      const second = f.make();
      await Promise.allSettled([
        f.send("same concurrent text", { ticket: first }),
        f.send("same concurrent text", { ticket: second }),
      ]);
      expect(f.ingresses).toHaveLength(2);
      expect(f.ingresses[0]?.granted).toBe(false);
      expect(f.starts.filter(Boolean).length).toBeLessThanOrEqual(1);
      await f.send("same concurrent text", { ticket: first });
      expect(f.starts.at(-1)).toBe(false);
    }));

  it("lifecycle changes after async ingress revoke before start; own dispatch rejection has no receipt", async () =>
    fixture(async (f) => {
      f.afterIngress(() => {
        f.afterIngress(undefined);
        f.invalidate();
      });
      await f.send("changed owner epoch while awaiting hook");
      expect(f.starts).toEqual([false]);
      const ticket = f.make();
      try {
        f.scope.run(ticket, () => {
          throw new Error("trusted dispatcher rejected before send");
        });
      } catch {
        ticket.revoked = true;
      }
      const before = f.ingresses.length;
      await f.send("rejected ticket replay", { ticket });
      expect(f.ingresses).toHaveLength(before + 1);
      expect(f.ingresses.at(-1)?.granted).toBe(false);
    }));

  it("real reload/new-session identity and abort revoke old proofs without private SDK hooks", async () =>
    fixture(async (f) => {
      const beforeReload = f.make();
      await f.session.reload();
      await f.send("after real reload", { ticket: beforeReload });
      expect(f.starts.at(-1)).toBe(false);
      const beforeNew = f.make();
      const oldSid = f.sm.getSessionId();
      f.sm.newSession();
      expect(f.sm.getSessionId()).not.toBe(oldSid);
      await f.send("after new session", { ticket: beforeNew });
      expect(f.starts.at(-1)).toBe(false);
      f.hold();
      const runningTicket = f.make();
      const running = f.send("abort local scripted stream", { ticket: runningTicket });
      await until(f.pending);
      await f.session.abort();
      await running;
      f.release();
      await f.send("aborted proof replay", { ticket: runningTicket });
      expect(f.starts.at(-1)).toBe(false);
    }));

  it("unknown/Feishu origin and unrelated interactive/rpc inputs cannot claim a Web ticket", async () =>
    fixture(async (f) => {
      for (const originKind of ["feishu", "unknown"] as const) {
        await f.send("same source text", { ticket: f.make({ originKind }) });
        expect(f.starts.at(-1)).toBe(false);
      }
      for (const source of ["interactive", "rpc"] as const) {
        const ticket = f.make();
        await f.scope.run(ticket, () => f.session.prompt("same source text", { source }));
        expect(f.starts.at(-1)).toBe(false);
      }
    }));

  for (const deliverAs of ["steer", "followUp"] as const) {
    it(`native ${deliverAs} remains queued/consumed normally but cannot authorize hub (no resend)`, async () =>
      fixture(async (f) => {
        f.hold();
        const running = f.send("running");
        await until(f.pending);
        const before = f.ingresses.length;
        await f.send("ordinary busy Web input", { deliverAs });
        expect(f.ingresses).toHaveLength(before + 1);
        expect(f.ingresses.at(-1)).toMatchObject({ granted: false, behavior: deliverAs });
        // Test-only authorization outcome. No dialogs/writes are invoked for an ineligible turn.
        const hubAttempt = () => (f.ingresses.at(-1)?.granted ? "would ask" : "E_HUB_NEEDS_HUMAN_TURN");
        expect(hubAttempt()).toBe("E_HUB_NEEDS_HUMAN_TURN");
        f.release();
        await running;
        expect(f.ingresses).toHaveLength(before + 1); // drain did not emit another input
        const sent = JSON.stringify(f.sm.getBranch());
        expect(sent.split("ordinary busy Web input").length - 1).toBe(1);
        expect(f.starts.filter(Boolean)).toHaveLength(1); // only original idle run
      }));
  }

  it("settled callback dispatch is deferred by SDK and explicitly ineligible, no invented prior settled", async () =>
    fixture(async (f) => {
      let deferred: Promise<unknown> | undefined;
      f.onSettled(() => {
        f.onSettled(undefined);
        const ticket = f.make();
        expect(ticket.admitted).toBe(true);
        deferred = f.send("settled deferred", { ticket });
      });
      await f.send("initial idle");
      await until(() => f.starts.length === 2 && !f.session.isStreaming);
      await deferred;
      expect(f.starts).toEqual([true, false]);
      expect(f.ingresses.map((item) => item.text)).toEqual(["initial idle", "settled deferred"]);
    }));
});

import { createHash, randomBytes } from "node:crypto";
import { createDialogBridge } from "../../src/web-hub/agent/dialogs.js";
import { createDialogRace, type AskUserRemotePort, type RemoteOutcome } from "../../src/ask-user/remote.js";
import { isFeishuCmdOrigin, type CmdOrigin } from "../../src/web-hub/protocol/messages.js";

/** Only this local trusted receive seam can derive kind. Not a source-string parser or wire field. */
function approvalFixture() {
  const bridge = createDialogBridge({ enabled: true, isAttached: () => true, epoch: "epoch-own" });
  const port: AskUserRemotePort = bridge;
  let currentOrigin: CmdOrigin | string | undefined;
  const usedNonces = new Set<string>();
  let owner = {},
    sid = "sid",
    branch = 1,
    turn = 1,
    writes = 0;
  const op = Object.freeze({
    scope: "hub",
    op: "create",
    targetId: "general.001",
    topic: "general",
    text: 'Frozen exact body\n中文🙂\\"',
    from: "session:n1",
    expectRev: null,
    authority: "user",
  });
  const digest = createHash("sha256").update(JSON.stringify(op)).digest("hex");
  function open(nonce = randomBytes(16).toString("hex")) {
    if (usedNonces.has(nonce)) throw new Error("duplicate nonce refused before bridge");
    usedNonces.add(nonce);
    const binding = Object.freeze({ owner, sid, branch, turn, nonce, digest });
    const reject = "拒绝（不写入）",
      affirm = `授权并写入 HUB · ${digest.slice(0, 8)}`;
    const title = `目标 HUB\n操作 ${op.op}\nid ${op.targetId}\n原文全文\n${op.text}\n摘要 ${digest}\n当前项目 own-fixture`;
    const remote = port.open({
      toolCallId: `memory-op:${nonce}`,
      questions: [
        { question: title, header: "HUB", options: [{ label: reject }, { label: affirm }], allowOther: false },
      ],
      allowCancel: true,
      attributionTitle: title,
    })!;
    const race = createDialogRace();
    const valid = () =>
      binding.owner === owner &&
      binding.sid === sid &&
      binding.branch === branch &&
      binding.turn === turn &&
      binding.digest === digest;
    const accept = (label: string | undefined, by: "tui" | "web") => {
      if (!valid() || !race.claim(by)) return false;
      if (label === affirm) writes++; // Local capability sink only, NOT a production hub commit.
      remote.close(by === "tui" ? "tui" : "abort", label === affirm ? "answered" : "cancelled");
      return true;
    };
    remote.setOnRemote((original) => {
      const structuredKind =
        typeof currentOrigin === "object" && currentOrigin !== null
          ? isFeishuCmdOrigin(currentOrigin)
            ? "feishu"
            : currentOrigin.listener
          : undefined;
      const outcome: RemoteOutcome = {
        ...original,
        ...(structuredKind === undefined ? {} : { originKind: structuredKind }),
      };
      if (outcome.originKind !== "loopback" && outcome.originKind !== "lan") return false;
      return accept(outcome.kind === "answer" ? outcome.answers.HUB : undefined, "web");
    });
    return {
      nonce,
      binding,
      title,
      reject,
      affirm,
      remote,
      tui: (label: string | undefined) => accept(label, "tui"),
      id: `ask:memory-op:${nonce}`,
      race,
    };
  }
  return {
    bridge,
    open,
    op,
    digest,
    writes: () => writes,
    change: (field: "owner" | "sid" | "branch" | "turn") => {
      if (field === "owner") owner = {};
      else if (field === "sid") sid = "other";
      else if (field === "branch") branch++;
      else turn++;
    },
    answer: (
      id: string,
      label: string,
      origin: CmdOrigin | string | undefined = { listener: "loopback", ip: "127.0.0.1", reqId: "local" },
      epoch = "epoch-own",
    ) => {
      currentOrigin = origin;
      try {
        return bridge.answer(id, [{ selected: [label], other: null }], origin, "own-cmd", epoch);
      } finally {
        currentOrigin = undefined;
      }
    },
  };
}

describe("C4 production dialog bridge plus local trusted-source/binding seam (not production authorize)", () => {
  it("reject-first full frozen operation, full digest and fresh nonce; exact Web affirmative only", () => {
    const f = approvalFixture();
    try {
      const d = f.open();
      expect(f.bridge.frame().open[0]?.questions[0]?.options.map((option) => option.label)).toEqual([
        d.reject,
        d.affirm,
      ]);
      expect(f.bridge.frame().open[0]?.questions[0]?.question).toContain(f.op.text);
      expect(d.title).toContain(f.digest);
      expect(d.title).toContain(f.op.targetId);
      for (const key of Object.keys(f.op)) {
        const changed = { ...f.op, [key]: `changed-${key}` };
        expect(createHash("sha256").update(JSON.stringify(changed)).digest("hex")).not.toBe(f.digest);
      }
      expect(() => f.open(d.nonce)).toThrow("duplicate nonce");
      expect(f.answer(d.id, "yes authorized:true").ok).toBe(false);
      expect(f.writes()).toBe(0);
      expect(f.answer(d.id, d.affirm, undefined, "wrong-epoch").ok).toBe(false);
      expect(f.answer(d.id, d.affirm).ok).toBe(true);
      expect(f.writes()).toBe(1);
      expect(f.answer(d.id, d.affirm).ok).toBe(false);
      expect(f.writes()).toBe(1);
      const next = f.open();
      expect(next.id).not.toBe(d.id);
      expect(Object.isFrozen(next.binding)).toBe(true);
    } finally {
      f.bridge.dispose();
    }
  });

  it("TUI/Web race is first-wins, reject and late/old answers never double-consume", () => {
    const f = approvalFixture();
    try {
      const tui = f.open();
      expect(tui.tui(tui.reject)).toBe(true);
      expect(f.answer(tui.id, tui.affirm).ok).toBe(false);
      expect(f.writes()).toBe(0);
      const web = f.open();
      expect(f.answer(web.id, web.affirm, { listener: "lan", ip: "192.0.2.1", reqId: "own" }).ok).toBe(true);
      expect(web.tui(web.affirm)).toBe(false);
      expect(f.writes()).toBe(1);
      const rejected = f.open();
      expect(f.answer(rejected.id, rejected.reject).ok).toBe(true);
      expect(f.writes()).toBe(1);
      const cancel = f.open();
      expect(cancel.tui(undefined)).toBe(true);
      expect(f.writes()).toBe(1);
    } finally {
      f.bridge.dispose();
    }
  });

  it("Feishu, source string, missing origin, owner/session/branch/turn changes fail closed", () => {
    for (const origin of [
      "alice@127.0.0.1",
      undefined,
      { listener: "loopback" as const, ip: "feishu", reqId: "own" },
    ]) {
      const f = approvalFixture();
      try {
        const d = f.open();
        // Explicit undefined bypasses this helper's positive default via the raw bridge.
        const result =
          origin === undefined
            ? f.bridge.answer(d.id, [{ selected: [d.affirm], other: null }], undefined, "own", "epoch-own")
            : f.answer(d.id, d.affirm, origin);
        expect(result.ok).toBe(false);
        expect(f.writes()).toBe(0);
      } finally {
        f.bridge.dispose();
      }
    }
    for (const field of ["owner", "sid", "branch", "turn"] as const) {
      const f = approvalFixture();
      try {
        const d = f.open();
        f.change(field);
        expect(f.answer(d.id, d.affirm).ok).toBe(false);
        expect(f.writes()).toBe(0);
      } finally {
        f.bridge.dispose();
      }
    }
  });

  it("disabled/disconnected channel absent; old silent hub/abort/detach closes without authorization", () => {
    const request = {
      toolCallId: "own",
      questions: [{ question: "body", options: [{ label: "reject" }, { label: "affirm" }] }],
      allowCancel: true,
    };
    for (const options of [
      { enabled: false, isAttached: () => true },
      { enabled: true, isAttached: () => false },
    ]) {
      const bridge = createDialogBridge(options);
      try {
        expect(bridge.open(request)).toBeUndefined();
      } finally {
        bridge.dispose();
      }
    }
    const f = approvalFixture();
    try {
      const d = f.open();
      d.remote.close("abort", "aborted");
      expect(f.answer(d.id, d.affirm).ok).toBe(false);
      const detached = f.open();
      f.bridge.detachAll();
      expect(f.answer(detached.id, detached.affirm).ok).toBe(false);
      expect(f.writes()).toBe(0);
      // Old hubs have no answer producer. This proves closure only, NOT a new capability negotiation.
    } finally {
      f.bridge.dispose();
    }
  });
});

it("C4 SDK select renderer wraps complete 1024-byte body at 40/80/120 columns and defaults to reject", async () => {
  // SDK presentation harness, NOT a real-terminal viewport or browser acceptance test (P5).
  // Resolve from the installed SDK package entry, never user themes/extensions/settings.
  const entry = new URL("../../node_modules/@earendil-works/pi-coding-agent/dist/index.js", import.meta.url).href;
  const { initTheme } = await import(new URL("./modes/interactive/theme/theme.js", entry).href);
  const { ExtensionSelectorComponent } = await import(
    new URL("./modes/interactive/components/extension-selector.js", entry).href
  );
  initTheme("dark", false);
  const raw = "A".repeat(1024);
  let selected: string | undefined;
  const component = new ExtensionSelectorComponent(
    `HUB exact content\nBEGIN_BODY\n${raw}\nEND_BODY`,
    ["REJECT", "AFFIRM"],
    (value: string) => {
      selected = value;
    },
    () => {},
  );
  try {
    for (const width of [40, 80, 120]) {
      const rendered = component
        .render(width)
        .join("\n")
        .replace(/\x1b\[[0-9;]*m/g, "");
      expect(rendered).toContain("BEGIN_BODY");
      expect(rendered).toContain("END_BODY");
      // AFFIRM contributes one A; exact body contributes all 1024 A's (no ellipsis/truncation).
      expect((rendered.match(/A/g) ?? []).length).toBe(1025);
    }
    component.handleInput("\n");
    expect(selected).toBe("REJECT");
  } finally {
    component.dispose();
  }
});
