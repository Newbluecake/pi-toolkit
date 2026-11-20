/** A11: original real auth + actual55s timers, independent private/public transports.
 * Failure seam loses original REAL lookup results, never synthesizes auth success.
 * Hard-expiry is an explicit owned SQLite timestamp fixture, not fake wall clock.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { request, type IncomingMessage } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { terminalV2AuthFixture } from "./helpers/terminal-v2-auth-fixture.js";
import { openTerminalTestView } from "./helpers/terminal-v2-view.js";
import { DbClientError } from "../../src/web-hub/hub/db-client.js";
import type { LanStore } from "../../src/web-hub/hub/lan-store.js";
import { hashSid } from "../../src/web-hub/hub/sid-hash.js";
import { login } from "../web-hub/http/helpers.js";
const closers: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("actual authority wait deadline")), ms);
    timer.unref();
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
async function publicLan(h: Awaited<ReturnType<typeof terminalV2AuthFixture>>) {
  const res = await new Promise<IncomingMessage>((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: h.lanPort,
        path: "/api/events",
        headers: { ...h.lanHeaders, Cookie: h.lanCookie, Accept: "text/event-stream" },
      },
      resolve,
    );
    req.once("error", reject);
    req.end();
  });
  expect(res.statusCode).toBe(200);
  res.on("data", () => {});
  closers.push(() => {
    res.destroy();
  });
  return res;
}
async function nativeView(h: Awaited<ReturnType<typeof terminalV2AuthFixture>>) {
  const list = await h.loop("list", { scope: h.scope }),
    envelope = { scope: h.scope, hubInstance: list.body.hubInstance };
  const created = await h.loop("create", {
    ...envelope,
    requestId: "a".repeat(24),
    mode: "ensure-empty",
    cols: 80,
    rows: 24,
  });
  expect(created.body.ok).toBe(true);
  const term = { ...envelope, termId: created.body.termId },
    stream = await openTerminalTestView(closers, h.lanPort, h.lanCookie, term, h.lanHeaders);
  const attached = await stream.next((f) => f.t === "attached");
  if (attached.t !== "attached") throw new Error("missing attached");
  const writer = { ...term, viewId: attached.viewId };
  let offset = attached.start,
    chain = Promise.resolve();
  const failures: unknown[] = [];
  stream.subscribe((frame) => {
    let complete = false;
    if (frame.t === "output") offset = Math.max(offset, frame.offset + Buffer.from(frame.bytesB64, "base64").length);
    else if (frame.t === "replay-end") {
      offset = Math.max(offset, frame.offset);
      complete = true;
    } else if (frame.t !== "ping") return;
    const payload = { ...writer, offset, ...(complete ? { replayComplete: true } : {}) };
    chain = chain
      .then(async () => {
        if (stream.response.destroyed) return;
        const ack = await h.lan("ack", payload);
        if (ack.status !== 200) failures.push(ack);
      })
      .catch((err) => {
        failures.push(err);
      });
  });
  await stream.next((f) => f.t === "ready");
  return { stream, term, writer, failures, closedAt: stream.closed.then(() => Date.now()) };
}
it.each([false, true])(
  "A11 actual55s original lookup failure: private detaches, public keeps; corrupt ledger=%s",
  async (corrupt) => {
    const h = await terminalV2AuthFixture(closers, corrupt, true, { retain: true }),
      pub = await publicLan(h);
    // The metadata responder is not an SDK. Keep its REAL UDS peer alive with
    // original protocol pings; a30s silence disconnect would cause ordinary
    // scope cleanup, not prove the independent55s auth check.
    const heartbeat = setInterval(() => h.agent.send({ t: "ping", ts: Date.now() }), 10000);
    heartbeat.unref();
    closers.push(() => {
      clearInterval(heartbeat);
    });
    // Isolate the one-shot ordinary lookup fault BEFORE starting the private ACK
    // producer. NDJSON ready does not drain its HTTP ACK chain, and same-SID
    // requests share an in-flight touch: an ACK could consume this fault or let
    // list reuse a healthy pre-fault lookup instead of exercising E_DB.
    const originalTouch = h.authStore.touchSession.bind(h.authStore);
    const fail = vi.spyOn(h.authStore, "touchSession").mockImplementationOnce(async (...args) => {
      await originalTouch(...args);
      throw new DbClientError("E_DB", "lost original lookup reply");
    });
    const denied = await h.lan("list", { scope: h.scope });
    expect(denied.status).toBe(503);
    expect(denied.body.code).toBe("E_DB");
    expect(fail).toHaveBeenCalled();
    expect(fail).toHaveBeenCalledTimes(1);
    fail.mockRestore();
    const live = corrupt ? undefined : await nativeView(h),
      ledger = readFileSync(`${h.state}/terminal-v2/ledger.json`);
    // Heartbeat ACKs still use actual normal authentication. ONLY the original
    // reserved expiry-query results are lost, so the real55s check is causal,
    // not an earlier15s missing-heartbeat detach masquerading as revalidation.
    const store = h.authStore as LanStore,
      actual = store.touchSessionReserved.bind(store);
    let queries = 0,
      signal!: () => void;
    const checked = new Promise<void>((r) => {
      signal = r;
    });
    const start = Date.now();
    vi.spyOn(store, "touchSessionReserved").mockImplementation(async (...args) => {
      await actual(...args);
      queries++;
      signal();
      throw new DbClientError("E_DB", "lost original reserved lookup reply");
    });
    await bounded(checked, 70000);
    if (live) await bounded(live.stream.closed, 10000);
    expect(Date.now() - start).toBeGreaterThanOrEqual(54000);
    expect(queries).toBeGreaterThanOrEqual(live ? 2 : 1);
    if (live) {
      expect((await live.closedAt) - start).toBeGreaterThanOrEqual(54000);
      expect(live.stream.response.destroyed).toBe(true);
      expect(live.failures).toEqual([]);
      expect(h.service.maintenanceSnapshot().allocationCount).toBe(1);
    }
    expect(pub.destroyed).toBe(false);
    expect(pub.readableEnded).toBe(false);
    expect(readFileSync(`${h.state}/terminal-v2/ledger.json`)).toEqual(ledger);
    expect((await login(h.hub.httpPort, h.hub.paths.tokenFile)).length).toBeGreaterThan(0); // other listener's actual authority unaffected
  },
  90000,
);
it("A11 actual LAN parent hard-expiry detaches before55s without waiting for revalidation", async () => {
  const h = await terminalV2AuthFixture(closers, false, true, { retain: true });
  const tag = hashSid(h.lanCookie.slice(h.lanCookie.indexOf("=") + 1)),
    expiresAt = Date.now() + 3500;
  const script = `const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);const result=db.prepare('UPDATE sessions SET absolute_expires_at=? WHERE sid_hash=?').run(Number(process.argv[3]),Buffer.from(process.argv[2],'base64url'));if(result.changes!==1)throw new Error('owned expiry fixture did not select one original SID');db.close();`;
  execFileSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", "-e", script, h.hub.paths.dbFile, tag, String(expiresAt)],
    { stdio: "pipe" },
  );
  const live = await nativeView(h),
    ledger = readFileSync(`${h.state}/terminal-v2/ledger.json`);
  await bounded(live.stream.closed, 7000);
  expect(Date.now()).toBeGreaterThanOrEqual(expiresAt - 20);
  expect(live.stream.response.destroyed).toBe(true);
  expect(h.service.maintenanceSnapshot().allocationCount).toBe(1);
  expect(readFileSync(`${h.state}/terminal-v2/ledger.json`)).toEqual(ledger);
  expect((await h.lan("list", { scope: h.scope })).status).toBe(401);
  expect((await h.loop("list", { scope: h.scope })).status).toBe(200);
}, 15000);
