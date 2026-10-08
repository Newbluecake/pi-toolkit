/**
 * web-hub session-history plan §4.5 (`service.ts`): end-to-end `createHistoryService` behavior
 * on a real tmp filesystem - `page()` listing/filtering/sorting, `resolve()` -> `prove()` ->
 * `verifyForSpawn()` -> `snapshot()` -> `verifySnapshot()`, `diag()`, and `dispose()` (X3 #4).
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createReqDeadline } from "../../../../../src/web-hub/hub/req-deadline.js";
import { HISTORY_DISPOSE_MS } from "../../../../../src/web-hub/hub/spawn/history/budget.js";
import { createHistoryService } from "../../../../../src/web-hub/hub/spawn/history/service.js";
import { defaultHistoryFs, type HistoryFs } from "../../../../../src/web-hub/hub/spawn/history/fs.js";
import type { HistoryServiceDeps } from "../../../../../src/web-hub/hub/spawn/history/ports.js";

let root: string;
let sessionsDir: string;
let realCwd: string;

function header(o: Record<string, unknown>): string {
  return `${JSON.stringify({ type: "session", id: "sess-default1", cwd: realCwd, timestamp: "t", ...o })}\n`;
}

/** A kind:"main" marker line — `prove()`/`reprove()` refuse anything not positively "main". */
const MAIN_MARKER = `${JSON.stringify({ type: "custom", customType: "pi-hud-session-start" })}\n`;

function baseDeps(over: Partial<HistoryServiceDeps> = {}): HistoryServiceDeps {
  return {
    agentDir: root,
    forkSrcDir: join(root, "spawn", "fork-src"),
    registry: { list: () => [] },
    managed: () => [],
    deathOf: () => undefined,
    uid: process.getuid?.() ?? 0,
    hubPid: 424242,
    now: () => Date.now(),
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    ...over,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pwh-svc-"));
  sessionsDir = join(root, "sessions");
  mkdirSync(join(sessionsDir, "d1"), { recursive: true });
  mkdirSync(join(root, "spawn"), { recursive: true });
  realCwd = mkdtempSync(join(tmpdir(), "pwh-svc-cwd-"));
});

