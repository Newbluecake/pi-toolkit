/** Bounded private loopback clients for the fixed controlled rehearsal only. No CLI
 * host, URL, token, command or cookie input. Secrets stay in memory, not reports.
 */
import { request } from "node:http";
import { readFileSync } from "node:fs";
export async function privatePost(
  port: number,
  path: string,
  body: unknown,
  cookie?: string,
): Promise<{ status: number; body: any; cookie?: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        agent: false,
        headers: {
          "Content-Type": "application/json",
          "X-PWH": "1",
          Origin: `http://127.0.0.1:${port}`,
          ...(cookie ? { Cookie: cookie } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 256 * 1024) res.destroy(new Error("private response capacity"));
          else chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          clearTimeout(timer);
          try {
            const cookie = res.headers["set-cookie"]?.[0]?.split(";")[0];
            resolve({
              status: res.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString()),
              ...(cookie ? { cookie } : {}),
            });
          } catch {
            reject(new Error("private response JSON"));
          }
        });
      },
    );
    const timer = setTimeout(() => req.destroy(new Error("private request deadline")), 8000);
    timer.unref();
    req.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    req.end(JSON.stringify(body));
  });
}
export async function privateLogin(port: number, tokenFile: string): Promise<string> {
  const result = await privatePost(port, "/api/login", { token: readFileSync(tokenFile, "utf8").trim() });
  if (result.status !== 200 || !result.cookie) throw new Error("real private login failed");
  return result.cookie;
}
export interface PrivateEvent {
  event: string;
  data: any;
}
export interface PrivateSse {
  events: PrivateEvent[];
  wait(predicate: (event: PrivateEvent) => boolean): Promise<PrivateEvent>;
  close(): void;
}
export async function privateSse(port: number, cookie: string): Promise<PrivateSse> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port,
      path: "/api/events",
      agent: false,
      headers: { Cookie: cookie, Accept: "text/event-stream" },
    });
    const startTimer = setTimeout(() => req.destroy(new Error("private SSE startup deadline")), 8000);
    startTimer.unref();
    req.on("error", (error) => {
      clearTimeout(startTimer);
      reject(error);
    });
    req.on("response", (res) => {
      clearTimeout(startTimer);
      if (res.statusCode !== 200) {
        res.destroy();
        reject(new Error("private SSE auth"));
        return;
      }
      const events: PrivateEvent[] = [],
        listeners = new Set<() => void>();
      let buffer = "",
        ended = false;
      const notify = () => {
        for (const listener of listeners) listener();
      };
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        if (buffer.length > 1024 * 1024 || events.length >= 256) {
          res.destroy(new Error("private SSE capacity"));
          return;
        }
        let end;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const name =
            block
              .split("\n")
              .find((line) => line.startsWith("event: "))
              ?.slice(7) ?? "message";
          const data = block
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => line.slice(6))
            .join("\n");
          if (data) {
            try {
              events.push({ event: name, data: JSON.parse(data) });
            } catch {
              res.destroy(new Error("private SSE JSON"));
            }
          }
        }
        notify();
      });
      const end = () => {
        ended = true;
        notify();
      };
      res.on("end", end);
      res.on("close", end);
      res.on("error", end);
      resolve({
        events,
        close: () => req.destroy(),
        wait: (predicate) =>
          new Promise((resolve, reject) => {
            const finish = (error?: Error, event?: PrivateEvent) => {
              clearTimeout(timer);
              listeners.delete(check);
              if (error) reject(error);
              else resolve(event!);
            };
            const check = () => {
              const hit = events.find(predicate);
              if (hit) finish(undefined, hit);
              else if (ended) finish(new Error("private SSE ended"));
            };
            const timer = setTimeout(() => finish(new Error("private SSE event deadline")), 8000);
            timer.unref();
            listeners.add(check);
            check();
          }),
      });
    });
    req.end();
  });
}
/** Bounded observation of actual IO/component state; no inferred success at timeout. */
export async function observeUntil<T>(
  observe: () => Promise<T>,
  accept: (value: T) => boolean,
  timeoutMs = 12000,
): Promise<T> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = await observe();
    if (accept(value)) return value;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 50);
      timer.unref();
    });
  }
  throw new Error("actual component observation deadline");
}

export async function privateTerminalView(
  port: number,
  cookie: string,
  body: object,
): Promise<{
  wait(predicate: (frame: any) => boolean): Promise<any>;
  close(): void;
}> {
  const { NdjsonDecoder } = await import("../../../src/web-hub/protocol/ndjson.js");
  const { terminalViewFrameV2Ok } = await import("../../../src/web-hub/protocol/terminal-v2.js");
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port,
      path: "/api/terminal/v2/view",
      method: "POST",
      agent: false,
      headers: { Cookie: cookie, Origin: `http://127.0.0.1:${port}`, "X-PWH": "1", "Content-Type": "application/json" },
    });
    const start = setTimeout(() => req.destroy(new Error("private view startup deadline")), 8000);
    start.unref();
    req.on("error", (error) => {
      clearTimeout(start);
      reject(error);
    });
    req.on("response", (res) => {
      clearTimeout(start);
      if (res.statusCode !== 200 || res.headers["content-encoding"] !== "identity") {
        res.destroy();
        reject(new Error("private view auth/encoding"));
        return;
      }
      const frames: unknown[] = [],
        listeners = new Set<() => void>();
      let ended = false;
      const notify = () => {
        for (const listener of listeners) listener();
      };
      const decoder = new NdjsonDecoder({
        onFrame(raw) {
          if (!terminalViewFrameV2Ok(raw) || frames.length >= 256) {
            res.destroy(new Error("private view invalid/capacity"));
            return;
          }
          frames.push(raw);
          notify();
        },
        onError() {
          res.destroy(new Error("private view malformed"));
        },
      });
      res.on("data", (chunk: Buffer) => decoder.push(chunk));
      const end = () => {
        ended = true;
        notify();
      };
      res.on("end", end);
      res.on("close", end);
      res.on("error", end);
      resolve({
        close: () => req.destroy(),
        wait: (predicate) =>
          new Promise((resolve, reject) => {
            const finish = (error?: Error, frame?: unknown) => {
              clearTimeout(timer);
              listeners.delete(check);
              if (error) reject(error);
              else resolve(frame);
            };
            const check = () => {
              const frame = frames.find(predicate);
              if (frame) finish(undefined, frame);
              else if (ended) finish(new Error("private view ended"));
            };
            const timer = setTimeout(() => finish(new Error("private view frame deadline")), 8000);
            timer.unref();
            listeners.add(check);
            check();
          }),
      });
    });
    req.end(JSON.stringify(body));
  });
}
