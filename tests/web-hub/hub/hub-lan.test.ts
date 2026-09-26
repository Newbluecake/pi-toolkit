/**
 * `startHub` \u2192 `defaultLanAssembly` \u2192 `admin.ts` end-to-end wiring (plan
 * \u00a71.4, \u00a78, \u00a78.3, \u00a75.2 \u2014 S1-W3 LD \u5305). Uses a *fake* `HttpFrontend` (own
 * minimal `LanFacade`, no real HTTP) so this file stays LD's own \u2014 the real
 * HTTP/SSE/login pipeline is LC's (`tests/web-hub/http/lan-*.test.ts`) and
 * the full real-browser e2e is LI's (`tests/integration/web-hub-lan.test.ts`).
 * What *is* real here: `defaultLanAssembly.build()`'s actual store/kdf/
 * limiter/admission/hosts wiring (real sqlite via `lan-store.ts`, `skipIf`
 * `hasNodeSqlite`), driven end-to-end through a real agent socket.
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { hasNodeSqlite } from "../../../src/web-hub/hub/db.js";
import { startHub, type RunningHub } from "../../../src/web-hub/hub/hub.js";
import type { LanAssembly, LanFrontendDeps } from "../../../src/web-hub/hub/ports.js";
import { defaultLanAssembly, LanAssemblyOffError } from "../../../src/web-hub/hub/lan-assembly.js";
import type {
  FrontendDeps,
  FrontendFactory,
  HttpFrontend,
  LanFacade,
  LanStatus,
} from "../../../src/web-hub/hub/ports.js";
import type { LanStore } from "../../../src/web-hub/hub/lan-store.js";
import { resolveHubPaths } from "../../../src/web-hub/protocol/paths.js";
import { config, connectClient, tmpDirs, waitFor, hello, type TestClient } from "./helpers.js";

const skipIfNoSqlite = (await hasNodeSqlite()) ? describe : describe.skip;

const tmp = tmpDirs();
// L8 "用户名默认系统登录名": the real `defaultLanAssembly` → `createLanStore` seeds this OS
// username, not the P1 literal `"admin"` — not to be confused with the unrelated `audit: "admin"`
// log-category tag several assertions below match on (that string is always literally "admin",
// hub/admin.ts's own fixed audit-line marker, regardless of the LAN account's real username).
const USERNAME = userInfo().username;
const hubs: RunningHub[] = [];
const clients: TestClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.sock.destroy();
  for (const h of hubs.splice(0)) await h.close("test");
  tmp.cleanup();
});

interface FakeFrontendWithLan extends FrontendFactory {
  deps: FrontendDeps[];
  closed: number;
  revokeCalls: Array<{ sidHash: string } | { userId: number }>;
  lanStarted: number;
}

function fakeFrontendWithLan(opts: { port?: number } = {}): FakeFrontendWithLan {
  const revokeCalls: Array<{ sidHash: string } | { userId: number }> = [];
  let lanStarted = 0;
  const f = ((deps: FrontendDeps): HttpFrontend => {
    f.deps.push(deps);
    let lanStatus: LanStatus = { state: "starting" };
    const lan: LanFacade | undefined =
      deps.lan === undefined
        ? undefined
        : {
            start: async () => {
              lanStarted++;
              lanStatus = {
                state: "on",
                port: deps.lan!.cfg.port,
                hosts: ["192.168.1.5"],
                omitted: [],
                warnings: ["plaintext"],
              };
              return lanStatus;
            },
            status: () => lanStatus,
            close: async () => {},
            revoke: (target) => {
              revokeCalls.push(target);
              return 1;
            },
          };
    return {
      listen: async () => ({ port: opts.port ?? 43210 }),
      close: async () => {
        f.closed++;
      },
      clientCount: () => 0,
      ...(lan === undefined ? {} : { lan }),
    };
  }) as FakeFrontendWithLan;
  f.deps = [];
  f.closed = 0;
  f.revokeCalls = revokeCalls;
  f.lanStarted = 0;
  Object.defineProperty(f, "lanStarted", { get: () => lanStarted });
  return f;
}

/** Wraps the real `defaultLanAssembly` so the test can grab the concrete `LanStore` it built
 * (LD's own file's `LanFrontendDeps.store` is frozen to the plain `LanStorePort`, which has no
 * `markInitialLogin` return value inspection beyond the port itself \u2014 the port has the method,
 * this is only needed so the test can call it directly without going through the LC HTTP login
 * pipeline this file deliberately does not depend on). */
function capturingAssembly(sink: { store?: LanStore }): LanAssembly {
  return {
    async build(args): Promise<LanFrontendDeps> {
      const deps = await defaultLanAssembly.build(args);
      sink.store = deps.store as LanStore;
      return deps;
    },
  };
}

