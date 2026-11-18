/** Real Linux PTY relocation gates. Owned fixture uid/home/rc only, no production services.
 * Imported system-rc audit rejects unsafe test hosts; no install or skip-to-green. */
import { afterEach, describe, it, expect } from "vitest";
import { createTerminalTestBackend, type TerminalBackend } from "../../src/web-hub/hub/terminal/v2/backend.js";
import { terminalIdentitiesGone, readTerminalIdentity } from "../../src/web-hub/hub/terminal/v2/reaper.js";
import { makeTerminalFixture } from "./terminal-v2-backend-fixture.js";
import { HubTerminalServiceV2 } from "../../src/web-hub/hub/terminal/v2/service.js";
import { createTerminalAllocationLedgerV2 } from "../../src/web-hub/hub/terminal/v2/ledger.js";
import { createInitialTerminalLedgerV2, type TerminalMarkerV2 } from "../../src/web-hub/protocol/terminal-v2.js";
import { readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
const backends: TerminalBackend[] = [],
  cleanups: Array<() => void> = [];
const pause = (ms = 25) => new Promise<void>((r) => setTimeout(r, ms));
async function until(check: () => boolean | Promise<boolean>, ms = 8000) {
  const at = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() >= at) throw new Error("v2 fixture deadline");
    await pause();
  }
}
function start(options: { startDelayMs?: number; execDelayMs?: number; kind?: "bash" | "zsh" } = {}) {
  const f = makeTerminalFixture(options.kind);
  cleanups.push(f.cleanup);
  let output = "";
  Object.assign(f.fixture, options);
  const backend = createTerminalTestBackend(
    {
      cwd: f.fixture.cwd,
      cols: 80,
      rows: 24,
      inputIdleMs: 60000,
      maxLifetimeMs: 120000,
      environment: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", PI_API_KEY: "fake-secret", BASH_ENV: "fake-env" },
      onData: (b) => {
        output = (output + b.toString()).slice(-65536);
      },
    },
    f.fixture,
  );
  backends.push(backend);
  return { backend, fixture: f.fixture, output: () => output };
}
afterEach(async () => {
  for (const b of backends.splice(0)) {
    b.close();
    await b.done;
  }
  for (const cleanup of cleanups.splice(0)) cleanup();
});
describe("v2 relocated backend real PTY", () => {
  it.each(["bash", "zsh"] as const)(
    "%s true exec-ready, native login rc, isatty, cwd, environment, resize and proof",
    async (kind) => {
      const f = start({ kind });
      await f.backend.ready;
      await until(() => f.output().includes("fixture> "));
      expect(f.backend.diagnostic).toMatchObject({ capable: true, ready: true });
      expect(f.backend.display?.cwd).toBe(f.fixture.cwd);
      await f.backend.input(
        1,
        Buffer.from(
          'printf \'V2_%s_%s_%s\\n\' "$PROFILE_COUNT" "$RC_COUNT" "${PI_API_KEY-unset}"; test -t 0 && echo V2_TTY; pwd\n',
        ),
        "user",
      );
      await until(
        () =>
          f.output().includes("V2_1_1_unset") && f.output().includes("V2_TTY") && f.output().includes(f.fixture.cwd),
      );
      await f.backend.resize(1, 101, 33);
      await f.backend.input(2, Buffer.from("stty size\n"), "user");
      await until(() => f.output().includes("33 101"));
      const shell = f.backend.managed.find((i) => i.role === "shell");
      expect(shell).toBeDefined();
      expect(await readTerminalIdentity(shell!.pid)).toMatchObject({ sid: shell!.pid, pgid: shell!.pid });
      f.backend.close();
      const result = await f.backend.done;
      expect(result).toMatchObject({
        outcome: "reaped",
        spawnSettled: true,
        ptyClosed: true,
        helperReaped: true,
        managedGroupsGone: true,
      });
      expect(await terminalIdentitiesGone(result.identitiesChecked)).toBe(true);
      expect(await readTerminalIdentity(shell!.pid)).toBeUndefined();
    },
    20000,
  );
  it("Ctrl-C interrupts foreground without replacing shell, Ctrl-D exits with complete proof", async () => {
    const f = start();
    await f.backend.ready;
    await until(() => f.output().includes("fixture> "));
    const shell = f.backend.managed.find((i) => i.role === "shell")!;
    await f.backend.input(1, Buffer.from("sleep 30\n"), "user");
    await until(() => f.backend.managed.some((i) => i.role === "foreground"));
    await f.backend.input(2, Buffer.from([3]), "user");
    await f.backend.input(3, Buffer.from("printf 'CTRL_%s\\n' OK\n"), "user");
    await until(() => f.output().includes("CTRL_OK"));
    expect(await readTerminalIdentity(shell.pid)).toBeDefined();
    await f.backend.input(4, Buffer.from([4]), "user");
    const result = await f.backend.done;
    expect(result).toMatchObject({ outcome: "reaped", exitCode: 0 });
    expect(await terminalIdentitiesGone(result.identitiesChecked)).toBe(true);
  }, 20000);
  it("ready waits for actual delayed exec, close before gate prevents a late shell exec", async () => {
    const f = start({ execDelayMs: 800 });
    let ready = false;
    void f.backend.ready.then(
      () => {
        ready = true;
      },
      () => {},
    );
    await until(() => f.backend.managed.some((i) => i.role === "shell"));
    expect(ready).toBe(false);
    expect(f.output()).not.toContain("RC_READY");
    f.backend.close();
    const result = await f.backend.done;
    expect(ready).toBe(false);
    expect(f.output()).not.toContain("RC_READY");
    expect(result).toMatchObject({
      outcome: "reaped",
      spawnSettled: true,
      ptyClosed: true,
      helperReaped: true,
      managedGroupsGone: true,
    });
  }, 20000);
  it("multiple foreground/background PGIDs and doublefork are really reaped", async () => {
    const f = start();
    await f.backend.ready;
    await until(() => f.output().includes("fixture> "));
    const script =
      "sleep 30 & sleep 30 & python3 -c 'import os,time; p=os.fork(); time.sleep(30) if p==0 else None' & echo V2_JOBS_READY\n";
    await f.backend.input(1, Buffer.from(script), "user");
    await until(() => f.output().includes("V2_JOBS_READY") && new Set(f.backend.managed.map((i) => i.pgid)).size >= 3);
    await pause(1200); // allow helper to publish adopted descendant history (real clock gate)
    expect(f.backend.managed.filter((i) => i.role !== "shell" && i.role !== "helper").length).toBeGreaterThanOrEqual(2);
    const groups = new Set(f.backend.managed.map((i) => i.pgid));
    expect(groups.size).toBeGreaterThanOrEqual(3);
    f.backend.close();
    const result = await f.backend.done;
    expect(result.outcome).toBe("reaped");
    expect(await terminalIdentitiesGone(result.identitiesChecked)).toBe(true);
  }, 20000);
  it("missing helper report after SIGKILL is NOT proof even when PID gone", async () => {
    const f = start();
    await f.backend.ready;
    const helper = f.backend.managed.find((i) => i.role === "helper");
    expect(helper).toBeDefined();
    process.kill(helper!.pid, "SIGKILL");
    f.backend.close();
    const result = await f.backend.done;
    expect(result.outcome).toBe("reap_incomplete");
    expect((await f.backend.retryReap()).outcome).toBe("reap_incomplete");
    // fallback is identity checked; observe physical cleanup but never convert absent report to proof.
    await until(() => terminalIdentitiesGone(f.backend.managed), 8000);
  }, 20000);
  it("cwd disappearing before exec fails closed, never HOME/hub fallback", async () => {
    const f = start({ execDelayMs: 800 });
    await until(() => f.backend.managed.some((i) => i.role === "shell"));
    await rm(f.fixture.cwd, { recursive: true });
    await expect(f.backend.ready).rejects.toThrow();
    f.backend.close();
    const result = await f.backend.done;
    expect(f.output()).not.toContain("RC_READY");
    expect(result.outcome).toBe("reaped");
    expect(result.exitCode).toBe(126);
    expect(result.waited).toContain(f.backend.managed.find((i) => i.role === "shell")!.pid);
  }, 20000);
  it("real service durable reserve -> helper exec -> proof -> exact prune and maintenance drain", async () => {
    const f = makeTerminalFixture();
    cleanups.push(f.cleanup);
    const store = join(f.fixture.root, "state");
    await mkdir(store, { mode: 0o700 });
    await mkdir(join(store, "terminal-v2"), { mode: 0o700 });
    const marker: TerminalMarkerV2 = {
      v: 2,
      storeId: "s".repeat(24),
      initialization: "fresh",
      checkpointId: "c".repeat(24),
    };
    const ledgerPath = join(store, "terminal-v2/ledger.json");
    await writeFile(join(store, "terminal-v2/marker.json"), JSON.stringify(marker), { mode: 0o600 });
    await writeFile(join(store, ".terminal-initialized-v2"), JSON.stringify(marker), { mode: 0o600 });
    await writeFile(ledgerPath, JSON.stringify(createInitialTerminalLedgerV2(marker)), { mode: 0o600 });
    const scope = { agentKey: "fixture", sessionId: "fixture", epoch: "fixture" },
      limits = { maxPerSession: 2, inputIdleMs: 60000, maxLifetimeMs: 120000 };
    const context = { scope, cwd: f.fixture.cwd, contextGeneration: 1, linkInstance: {}, limits };
    let forks = 0;
    const service = new HubTerminalServiceV2({
      ledger: createTerminalAllocationLedgerV2({ stateDir: store, current: () => true }),
      hubInstance: "h".repeat(24),
      revision: () => 0,
      check: () => limits,
      context: { resolve: async () => context, current: (s) => s === context },
      backend: (options) => {
        forks++;
        const b = createTerminalTestBackend(options, f.fixture);
        backends.push(b);
        return b;
      },
    });
    const sig = new AbortController().signal;
    expect(await service.initialize(sig)).toBe(true);
    const auth = {
      listener: "lan" as const,
      principal: "u1",
      sidTag: "a".repeat(43),
      parentExpiresAt: Date.now() + 120000,
    };
    const result = await service.create(
      auth,
      scope,
      { hubInstance: "h".repeat(24), requestId: "r".repeat(24), mode: "new", cols: 80, rows: 24 },
      sig,
    );
    expect(result.ok).toBe(true);
    expect(forks).toBe(1);
    expect(JSON.parse(await readFile(ledgerPath, "utf8")).allocations).toHaveLength(1);
    expect(await service.dispose()).toEqual({ clean: true, unresolved: 0 });
    const disk = JSON.parse(await readFile(ledgerPath, "utf8"));
    expect(disk.allocations).toEqual([]);
    expect(disk.revision).toBe(2);
    expect(service.maintenanceSnapshot()).toMatchObject({
      stopped: true,
      pendingCreates: 0,
      runtimes: [],
      allocationCount: 0,
    });
    expect(backends.at(-1)!.spawnSettled).toBe(true);
    expect((await backends.at(-1)!.retryReap()).outcome).toBe("reaped");
  }, 20000);
});
