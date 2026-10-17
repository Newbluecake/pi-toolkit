// Offline transport/step tests only: every fetch/WebSocket is replaced; no tenant is contacted.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Connection, Probe, isMessage } from "../../scripts/dev/feishu-probe/runtime.ts";
import { decodeFrame, encodeFrame } from "../../scripts/dev/feishu-probe/codec.ts";
import type { Frame } from "../../scripts/dev/feishu-probe/codec.ts";
import { P5, P6, P8 } from "../../scripts/dev/feishu-probe/steps.ts";

const credentials = {
  v: 1 as const,
  brand: "feishu" as const,
  appId: "cli_test",
  appSecret: "test-secret-canary",
  ownerOpenId: "ou_owner",
  createdAt: "2026-10-17",
  gen: "test",
};
const envelope = (id = "om_test") => ({
  schema: "2.0",
  header: {
    event_type: "im.message.receive_v1",
    event_id: "ev_" + id,
    app_id: "cli_test",
    tenant_key: "tenant-canary",
  },
  event: {
    sender: { tenant_key: "tenant-canary", sender_id: { open_id: "ou_owner" } },
    message: {
      message_id: id,
      chat_id: "oc_test",
      chat_type: "p2p",
      content: '{"text":"private-canary"}',
      create_time: String(Date.now()),
    },
  },
});
const eventFrame = (body: unknown, encoding = ""): Frame => ({
  seqId: 99n,
  logId: (1n << 63n) + 1n,
  service: 7,
  method: 1,
  headers: [
    { key: "type", value: "event" },
    { key: "message_id", value: "frame_id" },
    { key: "sum", value: "1" },
    { key: "seq", value: "0" },
  ],
  payloadEncoding: encoding,
  payload: new TextEncoder().encode(JSON.stringify(body)),
  logIdNew: "new",
});
class FakeWebSocket extends EventTarget {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  bufferedAmount = 0;
  binaryType = "";
  sent: Frame[] = [];
  constructor(_url: string) {
    super();
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.dispatchEvent(new Event("open"));
    });
  }
  send(bytes: Uint8Array): void {
    const f = decodeFrame(bytes);
    this.sent.push(f);
    if (f.method === 0)
      queueMicrotask(() =>
        this.emit({
          ...f,
          headers: [{ key: "type", value: "pong" }],
          payload: new TextEncoder().encode('{"PingInterval":10,"ReconnectNonce":2}'),
        }),
      );
  }
  emit(f: Frame): void {
    const b = encodeFrame(f);
    this.dispatchEvent(new MessageEvent("message", { data: b.buffer }));
  }
  close(): void {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
}
let probes: Probe[] = [];
function probe(): Probe {
  const p = new Probe(5000);
  p.credentials = { ...credentials };
  p.secrets.push(credentials.appSecret);
  p.current = "P3";
  probes.push(p);
  return p;
}
beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            code: 0,
            data: {
              URL: "wss://socket.feishu.cn/ws?service_id=7&device_id=query-canary&token=url-canary",
              ClientConfig: { PingInterval: 120 },
            },
          }),
          { status: 200 },
        ),
    ),
  );
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  for (const p of probes) p.close();
  probes = [];
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("offline WS and HTTP", () => {
  it.each(["SIGINT", "close"])(
    "handles readline %s (TTY Ctrl-C / EOF) without leaving unref timers pending",
    async (event) => {
      vi.useFakeTimers();
      const p = probe();
      const waiting = p.wait(600_000).catch((error) => error.message);
      p.input.emit(event);
      expect(await waiting).toBe("interrupted");
      expect(p.report.interrupted).toBe(true);
      expect(p.signal.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it("bootstraps fresh endpoints, pings, applies pong config, ACKs on the same socket and never records URL queries", async () => {
    const p = probe(),
      a = await p.connect("A"),
      b = await p.connect("B");
    const fa = FakeWebSocket.instances[0]!,
      fb = FakeWebSocket.instances[1]!;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(a.pingCount).toBe(1);
    expect(a.config.PingInterval).toBe(10);
    fa.emit(eventFrame(envelope()));
    expect(a.events).toHaveLength(1);
    expect(a.events[0]!.ackSent).toBe(true);
    expect(fa.sent.at(-1)!.payload).toEqual(new TextEncoder().encode('{"code":200}'));
    expect(fa.sent.at(-1)!.seqId).toBe(99n);
    expect(fa.sent.at(-1)!.logId).toBe((1n << 63n) + 1n);
    expect(fb.sent).toHaveLength(1); // B has only its own ping, never A's ACK.
    const report = JSON.stringify(p.report);
    for (const secret of ["query-canary", "url-canary", "private-canary", credentials.appSecret, "ou_owner"])
      expect(report).not.toContain(secret);
    expect(report).toContain("socket.feishu.cn");
    expect(p.report.steps.P3.liveAttempted).toBe(true);
    expect(p.report.untestedLive).not.toContain("P3");
    a.close();
    b.close();
    expect(p.sockets.size).toBe(0);
  });
  it("can deliberately withhold ACK and observes a matching event on a new connection", async () => {
    const p = probe(),
      a = await p.connect("noACK");
    a.ack = false;
    FakeWebSocket.instances[0]!.emit(eventFrame(envelope()));
    const original = a.events[0]!;
    expect(original.ackSent).toBe(false);
    expect(FakeWebSocket.instances[0]!.sent).toHaveLength(1);
    a.close();
    const b = await p.connect("new");
    const waiting = b.next((e) => e.envelope.header.event_id === original.envelope.header.event_id, 5000, 0);
    FakeWebSocket.instances[1]!.emit(eventFrame(envelope()));
    expect((await waiting)?.connection).toBe("new");
    expect(b.events[0]!.ackSent).toBe(true);
    // This test exercises observation mechanics; it is not evidence of tenant redelivery.
  });
  it("attempts JSON for every encoding, ACKs only decoded/undecodable event frames, and ignores legacy card frames like SDK", async () => {
    const p = probe(),
      c = await p.connect("A"),
      ws = FakeWebSocket.instances[0]!;
    ws.emit(eventFrame(envelope(), "gzip"));
    expect(c.events).toHaveLength(1);
    expect(c.events[0]!.frame.payloadEncoding).toBe("gzip");
    const bad = { ...eventFrame(envelope(), "custom"), payload: Uint8Array.from([255, 254]) };
    ws.emit(bad);
    expect(c.events).toHaveLength(1);
    expect(ws.sent.at(-1)!.method).toBe(1);
    const sent = ws.sent.length;
    ws.emit({ ...eventFrame(envelope()), headers: [{ key: "type", value: "card" }] });
    c.receive("not-binary");
    c.receive(Uint8Array.from([8, 128]).buffer);
    expect(ws.sent).toHaveLength(sent);
    expect(p.report.steps.P3.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "undecodable-json",
          data: expect.objectContaining({ payload_encoding: "custom" }),
        }),
        expect.objectContaining({ kind: "frame-rejected" }),
        expect.objectContaining({
          kind: "ignored-data-type",
          data: expect.objectContaining({ type: "card", ackSent: false }),
        }),
      ]),
    );
  });
  it("pins tenant from owner traffic and rejects app/tenant drift for subsequent action selection", async () => {
    const p = probe(),
      c = await p.connect("A"),
      ws = FakeWebSocket.instances[0]!;
    ws.emit(eventFrame(envelope()));
    expect(p.tenantKey).toBe("tenant-canary");
    const other = envelope("other");
    other.header.tenant_key = "other";
    other.event.sender.tenant_key = "other";
    ws.emit(eventFrame(other));
    expect(p.consistent(c.events.at(-1)!)).toBe(false);
    expect(p.tenantKey).toBe("tenant-canary");
  });
  it("bounds caches/observations and resolves pending receives on close", async () => {
    const p = probe(),
      c = await p.connect("A"),
      ws = FakeWebSocket.instances[0]!;
    for (let i = 0; i < 8; i++) ws.emit(eventFrame(envelope(String(i))));
    expect(c.events).toHaveLength(4);
    for (let i = 0; i < 300; i++) p.record("bounded", { code: i });
    expect(p.report.steps.P3.observations).toHaveLength(256);
    expect(p.report.steps.P3.droppedObservations).toBeGreaterThan(0);
    p.fact("V7", "unknown", { phase: "redelivery", received: false });
    p.fact("V7", "pass", { phase: "two-connections", received: true });
    expect(p.report.facts.V7!.status).toBe("unknown");
    const waiting = c.next(() => false, 600_000);
    c.close();
    expect(await waiting).toBeUndefined();
    expect(c.listeners.size).toBe(0);
    expect(c.closeListeners.size).toBe(0);
  });
  it("has a real HTTP deadline and clears the timer on timeout", async () => {
    vi.useFakeTimers();
    const p = probe();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, options: RequestInit) =>
          new Promise((_resolve, reject) => {
            options.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
      ),
    );
    const result = p.request("https://open.feishu.cn/a", "api").catch((e) => e.message);
    await vi.advanceTimersByTimeAsync(8000);
    expect(await result).toBe("timeout");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects oversized HTTP bodies and never follows redirects", async () => {
    const p = probe();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array(65 * 1024))),
    );
    await expect(p.request("https://open.feishu.cn/a", "api", {}, 64 * 1024)).rejects.toThrow(
      "protocol:body-too-large",
    );
    expect(fetch).toHaveBeenCalledWith(
      "https://open.feishu.cn/a",
      expect.objectContaining({ redirect: "error", signal: expect.any(AbortSignal) }),
    );
    await expect(p.request("https://evil.test/a", "api")).rejects.toThrow("destination-refused");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("closes a stale connection after ping without inbound traffic, clearing all timers", async () => {
    vi.useFakeTimers();
    const p = probe(),
      c = new Connection(p, "silent", 7);
    c.ws = new FakeWebSocket("unused") as unknown as WebSocket;
    await Promise.resolve();
    // Do not dispatch the fake's automatic pong to c: no message listener has been installed.
    c.ping();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(c.closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
describe("offline step contracts", () => {
  it("uploads an actual 16x16 PNG fixture and sends generated image/file content", async () => {
    const p = probe();
    p.current = "P6";
    vi.spyOn(p, "ask").mockResolvedValue("");
    vi.spyOn(p, "wait").mockResolvedValue();
    const conn = {
      close: vi.fn(),
      next: vi.fn().mockResolvedValueOnce({ envelope: envelope() }).mockResolvedValue(undefined),
    };
    vi.spyOn(p, "connect").mockResolvedValue(conn as unknown as Connection);
    let imageBytes: Uint8Array | undefined;
    const sentTypes: string[] = [];
    vi.spyOn(p, "api").mockImplementation(async (path, method, body: any) => {
      if (path.endsWith("/reactions")) return { reaction_id: "reaction" };
      if (method === "DELETE") return {};
      if (path.endsWith("/images")) {
        imageBytes = new Uint8Array(await ((body as FormData).get("image") as Blob).arrayBuffer());
        return { image_key: "test-image" };
      }
      if (path.endsWith("/files")) return { file_key: "test-file" };
      sentTypes.push(body.msg_type);
      return { message_id: "om_generated" };
    });
    await P6(p);
    const png = Buffer.from(imageBytes!);
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(png.readUInt32BE(16)).toBe(16);
    expect(png.readUInt32BE(20)).toBe(16);
    expect(sentTypes).toEqual(["image", "file"]);
  });
  it("reports missing scope tokens and precise API failures in V3 without leaking msg/secret", async () => {
    const p = probe();
    p.current = "P6";
    vi.spyOn(p, "ask").mockResolvedValue("");
    vi.spyOn(p, "accessToken").mockResolvedValue("fake-token");
    const conn = {
      close: vi.fn(),
      next: vi.fn().mockResolvedValueOnce({ envelope: envelope() }).mockResolvedValue(undefined),
    };
    vi.spyOn(p, "connect").mockResolvedValue(conn as unknown as Connection);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              code: 99991672,
              msg:
                "private-canary " + credentials.appSecret + " require [im:resource, im:message.reactions:write_only]",
            }),
            { status: 403 },
          ),
      ),
    );
    await P6(p);
    const fact = JSON.stringify(p.report.facts.V3),
      report = JSON.stringify(p.report);
    expect(fact).toContain("api-code-99991672");
    expect(fact).toContain("im:resource");
    expect(fact).toContain("im:message.reactions:write_only");
    expect(report).not.toContain("private-canary");
    expect(report).not.toContain(credentials.appSecret);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 503 })),
    );
    await expect(p.api("/open-apis/im/v1/images")).rejects.toMatchObject({ kind: "http-503" });
  });
  it("sends two schema-2 cards with config.update_multi absent/true, captures callback ACK, patches each", async () => {
    const p = probe();
    p.current = "P5";
    vi.spyOn(p, "ask").mockResolvedValue("");
    const callbacks: any[] = [];
    const conn = {
      close: vi.fn(),
      next: vi.fn(async (predicate: (e: any) => boolean) => {
        const e = callbacks.shift() ?? { envelope: envelope() };
        expect(predicate(e)).toBe(true);
        return e;
      }),
    };
    vi.spyOn(p, "connect").mockResolvedValue(conn as unknown as Connection);
    const cards: any[] = [];
    const patches: any[] = [];
    vi.spyOn(p, "api").mockImplementation(async (path, method, body: any) => {
      if (method === "PATCH") {
        patches.push(JSON.parse(body.content));
        return {};
      }
      expect(path).toContain("receive_id_type=chat_id");
      const card = JSON.parse(body.content),
        id = "om_card" + cards.length;
      cards.push(card);
      callbacks.push({
        ackSent: true,
        envelope: {
          schema: "2.0",
          header: { app_id: "cli_test", tenant_key: "tenant-canary", event_type: "card.action.trigger" },
          event: {
            action: { value: card.body.elements[1].behaviors[0].value },
            operator: { open_id: "ou_owner", tenant_key: "tenant-canary" },
            context: { open_chat_id: "oc_test", open_message_id: id },
          },
        },
      });
      return { message_id: id };
    });
    await P5(p);
    expect(cards.map((c) => c.schema)).toEqual(["2.0", "2.0"]);
    for (const card of cards) {
      expect(card.body.elements[1]).not.toHaveProperty("value");
      expect(card.body.elements[1].behaviors[0]).toEqual({ type: "callback", value: { n: expect.any(String) } });
    }
    expect(cards.map((c) => c.config.update_multi)).toEqual([undefined, true]);
    expect(patches.map((c) => c.config.update_multi)).toEqual([undefined, true]);
    expect(p.report.facts.V2b!.status).toBe("pass");
    expect(p.report.facts.V5!.observations).toHaveLength(2);
  });
  it("corrupts only a transient secret for P8 and records actual error codes", async () => {
    const p = probe();
    p.current = "P8";
    vi.spyOn(p, "ask").mockResolvedValueOnce("").mockResolvedValueOnce("s");
    const boot = vi.spyOn(p, "bootstrap").mockResolvedValue({ status: 200, body: { code: 514 } });
    const request = vi.spyOn(p, "request").mockResolvedValue({ status: 200, body: { code: 10003 } });
    const conn = { close: vi.fn() };
    vi.spyOn(p, "connect").mockResolvedValue(conn as unknown as Connection);
    await P8(p);
    const wrong = boot.mock.calls[0]![0];
    expect(wrong).toMatch(/^probe-invalid-/);
    expect(wrong).not.toBe(credentials.appSecret);
    expect(JSON.parse(request.mock.calls[0]![2]!.body as string).app_secret).toBe(wrong);
    expect(p.credentials!.appSecret).toBe(credentials.appSecret);
    expect(JSON.stringify(p.report.facts.V11)).toContain("514");
    expect(JSON.stringify(p.report.facts.V11)).toContain("10003");
    expect(JSON.stringify(p.report)).not.toContain(wrong!);
    expect(isMessage({ envelope: envelope() } as any)).toBe(true);
  });
});