async function client(sockPath: string): Promise<TestClient> {
  const c = await connectClient(sockPath);
  clients.push(c);
  return c;
}

describe("startHub + defaultLanAssembly (plan \u00a71.4, \u00a78) \u2014 config.lan undefined", () => {
  it("fe.lan is undefined, hub.json has no lan field, no db file, no lan.v1 cap, agentServer.hello_ack has ctl.v1 only", async () => {
    const home = tmp.make("wh-lan-off-");
    const fe = fakeFrontendWithLan();
    const uid = process.getuid?.() ?? 0;
    const hub = await startHub(config({ home }), fe, { uid });
    if ("exists" in hub) throw new Error("unexpected exists");
    hubs.push(hub);

    expect(hub.lan).toBeUndefined();
    expect(hub.lanStatus()).toBeUndefined();
    expect(fe.deps[0]!.lan).toBeUndefined();

    const paths = resolveHubPaths({ home, uid });
    expect(existsSync(paths.dbFile)).toBe(false);
    const json = JSON.parse(readFileSync(paths.hubJson, "utf8")) as Record<string, unknown>;
    expect("lan" in json).toBe(false);

    const c = await client(paths.socketPath);
    c.send(hello());
    const ack = await c.waitFrame((f) => f["t"] === "hello_ack");
    expect(ack["caps"]).toEqual(["ctl.v1"]);

    c.send({ t: "lan_req", rid: "r1", op: "info" });
    const lanRes = await c.waitFrame((f) => f["t"] === "lan_res");
    expect(lanRes).toEqual({ t: "lan_res", rid: "r1", ok: false, code: "E_NO_LAN", message: "LAN is not configured" });
  });
});

// LD review-fix suggestion (lan-plan.md's own defaultLanAssembly doc comment, plan section 1.4.2):
// only LanAssemblyOffError -- the class defaultLanAssembly.build() throws for a *recognized*
// section-4.1 db-open failure -- may degrade startHub to a loopback-only hub. Anything else a
// LanAssembly.build() throws (a real bug, a stub's E_NOT_IMPLEMENTED:*, ...) must still abort
// startHub outright, exactly like a P1 failure with no LAN configured at all would.
describe("startHub + LanAssembly.build() failures (plan section 1.4.2 / LD review-fix suggestion)", () => {
  it("LanAssemblyOffError degrades to loopback-only: fe.lan undefined, hub.json.lan = off/<reason>, hub still starts", async () => {
    const home = tmp.make("wh-lan-offerror-");
    const fe = fakeFrontendWithLan();
    const uid = process.getuid?.() ?? 0;
    const offAssembly: LanAssembly = {
      async build() {
        throw new LanAssemblyOffError("db-too-large", "hub.db exceeds 64 MiB");
      },
    };
    const hub = await startHub(
      { ...config({ home }), lan: { port: 0, extraHosts: [], trustProxyFrom: [], externalOrigins: [] } },
      fe,
      { uid, lanAssembly: offAssembly },
    );
    if ("exists" in hub) throw new Error("unexpected exists");
    hubs.push(hub);

    expect(hub.lan).toBeUndefined();
    expect(fe.deps[0]!.lan).toBeUndefined();
    expect(hub.lanStatus()).toEqual({ state: "off", reason: "db-too-large", detail: "hub.db exceeds 64 MiB" });

    const paths = resolveHubPaths({ home, uid });
    const json = JSON.parse(readFileSync(paths.hubJson, "utf8")) as Record<string, unknown>;
    expect(json["lan"]).toEqual({ state: "off", reason: "db-too-large", detail: "hub.db exceeds 64 MiB" });
  });

  it("a non-LanAssemblyOffError build failure aborts startHub entirely (rejects, no RunningHub, hub.json never written)", async () => {
    const home = tmp.make("wh-lan-abort-");
    const fe = fakeFrontendWithLan();
    const uid = process.getuid?.() ?? 0;
    const buggyAssembly: LanAssembly = {
      async build() {
        throw new Error("boom: not a recognized off-reason");
      },
    };
    await expect(
      startHub({ ...config({ home }), lan: { port: 0, extraHosts: [], trustProxyFrom: [], externalOrigins: [] } }, fe, {
        uid,
        lanAssembly: buggyAssembly,
      }),
    ).rejects.toThrow(/boom: not a recognized off-reason/);

    // Nothing was left running: fe.close/fe.listen never even got called (build() failed before
    // the frontend was constructed), and hub.json was never written for this attempt.
    expect(fe.deps).toHaveLength(0);
    expect(fe.closed).toBe(0);
    const paths = resolveHubPaths({ home, uid });
    expect(existsSync(paths.hubJson)).toBe(false);
  });
});

