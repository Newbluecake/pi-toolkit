import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentFrame, HubFrame } from "../../../src/web-hub/protocol/messages.js";
import { NdjsonDecoder, encodeFrame } from "../../../src/web-hub/protocol/ndjson.js";
import type { HubConfig, HubEvent, HubLog } from "../../../src/web-hub/hub/ports.js";
import type { AgentConn, Registry } from "../../../src/web-hub/hub/registry.js";

/** Captured at import time so helpers keep working under vi.useFakeTimers(). */
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

export type Hello = Extract<AgentFrame, { t: "hello" }>;

export interface TmpDirs {
  make(prefix?: string): string;
  cleanup(): void;
}

export function tmpDirs(): TmpDirs {
  const dirs: string[] = [];
  return {
    make(prefix = "wh-b-") {
      const d = mkdtempSync(join(tmpdir(), prefix));
      dirs.push(d);
      return d;
    },
    cleanup() {
      for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    },
  };
}

export interface MemLog extends HubLog {
  lines: Array<{ level: string; msg: string; data?: object }>;
}

export function memLog(): MemLog {
  const lines: MemLog["lines"] = [];
  const push = (level: string) => (msg: string, data?: object) => {
    lines.push(data === undefined ? { level, msg } : { level, msg, data });
  };
  return { lines, info: push("info"), warn: push("warn"), error: push("error") };
}

export function hello(over: Partial<Hello> = {}): Hello {
  return {
    t: "hello",
    proto: { major: 1, minor: 0 },
    pluginVersion: "1.2.3",
    buildId: "1.2.3@abc",
    agentId: { pid: 4242, nonce: "nonceAAAAAAAAAAAAAAA" },
    epoch: "epoch-1",
    kind: "tui",
    launcher: ["/usr/bin/node", "/usr/bin/pi"],
    cwd: "/tmp/work",
    caps: ["ev.v1"],
    ...over,
  };
}

export interface FakeConn extends AgentConn {
  sent: HubFrame[];
  closedWith: string[];
}

export function fakeConn(): FakeConn {
  const sent: HubFrame[] = [];
  const closedWith: string[] = [];
  return {
    sent,
    closedWith,
    send: (f) => {
      sent.push(f);
    },
    close: (r) => {
      closedWith.push(r);
    },
  };
}

export function recordBus(registry: Registry): HubEvent[] {
  const events: HubEvent[] = [];
  registry.bus.subscribe((e) => events.push(e));
  return events;
}

export function config(over: Partial<HubConfig> = {}): HubConfig {
  return {
    v: 1,
    home: "/tmp/none",
    port: 0,
    idleExitMinutes: 10,
    pluginVersion: "1.2.3",
    buildId: "1.2.3@abc",
    ...over,
  };
}

/** Minimal agent-side client over a real unix socket for agent-server tests. */
export interface TestClient {
  sock: net.Socket;
  frames: unknown[];
  send(frame: object): void;
  raw(text: string): void;
  waitFrame(pred: (f: Record<string, unknown>) => boolean, ms?: number): Promise<Record<string, unknown>>;
  closed: Promise<void>;
}

export function connectClient(socketPath: string): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(socketPath);
    const frames: unknown[] = [];
    const waiters: Array<{
      pred: (f: Record<string, unknown>) => boolean;
      resolve: (f: Record<string, unknown>) => void;
    }> = [];
    const decoder = new NdjsonDecoder({
      onFrame: (v) => {
        frames.push(v);
        const f = v as Record<string, unknown>;
        for (const w of [...waiters]) {
          if (w.pred(f)) {
            waiters.splice(waiters.indexOf(w), 1);
            w.resolve(f);
          }
        }
      },
      onError: () => {},
    });
    sock.on("data", (c) => decoder.push(c));
    sock.on("error", () => {});
    const closed = new Promise<void>((r) => sock.once("close", () => r()));
    sock.once("error", reject);
    sock.once("connect", () => {
      sock.removeListener("error", reject);
      resolve({
        sock,
        frames,
        closed,
        send: (f) => {
          sock.write(encodeFrame(f));
        },
        raw: (t) => {
          sock.write(t);
        },
        waitFrame: (pred, ms = 3000) =>
          new Promise((res, rej) => {
            const hit = (frames as Array<Record<string, unknown>>).find(pred);
            if (hit !== undefined) {
              res(hit);
              return;
            }
            const timer = realSetTimeout(() => rej(new Error("waitFrame timeout")), ms);
            waiters.push({
              pred,
              resolve: (f) => {
                realClearTimeout(timer);
                res(f);
              },
            });
          }),
      });
    });
  });
}

export function sleepReal(ms: number): Promise<void> {
  return new Promise((r) => realSetTimeout(r, ms));
}

export function waitFor(cond: () => boolean, ms = 3000, stepMs = 5): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Number(process.hrtime.bigint() / 1_000_000n);
    const loop = (): void => {
      if (cond()) {
        resolve();
        return;
      }
      if (Number(process.hrtime.bigint() / 1_000_000n) - started > ms) {
        reject(new Error("waitFor timeout"));
        return;
      }
      realSetTimeout(loop, stepMs);
    };
    loop();
  });
}