describe("plain-node CLI (no live network)", () => {
  it("prints help without disk writes and saves a partial 0600 report on Ctrl-C", async () => {
    const { mkdtemp, readdir, readFile, rm, stat, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join, resolve } = await import("node:path");
    const { spawn, spawnSync } = await import("node:child_process");
    const home = await mkdtemp(join(tmpdir(), "feishu-probe-cli-"));
    const cli = resolve("scripts/dev/feishu-probe.ts");
    // Even an accidental fetch/socket call in this child must never reach a tenant.
    const preload = join(home, "no-network.mjs");
    await writeFile(
      preload,
      'globalThis.fetch=async()=>{throw new Error("network forbidden")};globalThis.WebSocket=class {constructor(){throw new Error("network forbidden")}};',
    );
    try {
      const help = spawnSync(process.execPath, [cli, "--help"], {
        env: { ...process.env, HOME: home },
        encoding: "utf8",
        timeout: 5000,
      });
      expect(help.status).toBe(0);
      expect(help.stdout).toContain("--steps P1");
      expect(await readdir(home)).toEqual(["no-network.mjs"]);
      const invalid = spawnSync(process.execPath, [cli, "--steps", "P99"], {
        env: { ...process.env, HOME: home },
        encoding: "utf8",
        timeout: 5000,
      });
      expect(invalid.status).toBe(2);
      const child = spawn(process.execPath, ["--import", preload, cli, "--steps", "P2"], {
        env: { ...process.env, HOME: home },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "",
        errors = "",
        signalled = false;
      child.stderr.on("data", (b) => {
        errors += b.toString();
      });
      child.stdout.on("data", (b) => {
        output += b.toString();
        if (!signalled && output.includes("运行 P2")) {
          signalled = true;
          child.kill("SIGINT");
        }
      });
      const exit = await new Promise<number | null>((resolveExit, reject) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error("CLI did not terminate"));
        }, 5000);
        timer.unref();
        child.once("error", (e) => {
          clearTimeout(timer);
          reject(e);
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          resolveExit(code);
        });
      });
      expect(errors).toBe("");
      expect(exit).toBe(130);
      const dir = join(home, ".pi", "agent", "feishu-probe"),
        files = await readdir(dir);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^report-.*\.json$/);
      const file = join(dir, files[0]!);
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      const report = JSON.parse(await readFile(file, "utf8"));
      expect(report.interrupted).toBe(true);
      expect(report.live).toBe(false);
      expect(report.steps.P2.status).toBe("unknown");
      expect(report.untestedLive).toEqual(["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8"]);
      expect(report.facts.V7.status).toBe("unknown");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
