/** Actual resident SQLite child and its ORIGINAL 8s IPC deadline. Either discard
 * one original request (no commit) or one REAL successful reply (commit happened).
 * No auth success is mocked; true hub restart reopens unchanged original state.
 */
import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { terminalV2AuthFixture } from "./helpers/terminal-v2-auth-fixture.js";
import { rawRequest } from "../web-hub/http/helpers.js";
import { lanRequest } from "../web-hub/http/lan-helpers.js";
import { DEFAULT_DEADLINE_MS } from "../../src/web-hub/hub/db-client.js";
const wire = vi.hoisted(() => ({
  fault: undefined as
    | undefined
    | {
        dbFile: string;
        mode: "drop-reply" | "drop-request";
        id?: number;
        matched: boolean;
        successfulReply: boolean;
      },
}));
vi.mock("../../src/web-hub/hub/lan-store.js", async (original) => {
  const actual = await original<typeof import("../../src/web-hub/hub/lan-store.js")>();
  return {
    ...actual,
    createLanStore: (deps: Parameters<typeof actual.createLanStore>[0]) =>
      actual.createLanStore({
        ...deps,
        dbClient: {
          ...deps.dbClient,
          spawnFn: ((...args: Parameters<typeof spawn>) => {
            const child = spawn(...args) as import("node:child_process").ChildProcessWithoutNullStreams;
            const write = child.stdin.write.bind(child.stdin);
            child.stdin.write = ((chunk: any, ...rest: any[]) => {
              const fault = wire.fault;
              if (fault?.dbFile === deps.dbFile && !fault.matched) {
                const frame = JSON.parse(String(chunk));
                if (frame.op === "deleteSession") {
                  fault.matched = true;
                  fault.id = frame.id;
                  if (fault.mode === "drop-request") return true; // actual original child NEVER receives this op
                }
              }
              return Reflect.apply(write, child.stdin, [chunk, ...rest]);
            }) as typeof child.stdin.write;
            const on = child.stdout.on.bind(child.stdout);
            child.stdout.on = ((event: string, callback: any) => {
              if (event !== "data") return on(event, callback);
              let buffer = Buffer.alloc(0);
              return on("data", (chunk: Buffer) => {
                buffer = Buffer.concat([buffer, chunk]);
                let index;
                while ((index = buffer.indexOf(10)) >= 0) {
                  const line = buffer.subarray(0, index + 1);
                  buffer = buffer.subarray(index + 1);
                  const fault = wire.fault,
                    frame = JSON.parse(line.toString("utf8"));
                  if (fault?.dbFile === deps.dbFile && fault.mode === "drop-reply" && frame.id === fault.id) {
                    fault.successfulReply = frame.ok === true;
                    continue; // lose ONLY the original real commit reply
                  }
                  callback(line);
                }
              });
            }) as typeof child.stdout.on;
            return child;
          }) as typeof spawn,
        },
      }),
  };
});
const closers: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  wire.fault = undefined;
  for (const close of closers.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const cases = [true, false].flatMap((enabled) =>
  [false, true].flatMap((corrupt) => ["drop-reply", "drop-request"].map((mode) => ({ enabled, corrupt, mode }))),
) as Array<{ enabled: boolean; corrupt: boolean; mode: "drop-reply" | "drop-request" }>;
it.each(cases)(
  "A4/A6/A7 original deadline+restart terminal=$enabled corrupt=$corrupt $mode",
  async ({ enabled, corrupt, mode }) => {
    const h = await terminalV2AuthFixture(closers, corrupt, enabled, { retain: true }),
      oldCookie = h.lanCookie;
    const before = readFileSync(`${h.state}/terminal-v2/ledger.json`),
      fault = { dbFile: h.hub.paths.dbFile, mode, matched: false, successfulReply: false };
    wire.fault = fault;
    const start = Date.now();
    const failed = await rawRequest(h.lanPort, {
      method: "POST",
      path: "/api/logout",
      timeoutMs: 20000,
      headers: { ...h.lanHeaders, Cookie: oldCookie, "X-PWH": "1", "Content-Type": "application/json" },
      body: "{}",
    });
    expect(Date.now() - start).toBeGreaterThanOrEqual(DEFAULT_DEADLINE_MS - 100);
    expect(failed.status).toBe(503);
    expect(JSON.parse(failed.body)).toEqual({ error: "E_DB", effect: "unknown", localSignedOut: true });
    expect(failed.headers["set-cookie"]![0]).toContain("Max-Age=0");
    expect(fault.matched).toBe(true);
    expect(fault.successfulReply).toBe(mode === "drop-reply"); // observed ORIGINAL child success, not a generated JSON fact
    expect(readFileSync(`${h.state}/terminal-v2/ledger.json`)).toEqual(before);
    wire.fault = undefined;
    const restarted = await h.restart();
    expect(readFileSync(`${h.state}/terminal-v2/ledger.json`)).toEqual(before);
    const auth = await lanRequest(restarted.lanPort, {
      method: "GET",
      path: "/api/lan/sessions",
      headers: { ...restarted.lanHeaders, Cookie: oldCookie, "X-PWH": "1" },
    });
    expect(auth.status).toBe(mode === "drop-reply" ? 401 : 200); // original DB truth survives restart; no terminal auth replay
    expect(readdirSync(restarted.state).filter((name) => /terminal.*auth|auth.*terminal/i.test(name))).toEqual([]);
    expect(restarted.backendCalls).toBe(0);
  },
  30000,
);