describe("createHistoryService.page", () => {
  it("lists a main-kind session with a sane default page shape", async () => {
    const lines = [
      header({ id: "sess-aaaa1" }),
      `${JSON.stringify({ type: "custom", customType: "pi-hud-session-start" })}\n`,
      `${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "hello" }] } })}\n`,
    ].join("");
    writeFileSync(join(sessionsDir, "d1", "a.jsonl"), lines);
    const service = createHistoryService(baseDeps());
    const deadline = createReqDeadline(() => Date.now(), 5000);
    const result = await service.page({ kind: "main", limit: 50 }, deadline);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.page.items).toHaveLength(1);
    expect(result.page.items[0]).toMatchObject({ id: "sess-aaaa1", kind: "main", cwdState: "ok", startable: true });
    await service.dispose();
  });

  it("default kind 'main' excludes sub-kind sessions; kind 'all' includes them", async () => {
    const lines = `${header({ id: "sess-subbbb1" })}${JSON.stringify({ type: "custom", customType: "subagent:child" })}\n`;
    writeFileSync(join(sessionsDir, "d1", "sub.jsonl"), lines);
    const service = createHistoryService(baseDeps());
    const d = () => createReqDeadline(() => Date.now(), 5000);
    const mainOnly = await service.page({ kind: "main", limit: 50 }, d());
    expect(mainOnly.ok && mainOnly.page.items).toHaveLength(0);
    const all = await service.page({ kind: "all", limit: 50 }, d());
    expect(all.ok && all.page.items.some((i) => i.id === "sess-subbbb1")).toBe(true);
    await service.dispose();
  });

  it("q filters by substring against cwd/title/firstMessage", async () => {
    writeFileSync(join(sessionsDir, "d1", "a.jsonl"), header({ id: "sess-aaaa1" }));
    const service = createHistoryService(baseDeps());
    const d = () => createReqDeadline(() => Date.now(), 5000);
    const hit = await service.page({ kind: "all", limit: 50, q: realCwd.slice(-8) }, d());
    expect(hit.ok && hit.page.items).toHaveLength(1);
    const miss = await service.page({ kind: "all", limit: 50, q: "no-such-substring-xyz" }, d());
    expect(miss.ok && miss.page.items).toHaveLength(0);
    await service.dispose();
  });

  it("a header-less/invalid file never appears as a row and is counted in stats.invalid", async () => {
    writeFileSync(join(sessionsDir, "d1", "bad.jsonl"), "not even json\n");
    const service = createHistoryService(baseDeps());
    const result = await service.page(
      { kind: "all", limit: 50 },
      createReqDeadline(() => Date.now(), 5000),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.page.items).toHaveLength(0);
    expect(result.page.stats.invalid).toBeGreaterThanOrEqual(1);
    await service.dispose();
  });

  it("cwdState reflects a gone directory", async () => {
    writeFileSync(
      join(sessionsDir, "d1", "a.jsonl"),
      header({ id: "sess-aaaa1", cwd: "/definitely/not/a/real/path/xyz" }),
    );
    const service = createHistoryService(baseDeps());
    const result = await service.page(
      { kind: "all", limit: 50 },
      createReqDeadline(() => Date.now(), 5000),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.page.items[0]?.cwdState).toBe("gone");
    expect(result.page.items[0]?.blocked).toBe("gone");
    expect(result.page.items[0]?.startable).toBe(false);
    await service.dispose();
  });

  it("pagination: mtime-desc sort when the gen completes within a single advance (PD23)", async () => {
    writeFileSync(join(sessionsDir, "d1", "a.jsonl"), header({ id: "sess-aaaa1" }));
    await new Promise((r) => setTimeout(r, 5));
    writeFileSync(join(sessionsDir, "d1", "b.jsonl"), header({ id: "sess-bbbb1" }));
    const service = createHistoryService(baseDeps());
    const result = await service.page(
      { kind: "all", limit: 50 },
      createReqDeadline(() => Date.now(), 5000),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.page.items.map((i) => i.id)).toEqual(["sess-bbbb1", "sess-aaaa1"]);
    await service.dispose();
  });
});

describe("createHistoryService.resolve/prove/verifyForSpawn/snapshot/verifySnapshot", () => {
  // prove()/reprove() do a REAL /proc scan by default — on a dev box that may see unrelated
  // real `pi` processes under the same uid (including the one running this very test!), so
  // every test that checks `prove()`'s verdict injects an EMPTY procFs seam to stay deterministic.
  const emptyProcSeam = { procFs: { readdirProc: () => Promise.resolve([]) } };

  it("round-trips a valid session", async () => {
    writeFileSync(join(sessionsDir, "d1", "a.jsonl"), header({ id: "sess-aaaa1" }) + MAIN_MARKER);
    const service = createHistoryService(baseDeps(), emptyProcSeam);
    const d = () => createReqDeadline(() => Date.now(), 5000);
    const resolved = await service.resolve({ key: "d1/a.jsonl", id: "sess-aaaa1" }, realCwd, d());
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    const proof = await service.prove(resolved.pin, d());
    expect(proof.free).toBe(true);
    expect(service.verifyForSpawn(resolved.pin)).toEqual({ ok: true });
    const snap = await service.snapshot(resolved.pin, d());
    expect(snap.ok).toBe(true);
    if (snap.ok) {
      expect(service.verifySnapshot(snap.snapshot)).toBe(true);
      expect(readFileSync(snap.snapshot.path, "utf8")).toContain("sess-aaaa1");
    }
    resolved.pin.release();
    await service.dispose();
  });

  it("a card reporting the same sessionId makes prove report occupied", async () => {
    writeFileSync(join(sessionsDir, "d1", "a.jsonl"), header({ id: "sess-aaaa1" }) + MAIN_MARKER);
    const card = {
      agentKey: "k1",
      kind: "rpc" as const,
      pid: 55,
      cwd: realCwd,
      state: "live" as const,
      pluginVersion: "1",
      outdated: false,
      prompts: [],
      agentId: { pid: 55, nonce: "n" },
      connectedAt: 0,
      lastFrameAt: 0,
      seq: 0,
      session: { sessionId: "sess-aaaa1", cwd: realCwd, reason: "ok", leafId: null, mode: "rpc" as const },
    };
    const service = createHistoryService(baseDeps({ registry: { list: () => [card] } }), emptyProcSeam);
    const d = () => createReqDeadline(() => Date.now(), 5000);
    const resolved = await service.resolve({ key: "d1/a.jsonl", id: "sess-aaaa1" }, realCwd, d());
    if (!resolved.ok) throw new Error("unreachable");
    const proof = await service.prove(resolved.pin, d());
    expect(proof.free).toBe(false);
    resolved.pin.release();
    await service.dispose();
  });
});

