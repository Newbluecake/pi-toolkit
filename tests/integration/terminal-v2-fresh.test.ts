/** Fresh/restart contract: real startHub/auth/native private-rc backend, no hand-written
 * v2 initialization files. Metadata responder is simulated, not SDK/browser coverage.
 * Syscall barriers delegate real IO; retained fixtures include failed/late publications. */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureTerminalStoreV2, FRESH_STAGE_V2 } from "../../src/web-hub/hub/terminal/v2/fresh.js";
import { createTerminalAllocationLedgerV2 } from "../../src/web-hub/hub/terminal/v2/ledger.js";
import { terminalV2AuthFixture } from "./helpers/terminal-v2-auth-fixture.js";
import { observeUntil } from "../../scripts/web-hub/terminal-v2-maintenance/http-client.js";
import { openTerminalTestView } from "./helpers/terminal-v2-view.js";

const openedFiles = vi.hoisted(() => [] as Array<{ path: string; handle: import("node:fs/promises").FileHandle }>);
const fault = vi.hoisted(() => ({
  active: undefined as
    | undefined
    | {
        state: string;
        point: string;
        mode: "ENOSPC" | "EACCES" | "ENOTDIR" | "hold";
        entered: boolean;
        calls: string[];
        openHandles: Set<number>;
        wait: Promise<void>;
        release(): void;
      },
}));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  const wrapped = Object.fromEntries(
    (["lstatSync", "realpathSync", "openSync", "readFileSync"] as const).map((name) => {
      const delegate = actual[name] as (...args: unknown[]) => unknown;
      return [
        name,
        (...args: unknown[]) => {
          const f = fault.active,
            path = String(args[0]);
          if (f && path.startsWith(f.state)) f.calls.push(`${name}:${path.slice(f.state.length)}`);
          return delegate(...args);
        },
      ];
    }),
  );
  return { ...actual, ...wrapped };
});
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  const location = (path: string) => {
    const match = /^\/proc\/self\/fd\/(\d+)(.*)$/.exec(path);
    return match ? readlinkSync(`/proc/self/fd/${match[1]}`) + match[2] : path;
  };
  const hit = async (path: string, point: string) => {
    const f = fault.active;
    if (!f || !path.startsWith(f.state)) return;
    f.calls.push(point);
    if (point !== f.point) return;
    f.entered = true;
    if (f.mode !== "hold") throw Object.assign(new Error(`injected ${f.mode}`), { code: f.mode });
    await f.wait;
  };
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const f = fault.active;
      if (f) await hit(String(args[0]), `lstat:${String(args[0]).slice(f.state.length)}`);
      return actual.lstat(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const path = location(String(args[0]));
      const h = await actual.open(...args);
      openedFiles.push({ path, handle: h });
      const f = fault.active;
      if (f && path.startsWith(f.state)) {
        f.calls.push(`open:${path.slice(f.state.length)}`);
        f.openHandles.add(h.fd);
        const fd = h.fd,
          close = h.close.bind(h),
          sync = h.sync.bind(h);
        h.close = async () => {
          try {
            await close();
          } finally {
            f.openHandles.delete(fd);
          }
        };
        let syncCount = 0;
        h.sync = async () => {
          const suffix = path.slice(f.state.length);
          // State-parent syncs: persist staging, persist witness, persist rename.
          const point =
            suffix === ""
              ? `parent-sync-${++syncCount}`
              : /\/terminal-v2\/\.ledger-[a-f0-9]+\.tmp$/.test(suffix)
                ? "prune-sync"
                : `sync:${suffix}`;
          await hit(path, point);
          return sync();
        };
      }
      return h;
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      const path = location(String(args[0]));
      if (path.endsWith(`/${FRESH_STAGE_V2}`)) {
        await hit(path, "before-rename");
        await actual.rename(...args);
        // Real rename ALREADY entered and completed; only its return is withheld.
        await hit(path, "rename-return");
        return;
      }
      return actual.rename(...args);
    },
  };
});
const closers: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  fault.active?.release();
  fault.active = undefined;
  for (const close of closers.splice(0).reverse()) await close();
  const leaked = openedFiles.filter((f) => f.handle.fd >= 0).map((f) => f.path);
  openedFiles.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  expect(leaked).toEqual([]); // late IO must really close FDs, not become a GC-only promise cycle
});
function arm(state: string, point: string, mode: "ENOSPC" | "EACCES" | "ENOTDIR" | "hold" = "ENOSPC") {
  let release!: () => void;
  const wait = new Promise<void>((r) => {
    release = r;
  });
  const f = {
    state,
    point,
    mode,
    entered: false,
    calls: [] as string[],
    openHandles: new Set<number>(),
    wait,
    release,
  };
  fault.active = f;
  return f;
}
function owned() {
  const state = mkdtempSync(join(tmpdir(), "t51-fresh-"));
  chmodSync(state, 0o700);
  // Deliberately retained for red/green inspection; never clean partial evidence.
  console.info("fresh fixture", state);
  return state;
}
function store(state: string, current = () => true) {
  const ledger = createTerminalAllocationLedgerV2({ stateDir: state, current });
  return {
    ledger,
    run: (signal = new AbortController().signal, ms = 1500) =>
      ensureTerminalStoreV2({ stateDir: state, ledger, current, at: Date.now() + ms }, signal),
  };
}
const disk = (state: string) => JSON.parse(readFileSync(join(state, "terminal-v2/ledger.json"), "utf8"));
async function create(h: Awaited<ReturnType<typeof terminalV2AuthFixture>>, id: string) {
  const list = await h.loop("list", { scope: h.scope });
  expect(list.body.ok).toBe(true);
  const envelope = { scope: h.scope, hubInstance: list.body.hubInstance };
  const response = await h.loop("create", { ...envelope, requestId: id.repeat(24), mode: "new", cols: 80, rows: 24 });
  return { ...response, envelope };
}

