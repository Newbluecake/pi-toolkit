/**
 * web-hub-privacy plan v2.1 (P1 测试锚点, 「Fork 继承」): a hub-initiated session-history fork
 * (`POST /api/headless` with `session.mode:"fork"`) inherits a LOCKED source session's mark —
 * the new sessionId is written to the privacy store BEFORE `supervisor.start()` forks
 * (「先写标记后 spawn」); a write failure / E_LIMIT fails the whole fork request (409/500, the
 * snapshot is discarded, no fork ever starts). An unlocked source inherits nothing.
 *
 * Drives the REAL `createSpawnRoutes` through the loopback HTTP stack (`spawnKit` +
 * `fakeDeps`, the `api-headless-history.test.ts` pattern) with a spying `SpawnPrivacyPort`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHttpFrontend } from "../../../src/web-hub/hub/http.js";
import type { HttpFrontend } from "../../../src/web-hub/hub/ports.js";
import type { SpawnPrivacyPort } from "../../../src/web-hub/hub/spawn/routes.js";
import { fakeDeps, login, makeTmp, postJson, type FakeDeps, type RawResponse } from "./helpers.js";
import { fakeClock, type FakeClock } from "./lan-helpers.js";
import { fakeHistory, fakeSessionPin, spawnKit, type FakeHistoryService, type SpawnKit } from "./spawn-kit.js";

let tmp: ReturnType<typeof makeTmp>;
let deps: FakeDeps;
let fe: HttpFrontend;
let port: number;
let cookie: string;
let kit: SpawnKit;
let history: FakeHistoryService;
let clock: FakeClock;

/** Spy privacy port with a call-order log shared with the supervisor's start calls. */
let order: string[];
let privacy: SpawnPrivacyPort & { marks: Map<string, boolean>; failNext: "limit" | "io" | null };

beforeEach(async () => {
  tmp = makeTmp("pwh-privacy-fork-");
  deps = fakeDeps(tmp.dir);
  clock = fakeClock();
  history = fakeHistory();
  order = [];
  privacy = {
    marks: new Map(),
    failNext: null,
    isLocked: (id) => privacy.marks.get(id) === true,
    async setLocked(id, locked) {
      if (privacy.failNext !== null) {
        const kind = privacy.failNext;
        privacy.failNext = null;
        throw Object.assign(new Error(kind), { status: kind === "limit" ? 409 : 500 });
      }
      order.push(`privacy:set:${id}`);
      privacy.marks.set(id, locked);
    },
  };
  kit = spawnKit({ history: true }, clock, undefined, history, undefined, privacy);
  // wrap start() so the order log sees it relative to the privacy write
  const origStart = kit.supervisor.start;
  kit.supervisor.start = ((req: unknown, dl: unknown) => {
    order.push("supervisor:start");
    return origStart.call(kit.supervisor, req as never, dl as never);
  }) as typeof kit.supervisor.start;
  deps.spawn = kit.spawn;
  fe = createHttpFrontend(deps);
  port = (await fe.listen()).port;
  cookie = await login(port, deps.paths.tokenFile);
});

afterEach(async () => {
  await fe.close();
  tmp.cleanup();
});

const ID = "0123456789abcdef0123456789abcdef";

function spawnPost(body: unknown): Promise<RawResponse> {
  return postJson(port, "/api/headless", body, { Cookie: cookie, Origin: `http://127.0.0.1:${port}` });
}

function forkRequest(pin: ReturnType<typeof fakeSessionPin>) {
  history.setResolveResult({ ok: true, pin });
  history.setProveResult({ free: false, reason: "open", live: { state: "open", by: "card" } });
  return {
    id: ID,
    cwd: pin.cwd,
    confirm: true,
    expectCwd: pin.cwd,
    session: { key: "dir/sess-old.jsonl", id: pin.id, mode: "fork" as const },
  };
}

describe("POST /api/headless fork × privacy inheritance", () => {
  it("locked source ⇒ the NEW sessionId is marked BEFORE supervisor.start() runs", async () => {
    const pin = fakeSessionPin();
    privacy.marks.set(pin.id, true);
    const r = await spawnPost(forkRequest(pin));
    expect(r.status).toBe(202);
    expect(kit.supervisor.startCalls).toHaveLength(1);
    const started = kit.supervisor.startCalls[0]!;
    const newId = started.session?.mode === "fork" ? started.session.newId : undefined;
    expect(typeof newId).toBe("string");
    // the forked session carries the mark…
    expect(privacy.marks.get(newId!)).toBe(true);
    // …and the write happened strictly BEFORE the fork
    expect(order).toEqual([`privacy:set:${newId}`, "supervisor:start"]);
  });

  it("unlocked source ⇒ no privacy write at all (byte-identical fork)", async () => {
    const pin = fakeSessionPin();
    const r = await spawnPost(forkRequest(pin));
    expect(r.status).toBe(202);
    expect(kit.supervisor.startCalls).toHaveLength(1);
    expect(order).toEqual(["supervisor:start"]);
    expect([...privacy.marks.keys()].filter((k) => k !== pin.id)).toEqual([]);
  });

  it("privacy E_LIMIT ⇒ the WHOLE fork fails (409), start never runs, snapshot discarded", async () => {
    const pin = fakeSessionPin();
    privacy.marks.set(pin.id, true);
    privacy.failNext = "limit";
    const r = await spawnPost(forkRequest(pin));
    expect(r.status).toBe(409);
    expect(JSON.parse(r.body)).toEqual({ error: "E_LIMIT" });
    expect(kit.supervisor.startCalls).toHaveLength(0);
    expect(history.discardedSnapshots).toHaveLength(1);
  });

  it("privacy write failure ⇒ the fork fails (500), start never runs", async () => {
    const pin = fakeSessionPin();
    privacy.marks.set(pin.id, true);
    privacy.failNext = "io";
    const r = await spawnPost(forkRequest(pin));
    expect(r.status).toBe(500);
    expect(JSON.parse(r.body)).toEqual({ error: "E_INTERNAL" });
    expect(kit.supervisor.startCalls).toHaveLength(0);
    expect(history.discardedSnapshots).toHaveLength(1);
  });

  it("resume mode never touches the privacy store (same sessionId keeps its own mark)", async () => {
    const pin = fakeSessionPin();
    privacy.marks.set(pin.id, true);
    history.setResolveResult({ ok: true, pin });
    const r = await spawnPost({
      id: ID,
      cwd: pin.cwd,
      session: { key: "dir/sess-old.jsonl", id: pin.id, mode: "resume" },
    });
    expect(r.status).toBe(202);
    expect(order).toEqual(["supervisor:start"]);
  });
});
