/**
 * scheduled-reports plan r3 §7.6 (H1) — the hub's budgeted read-only scanner over S1's reader:
 * single scan = chunked session reads with a cooperative 2s deadline, generation fencing, ≤64
 * sessions; ZERO writes (pinned by a file-tree snapshot); root failures degrade the whole scan.
 */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanSessionOne, scanStore } from "../../../src/web-hub/hub/schedule/scan.js";
import { emptyStateFile, type ScheduleStateFile } from "../../../src/schedule/core/spec.js";
import { resolveStoreRoot, sessionDirName } from "../../../src/schedule/core/paths.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function store(): string {
  const d = mkdtempSync(join(tmpdir(), "pwh-sched-scan-"));
  dirs.push(d);
  return d;
}

function put(root: string, sid: string, mutate?: (s: ScheduleStateFile) => void, name = "state.json"): void {
  const dir = join(root, sessionDirName(sid));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const s = emptyStateFile(sid);
  s.rev = 1;
  mutate?.(s);
  writeFileSync(join(dir, name), JSON.stringify(s), { mode: 0o600 });
}

function snapshot(root: string): Map<string, { mode: number; size: number; mtimeMs: number; body?: string }> {
  const out = new Map<string, { mode: number; size: number; mtimeMs: number; body?: string }>();
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else {
        const st = statSync(p);
        out.set(p, {
          mode: st.mode,
          size: st.size,
          mtimeMs: st.mtimeMs,
          ...(p.endsWith("state.json") ? { body: readFileSync(p, "utf8") } : {}),
        });
      }
    }
  };
  walk(root);
  return out;
}

describe("scanStore", () => {
  it("reads every session with a state.json and skips absent/degraded ones cleanly", async () => {
    const root = store();
    put(root, "sid-one");
    put(root, "sid-two", (s) => {
      s.tasks = [];
    });
    mkdirSync(join(root, "sid-empty"), { mode: 0o700 }); // dir but no state.json
    const pinned = resolveStoreRoot(root);
    const r = await scanStore(pinned, {});
    expect(r.rootDegraded).toBeUndefined();
    const ids = r.sessions.map((s) => s.sessionId).sort();
    expect(ids).toEqual(["sid-one", "sid-two"]);
    expect(r.sessions.every((s) => s.read.kind === "ok")).toBe(true);
  });

  it("is READ-ONLY — the file tree is byte-identical after a full scan (incl. degraded input)", async () => {
    const root = store();
    put(root, "sid-one");
    put(root, "sid-bad");
    writeFileSync(join(root, sessionDirName("sid-bad"), "state.json"), "{broken", { mode: 0o600 });
    const before = snapshot(root);
    const pinned = resolveStoreRoot(root);
    const r = await scanStore(pinned, {});
    expect(r.sessions.find((s) => s.sessionId === "sid-bad")!.read.kind).toBe("degraded");
    expect(snapshot(root)).toEqual(before);
  });

  it("caps at 64 session dirs and reports truncation", async () => {
    const root = store();
    for (let i = 0; i < 70; i++) put(root, `sid-${String(i).padStart(3, "0")}`);
    const pinned = resolveStoreRoot(root);
    const r = await scanStore(pinned, {});
    expect(r.sessions).toHaveLength(64);
    expect(r.truncated).toBe(true);
  });

  it("a root that vanished after pinning degrades the whole scan", async () => {
    const root = store();
    put(root, "sid-one");
    const pinned = resolveStoreRoot(root);
    rmSync(root, { recursive: true, force: true });
    const r = await scanStore(pinned, {});
    expect(r.rootDegraded).toBeDefined();
    expect(r.sessions).toEqual([]);
  });

  it("respects the cooperative deadline (partial result, timedOut set)", async () => {
    const root = store();
    for (let i = 0; i < 30; i++) put(root, `sid-${String(i).padStart(3, "0")}`);
    const pinned = resolveStoreRoot(root);
    const r = await scanStore(pinned, { deadlineMs: 0 });
    expect(r.timedOut).toBe(true);
    expect(r.sessions.length).toBeLessThan(30);
    // A later full-deadline scan recovers everything.
    const again = await scanStore(pinned, {});
    expect(again.sessions).toHaveLength(30);
  });

  it("a pass started at the rotation cursor covers the tail FIRST (review r1 #10 fairness)", async () => {
    const root = store();
    for (let i = 0; i < 20; i++) put(root, `sid-${String(i).padStart(3, "0")}`);
    const pinned = resolveStoreRoot(root);
    const rotated = await scanStore(pinned, { startAt: 17, deadlineMs: 60_000 });
    expect(rotated.timedOut).toBe(false);
    const expected = ["sid-017", "sid-018", "sid-019"].concat(
      Array.from({ length: 17 }, (_, i) => `sid-${String(i).padStart(3, "0")}`),
    );
    expect(rotated.sessions.map((s) => s.sessionId)).toEqual(expected);
  });

  it("startAt wraps modulo the listing and an empty store scans clean", async () => {
    const root = store();
    const pinned = resolveStoreRoot(root);
    const empty = await scanStore(pinned, { startAt: 5 });
    expect(empty.sessions).toEqual([]);
    expect(empty.timedOut).toBe(false);
    put(root, "sid-a");
    const one = await scanStore(pinned, { startAt: 9 }); // 9 % 1 = 0
    expect(one.sessions.map((s) => s.sessionId)).toEqual(["sid-a"]);
  });

  it("a stale generation (isCurrent false) abandons its result", async () => {
    const root = store();
    for (let i = 0; i < 10; i++) put(root, `sid-${String(i).padStart(3, "0")}`);
    const pinned = resolveStoreRoot(root);
    const r = await scanStore(pinned, { isCurrent: () => false });
    expect(r.fenced).toBe(true);
    expect(r.sessions).toEqual([]);
  });

  it("a symlinked session directory is refused (degraded), never followed", async () => {
    const root = store();
    const outside = store();
    put(outside, "sid-outside");
    mkdirSync(join(root, "sid-link"), { mode: 0o700 });
    symlinkSync(join(outside, sessionDirName("sid-outside")), join(root, "sid-link", "state.json"));
    const pinned = resolveStoreRoot(root);
    const r = await scanStore(pinned, {});
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0]!.sessionId).toBe("sid-link");
    expect(r.sessions[0]!.read.kind).toBe("degraded");
  });
});

describe("scanSessionOne", () => {
  it("reads exactly one session by id", async () => {
    const root = store();
    put(root, "sid-one");
    const pinned = resolveStoreRoot(root);
    const read = await scanSessionOne(pinned, "sid-one", {});
    expect(read.kind).toBe("ok");
    if (read.kind === "ok") expect(read.state.sessionId).toBe("sid-one");
  });

  it("an unknown session reads as absent", async () => {
    const root = store();
    const pinned = resolveStoreRoot(root);
    expect((await scanSessionOne(pinned, "sid-nope", {})).kind).toBe("absent");
  });
});
