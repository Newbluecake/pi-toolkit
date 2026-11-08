import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
  rmSync,
  symlinkSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createGovernanceMarkers,
  type GovernanceMarkersSnapshot,
  type FirstUserReviewMarker,
} from "../../../src/memory/govern/markers.js";
import {
  JEV_GOVERNANCE_FIRST_USER_REVIEW_MARKER as REVIEW,
  JEV_GOVERNANCE_RELOAD_REMINDER_MARKER as RELOAD,
} from "../../../src/memory/jev/contracts.js";
import * as fs from "../../../src/memory/safe-fs.js";

const roots: string[] = [];
const runId = "20261108T090000000Z-123-abcdef";
const at = "2026-11-08T09:00:00.000Z";
const completed: FirstUserReviewMarker = {
  completedAt: at,
  corpusFp: "fp",
  policy: "bounded-neighbours-v1",
  eligibleUsers: 40,
  selectedUsers: 32,
  reviewedPairs: 61,
};
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "govern-markers-"));
  roots.push(dir);
  mkdirSync(join(dir, "blocks"));
  layout(dir);
  return dir;
}
function layout(dir: string, gen = 1, id = runId) {
  writeFileSync(join(dir, "blocks/.layout.json"), JSON.stringify({ v: 1, source: "migrate", gen, runId: id }));
}
function path(dir: string) {
  return join(dir, "blocks/.jev/governance-markers.json");
}
function raw(dir: string, value: string) {
  mkdirSync(join(dir, "blocks/.jev"), { recursive: true });
  writeFileSync(path(dir), value);
}
function snapshot(owner: ReturnType<typeof createGovernanceMarkers>): GovernanceMarkersSnapshot {
  const s = owner.read();
  if (s.state === "invalid" || s.state === "unavailable") throw new Error(JSON.stringify(s));
  return s;
}
function data(markers: object = {}, gen = 1) {
  return { v: 1, migration: { gen, runId }, markers };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("first write/reopen keeps both markers, mode 0600, and CAS rejects a stale snapshot", async () => {
  const dir = setup(),
    owner = createGovernanceMarkers(dir, { now: () => new Date(at) });
  const before = snapshot(owner);
  expect(before.state).toBe("missing");
  expect(existsSync(join(dir, "blocks/.jev"))).toBe(false);
  expect(await owner.writeFirstUserReview(before, completed)).toEqual({ status: "written" });
  const notify = vi.fn();
  expect(await owner.deliverReloadReminder(notify)).toEqual({ status: "delivered" });
  expect(notify).toHaveBeenCalledWith("memory: migrated block memory — /reload to refresh memory");
  expect(JSON.parse(readFileSync(path(dir), "utf8"))).toEqual(
    data({ [REVIEW]: completed, [RELOAD]: { deliveredAt: at } }),
  );
  const reopened = createGovernanceMarkers(dir);
  expect(snapshot(reopened).markers[REVIEW]).toEqual(completed);
  expect((await reopened.deliverReloadReminder(notify)).status).toBe("already-delivered");
  expect(notify).toHaveBeenCalledTimes(1);
  expect(await owner.writeFirstUserReview(before, { ...completed, corpusFp: "stale" })).toEqual({
    status: "rejected",
    reason: "E_CONFLICT",
  });
  const live = snapshot(reopened);
  expect((await reopened.writeFirstUserReview(live, { ...completed, corpusFp: "changed" })).status).toBe("written");
  expect(snapshot(reopened).markers[RELOAD]).toEqual({ deliveredAt: at });
  expect(statSync(path(dir)).mode & 0o777).toBe(0o600);
  expect(readdirSync(join(dir, "blocks/.jev"))).toEqual(["governance-markers.json"]);
});

it.each(["gen", "runId"])(
  "%s change invalidates markers; replaces old generation instead of appending history",
  async (change) => {
    const dir = setup(),
      owner = createGovernanceMarkers(dir),
      notify = vi.fn();
    await owner.writeFirstUserReview(snapshot(owner), completed);
    await owner.deliverReloadReminder(notify);
    const old = snapshot(owner);
    layout(dir, change === "gen" ? 2 : 1, change === "runId" ? runId.replace("abcdef", "123456") : runId);
    expect(snapshot(owner)).toMatchObject({ state: "different-generation", markers: {} });
    expect((await owner.writeFirstUserReview(old, completed)).reason).toBe("E_CONFLICT");
    expect((await owner.deliverReloadReminder(notify)).status).toBe("delivered");
    expect(notify).toHaveBeenCalledTimes(2);
    expect(Object.keys(JSON.parse(readFileSync(path(dir), "utf8")))).toEqual(["v", "migration", "markers"]);
    expect(snapshot(owner).markers[REVIEW]).toBeUndefined();
  },
);

it.each([
  "{",
  "null",
  "[]",
  "{}",
  JSON.stringify({ ...data(), v: 2 }),
  JSON.stringify({ ...data(), migration: { gen: -1, runId } }),
  JSON.stringify({ ...data(), migration: { gen: "1", runId } }),
  JSON.stringify({ ...data(), migration: { gen: 1, runId: "" } }),
  JSON.stringify({ ...data(), migration: { gen: 1, runId: "../unsafe" } }),
  JSON.stringify({ ...data(), markers: [] }),
  JSON.stringify(data({ [RELOAD]: true })),
  JSON.stringify(data({ [RELOAD]: { deliveredAt: 123 } })),
  JSON.stringify(data({ [RELOAD]: { deliveredAt: "2026-02-30T09:00:00.000Z" } })),
  JSON.stringify(data({ [RELOAD]: { deliveredAt: at, body: "not allowed" } })),
  JSON.stringify(data({ [REVIEW]: { ...completed, selectedUsers: 33 } })),
  JSON.stringify(data({ [REVIEW]: { ...completed, reviewedPairs: 65 } })),
  JSON.stringify(data({ [REVIEW]: { ...completed, eligibleUsers: 2 } })),
  JSON.stringify(data({ [REVIEW]: { ...completed, eligibleUsers: 1.5 } })),
  JSON.stringify(data({ [REVIEW]: { ...completed, completedAt: null } })),
  JSON.stringify(data({ [REVIEW]: { ...completed, policy: "unknown" } })),
  JSON.stringify(data({ [REVIEW]: { ...completed, corpusFp: "" } })),
  JSON.stringify(data({ future: {} })),
  JSON.stringify({ ...data(), history: [] }),
  " ".repeat(65537),
])("invalid derived file #%# is fail-closed, diagnosed once and never overwritten", async (value) => {
  const dir = setup(),
    diag = vi.fn(),
    notify = vi.fn();
  const owner = createGovernanceMarkers(dir, { diag });
  const missing = snapshot(owner);
  raw(dir, value);
  expect(owner.read().state).toBe("invalid");
  expect((await owner.deliverReloadReminder(notify)).reason).toBe("E_GOVERNANCE_MARKERS_INVALID");
  expect((await owner.writeFirstUserReview(missing, completed)).status).toBe("rejected");
  expect(notify).not.toHaveBeenCalled();
  expect(diag).toHaveBeenCalledTimes(1);
  expect(readFileSync(path(dir), "utf8")).toBe(value);
});

it.each(["file-symlink", "file-directory", "jev-symlink"])("refuses %s without following/removing it", async (kind) => {
  const dir = setup(),
    external = join(dir, "external");
  mkdirSync(external);
  const original = JSON.stringify(data({ [RELOAD]: { deliveredAt: at } }));
  writeFileSync(join(external, "governance-markers.json"), original);
  if (kind === "jev-symlink") symlinkSync(external, join(dir, "blocks/.jev"));
  else {
    mkdirSync(join(dir, "blocks/.jev"));
    if (kind === "file-directory") mkdirSync(path(dir));
    else symlinkSync(join(external, "governance-markers.json"), path(dir));
  }
  const owner = createGovernanceMarkers(dir),
    notify = vi.fn();
  expect(owner.read().state).toBe("invalid");
  expect((await owner.deliverReloadReminder(notify)).status).toBe("skipped");
  expect(notify).not.toHaveBeenCalled();
  expect(readFileSync(join(external, "governance-markers.json"), "utf8")).toBe(original);
});

it("concurrent stale CAS writers do not lose updates; concurrent startup notifies only once", async () => {
  const dir = setup(),
    a = createGovernanceMarkers(dir),
    b = createGovernanceMarkers(dir);
  const first = snapshot(a),
    second = snapshot(b);
  const results = await Promise.all([
    a.writeFirstUserReview(first, completed),
    b.writeFirstUserReview(second, { ...completed, corpusFp: "other" }),
  ]);
  expect(results.map((r) => r.status)).toEqual(["written", "rejected"]);
  expect(results[1]?.reason).toBe("E_CONFLICT");
  const notify = vi.fn();
  // Hold the REAL common lock so both callers capture pre-delivery snapshots.
  expect(fs.lockCreate(dir, { pid: process.pid, host: "test-owner", token: "hold", at: Date.now() })).toBe(true);
  const p = [a.deliverReloadReminder(notify), b.deliverReloadReminder(notify)];
  fs.lockRelease(dir, "hold");
  expect((await Promise.all(p)).map((r) => r.status).sort()).toEqual(["already-delivered", "delivered"]);
  expect(notify).toHaveBeenCalledTimes(1);
  expect(snapshot(b).markers[REVIEW]).toEqual(completed);
});

it("atomic replacement exposes only whole old/new JSON; failure cleans temp and permits retry", async () => {
  const dir = setup(),
    owner = createGovernanceMarkers(dir),
    notify = vi.fn();
  await owner.writeFirstUserReview(snapshot(owner), completed);
  const before = readFileSync(path(dir), "utf8");
  const replace = fs.replaceAtomic;
  const spy = vi.spyOn(fs, "replaceAtomic").mockImplementationOnce((target, tmp, name) => {
    expect(readFileSync(path(dir), "utf8")).toBe(before);
    expect(JSON.parse(readFileSync(join(target, tmp), "utf8")).markers[RELOAD]).toBeDefined();
    expect(name).toBe("governance-markers.json");
    throw new Error("injected disk failure");
  });
  expect((await owner.deliverReloadReminder(notify)).status).toBe("rejected");
  expect(readFileSync(path(dir), "utf8")).toBe(before);
  expect(readdirSync(join(dir, "blocks/.jev"))).toEqual(["governance-markers.json"]);
  spy.mockImplementationOnce((target, tmp, name) => {
    expect(JSON.parse(readFileSync(path(dir), "utf8")).markers[RELOAD]).toBeUndefined();
    replace(target, tmp, name);
    expect(JSON.parse(readFileSync(path(dir), "utf8")).markers[RELOAD]).toBeDefined();
  });
  expect((await owner.deliverReloadReminder(notify)).status).toBe("delivered");
  expect(notify).toHaveBeenCalledTimes(2); // intentional at-least-retry tradeoff, not exactly-once
});

it("no port, throwing or async notify, and gate denial never consume", async () => {
  const dir = setup(),
    owner = createGovernanceMarkers(dir);
  expect((await owner.deliverReloadReminder()).reason).toBe("no-ui");
  expect(
    (
      await owner.deliverReloadReminder(() => {
        throw new Error("UI unavailable");
      })
    ).status,
  ).toBe("rejected");
  expect(
    (
      await owner.deliverReloadReminder(async () => {
        throw new Error("bad async port");
      })
    ).reason,
  ).toBe("E_NOTIFY_ASYNC");
  const notify = vi.fn();
  const denied = createGovernanceMarkers(dir, {
    gate: { capture() {}, check: () => ({ ok: false, reason: "locked" }) },
  });
  expect((await denied.deliverReloadReminder(notify)).reason).toBe("E_WRITE_GATE");
  expect(notify).not.toHaveBeenCalled();
  expect(existsSync(path(dir))).toBe(false);
  expect((await owner.deliverReloadReminder(notify)).status).toBe("delivered");
});

it("abort/epoch revocation before or inside notify does not consume; abort after rename cannot undo", async () => {
  for (const when of ["before", "notify", "epoch", "after"] as const) {
    const dir = setup(),
      abort = new AbortController();
    let current = true;
    const owner = createGovernanceMarkers(dir, { signal: abort.signal, isCurrent: () => current });
    if (when === "before") abort.abort();
    if (when === "after") {
      const replace = fs.replaceAtomic;
      vi.spyOn(fs, "replaceAtomic").mockImplementationOnce((...args) => {
        replace(...args);
        abort.abort();
      });
    }
    const notify = vi.fn(() => {
      if (when === "notify") abort.abort();
      if (when === "epoch") current = false;
    });
    const result = await owner.deliverReloadReminder(notify);
    expect(result.status).toBe(when === "after" ? "delivered" : when === "before" ? "skipped" : "rejected");
    expect(notify).toHaveBeenCalledTimes(when === "before" ? 0 : 1);
    expect(existsSync(path(dir))).toBe(when === "after");
    const next = createGovernanceMarkers(dir);
    expect((await next.deliverReloadReminder(vi.fn())).status).toBe(
      when === "after" ? "already-delivered" : "delivered",
    );
  }
});

it.each(["migration", "directory", "raw-file"])(
  "%s changing during notify fails CAS, never overwrites new state",
  async (change) => {
    const dir = setup(),
      owner = createGovernanceMarkers(dir);
    const result = await owner.deliverReloadReminder(() => {
      if (change === "migration") layout(dir, 2);
      if (change === "directory") {
        renameSync(join(dir, "blocks"), join(dir, "old-blocks"));
        mkdirSync(join(dir, "blocks"));
        layout(dir);
      }
      if (change === "raw-file") raw(dir, JSON.stringify(data({ [REVIEW]: completed })));
    });
    expect(result).toEqual({ status: "rejected", reason: "E_CONFLICT" });
    expect(snapshot(owner).markers[RELOAD]).toBeUndefined();
    if (change === "raw-file") expect(snapshot(owner).markers[REVIEW]).toEqual(completed);
  },
);

it("busy lock and abort while waiting are unconsumed; next natural call retries", async () => {
  const dir = setup(),
    notify = vi.fn();
  fs.lockCreate(dir, { pid: process.pid, host: "test-owner", token: "busy", at: Date.now() });
  const result = await createGovernanceMarkers(dir).deliverReloadReminder(notify);
  expect(result.status).toBe("rejected");
  expect(result.reason).toContain("busy");
  const abort = new AbortController();
  const waiting = createGovernanceMarkers(dir, { signal: abort.signal }).deliverReloadReminder(notify);
  abort.abort();
  fs.lockRelease(dir, "busy");
  expect((await waiting).reason).toBe("E_ABORTED");
  expect(notify).not.toHaveBeenCalled();
  expect(existsSync(path(dir))).toBe(false);
  expect((await createGovernanceMarkers(dir).deliverReloadReminder(notify)).status).toBe("delivered");
});

it("absent memory/blocks, fresh and invalid migration identity never create blocks or sidecars", async () => {
  for (const kind of ["absent-memory", "absent-blocks", "fresh", "invalid-id", "invalid-gen"]) {
    const dir = setup();
    if (kind === "absent-memory") rmSync(dir, { recursive: true });
    else if (kind === "absent-blocks") rmSync(join(dir, "blocks"), { recursive: true });
    else if (kind === "fresh") writeFileSync(join(dir, "blocks/.layout.json"), '{"v":1,"source":"fresh"}');
    else if (kind === "invalid-id") layout(dir, 1, "test");
    else layout(dir, -1);
    const notify = vi.fn();
    expect((await createGovernanceMarkers(dir).deliverReloadReminder(notify)).status).toBe("skipped");
    expect(notify).not.toHaveBeenCalled();
    expect(existsSync(path(dir))).toBe(false);
    if (kind.startsWith("absent")) expect(existsSync(join(dir, "blocks"))).toBe(false);
  }
});

it("bounded reads reject a short valid-JSON prefix and invalid UTF-8; exactly 64KiB is allowed", async () => {
  const dir = setup(),
    owner = createGovernanceMarkers(dir),
    notify = vi.fn();
  const complete = JSON.stringify(data({ [RELOAD]: { deliveredAt: at } }));
  raw(dir, complete + "garbage");
  const head = fs.readRegularHead;
  const spy = vi
    .spyOn(fs, "readRegularHead")
    .mockImplementationOnce((...args) => ({ ...head(...args), text: complete }));
  expect(owner.read().state).toBe("invalid");
  spy.mockRestore();
  writeFileSync(path(dir), Buffer.concat([Buffer.from(complete.slice(0, -1)), Buffer.from([0xff]), Buffer.from("}")]));
  expect(owner.read().state).toBe("invalid");
  raw(dir, JSON.stringify(data()).padEnd(65536, " "));
  expect(owner.read().state).toBe("current");
  expect((await owner.deliverReloadReminder(notify)).status).toBe("delivered");
  expect(notify).toHaveBeenCalledTimes(1);
});

it("a gate-time parent removal cannot bootstrap blocks again", async () => {
  const dir = setup();
  let notified = false;
  const owner = createGovernanceMarkers(dir, {
    gate: {
      capture() {},
      check() {
        if (notified) rmSync(join(dir, "blocks"), { recursive: true, force: true });
        return { ok: true };
      },
    },
  });
  expect(
    (
      await owner.deliverReloadReminder(() => {
        notified = true;
      })
    ).status,
  ).toBe("rejected");
  expect(existsSync(join(dir, "blocks"))).toBe(false);
});