describe("createHistoryService.diag", () => {
  it("no seams injected ⇒ default sources; fds start at 0", async () => {
    const service = createHistoryService(baseDeps());
    const diag = service.diag();
    expect(diag).toMatchObject({ procFsSource: "default", fsSource: "default" });
    expect(diag.fds).toEqual({ gen: 0, pin: 0, temp: 0, max: 32 });
    await service.dispose();
  });

  it("injecting a procFs/fs seam reports 'seam'", async () => {
    const service = createHistoryService(baseDeps(), { fs: {}, procFs: {} });
    expect(service.diag()).toMatchObject({ procFsSource: "seam", fsSource: "seam" });
    await service.dispose();
  });
});

describe("createHistoryService.dispose (X3 #4)", () => {
  it("is idempotent and returns the SAME promise on repeated calls", async () => {
    const service = createHistoryService(baseDeps());
    const p1 = service.dispose();
    const p2 = service.dispose();
    expect(p1).toBe(p2);
    await p1;
  });

  it("after dispose(), page/resolve/prove/snapshot degrade instead of hanging; verifyForSpawn fails closed", async () => {
    writeFileSync(join(sessionsDir, "d1", "a.jsonl"), header({ id: "sess-aaaa1" }));
    const service = createHistoryService(baseDeps());
    const d = () => createReqDeadline(() => Date.now(), 5000);
    const resolved = await service.resolve({ key: "d1/a.jsonl", id: "sess-aaaa1" }, realCwd, d());
    if (!resolved.ok) throw new Error("unreachable");
    await service.dispose();

    const page = await service.page({ kind: "all", limit: 50 }, d());
    expect(page.ok).toBe(true);
    if (page.ok) expect(page.page.partial).toEqual({ reason: "zombie" });

    const resolve2 = await service.resolve({ key: "d1/a.jsonl", id: "sess-aaaa1" }, realCwd, d());
    expect(resolve2).toMatchObject({ ok: false, status: 504, code: "E_DEADLINE" });

    const proof = await service.prove(resolved.pin, d());
    expect(proof).toMatchObject({ free: false, reason: "unverified", gap: "proc-partial" });

    expect(service.verifyForSpawn(resolved.pin)).toEqual({ ok: false, reason: "session-changed" });

    const snap = await service.snapshot(resolved.pin, d());
    expect(snap).toMatchObject({ ok: false, status: 504 });
  });

  it("force-releases outstanding pins (fd ledger returns to 0)", async () => {
    writeFileSync(join(sessionsDir, "d1", "a.jsonl"), header({ id: "sess-aaaa1" }));
    const service = createHistoryService(baseDeps());
    const d = () => createReqDeadline(() => Date.now(), 5000);
    const resolved = await service.resolve({ key: "d1/a.jsonl", id: "sess-aaaa1" }, realCwd, d());
    if (!resolved.ok) throw new Error("unreachable");
    expect(service.diag().fds.pin).toBeGreaterThan(0);
    await service.dispose();
    expect(service.diag().fds.pin).toBe(0);
  });

  it("completes within its bound even with an outstanding lease (does not hang)", async () => {
    const service = createHistoryService(baseDeps());
    const start = Date.now();
    await service.dispose();
    expect(Date.now() - start).toBeLessThan(3000);
  });

  it("verifier round 3 (defect 3c): resolves within HISTORY_DISPOSE_MS + ε even when every force-close hangs", async () => {
    writeFileSync(join(sessionsDir, "d1", "a.jsonl"), header({ id: "sess-aaaa1" }));
    // Only the sessionsRoot fd (the gen's resident rootFd, and the pin's root fd) hangs on
    // close once armed — file/temp closes stay real so the warm-up page/resolve run normally.
    // Awaiting the gen force-close after the hard deadline would push dispose() to ~2.5s +
    // HISTORY_CLOSE_MS ≈ 3.5s (2× with a serial root→pending chain); the bound catches both.
    let hangClose = false;
    const real = defaultHistoryFs();
    const fs: HistoryFs = {
      ...real,
      open: async (p, flags, mode) => {
        const h = await real.open(p, flags, mode);
        if (p !== sessionsDir) return h;
        return {
          fd: h.fd,
          stat: () => h.stat(),
          read: (buf: Buffer, offset: number, length: number, position: number) =>
            h.read(buf, offset, length, position),
          write: (buf: Buffer, offset: number, length: number, position: number) =>
            h.write(buf, offset, length, position),
          truncate: (len: number) => h.truncate(len),
          close: () => {
            void h.close(); // the REAL fd is always closed — only the returned promise hangs
            return hangClose ? new Promise<void>(() => undefined) : Promise.resolve();
          },
        };
      },
    };
    const service = createHistoryService(baseDeps(), { fs });
    const d = () => createReqDeadline(() => Date.now(), 5000);
    await service.page({ kind: "all", limit: 50 }, d()); // creates the gen (resident root fd)
    const resolved = await service.resolve({ key: "d1/a.jsonl", id: "sess-aaaa1" }, realCwd, d());
    expect(resolved.ok).toBe(true);

    hangClose = true;
    const start = Date.now();
    await service.dispose();
    const elapsed = Date.now() - start;
    // the outstanding pin keeps the wait loop alive to the full hard deadline …
    expect(elapsed).toBeGreaterThanOrEqual(HISTORY_DISPOSE_MS - 100);
    // … but the hanging force-closes must NOT be awaited past it (old behavior: ~3.5s+)
    expect(elapsed).toBeLessThan(HISTORY_DISPOSE_MS + 500);
  }, 10_000);

  it("Linux: /proc/self/fd count returns to baseline after dispose(), even with outstanding pin/gen leases", async () => {
    if (process.platform !== "linux") return; // fail-closed skip — no /proc/self/fd elsewhere
    const { readdirSync } = await import("node:fs");
    writeFileSync(join(sessionsDir, "d1", "a.jsonl"), header({ id: "sess-aaaa1" }));
    const baseline = readdirSync("/proc/self/fd").length;
    const service = createHistoryService(baseDeps());
    const d = () => createReqDeadline(() => Date.now(), 5000);
    // page() leaves the gen's resident rootFd open (reused across calls); resolve() leaves 3
    // pin fds open (never released below) — dispose() must force-close every one of them.
    await service.page({ kind: "all", limit: 50 }, d());
    const resolved = await service.resolve({ key: "d1/a.jsonl", id: "sess-aaaa1" }, realCwd, d());
    if (!resolved.ok) throw new Error("unreachable");
    await service.dispose();
    // one more tick for any fire-and-forget bounded close to settle.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const after = readdirSync("/proc/self/fd").length;
    expect(after).toBeLessThanOrEqual(baseline);
  }, 5_000);
});
