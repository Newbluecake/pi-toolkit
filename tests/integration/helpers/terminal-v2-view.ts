/** Real independent HTTP NDJSON transport; no view/auth/proof mocks. */
import { request, type IncomingMessage } from "node:http";
import { expect } from "vitest";
import { NdjsonDecoder } from "../../../src/web-hub/protocol/ndjson.js";
import type { TerminalViewFrameV2 } from "../../../src/web-hub/protocol/terminal-v2.js";
export async function openTerminalTestView(
  closers: Array<() => void | Promise<void>>,
  port: number,
  cookie: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/api/terminal/v2/view",
        method: "POST",
        agent: false,
        headers: {
          Cookie: cookie,
          Origin: `http://127.0.0.1:${port}`,
          "X-PWH": "1",
          "Content-Type": "application/json",
          ...headers,
        },
      },
      resolve,
    );
    req.once("error", reject);
    req.end(JSON.stringify(body));
  });
  closers.push(() => {
    response.destroy();
  });
  expect(response.statusCode).toBe(200);
  const frames: TerminalViewFrameV2[] = [],
    listeners = new Set<(f: TerminalViewFrameV2) => void>();
  const closed = new Promise<void>((r) => response.once("close", () => r()));
  const decoder = new NdjsonDecoder({
    onFrame(raw) {
      const f = raw as TerminalViewFrameV2;
      frames.push(f);
      for (const listener of listeners) listener(f);
    },
    onError() {
      throw new Error("invalid actual private NDJSON");
    },
  });
  response.on("data", (chunk: Buffer) => decoder.push(chunk));
  const subscribe = (callback: (frame: TerminalViewFrameV2) => void) => {
    listeners.add(callback);
    for (const frame of frames) callback(frame);
    return () => {
      listeners.delete(callback);
    };
  };
  const next = (predicate: (f: TerminalViewFrameV2) => boolean, ms = 5000) =>
    new Promise<TerminalViewFrameV2>((resolve, reject) => {
      const check = (frame: TerminalViewFrameV2) => {
        if (predicate(frame)) {
          clearTimeout(timer);
          listeners.delete(check);
          resolve(frame);
        }
      };
      const timer = setTimeout(() => {
        listeners.delete(check);
        reject(new Error("actual private frame timeout"));
      }, ms);
      timer.unref();
      listeners.add(check);
      for (const frame of frames) check(frame);
    });
  return { response, frames, closed, subscribe, next };
}