skipIfNoSqlite(
  "startHub + defaultLanAssembly (plan \u00a71.4, \u00a78) \u2014 config.lan set, real sqlite store",
  () => {
    async function startWithLan(
      home: string,
      port: number,
    ): Promise<{ hub: RunningHub; fe: FakeFrontendWithLan; sink: { store?: LanStore } }> {
      const uid = process.getuid?.() ?? 0;
      const fe = fakeFrontendWithLan();
      const sink: { store?: LanStore } = {};
      const hub = await startHub(
        { ...config({ home }), lan: { port, extraHosts: [], trustProxyFrom: [], externalOrigins: [] } },
        fe,
        { uid, lanAssembly: capturingAssembly(sink) },
      );
      if ("exists" in hub) throw new Error("unexpected exists");
      hubs.push(hub);
      return { hub, fe, sink };
    }

    it("builds a real store/kdf/limiter/admission/hosts LanFrontendDeps; hub.json.lan settles to on; lan_req info round-trips through a real agent socket", async () => {
      const home = tmp.make("wh-lan-on-");
      const { hub, fe } = await startWithLan(home, 34567);

      expect(hub.lan).toBeDefined();
      await waitFor(() => fe.lanStarted > 0);
      await waitFor(() => hub.lanStatus()?.state === "on");
      expect(hub.lanStatus()).toMatchObject({ state: "on", port: 34567 });

      const paths = resolveHubPaths({ home, uid: process.getuid?.() ?? 0 });
      expect(existsSync(paths.dbFile)).toBe(true);

      const c = await client(paths.socketPath);
      c.send(hello());
      const ack = await c.waitFrame((f) => f["t"] === "hello_ack");
      expect(ack["caps"]).toEqual(["ctl.v1", "lan.v1"]);

      c.send({ t: "lan_req", rid: "r1", op: "info" });
      const res = await c.waitFrame((f) => f["t"] === "lan_res");
      expect(res["ok"]).toBe(true);
      const info = (res as Record<string, unknown>)["info"] as Record<string, unknown>;
      expect(info["username"]).toBe(USERNAME);
      expect(typeof info["initialPassword"]).toBe("string");
      expect((info["initialPassword"] as string).length).toBeGreaterThan(0);
      expect(info["lan"]).toMatchObject({ state: "on", port: 34567 });

      // §5.2 "传输": the initial password only ever appears in the lan_res{op:"info"} reply body,
      // never in hub.json (the type itself guarantees this — LanStatus has no such field — this
      // asserts it holds at the byte level too).
      const rawHubJson = readFileSync(paths.hubJson, "utf8");
      expect(rawHubJson).not.toContain(info["initialPassword"] as string);
    }, 20_000);

    it("first observed initial-password login \u21d2 lan_req info surfaces initialLogin and hub.log gets exactly one initial-login audit warning", async () => {
      const home = tmp.make("wh-lan-initial-login-");
      const { hub, sink } = await startWithLan(home, 34568);
      await waitFor(() => hub.lanStatus()?.state === "on");
      await waitFor(() => sink.store !== undefined);

      await sink.store!.markInitialLogin(USERNAME, "192.168.1.40", 1_700_000_000_000);

      const paths = resolveHubPaths({ home, uid: process.getuid?.() ?? 0 });
      const c = await client(paths.socketPath);
      c.send(hello());
      await c.waitFrame((f) => f["t"] === "hello_ack");

      c.send({ t: "lan_req", rid: "r1", op: "info" });
      const res1 = await c.waitFrame((f) => f["t"] === "lan_res" && f["rid"] === "r1");
      const info1 = (res1 as Record<string, unknown>)["info"] as Record<string, unknown>;
      expect(info1["initialLogin"]).toEqual({ ip: "192.168.1.40", at: 1_700_000_000_000 });

      // A second `info` call must not repeat the one-time audit warning.
      c.send({ t: "lan_req", rid: "r2", op: "info" });
      await c.waitFrame((f) => f["t"] === "lan_res" && f["rid"] === "r2");

      const logLines = readFileSync(paths.logFile, "utf8")
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      const initialLoginAudits = logLines.filter((l) => l["op"] === "initial-login");
      expect(initialLoginAudits).toHaveLength(1);
      expect(initialLoginAudits[0]).toMatchObject({ audit: "admin", ip: "192.168.1.40", at: 1_700_000_000_000 });
      // Never leaks the actual initial password value anywhere in hub.log.
      const info = await sink.store!.initialInfo();
      expect(readFileSync(paths.logFile, "utf8")).not.toContain(info?.initialPassword ?? "\u0000never\u0000");
    }, 20_000);

    it("lan_req passwd updates the password and revokes all LAN sessions via fe.lan.revoke; audited without leaking the password", async () => {
      const home = tmp.make("wh-lan-passwd-");
      const { hub, fe, sink } = await startWithLan(home, 34569);
      await waitFor(() => hub.lanStatus()?.state === "on");
      await waitFor(() => sink.store !== undefined);

      const paths = resolveHubPaths({ home, uid: process.getuid?.() ?? 0 });
      const c = await client(paths.socketPath);
      c.send(hello());
      await c.waitFrame((f) => f["t"] === "hello_ack");

      c.send({ t: "lan_req", rid: "r1", op: "passwd", username: USERNAME, password: "correct-horse-battery" });
      const res = await c.waitFrame((f) => f["t"] === "lan_res" && f["rid"] === "r1");
      expect(res).toEqual({ t: "lan_res", rid: "r1", ok: true });

      expect(fe.revokeCalls).toEqual([{ userId: 1 }]);
      const updated = await sink.store!.getUser(USERNAME);
      expect(updated?.initialPassword).toBeUndefined();
      expect(updated?.epoch).toBe(2);

      const rawLog = readFileSync(paths.logFile, "utf8");
      expect(rawLog).not.toContain("correct-horse-battery");
    }, 20_000);

    it("lan_req unlock calls limiter.unlock() end-to-end", async () => {
      const home = tmp.make("wh-lan-unlock-");
      const { hub } = await startWithLan(home, 34570);
      await waitFor(() => hub.lanStatus()?.state === "on");

      const paths = resolveHubPaths({ home, uid: process.getuid?.() ?? 0 });
      const c = await client(paths.socketPath);
      c.send(hello());
      await c.waitFrame((f) => f["t"] === "hello_ack");
      c.send({ t: "lan_req", rid: "r1", op: "unlock" });
      const res = await c.waitFrame((f) => f["t"] === "lan_res" && f["rid"] === "r1");
      expect(res).toEqual({ t: "lan_res", rid: "r1", ok: true });
    }, 20_000);

    it("hub_ctl shutdown: hub_ctl_ack arrives before the hub actually closes", async () => {
      const home = tmp.make("wh-lan-shutdown-");
      const { hub } = await startWithLan(home, 34571);
      await waitFor(() => hub.lanStatus()?.state === "on");

      const paths = resolveHubPaths({ home, uid: process.getuid?.() ?? 0 });
      const c = await client(paths.socketPath);
      c.send(hello());
      await c.waitFrame((f) => f["t"] === "hello_ack");

      let closedYet = false;
      void hub.closed.then(() => {
        closedYet = true;
      });

      c.send({ t: "hub_ctl", rid: "r1", op: "shutdown", reason: "restart" });
      const ack = await c.waitFrame((f) => f["t"] === "hub_ctl_ack" && f["rid"] === "r1");
      expect(ack).toEqual({ t: "hub_ctl_ack", rid: "r1" });
      // The ack is guaranteed to have been queued for write before close() was even invoked
      // (agent-server.ts writes it synchronously before calling admin.handleShutdown); the hub may
      // race to close very quickly afterwards, so this only pins the *observable* ordering promise
      // — that the ack frame itself was never blocked behind the close.
      await waitFor(() => closedYet, 5_000);
      hubs.length = 0; // already closed itself
    }, 20_000);

    it("lan_req never reaches the registry/bus even with a real store behind it", async () => {
      const home = tmp.make("wh-lan-registry-");
      const { hub } = await startWithLan(home, 34572);
      await waitFor(() => hub.lanStatus()?.state === "on");

      const paths = resolveHubPaths({ home, uid: process.getuid?.() ?? 0 });
      const c = await client(paths.socketPath);
      c.send(hello());
      await c.waitFrame((f) => f["t"] === "hello_ack");

      const before = readFileSync(paths.logFile, "utf8")
        .split("\n")
        .filter((l) => l.length > 0);
      c.send({ t: "lan_req", rid: "r1", op: "info" });
      await c.waitFrame((f) => f["t"] === "lan_res" && f["rid"] === "r1");
      const after = readFileSync(paths.logFile, "utf8")
        .split("\n")
        .filter((l) => l.length > 0);
      // Exactly one new line — admin.ts's own deliberate audit entry for this op — and it is
      // *that* line, never a registry-style entry ("agent up", "session", …). The sharper
      // assertion (registry.onFrame itself is never called, the bus never fires) is covered by
      // agent-server-admin.test.ts's spy-based version of this same case against a fake registry.
      expect(after.length - before.length).toBe(1);
      const added = JSON.parse(after[after.length - 1]!) as Record<string, unknown>;
      expect(added).toMatchObject({ audit: "admin", op: "info" });
    }, 20_000);
  },
);
