/** Real HTTP/SQLite/token + actual ledger fds/native PTY. Only resource completion/
 * syscall barriers/failures are injected; NO successful auth/physical result stub.
 */
import { readFileSync, readlinkSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { terminalV2AuthFixture } from "./helpers/terminal-v2-auth-fixture.js";
import { exerciseOriginalAuthMutations } from "./helpers/terminal-v2-auth-ops.js";
import { postJson, rawRequest } from "../web-hub/http/helpers.js";
import { observeUntil } from "../../scripts/web-hub/terminal-v2-maintenance/http-client.js";
const injection = vi.hoisted(() => ({
  gate: undefined as
    | undefined
    | {
        directory: string;
        kind: "pending" | "ENOSPC";
        armed: boolean;
        entered: boolean;
        wait: Promise<void>;
        release(): void;
      },
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args),
        path = String(args[0]),
        gate = injection.gate;
      const match = /^\/proc\/self\/fd\/(\d+)\/\.ledger-[a-f0-9]+\.tmp$/.exec(path);
      if (gate?.armed && match && readlinkSync(`/proc/self/fd/${match[1]}`) === `${gate.directory}/terminal-v2`) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          gate.entered = true;
          if (gate.kind === "ENOSPC" && gate.armed)
            throw Object.assign(new Error("owned injected sync ENOSPC"), { code: "ENOSPC" });
          gate.armed = false;
          await gate.wait;
          return sync();
        };
      }
      return handle;
    },
  };
});
const closers: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  injection.gate?.release();
  injection.gate = undefined;
  for (const close of closers.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
function arm(directory: string, kind: "pending" | "ENOSPC" = "pending") {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const gate = {
    directory,
    kind,
    armed: true,
    entered: false,
    wait,
    release: () => {
      gate.armed = false;
      release();
    },
  };
  injection.gate = gate;
  return gate;
}
async function create(h: Awaited<ReturnType<typeof terminalV2AuthFixture>>) {
  const list = await h.loop("list", { scope: h.scope });
  expect(list.status).toBe(200);
  const envelope = { scope: h.scope, hubInstance: list.body.hubInstance };
  return {
    envelope,
    work: h.loop("create", { ...envelope, requestId: "r".repeat(24), mode: "ensure-empty", cols: 80, rows: 24 }),
  };
}
it.each([
  { phase: "reserve", kind: "pending" },
  { phase: "reserve", kind: "ENOSPC" },
  { phase: "prune", kind: "pending" },
  { phase: "prune", kind: "ENOSPC" },
] as const)(
  "A2 actual $phase temp-sync $kind cannot gate five original auth mutation kinds",
  async ({ phase, kind }) => {
    const h = await terminalV2AuthFixture(closers, false, true, { retain: true });
    let gate: ReturnType<typeof arm>, work: ReturnType<typeof h.loop>;
    if (phase === "reserve") {
      gate = arm(h.state, kind);
      work = (await create(h)).work;
    } else {
      const opened = await create(h),
        created = await opened.work;
      expect(created.body.ok).toBe(true);
      gate = arm(h.state, kind);
      work = h.loop("close", { ...opened.envelope, termId: created.body.termId });
    }
    await observeUntil(
      async () => gate.entered,
      (value) => value,
    );
    expect(h.backendCalls).toBe(phase === "reserve" ? 0 : 1);
    await exerciseOriginalAuthMutations(h);
    expect(gate.entered).toBe(true);
    const disk = JSON.parse(readFileSync(`${h.state}/terminal-v2/ledger.json`, "utf8"));
    expect(disk.allocations).toHaveLength(phase === "reserve" ? 0 : 1);
    expect(h.service.maintenanceSnapshot().physicalPrunes).toBe(0);
    gate.release();
    injection.gate = undefined;
    const response = await work;
    if (phase === "reserve") expect(response.body.ok).toBe(false);
    await observeUntil(
      async () => h.service.maintenanceSnapshot(),
      (state) => state.mutationFlights === 0 && state.pendingCreates === 0,
    );
    expect(h.backendCalls).toBe(phase === "reserve" ? 0 : 1);
    const snapshot = h.service.maintenanceSnapshot();
    expect(snapshot.physicalPrunes).toBeLessThanOrEqual(phase === "reserve" ? 0 : 1);
    // A fresh retry after a proven pre-rename ENOSPC may legitimately commit the
    // retained real proof once the injected fault is lifted; never count it twice.
    expect(JSON.parse(readFileSync(`${h.state}/terminal-v2/ledger.json`, "utf8")).allocations).toHaveLength(
      phase === "reserve" ? 0 : 1 - snapshot.physicalPrunes,
    );
  },
  30000,
);
it("A3 actual backend completion future remains withheld: logout succeeds first, exact slot stays charged, original proof later prunes once", async () => {
  let release!: () => void;
  const completion = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const h = await terminalV2AuthFixture(closers, false, true, { backendDoneBarrier: completion, retain: true }),
      pending = await create(h),
      created = await pending.work;
    expect(created.body.ok).toBe(true);
    expect(h.backendCalls).toBe(1);
    const response = await postJson(
      h.hub.httpPort,
      "/api/logout",
      {},
      { Cookie: h.loopCookie, Origin: `http://127.0.0.1:${h.hub.httpPort}` },
    );
    expect(response.status).toBe(200);
    expect(response.body).toBe('{"ok":true}');
    expect(h.service.maintenanceSnapshot().allocationCount).toBe(1);
    expect(h.service.maintenanceSnapshot().physicalPrunes).toBe(0);
    expect(JSON.parse(readFileSync(`${h.state}/terminal-v2/ledger.json`, "utf8")).allocations).toHaveLength(1);
    expect((await rawRequest(h.hub.httpPort, { path: "/api/agents", headers: { Cookie: h.loopCookie } })).status).toBe(
      401,
    );
    release();
    await observeUntil(
      async () => h.service.maintenanceSnapshot(),
      (state) => state.allocationCount === 0 && state.physicalPrunes === 1,
    );
    expect(JSON.parse(readFileSync(`${h.state}/terminal-v2/ledger.json`, "utf8")).allocations).toEqual([]);
  } finally {
    release?.();
  }
}, 30000);
it("A12 real prune sync past its deadline cannot publish late release or alter earlier successful logout", async () => {
  const h = await terminalV2AuthFixture(closers, false, true, { retain: true }),
    pending = await create(h),
    created = await pending.work;
  expect(created.body.ok).toBe(true);
  const gate = arm(h.state),
    closing = h.loop("close", { ...pending.envelope, termId: created.body.termId });
  await observeUntil(
    async () => gate.entered,
    (value) => value,
  );
  const response = await postJson(
    h.hub.httpPort,
    "/api/logout",
    {},
    { Cookie: h.loopCookie, Origin: `http://127.0.0.1:${h.hub.httpPort}` },
  );
  expect(response.status).toBe(200);
  expect(response.body).toBe('{"ok":true}');
  expect(h.service.maintenanceSnapshot().allocationCount).toBe(1);
  // Actual logical deadline, not fake clock or a proof made from PID absence.
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 2300);
    timer.unref();
  });
  gate.release();
  injection.gate = undefined;
  expect((await closing).body.ok).toBe(false);
  await observeUntil(
    async () => h.service.maintenanceSnapshot(),
    (state) => state.mutationFlights === 0,
  );
  expect(h.service.maintenanceSnapshot().allocationCount).toBe(1);
  expect(h.service.maintenanceSnapshot().physicalPrunes).toBe(0);
  expect(JSON.parse(readFileSync(`${h.state}/terminal-v2/ledger.json`, "utf8")).allocations).toHaveLength(1);
  expect(response.body).toBe('{"ok":true}');
}, 30000);
