/**
 * preview-perf P5 (plan r3 §5.3) — the main-thread `highlight-worker-client` against a fake
 * worker: request/id/deadline protocol, transfer-shaped replies, cancellation, the 3 s timeout
 * (terminate + lazy rebuild, non-sticky), and the STICKY unavailable verdict (constructor
 * throw / `error` / `messageerror` / no-Worker environment) that routes every current and
 * future request to the §5.1 main-thread fallback. Node env: the client module has no runtime
 * imports (type-only), and `Worker` being undefined here is itself one of the tested paths.
 */
import { describe, expect, it } from "vitest";
import {
  createHighlightWorkerClient,
  getHighlightWorkerClient,
  HIGHLIGHT_WORKER_MAX_BYTES,
  HIGHLIGHT_WORKER_TIMEOUT_MS,
  type HighlightWorkerClient,
  type HighlightWorkerLike,
} from "../../../src/web-hub/ui/src/components/shared/highlight-worker-client.js";

class FakeWorker {
  static created: FakeWorker[] = [];
  readonly posted: Array<{ message: unknown; transfer?: unknown }> = [];
  terminated = 0;
  private readonly listeners = new Map<string, Array<(ev?: { data?: unknown }) => void>>();

  constructor() {
    FakeWorker.created.push(this);
  }

  postMessage(message: unknown, transfer?: unknown): void {
    this.posted.push({ message, transfer });
  }

  terminate(): void {
    this.terminated += 1;
  }

