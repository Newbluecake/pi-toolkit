import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { f8Rig, eventually, sentContent } from "../../../fixtures/feishu/f8.js";
import { messageEnvelope, NOW } from "../../../fixtures/feishu/f6.js";
import { createFakeClock } from "../../../fixtures/feishu/fake-http.js";
import { systemFeishuClock, type FeishuClock } from "../../../../src/web-hub/hub/feishu/http.js";
import { FEISHU_SHUTDOWN_BUDGET_MS } from "../../../../src/web-hub/protocol/feishu.js";
import * as connectorModule from "../../../../src/web-hub/hub/feishu/connector.js";
import * as stateModule from "../../../../src/web-hub/hub/feishu/state.js";
import * as inboundModule from "../../../../src/web-hub/hub/feishu/inbound.js";
import * as routerModule from "../../../../src/web-hub/hub/feishu/router.js";
import * as requestsModule from "../../../../src/web-hub/hub/feishu/requests.js";
import * as dialogsModule from "../../../../src/web-hub/hub/feishu/dialogs.js";
import * as sessionsModule from "../../../../src/web-hub/hub/feishu/sessions.js";
import * as runsModule from "../../../../src/web-hub/hub/feishu/runs.js";
import * as filesModule from "../../../../src/web-hub/hub/feishu/files.js";
import * as notifyModule from "../../../../src/web-hub/hub/feishu/notify.js";
import * as outboxModule from "../../../../src/web-hub/hub/feishu/outbox.js";
import * as tokenModule from "../../../../src/web-hub/hub/feishu/token.js";
import * as registrationModule from "../../../../src/web-hub/hub/feishu/registration.js";
import * as runtimeModule from "../../../../src/web-hub/hub/feishu/runtime.js";
import type { CmdResultFrame } from "../../../../src/web-hub/protocol/messages.js";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});
async function rig(...args: Parameters<typeof f8Rig>) {
  const r = await f8Rig(...args);
  cleanups.push(() => r.close());
  await r.ready();
  return r;
}

/** Wrap REAL factory products: no replacement behavior, so order assertions exercise the actual stop path. */
function observeTeardown(trace: string[]) {
  function watch<T extends object>(name: string, value: T, methods: readonly string[]): T {
    const target = value as Record<string, unknown>;
    for (const method of methods) {
      const original = target[method];
      if (typeof original !== "function") throw new Error(`missing ${name}.${method}`);
      target[method] = (...args: unknown[]) => {
        trace.push(`${name}.${method}`);
        return Reflect.apply(original, value, args);
      };
    }
    return value;
  }
  const connector = connectorModule.createFeishuConnector;
  vi.spyOn(connectorModule, "createFeishuConnector").mockImplementation((d) =>
    watch("connector", connector(d), ["stop", "dispose"]),
  );
  const state = stateModule.createFeishuState;
  vi.spyOn(stateModule, "createFeishuState").mockImplementation((d) =>
    watch("state", state(d), ["commit", "flush", "dispose", "destroy"]),
  );
  const inbound = inboundModule.createFeishuInbound;
  vi.spyOn(inboundModule, "createFeishuInbound").mockImplementation((d) => watch("inbound", inbound(d), ["dispose"]));
  const router = routerModule.createFeishuRouter;
  vi.spyOn(routerModule, "createFeishuRouter").mockImplementation((d) => watch("router", router(d), ["dispose"]));
  const requests = requestsModule.createFeishuRequests;
  vi.spyOn(requestsModule, "createFeishuRequests").mockImplementation((d) =>
    watch("requests", requests(d), ["dispose"]),
  );
  const dialogs = dialogsModule.createFeishuDialogs;
  vi.spyOn(dialogsModule, "createFeishuDialogs").mockImplementation((d) => watch("dialogs", dialogs(d), ["dispose"]));
  const sessions = sessionsModule.createFeishuSessions;
  vi.spyOn(sessionsModule, "createFeishuSessions").mockImplementation((d, now) =>
    watch("sessions", sessions(d, now), ["clear"]),
  );
  const runs = runsModule.createFeishuRuns;
  vi.spyOn(runsModule, "createFeishuRuns").mockImplementation((d) => watch("runs", runs(d), ["dispose"]));
  const files = filesModule.createFeishuFiles;
  vi.spyOn(filesModule, "createFeishuFiles").mockImplementation((d) => watch("files", files(d), ["dispose"]));
  const notify = notifyModule.createFeishuNotify;
  vi.spyOn(notifyModule, "createFeishuNotify").mockImplementation((d) => watch("notify", notify(d), ["dispose"]));
  const outbox = outboxModule.createFeishuOutbox;
  vi.spyOn(outboxModule, "createFeishuOutbox").mockImplementation((d) =>
    watch("outbox", outbox(d), ["stop", "dispose"]),
  );
  const token = tokenModule.createTokenManager;
  vi.spyOn(tokenModule, "createTokenManager").mockImplementation((d) => watch("token", token(d), ["dispose"]));
  const registration = registrationModule.createRegistration;
  vi.spyOn(registrationModule, "createRegistration").mockImplementation((d) =>
    watch("registration", registration(d), ["cancel", "fence", "dispose"]),
  );
  const work = runtimeModule.createFeishuWork;
  vi.spyOn(runtimeModule, "createFeishuWork").mockImplementation((...args) =>
    watch("work", work(...args), ["drain", "close"]),
  );
}