describe("real enabled hub fresh/restart", () => {
  it("fresh without three-file fixture -> two native tabs -> normal close/prune -> same-kernel restart/new", async () => {
    const h = await terminalV2AuthFixture(closers, false, true, { fresh: true, retain: true });
    console.info("native fresh fixture", h.state);
    expect(h.hub.info.terminal).toBeUndefined();
    const first = await create(h, "a"),
      second = await create(h, "b");
    expect(first.body.ok).toBe(true);
    expect(second.body.ok).toBe(true);
    expect(first.body.termId).not.toBe(second.body.termId);
    const before = disk(h.state);
    expect(before.allocations).toHaveLength(2);
    expect(h.backendCalls).toBe(2);
    // Real authenticated single-writer NDJSON and input on a genuinely fresh store.
    const term = { ...first.envelope, termId: first.body.termId };
    const view = await openTerminalTestView(closers, h.hub.httpPort, h.loopCookie, term);
    const attached = await view.next((f) => f.t === "attached");
    const replay = await view.next((f) => f.t === "replay-end");
    if (attached.t !== "attached" || replay.t !== "replay-end") throw new Error("unexpected view frame");
    const writer = { ...term, viewId: attached.viewId };
    expect((await h.loop("ack", { ...writer, offset: replay.offset, replayComplete: true })).body.ok).toBe(true);
    await view.next((f) => f.t === "ready");
    expect(
      (
        await h.loop("input", {
          ...writer,
          seq: 1,
          kind: "user",
          bytesB64: Buffer.from("printf 'FRESH_NATIVE_%s\\n' \"$$\"\n").toString("base64"),
        })
      ).body.ok,
    ).toBe(true);
    const output = await view.next(
      (f) => f.t === "output" && /FRESH_NATIVE_\d+/.test(Buffer.from(f.bytesB64, "base64").toString()),
    );
    if (output.t !== "output") throw new Error("unexpected output frame");
    const pid = /FRESH_NATIVE_(\d+)/.exec(Buffer.from(output.bytesB64, "base64").toString())![1]!;
    expect(existsSync(`/proc/${pid}/stat`)).toBe(true);
    await h.hub.close("fresh-restart");
    expect(existsSync(`/proc/${pid}/stat`)).toBe(false);
    const closed = disk(h.state);
    expect(closed.allocations).toEqual([]);
    expect(closed.revision).toBe(before.revision + 2);
    expect((await h.service.dispose()).clean).toBe(true);
    expect(h.service.maintenanceSnapshot().physicalPrunes).toBe(2);
    const log = readFileSync(join(h.state, "hub.log"), "utf8");
    expect(log).not.toContain("terminal cleanup unresolved");
    expect(log).toContain('"msg":"web-hub terminal cleanup complete","result":"clean"');
    expect(log.indexOf("terminal cleanup complete")).toBeLessThan(log.indexOf("hub closed"));
    const next = await h.restart();
    expect(disk(h.state)).toEqual(closed);
    const created = await create(next, "c");
    expect(created.body.ok).toBe(true);
    expect(created.body.termId).not.toBe(first.body.termId);
    expect(created.body.termId).not.toBe(second.body.termId);
    expect(next.backendCalls).toBe(1);
  }, 30000);

  it("withheld original backend.done closes bounded with warning before log close; exact cold row charges remainder/E_LIMIT", async () => {
    let release!: () => void;
    const barrier = new Promise<void>((r) => {
      release = r;
    });
    try {
      const h = await terminalV2AuthFixture(closers, false, true, {
        fresh: true,
        retain: true,
        backendDoneBarrier: barrier,
      });
      expect((await create(h, "d")).body.ok).toBe(true);
      const before = readFileSync(join(h.state, "terminal-v2/ledger.json"));
      const start = Date.now();
      await h.hub.close("fresh-unknown");
      expect(Date.now() - start).toBeLessThan(3000);
      const log = readFileSync(join(h.state, "hub.log"), "utf8");
      expect(log).toContain('"msg":"web-hub terminal cleanup unresolved","result":"unknown"');
      expect(log.indexOf("terminal cleanup unresolved")).toBeLessThan(log.indexOf("hub closed"));
      expect(readFileSync(join(h.state, "terminal-v2/ledger.json"))).toEqual(before);
      expect(h.service.maintenanceSnapshot().physicalPrunes).toBe(0);
      const next = await h.restart();
      const listed = await next.loop("list", { scope: next.scope });
      expect(listed.body.rows).toEqual([]); // cold allocations are NOT attachable tabs
      expect(listed.body.unknownResources).toHaveLength(1);
      expect(listed.body.unknownResources[0].state).toBe("cleanup-unknown");
      expect(listed.body.quota.session).toMatchObject({ used: 1, unknown: 1, limit: 2 });
      expect(
        (
          await next.loop("rename", {
            scope: next.scope,
            hubInstance: listed.body.hubInstance,
            termId: JSON.parse(before.toString()).allocations[0].termId,
            name: "never-adopt",
          })
        ).body.code,
      ).toBe("E_NOT_FOUND");
      expect(next.backendCalls).toBe(0);
      expect(readFileSync(join(h.state, "terminal-v2/ledger.json"))).toEqual(before);
      expect((await create(next, "e")).body.ok).toBe(true);
      expect((await create(next, "f")).body.code).toBe("E_LIMIT");
      expect(next.backendCalls).toBe(1);
      const successor = readFileSync(join(h.state, "terminal-v2/ledger.json"));
      release();
      const result = await h.service.dispose();
      expect(result.clean).toBe(false);
      expect(result.unresolved).toBeGreaterThanOrEqual(1);
      expect(readFileSync(join(h.state, "terminal-v2/ledger.json"))).toEqual(successor);
      expect(disk(h.state).allocations[0].allocationId).toBe(JSON.parse(before.toString()).allocations[0].allocationId);
    } finally {
      release();
    }
  }, 30000);

  it("held fresh IO does not block real auth and admission never forks before ready; dispose revokes it", async () => {
    let gate: ReturnType<typeof arm> | undefined;
    const h = await terminalV2AuthFixture(closers, false, true, {
      fresh: true,
      retain: true,
      awaitTerminal: false,
      beforeStart: (state) => {
        gate = arm(state, "sync:/.terminal-initializing-v2/marker.json", "hold");
      },
    });
    expect(gate?.entered).toBe(true);
    expect((await h.loop("list", { scope: h.scope })).body.code).toBe("E_RESOURCE_UNAVAILABLE");
    // Read ONLY the original test-owned service's correlation id; do not bypass
    // the real HTTP hub check with an invented id or fabricate readiness/auth.
    const hubInstance = (h.service as unknown as { deps: { hubInstance: string } }).deps.hubInstance;
    const results = await Promise.all(
      ["g", "h"].map((id) =>
        h.loop("create", {
          scope: h.scope,
          hubInstance,
          requestId: id.repeat(24),
          mode: "new",
          cols: 80,
          rows: 24,
        }),
      ),
    );
    for (const result of results) expect(result.body).toMatchObject({ ok: false, code: "E_RESOURCE_UNAVAILABLE" });
    expect(h.backendCalls).toBe(0);
    await h.hub.close("fresh-held");
    await h.initialized;
    gate!.release();
    fault.active = undefined;
    await observeUntil(async () => gate!.openHandles.size === 0, Boolean);
    expect(existsSync(join(h.state, FRESH_STAGE_V2, "marker.json"))).toBe(true);
    expect(existsSync(join(h.state, ".terminal-initialized-v2"))).toBe(false);
    expect(existsSync(join(h.state, "terminal-v2"))).toBe(false);
  }, 30000);

  it("true off never probes or writes terminal paths and preserves existing bytes", async () => {
    let gate: ReturnType<typeof arm> | undefined;
    const h = await terminalV2AuthFixture(closers, false, false, {
      fresh: true,
      retain: true,
      beforeStart(state) {
        writeFileSync(join(state, ".terminal-initialized-v2"), "off-sentinel", { mode: 0o600 });
        gate = arm(state, "unused");
      },
    });
    expect(h.hub.info.caps).not.toContain("terminal.tabs.v2");
    expect(h.backendCalls).toBe(0);
    expect((await h.loop("list", { scope: h.scope })).status).toBe(404);
    await h.hub.close("fresh-off");
    expect(gate!.calls.filter((p) => /terminal/.test(p))).toEqual([]);
    expect(readFileSync(join(h.state, ".terminal-initialized-v2"), "utf8")).toBe("off-sentinel");
    expect(existsSync(join(h.state, "terminal-v2"))).toBe(false);
    expect(existsSync(join(h.state, FRESH_STAGE_V2))).toBe(false);
  }, 30000);

  it("held real prune IO closes within original step and warns before close; old writer cannot prune successor", async () => {
    const h = await terminalV2AuthFixture(closers, false, true, { fresh: true, retain: true });
    expect((await create(h, "p")).body.ok).toBe(true);
    const before = readFileSync(join(h.state, "terminal-v2/ledger.json"));
    const gate = arm(h.state, "prune-sync", "hold"),
      start = Date.now();
    const closing = h.hub.close("fresh-prune-held");
    await observeUntil(async () => gate.entered, Boolean);
    await closing;
    expect(Date.now() - start).toBeLessThan(3000);
    const log = readFileSync(join(h.state, "hub.log"), "utf8");
    expect(log).toContain('"msg":"web-hub terminal cleanup unresolved","result":"unknown"');
    expect(log.indexOf("terminal cleanup unresolved")).toBeLessThan(log.indexOf("hub closed"));
    expect(readFileSync(join(h.state, "terminal-v2/ledger.json"))).toEqual(before);
    fault.active = undefined;
    const next = await h.restart();
    expect((await create(next, "q")).body.ok).toBe(true);
    expect((await create(next, "r")).body.code).toBe("E_LIMIT");
    const successor = readFileSync(join(h.state, "terminal-v2/ledger.json"));
    gate.release();
    await observeUntil(async () => gate.openHandles.size === 0, Boolean);
    expect((await h.service.dispose()).clean).toBe(false);
    expect(readFileSync(join(h.state, "terminal-v2/ledger.json"))).toEqual(successor);
  }, 30000);

  it.each(["timeout", "dispose"])(
    "real hub late rename %s: only successor strict load may accept complete disk",
    async (kind) => {
      let gate: ReturnType<typeof arm> | undefined;
      const h = await terminalV2AuthFixture(closers, false, true, {
        fresh: true,
        retain: true,
        awaitTerminal: false,
        beforeStart: (state) => {
          gate = arm(state, "rename-return", "hold");
        },
      });
      await observeUntil(async () => gate!.entered, Boolean);
      if (kind === "dispose") await h.hub.close("fresh-late-rename");
      await h.initialized; // actual terminal-only 6s timer for timeout, not fake time
      expect(h.hub.info.terminal?.state).toBe("unavailable");
      expect(h.backendCalls).toBe(0);
      const next = await h.restart();
      expect(next.hub.info.terminal).toBeUndefined();
      expect((await create(next, "s")).body.ok).toBe(true);
      const successor = readFileSync(join(h.state, "terminal-v2/ledger.json"));
      const calls = gate!.calls.length;
      gate!.release();
      fault.active = undefined;
      await observeUntil(async () => gate!.openHandles.size === 0, Boolean);
      expect(gate!.calls.slice(calls).filter((p) => p === "parent-sync-3")).toEqual([]);
      expect(readFileSync(join(h.state, "terminal-v2/ledger.json"))).toEqual(successor);
      expect(h.hub.info.terminal?.state).toBe("unavailable");
    },
    20000,
  );

  it.each(["reject", "throw"])(
    "dispose %s records unknown once before original log closes",
    async (kind) => {
      const h = await terminalV2AuthFixture(closers, false, true, { fresh: true, retain: true });
      const original = h.service.dispose.bind(h.service);
      vi.spyOn(h.service, "dispose").mockImplementationOnce(() => {
        void original(); // preserve the original synchronous seal/cleanup, alter only result delivery
        if (kind === "throw") throw new Error("injected observation loss");
        return Promise.reject(new Error("injected observation loss"));
      });
      await h.hub.close("fresh-dispose-failed");
      await h.hub.close("duplicate");
      const log = readFileSync(join(h.state, "hub.log"), "utf8");
      expect(log.match(/terminal cleanup unresolved/g)).toHaveLength(1);
      expect(log.indexOf("terminal cleanup unresolved")).toBeLessThan(log.indexOf("hub closed"));
      expect(log).not.toContain("injected observation loss");
    },
    20000,
  );
});