  addEventListener(type: string, listener: (ev?: { data?: unknown }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  /** Test-side: deliver a worker→main message. */
  emitMessage(data: unknown): void {
    for (const l of this.listeners.get("message") ?? []) l({ data });
  }

  /** Test-side: fire the error / messageerror event. */
  emitEvent(type: "error" | "messageerror"): void {
    for (const l of this.listeners.get(type) ?? []) l();
  }
}

/** A fresh fake-worker client with its handle to the latest created FakeWorker. */
function makeClient(timeoutMs = 5_000): {
  client: HighlightWorkerClient;
  lastWorker(): FakeWorker;
  reset(): void;
} {
  FakeWorker.created = [];
  return {
    client: createHighlightWorkerClient({
      workerFactory: () => new FakeWorker() as unknown as HighlightWorkerLike,
      timeoutMs,
    }),
    lastWorker: () => {
      const w = FakeWorker.created[FakeWorker.created.length - 1];
      if (w === undefined) throw new Error("no worker created yet");
      return w;
    },
    reset: () => {
      FakeWorker.created = [];
    },
  };
}

function spansPayload(): { classes: string[]; spans: Uint32Array } {
  return { classes: ["tok-keyword"], spans: new Uint32Array([0, 5, 0]) };
}

describe("highlight-worker-client (P5 §5.3)", () => {
  it("exports the frozen plan constants (256 KiB gate, 3 s deadline)", () => {
    expect(HIGHLIGHT_WORKER_MAX_BYTES).toBe(256 * 1024);
    expect(HIGHLIGHT_WORKER_TIMEOUT_MS).toBe(3_000);
  });

  it("happy path: posts a well-formed tokenize request, resolves spans from the reply", async () => {
    const { client, lastWorker } = makeClient();
    const handle = client.request("const a = 1;", "typescript");
    const w = lastWorker();
    expect(w.posted).toHaveLength(1);
    expect(w.posted[0]!.message).toEqual({ kind: "tokenize", id: 1, text: "const a = 1;", lang: "typescript" });
    const payload = spansPayload();
    w.emitMessage({ kind: "spans", id: 1, classes: payload.classes, spans: payload.spans });
    const outcome = await handle.result;
    expect(outcome).toEqual({ status: "spans", spans: payload });
  });

  it("plain reply resolves plain (grammar/budget negatives — worker stays usable)", async () => {
    const { client, lastWorker } = makeClient();
    const handle = client.request("x", "nosuchlang");
    lastWorker().emitMessage({ kind: "plain", id: 1 });
    await expect(handle.result).resolves.toEqual({ status: "plain" });
  });

  it("cancel resolves cancelled and detaches the id — a late reply is dropped", async () => {
    const { client, lastWorker } = makeClient();
    const handle = client.request("x", "typescript");
    handle.cancel();
    await expect(handle.result).resolves.toEqual({ status: "cancelled" });
    // the worker still finishes (cannot be interrupted) and replies — ignored, no double settle
    lastWorker().emitMessage({ kind: "spans", id: 1, ...spansPayload() });
    await expect(handle.result).resolves.toEqual({ status: "cancelled" });
  });

  it("timeout: terminates the shared worker, resolves fallback, lazily REBUILDS (non-sticky)", async () => {
    const { client, lastWorker, reset } = makeClient(15);
    const a = client.request("x", "typescript");
    const w1 = lastWorker();
    reset(); // isolate worker #1's handle
    const b = client.request("y", "typescript");
    await expect(a.result).resolves.toEqual({ status: "fallback" });
    // the terminated worker took the other pending request down with it
    await expect(b.result).resolves.toEqual({ status: "fallback" });
    expect(w1.terminated).toBe(1);
    expect(client.unavailable).toBe(false); // timeout is NOT the sticky verdict
    // the next request lazily rebuilds a fresh worker
    const c = client.request("z", "typescript");
    const w2 = lastWorker();
    expect(w2).not.toBe(w1);
    expect(w2.posted[0]!.message).toMatchObject({ text: "z" });
    w2.emitMessage({ kind: "spans", id: 3, ...spansPayload() });
    await expect(c.result).resolves.toMatchObject({ status: "spans" });
  });

  it("STICKY: a throwing constructor kills the worker path for the process", async () => {
    let calls = 0;
    const client = createHighlightWorkerClient({
      workerFactory: () => {
        calls += 1;
        throw new Error("blocked");
      },
    });
    await expect(client.request("x", "typescript").result).resolves.toEqual({ status: "fallback" });
    expect(client.unavailable).toBe(true);
    await expect(client.request("y", "typescript").result).resolves.toEqual({ status: "fallback" });
    expect(calls).toBe(1); // sticky — never constructed again
  });

  it("STICKY: a factory returning null (no Worker in this env) behaves identically", async () => {
    let calls = 0;
    const client = createHighlightWorkerClient({
      workerFactory: () => {
        calls += 1;
        return null;
      },
    });
    await expect(client.request("x", "typescript").result).resolves.toEqual({ status: "fallback" });
    expect(client.unavailable).toBe(true);
    await expect(client.request("y", "typescript").result).resolves.toEqual({ status: "fallback" });
    expect(calls).toBe(1);
  });

  it("STICKY: the error event (CSP rejection / load failure / uncaught worker error) fails all pending", async () => {
    const { client, lastWorker } = makeClient();
    const a = client.request("x", "typescript");
    const b = client.request("y", "typescript");
    lastWorker().emitEvent("error");
    await expect(a.result).resolves.toEqual({ status: "fallback" });
    await expect(b.result).resolves.toEqual({ status: "fallback" });
    expect(client.unavailable).toBe(true);
    expect(lastWorker().terminated).toBe(1);
    await expect(client.request("z", "typescript").result).resolves.toEqual({ status: "fallback" });
  });

  it("STICKY: messageerror behaves like error", async () => {
    const { client, lastWorker } = makeClient();
    const a = client.request("x", "typescript");
    lastWorker().emitEvent("messageerror");
    await expect(a.result).resolves.toEqual({ status: "fallback" });
    expect(client.unavailable).toBe(true);
  });

  it("garbage / structurally invalid replies are ignored — the deadline decides", async () => {
    const { client, lastWorker } = makeClient(15);
    const handle = client.request("x", "typescript");
    const w = lastWorker();
    w.emitMessage(null);
    w.emitMessage({ kind: "spans", id: 999, ...spansPayload() }); // unknown id
    w.emitMessage({ kind: "spans", id: 1, classes: "nope", spans: spansPayload().spans }); // bad classes
    w.emitMessage({ kind: "spans", id: 1, classes: ["tok-x"], spans: new Uint32Array([1, 2]) }); // length % 3 !== 0
    w.emitMessage({ kind: "spans", id: 1, classes: ["tok-x"], spans: [0, 5, 0] }); // not a Uint32Array
    w.emitMessage({ kind: "???", id: 1 });
    await expect(handle.result).resolves.toEqual({ status: "fallback" }); // fell to the deadline
    expect(client.unavailable).toBe(false); // garbage is per-request, not sticky
  });

  it("request ids are monotone and scoped to the (rebuilt) worker's lifetime", async () => {
    const { client, lastWorker } = makeClient(15);
    const a = client.request("x", "typescript");
    const b = client.request("y", "typescript");
    expect(lastWorker().posted.map((p) => (p.message as { id: number }).id)).toEqual([1, 2]);
    await a.result; // timeout — terminate + rebuild
    await b.result;
    const c = client.request("z", "typescript");
    expect((lastWorker().posted[0]!.message as { id: number }).id).toBe(3);
    lastWorker().emitMessage({ kind: "spans", id: 3, ...spansPayload() });
    await expect(c.result).resolves.toMatchObject({ status: "spans" });
  });

  it("the shared singleton: node has no Worker ⇒ sticky fallback immediately, one instance forever", async () => {
    const a = getHighlightWorkerClient();
    const b = getHighlightWorkerClient();
    expect(a).toBe(b);
    if (typeof Worker === "function") return; // only assert where Worker is truly absent (node)
    await expect(a.request("x", "typescript").result).resolves.toEqual({ status: "fallback" });
    expect(a.unavailable).toBe(true); // sticky after the first (lazy) probe
  });
});