describe("F8 follow-ups after r_NHKEWJ0Z", () => {
  it("a successful capability probe clears its previous degraded denial", async () => {
    const r = await rig();
    await r.bind();
    r.fake.script("POST", /reactions$/, { json: { code: 99991672, msg: "capability denied" } });
    r.send(messageEnvelope("denied-reaction", "first"));
    await eventually(() => expect(r.service.snapshot().caps.reactions).toBe("denied"));
    expect(r.service.snapshot().degraded).toContain("capability-denied:reactions");
    r.send(messageEnvelope("allowed-reaction", "second"));
    await eventually(() => expect(r.service.snapshot().caps.reactions).toBe("ok"));
    expect(r.service.snapshot().degraded ?? []).not.toContain("capability-denied:reactions");
    expect(r.service.snapshot().status).toBe("open");
  });
  it("service-lifetime receive/duplicate/outbox/drop counters survive stop and restart without double-counting", async () => {
    const r = await rig();
    await r.bind();
    r.send(messageEnvelope("counter-help", "/help"));
    await eventually(() => expect(sentContent(r)).toContain("/help"));
    r.send(messageEnvelope("counter-help", "/help"));
    await eventually(() => expect(r.service.snapshot().counters.dup).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const before = r.service.snapshot();
    expect(before.counters.in).toBe(3);
    expect(before.outbox.ok).toBe(2);
    await r.service.stop();
    const stopped = r.service.snapshot();
    expect(stopped.counters).toEqual(before.counters);
    expect(stopped.outbox).toEqual(before.outbox);
    await r.service.start();
    await r.ready();
    expect(r.service.snapshot().counters).toEqual(before.counters);
    r.send(messageEnvelope("new-runtime-help", "/help"));
    await eventually(() => expect(r.service.snapshot().outbox.ok).toBe(3));
    expect(r.service.snapshot().counters.in).toBe(4);
    expect(r.service.snapshot().counters.dup).toBe(1);
    const counts = r.service.snapshot().counters;
    await r.service.stop();
    expect(r.service.snapshot().counters).toEqual(counts);
  });
  it.each(["stop", "dispose", "reset"] as const)(
    "%s invokes connector.stop before EVERY other teardown operation",
    async (method) => {
      const trace: string[] = [];
      observeTeardown(trace);
      const r = await rig();
      trace.length = 0;
      if (method === "reset")
        expect((await r.service.admin({ t: "fsb_req", rid: "reset-order", op: "reset", confirm: true })).ok).toBe(true);
      else await r.service[method]();
      expect(trace[0]).toBe("connector.stop");
      for (const name of [
        "inbound.dispose",
        "router.dispose",
        "requests.dispose",
        "dialogs.dispose",
        "sessions.clear",
        "runs.dispose",
        "files.dispose",
        "notify.dispose",
        "work.drain",
        "work.close",
        "outbox.stop",
        "outbox.dispose",
        "state.commit",
        "state.flush",
        "token.dispose",
        "connector.dispose",
      ]) {
        expect(trace).toContain(name);
        expect(trace.indexOf(name)).toBeGreaterThan(trace.indexOf("connector.stop"));
      }
      for (const name of [
        "registration.cancel",
        "registration.fence",
        "registration.dispose",
        "state.destroy",
        "state.dispose",
      ])
        if (trace.includes(name)) expect(trace.indexOf(name)).toBeGreaterThan(0);
      if (method === "reset") expect(r.service.keepalive()).toBe(false);
    },
  );
  it("hanging socket close + pending dispatch + hanging drains/flush still finish within the shared six-second budget", async () => {
    let fake: ReturnType<typeof createFakeClock> | undefined;
    const realStart = Date.now();
    const clock: FeishuClock = {
      now: () => (fake ? fake.now() : NOW + Date.now() - realStart),
      setTimeout: (fn, ms) => (fake ? fake.setTimeout(fn, ms) : systemFeishuClock.setTimeout(fn, ms)),
      clearTimeout: (handle) => {
        if (typeof handle === "number") fake?.clearTimeout(handle);
        else systemFeishuClock.clearTimeout(handle);
      },
    };
    let state!: stateModule.FeishuState, outbox!: ReturnType<typeof outboxModule.createFeishuOutbox>;
    const createState = stateModule.createFeishuState,
      createOutbox = outboxModule.createFeishuOutbox;
    vi.spyOn(stateModule, "createFeishuState").mockImplementation((d) => (state = createState(d)));
    vi.spyOn(outboxModule, "createFeishuOutbox").mockImplementation((d) => (outbox = createOutbox(d)));
    const r = await rig({ clock });
    await r.bind();
    let resolve!: (result: CmdResultFrame) => void;
    r.request.mockImplementationOnce(
      () =>
        new Promise<CmdResultFrame>((done) => {
          resolve = done;
        }),
    );
    r.send(messageEnvelope("pending-through-stop", "do not re-dispatch"));
    await eventually(() => expect(r.request).toHaveBeenCalledTimes(1));
    const frame = r.request.mock.calls[0]![0];
    r.ws.sockets[0]!.stallClose = true;
    // Failure injection, not success stubs: every phase is forced to consume its deadline.
    vi.spyOn(state, "commit").mockImplementation(() => new Promise(() => {}));
    vi.spyOn(outbox, "stop").mockImplementation(() => new Promise(() => {}));
    vi.spyOn(state, "flush").mockImplementation(() => new Promise(() => {}));
    fake = createFakeClock(clock.now());
    const startAt = fake.now(),
      budget = Object.values(FEISHU_SHUTDOWN_BUDGET_MS).reduce((a, b) => a + b, 0);
    let finished = false;
    const stopped = r.service.dispose().then(() => {
      finished = true;
    });
    expect(r.ws.sockets[0]!.closeCalls).toBe(1);
    // Advance one known deadline at a time; microtasks schedule the next phase at the same fake instant.
    for (const ms of [1_000, 2_000, 2_000, 999]) {
      fake.advance(ms);
      for (let i = 0; i < 40; i++) await Promise.resolve();
    }
    expect(finished).toBe(false);
    fake.advance(1);
    for (let i = 0; i < 80; i++) await Promise.resolve();
    expect(finished).toBe(true);
    await stopped;
    expect(fake.now() - startAt).toBe(budget);
    expect(r.ws.sockets[0]!.readyState).toBe(2); // native-like socket never confirmed close
    resolve({ t: "cmd_result", rid: frame.rid, id: frame.id, ok: true, data: { op: "prompt", delivery: "observed" } });
    for (let i = 0; i < 40; i++) await Promise.resolve();
    expect((await r.disk())["requests"][frame.id].state).toBe("dispatching");
    r.ws.sockets[0]!.finishClose();
  });
  it("unsafe credentials keep the hub alive until a successful reset removes them", async () => {
    const original = await rig();
    await original.service.dispose();
    await chmod(join(original.stateDir, "feishu-bot", "credentials.json"), 0o644);
    const next = await f8Rig({ stateDir: original.stateDir });
    cleanups.push(() => next.service.dispose());
    expect(next.service.snapshot().degraded).toContain("credentials-unsafe");
    expect(next.ws.sockets).toHaveLength(0);
    expect(next.service.keepalive()).toBe(true);
    expect((await next.service.admin({ t: "fsb_req", rid: "reset-unsafe", op: "reset", confirm: true })).ok).toBe(true);
    expect(next.service.keepalive()).toBe(false);
  });
});
