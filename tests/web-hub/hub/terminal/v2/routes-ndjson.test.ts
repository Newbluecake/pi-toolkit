import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { terminalNdjsonSinkV2 } from "../../../../../src/web-hub/hub/terminal/v2/ndjson.js";
import { terminalRouteAuditV2, type TerminalRouteAuditV2 } from "../../../../../src/web-hub/hub/terminal/v2/audit.js";
function transport(accept = false) {
  const req = new EventEmitter();
  const res = new EventEmitter();
  const writes: string[] = [];
  const callbacks: Array<(error?: Error | null) => void> = [];
  Object.assign(res, {
    destroyed: false,
    writableEnded: false,
    writableLength: 0,
    write: vi.fn((line: string, callback: (error?: Error | null) => void) => {
      writes.push(line);
      callbacks.push(callback);
      return accept;
    }),
    destroy: vi.fn(() => {
      res.emit("close");
    }),
  });
  const close = vi.fn();
  const sink = terminalNdjsonSinkV2(req as IncomingMessage, res as ServerResponse, close);
  return { req, res, sink, writes, callbacks, close };
}
describe("terminal v2 response-local queue and audit", () => {
  it("write=false waits for BOTH callback and drain, in FIFO; no end/gzip/shared sink", () => {
    const t = transport();
    expect(t.sink.send({ t: "ping" })).toBe(true);
    expect(t.sink.send({ t: "ready", offset: 3 })).toBe(true);
    expect(t.writes).toEqual(['{"t":"ping"}\n']);
    t.callbacks.shift()!();
    expect(t.writes).toHaveLength(1);
    t.res.emit("drain");
    expect(t.writes).toEqual(['{"t":"ping"}\n', '{"t":"ready","offset":3}\n']);
    t.sink.close();
    t.sink.close();
    expect(t.close).toHaveBeenCalledOnce();
    expect(t.res.listenerCount("drain")).toBe(0);
    expect(t.req.listenerCount("aborted")).toBe(0);
    t.callbacks.shift()!();
    expect(t.writes).toHaveLength(2);
    expect(t.sink.send({ t: "ping" })).toBe(false);
  });
  it("drain cannot skip an unfinished write callback; errors close only this response", () => {
    const slow = transport();
    const healthy = transport(true);
    slow.sink.send({ t: "ping" });
    slow.sink.send({ t: "ready", offset: 0 });
    slow.res.emit("drain");
    expect(slow.writes).toHaveLength(1);
    slow.callbacks.shift()!(new Error("write fault"));
    expect(slow.close).toHaveBeenCalledOnce();
    expect(healthy.sink.send({ t: "ping" })).toBe(true);
    expect(healthy.close).not.toHaveBeenCalled();
    healthy.sink.close();
  });
  it("raw64KiB/128control items are hard caps including in-flight frame; late callbacks do not revive", () => {
    const raw = transport();
    for (let i = 0; i < 8; i++)
      expect(raw.sink.send({ t: "output", offset: i * 8192, bytesB64: Buffer.alloc(8192).toString("base64") })).toBe(
        true,
      );
    expect(raw.sink.send({ t: "output", offset: 65_536, bytesB64: "YQ==" })).toBe(false);
    expect(raw.close).toHaveBeenCalledOnce();
    raw.callbacks.shift()!();
    raw.res.emit("drain");
    expect(raw.writes).toHaveLength(1);
    const controls = transport();
    for (let i = 0; i < 128; i++) expect(controls.sink.send({ t: "ping" })).toBe(true);
    expect(controls.sink.send({ t: "ping" })).toBe(false);
    expect(controls.close).toHaveBeenCalledOnce();
  });
  it("secret-free finite audit records aggregate keystrokes, globally rate-limit and fail-soft", () => {
    let now = 0;
    const records: Readonly<TerminalRouteAuditV2>[] = [];
    const audit = terminalRouteAuditV2(
      () => now,
      (record) => {
        records.push(record);
      },
    );
    for (let i = 0; i < 1000; i++) audit.record("input", "lan", now);
    expect(records).toEqual([]);
    now = 60_000;
    audit.record("input", "lan", now);
    expect(records).toEqual([{ op: "aggregate", listener: "lan", ok: true, ms: 0, n: 1000 }]);
    for (let i = 0; i < 1000; i++) audit.record("create", "lan", now, "E_RESOURCE_UNAVAILABLE");
    expect(records).toHaveLength(8);
    expect(Object.keys(records[1]!).sort()).toEqual(["code", "listener", "ms", "n", "ok", "op"]);
    const throwing = terminalRouteAuditV2(
      () => now,
      () => {
        throw new Error("logger fault");
      },
    );
    throwing.record("create", "loopback", now);
    expect(throwing.failures()).toBe(1);
    audit.dispose();
    throwing.dispose();
  });
});
