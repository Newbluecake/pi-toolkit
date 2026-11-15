/** Direct route unit seam; no child/HTTP effects. Snapshot/start/mark call order
 * is asserted, including errors before any snapshot is created. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { createSpawnRoutes, type SpawnPrivacyPort } from "../../../../src/web-hub/hub/spawn/routes.js";
import type { SpawnRouteIo } from "../../../../src/web-hub/hub/spawn/ports.js";
import { createCmdLimit } from "../../../../src/web-hub/hub/cmd-limit.js";
import { fakeHistory, fakeSessionPin, spawnKit } from "../../http/spawn-kit.js";
import { fakeClock } from "../../http/lan-helpers.js";
async function run(privacy?: SpawnPrivacyPort, required = true, snapshotHook?: () => void) {
  const clock = fakeClock();
  const history = fakeHistory();
  const kit = spawnKit({ history: true }, clock, undefined, history);
  const pin = fakeSessionPin();
  history.setResolveResult({ ok: true, pin });
  history.setProveResult({ free: false, reason: "open", live: { state: "open", by: "card" } });
  const snapshot = history.snapshot;
  history.snapshot = async (...args) => {
    snapshotHook?.();
    return snapshot(...args);
  };
  const order: string[] = [];
  const start = kit.supervisor.start;
  kit.supervisor.start = (...args) => {
    order.push("start");
    return start(...args);
  };
  const observedPrivacy: SpawnPrivacyPort | undefined =
    privacy === undefined
      ? undefined
      : {
          get degraded() {
            return privacy.degraded;
          },
          isLocked: (id) => privacy.isLocked(id),
          async setLocked(id, locked) {
            order.push("mark");
            await privacy.setLocked(id, locked);
            order.push("marked");
          },
        };
  const routes = createSpawnRoutes({
    supervisor: kit.supervisor,
    dirs: kit.dirs,
    firstPrompt: kit.firstPrompt,
    prefs: kit.prefs,
    cfg: kit.cfg,
    limit: createCmdLimit(clock.now),
    rejectAudit429: new Map(),
    log: kit.log,
    now: clock.now,
    history,
    ...(observedPrivacy ? { privacy: observedPrivacy } : {}),
    ...(required ? { privacyRequired: true } : {}),
  });
  let response: { status: number; body: unknown } | undefined;
  const io: SpawnRouteIo = {
    listener: "loopback",
    ip: "127.0.0.1",
    scheme: "http",
    viaTrustedProxy: false,
    strictCsrfOk: () => true,
    authorize: async () => ({ ip: "127.0.0.1" }),
    readJson: async () => ({
      id: "0123456789abcdef0123456789abcdef",
      cwd: pin.cwd,
      confirm: true,
      expectCwd: pin.cwd,
      session: { key: "dir/sess-old.jsonl", id: pin.id, mode: "fork" },
    }),
    sendJson(_res, status, body) {
      response = { status, body };
    },
    sendError(_res, status, code) {
      response = { status, body: { error: code } };
    },
    HttpError: class extends Error {
      constructor(
        readonly status: number,
        readonly code: string,
      ) {
        super(code);
      }
    },
  };
  await routes.handle(
    { headers: { "x-pwh": "1" } } as IncomingMessage,
    {} as ServerResponse,
    "POST",
    "/api/headless",
    new URLSearchParams(),
    io,
  );
  return { response, kit, history, pin, order };
}
describe("machine terminal requires healthy fork privacy even when public privacy is off", () => {
  it.each(["missing", "degraded", "unknown-health", "query-throws"])(
    "%s fails fixed E_INTERNAL BEFORE snapshot/start",
    async (kind) => {
      let snapshots = 0;
      const privacy =
        kind === "missing"
          ? undefined
          : {
              ...(kind === "unknown-health" ? {} : { degraded: kind === "degraded" }),
              isLocked: () => {
                if (kind === "query-throws") throw new Error("private-body");
                return false;
              },
              setLocked: async () => {},
            };
      const h = await run(privacy, true, () => {
        snapshots++;
      });
      expect(h.response).toEqual({ status: 500, body: { error: "E_INTERNAL" } });
      expect(snapshots).toBe(0);
      expect(h.kit.supervisor.startCalls).toHaveLength(0);
      expect(h.pin.releaseCalls).toBe(1);
    },
  );
  it("locked source: mark the NEW id before supervisor.start", async () => {
    const marks: string[] = [];
    const h = await run({
      degraded: false,
      isLocked: () => true,
      async setLocked(id) {
        marks.push(id);
      },
    });
    expect(h.response?.status).toBe(202);
    const session = h.kit.supervisor.startCalls[0]?.session;
    expect(session?.mode).toBe("fork");
    if (session?.mode !== "fork") throw new Error("fork required");
    expect(marks).toEqual([session.newId]);
    expect(h.order).toEqual(["mark", "marked", "start"]);
    expect(h.history.discardedSnapshots).toHaveLength(0);
  });
  it("mark failure: discard snapshot, zero spawn", async () => {
    const h = await run({
      degraded: false,
      isLocked: () => true,
      async setLocked() {
        throw new Error("private-body");
      },
    });
    expect(h.response).toEqual({ status: 500, body: { error: "E_INTERNAL" } });
    expect(h.history.discardedSnapshots).toHaveLength(1);
    expect(h.kit.supervisor.startCalls).toHaveLength(0);
  });
  it("rechecks privacy after awaited snapshot: no stale unlocked cache", async () => {
    let locked = false;
    const marks: string[] = [];
    const h = await run(
      {
        degraded: false,
        isLocked: () => locked,
        async setLocked(id) {
          marks.push(id);
        },
      },
      true,
      () => {
        locked = true;
      },
    );
    expect(h.response?.status).toBe(202);
    const session = h.kit.supervisor.startCalls[0]?.session;
    expect(session?.mode === "fork" && marks[0] === session.newId).toBe(true);
  });
  it("off has no required/degraded contract: legacy missing privacy still forks", async () => {
    const h = await run(undefined, false);
    expect(h.response?.status).toBe(202);
    expect(h.kit.supervisor.startCalls).toHaveLength(1);
  });
});