describe("fresh real IO state table", () => {
  it("strict load preserves legal nonzero existing bytes without any legacy dependency", async () => {
    const state = owned(),
      s = store(state);
    await s.run();
    const loaded = await s.ledger.load(new AbortController().signal);
    if (loaded.kind !== "loaded") throw new Error("not loaded");
    // Use real serialized CAS, not overwriting the initial ledger as a restart fixture.
    expect((await s.ledger.commit(0, { ...loaded.ledger, revision: 1 }, new AbortController().signal)).kind).toBe(
      "committed",
    );
    writeFileSync(join(state, "terminal-resource-fence-v1.json"), "DO NOT PARSE");
    const before = readFileSync(join(state, "terminal-v2/ledger.json"));
    const f = arm(state, "unused");
    await store(state).run();
    expect(readFileSync(join(state, "terminal-v2/ledger.json"))).toEqual(before);
    expect(f.calls.some((x) => x.includes("v1"))).toBe(false);
    expect(lstatSync(join(state, "terminal-v2")).mode & 0o777).toBe(0o700);
    for (const name of ["terminal-v2/marker.json", "terminal-v2/ledger.json", ".terminal-initialized-v2"])
      expect(lstatSync(join(state, name)).mode & 0o777).toBe(0o600);
  });
  it.each([
    "terminal-v1",
    ".terminal-initialized-v1",
    "terminal-resource-fence-v1.json",
    ".terminal-authority-archive-v1",
  ])("legacy sentinel %s refuses using presence only, never reads/parses", async (name) => {
    const state = owned();
    writeFileSync(join(state, name), "not-json", { mode: 0o600 });
    await expect(store(state).run()).rejects.toThrow("legacy-unsupported");
    expect(existsSync(join(state, FRESH_STAGE_V2))).toBe(false);
    expect(readFileSync(join(state, name), "utf8")).toBe("not-json");
  });
  it.each(["terminal-v2", ".terminal-initialized-v2", ".terminal-allocation-archive-v2", FRESH_STAGE_V2])(
    "partial %s is retained/refused",
    async (name) => {
      const state = owned();
      mkdirSync(join(state, name), { mode: 0o700 });
      await expect(store(state).run()).rejects.toThrow();
      expect(lstatSync(join(state, name)).isDirectory()).toBe(true);
      expect(existsSync(join(state, "terminal-v2/ledger.json"))).toBe(false);
    },
  );
  it("symlink v2 or legacy and invalid parent are never absence", async () => {
    for (const name of ["terminal-v2", ".terminal-initialized-v2", "terminal-v1"]) {
      const state = owned();
      symlinkSync("does-not-exist", join(state, name));
      await expect(store(state).run()).rejects.toThrow();
      expect(lstatSync(join(state, name)).isSymbolicLink()).toBe(true);
      expect(existsSync(join(state, FRESH_STAGE_V2))).toBe(false);
    }
    const state = owned();
    chmodSync(state, 0o500);
    await expect(store(state).run()).rejects.toThrow();
    chmodSync(state, 0o700);
  });
  it.each([
    "parent-sync-1",
    "sync:/.terminal-initializing-v2/marker.json",
    "sync:/.terminal-initializing-v2/ledger.json",
    "sync:/.terminal-initializing-v2",
    "sync:/.terminal-initialized-v2",
    "parent-sync-2",
    "before-rename",
    "rename-return",
    "parent-sync-3",
  ])("ENOSPC at %s retains partial; successor only accepts fully published valid store", async (point) => {
    const state = owned(),
      f = arm(state, point);
    await expect(store(state).run()).rejects.toThrow();
    expect(f.entered).toBe(true);
    const observed = f.calls.slice();
    fault.active = undefined;
    expect(existsSync(join(state, FRESH_STAGE_V2)) || existsSync(join(state, "terminal-v2"))).toBe(true);
    if (["rename-return", "parent-sync-3"].includes(point)) {
      await store(state).run();
      expect(disk(state).revision).toBe(0);
    } else await expect(store(state).run()).rejects.toThrow();
    expect(observed.filter((p) => p === point)).toHaveLength(1);
  });
  it.each(["EACCES", "ENOTDIR"] as const)("lstat %s is not missing and never starts fresh", async (code) => {
    const state = owned(),
      f = arm(state, "lstat:/terminal-v2", code);
    await expect(store(state).run()).rejects.toMatchObject({ code });
    expect(f.entered).toBe(true);
    expect(existsSync(join(state, FRESH_STAGE_V2))).toBe(false);
    expect(existsSync(join(state, ".terminal-initialized-v2"))).toBe(false);
  });
  it.each(["parent", "stage", "new-legacy", "new-root"])(
    "held real marker sync detects %s replacement without a false current() flag",
    async (kind) => {
      const state = owned(),
        f = arm(state, "sync:/.terminal-initializing-v2/marker.json", "hold");
      const s = store(state),
        load = vi.spyOn(s.ledger, "load");
      const rejected = expect(s.run()).rejects.toThrow();
      await observeUntil(async () => f.entered, Boolean);
      if (kind === "parent") {
        renameSync(state, `${state}-original`);
        mkdirSync(state, { mode: 0o700 });
      } else if (kind === "stage") {
        renameSync(join(state, FRESH_STAGE_V2), join(state, `${FRESH_STAGE_V2}-original`));
        mkdirSync(join(state, FRESH_STAGE_V2), { mode: 0o700 });
      } else if (kind === "new-legacy") writeFileSync(join(state, "terminal-resource-fence-v1.json"), "late legacy");
      else mkdirSync(join(state, "terminal-v2"), { mode: 0o700 });
      f.release();
      await rejected;
      expect(f.openHandles.size).toBe(0);
      expect(load).not.toHaveBeenCalled();
      expect(existsSync(join(state, ".terminal-initialized-v2"))).toBe(false);
      if (kind === "new-root") expect(lstatSync(join(state, "terminal-v2")).isDirectory()).toBe(true);
    },
  );
  it.each(["timeout", "dispose", "parent-replacement"])(
    "real rename entered but not returned: %s cannot continue/adopt success or borrow successor lifecycle",
    async (kind) => {
      const state = owned(),
        f = arm(state, "rename-return", "hold"),
        controller = new AbortController();
      let current = true;
      const s = store(state, () => current);
      const load = vi.spyOn(s.ledger, "load");
      const work = s.run(controller.signal, kind === "timeout" ? 80 : 1500);
      // Attach rejection observer before triggering abort/timeout.
      const rejected = expect(work).rejects.toThrow();
      await observeUntil(async () => f.entered, Boolean);
      expect(existsSync(join(state, "terminal-v2/ledger.json"))).toBe(true);
      if (kind === "dispose") {
        current = false;
        controller.abort();
      }
      if (kind === "parent-replacement") {
        renameSync(state, `${state}-original`);
        mkdirSync(state, { mode: 0o700 });
        current = false;
        controller.abort();
      }
      await rejected;
      const count = f.calls.length;
      // A complete late store is usable ONLY by a separate strict existing loader.
      if (kind !== "parent-replacement") await store(state).run();
      f.release();
      fault.active = undefined;
      await observeUntil(async () => f.openHandles.size === 0, Boolean);
      expect(f.calls.slice(count).filter((p) => p === "parent-sync-3")).toEqual([]);
      expect(load).not.toHaveBeenCalled(); // failed initializer never starts strict load
      if (kind === "parent-replacement") expect(existsSync(join(state, "terminal-v2"))).toBe(false);
    },
    10000,
  );
});
