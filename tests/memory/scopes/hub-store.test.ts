/**
 * #39 P3a hub-store kernel tests: durable round-trip over the REAL blocks/lock/safe-fs
 * primitives in own /tmp dirs, capacity (reject, never truncate), CAS last-write-wins,
 * capability/child zero-disk refusals, fault-injection half-state DETECTION, audit bounds.
 */
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  chmodSync,
  renameSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  commitHubUserCommandLocked,
  createHubMemoryProvider,
  defaultStoreIo,
  hubHostFingerprint,
  parseHubItemsFile,
  readHubCorpus,
  withHubStoreLock,
  type HubFaultPoints,
  type HubStoreIo,
} from "../../../src/memory/scopes/hub-store.js";
import { checkHubSlot, resolveHubSlot } from "../../../src/memory/scopes/hub-slot.js";
import { createMemoryOpCapRegistry, createHumanTurnTracker } from "../../../src/memory/scopes/op-cap.js";
import type { HubItem, MemoryOwner } from "../../../src/memory/scopes/types.js";

const uid = process.getuid?.() ?? 0;
const homes: string[] = [];
const home = () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-store-"));
  homes.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const owner = (sid = "sess-abcd1234"): MemoryOwner => ({
  incarnation: {},
  sid,
  sessionEpoch: 1,
  branchGen: 0,
});

const counting = (io: HubStoreIo = defaultStoreIo) => {
  const counts = { inspect: 0, stat: 0, realpath: 0, read: 0, write: 0, create: 0, mkdir: 0 };
  return {
    counts,
    io: {
      inspectDir: (p: string) => {
        counts.inspect++;
        return io.inspectDir(p);
      },
      statFile: (p: string) => {
        counts.stat++;
        return io.statFile(p);
      },
      realpath: (p: string) => {
        counts.realpath++;
        return io.realpath(p);
      },
      readUtf8File: (p: string) => {
        counts.read++;
        return io.readUtf8File(p);
      },
      writePrivateFile: (d: string, n: string, t: string) => {
        counts.write++;
        io.writePrivateFile(d, n, t);
      },
      createPrivateFile: (d: string, n: string, t: string) => {
        counts.create++;
        io.createPrivateFile(d, n, t);
      },
      ensureDir: (p: string) => {
        counts.mkdir++;
        io.ensureDir(p);
      },
      fsync: (p: string) => io.fsync(p),
    } satisfies HubStoreIo,
  };
};

const userCreate = (slot: { effectiveStateDir: string; uid: number }, text: string, topic = "general") => {
  if (checkHubSlot(slot) === "absent") defaultStoreIo.ensureDir(join(slot.effectiveStateDir, "hub-memory"));
  return withHubStoreLock(slot, () =>
    commitHubUserCommandLocked(
      { slot, io: defaultStoreIo, now: new Date("2026-11-07T09:00:00.000Z") },
      {
        op: "create",
        topic,
        text,
        src: { project: "abc123def456", label: "proj-label", sid8: "sessab87" },
      },
    ),
  );
};

describe("durable round-trip via real blocks primitives", () => {
  it("user-command create persists a block with the storageScope:hub marker + provenance + audit", async () => {
    const h = home();
    const slot = resolveHubSlot({ launchHome: h, env: {}, getuid: () => uid });
    expect((await userCreate(slot, "first hub item")).ok).toBe(true);
    const read = readHubCorpus(slot, { expectedHost: hubHostFingerprint() });
    expect(read.state).toBe("ok");
    const item: HubItem = read.items[0]!;
    expect(item.id).toBe("general.001");
    expect(item.text).toBe("first hub item");
    expect(item.authority).toBe("user");
    expect(item.grant).toEqual({ via: "command", by: "user" });
    expect(item.src).toEqual({ project: "abc123def456", label: "proj-label", sid8: "sessab87" });
    const blockRaw = readFileSync(join(slot.effectiveStateDir, "hub-memory", "blocks", "general.001.md"), "utf8");
    expect(blockRaw).toContain("storageScope: hub");
    expect(blockRaw).toContain("authority: user");
    const audit = readFileSync(join(slot.effectiveStateDir, "hub-memory", "audit.jsonl"), "utf8");
    expect(audit).toContain('"via":"command"');
    expect(audit).not.toContain("first hub item"); // no bodies in audit
    expect(existsSync(join(slot.effectiveStateDir, "hub-memory", "namespace.json"))).toBe(true);
  });

  it("same slot across two cwds is ONE store; view/render mark this-project by slug", async () => {
    const h = home();
    const slotA = resolveHubSlot({ launchHome: h, env: {}, getuid: () => uid });
    const slotB = resolveHubSlot({ launchHome: h, env: {}, getuid: () => uid }); // another cwd/session
    expect((await userCreate(slotA, "shared")).ok).toBe(true);
    expect(readHubCorpus(slotB, { expectedHost: hubHostFingerprint() }).items).toHaveLength(1);
    const registry = createMemoryOpCapRegistry();
    const provider = createHubMemoryProvider({
      capability: () => "ok",
      registry,
      owner: () => owner(),
      slot: () => slotB,
      currentProjectSlug: () => "abc123def456",
      sessionItems: () => [],
    });
    const view = provider.view();
    expect(view.state).toBe("ok");
    expect(provider.render()).toContain("src=this-project");
    const other = createHubMemoryProvider({
      capability: () => "ok",
      registry,
      owner: () => owner(),
      slot: () => slotB,
      currentProjectSlug: () => "000000000000",
    });
    expect(other.render()).toContain("src=other#abc123");
  });

  it("update/delete are CAS: stale expectRev ⇒ E_CONFLICT, disk unchanged", async () => {
    const h = home();
    const slot = resolveHubSlot({ launchHome: h, env: {}, getuid: () => uid });
    const created = await userCreate(slot, "v1");
    expect(created.ok).toBe(true);
    const rev = created.ok ? (created.rev ?? "") : "";
    const stale = await withHubStoreLock(slot, () =>
      commitHubUserCommandLocked(
        { slot, io: defaultStoreIo, now: new Date("2026-11-07T09:01:00.000Z") },
        {
          op: "update",
          targetId: "general.001",
          text: "v2-wrong",
          expectRev: "deadbeef",
          src: { project: "", label: "l", sid8: "s" },
        },
      ),
    );
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe("E_CONFLICT");
    expect(readHubCorpus(slot, { expectedHost: hubHostFingerprint() }).items[0]!.text).toBe("v1");
    const ok = await withHubStoreLock(slot, () =>
      commitHubUserCommandLocked(
        { slot, io: defaultStoreIo, now: new Date("2026-11-07T09:02:00.000Z") },
        {
          op: "update",
          targetId: "general.001",
          text: "v2",
          expectRev: rev,
          src: { project: "", label: "l", sid8: "s" },
        },
      ),
    );
    expect(ok.ok).toBe(true);
    const read = readHubCorpus(slot, { expectedHost: hubHostFingerprint() });
    expect(read.items[0]!.text).toBe("v2");
    expect(read.items[0]!.grant).toEqual({ via: "command", by: "user" }); // provenance refreshed, not stale
    const del = await withHubStoreLock(slot, () =>
      commitHubUserCommandLocked(
        { slot, io: defaultStoreIo, now: new Date("2026-11-07T09:03:00.000Z") },
        {
          op: "delete",
          targetId: "general.001",
          expectRev: ok.ok ? (ok.rev ?? "") : "",
          src: { project: "", label: "l", sid8: "s" },
        },
      ),
    );
    expect(del.ok).toBe(true);
    expect(readHubCorpus(slot, { expectedHost: hubHostFingerprint() }).items).toHaveLength(0);
    expect(readdirSync(join(slot.effectiveStateDir, "hub-memory", "blocks", ".trash")).length).toBe(1);
  });
});

describe("capacity: reject, never truncate", () => {
  it("33rd item ⇒ E_FULL; single body >1024B ⇒ E_TOO_LARGE with disk untouched", async () => {
    const h = home();
    const slot = resolveHubSlot({ launchHome: h, env: {}, getuid: () => uid });
    for (let i = 1; i <= 32; i++) expect((await userCreate(slot, `item-${i}`)).ok).toBe(true);
    expect(readHubCorpus(slot, { expectedHost: hubHostFingerprint() }).items).toHaveLength(32);
    const over = await userCreate(slot, "item-33");
    expect(over.ok).toBe(false);
    expect(over).toMatchObject({ ok: false, code: "E_FULL", message: expect.stringContaining("all 32 item slots") });
    expect(readHubCorpus(slot, { expectedHost: hubHostFingerprint() }).items).toHaveLength(32);
    const big = "x".repeat(1025);
    const h2 = home();
    const slot2 = resolveHubSlot({ launchHome: h2, env: {}, getuid: () => uid });
    if (checkHubSlot(slot2) === "absent") defaultStoreIo.ensureDir(join(slot2.effectiveStateDir, "hub-memory"));
    const tooLarge = await withHubStoreLock(slot2, () =>
      commitHubUserCommandLocked(
        { slot: slot2, io: defaultStoreIo, now: new Date() },
        { op: "create", topic: "general", text: big, src: { project: "", label: "l", sid8: "s" } },
      ),
    );
    expect(tooLarge.ok).toBe(false);
    expect(tooLarge).toMatchObject({
      ok: false,
      code: "E_TOO_LARGE",
      message: expect.stringContaining("1024 UTF-8 body bytes"),
    });
    expect(checkHubSlot(slot2)).toBe("absent"); // nothing was created on a size rejection
  });

  it("body budget 4096B: 4×1024 ok, one more byte ⇒ E_FULL", async () => {
    const h = home();
    const slot = resolveHubSlot({ launchHome: h, env: {}, getuid: () => uid });
    for (let i = 1; i <= 4; i++) expect((await userCreate(slot, "y".repeat(1024))).ok).toBe(true);
    const over = await userCreate(slot, "z");
    expect(over.ok).toBe(false);
    expect(over).toMatchObject({ ok: false, code: "E_FULL", message: expect.stringContaining("total body budget") });
    expect(readHubCorpus(slot, { expectedHost: hubHostFingerprint() }).items.map((item) => item.text)).toEqual(
      Array(4).fill("y".repeat(1024)),
    );
  });
});

describe("fail-closed refusals with ZERO disk", () => {
  it("capability unknown/disabled/secure/locked ⇒ view disabled, enqueue refused, io untouched", async () => {
    const h = home();
    const slot = resolveHubSlot({ launchHome: h, env: {}, getuid: () => uid });
    for (const capability of ["unknown", "disabled", "secure", "locked"] as const) {
      const wrap = counting();
      const tracker = createHumanTurnTracker();
      const registry = createMemoryOpCapRegistry(() => tracker.current());
      const provider = createHubMemoryProvider({
        capability: () => capability,
        registry,
        owner: () => owner(),
        slot: () => slot,
        io: wrap.io,
      });
      expect(provider.view()).toEqual({ items: [], state: "disabled", reason: capability });
      const result = await provider.enqueue({
        operation: { storageScope: "hub", authority: "user", op: "create", topic: "general", text: "x" },
        owner: owner(),
        cap: {} as never,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("E_SCOPE_DISABLED");
      expect(wrap.counts).toEqual({ inspect: 0, stat: 0, realpath: 0, read: 0, write: 0, create: 0, mkdir: 0 });
    }
  });

  it("child sessions are hard-refused (E_CHILD_READONLY) even though a cap exists", async () => {
    const h = home();
    const slot = resolveHubSlot({ launchHome: h, env: {}, getuid: () => uid });
    const wrap = counting();
    const tracker = createHumanTurnTracker();
    const registry = createMemoryOpCapRegistry(() => tracker.current());
    tracker.noteInteractive(owner());
    const provider = createHubMemoryProvider({
      capability: () => "ok",
      registry,
      owner: () => owner(),
      slot: () => slot,
      isChildSession: () => true,
      io: wrap.io,
    });
    const result = await provider.enqueue({
      operation: { storageScope: "hub", authority: "user", op: "create", topic: "general", text: "child tries" },
      owner: owner(),
      cap: {} as never,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("E_CHILD_READONLY");
    expect(wrap.counts.inspect).toBe(0);
  });
});

describe("fault injection: torn states are DETECTED (never silently wrong)", () => {
  const inject = (faults: HubFaultPoints) => {
    const h = home();
    const slot = resolveHubSlot({ launchHome: h, env: {}, getuid: () => uid });
    defaultStoreIo.ensureDir(join(slot.effectiveStateDir, "hub-memory"));
    const attempt = withHubStoreLock(slot, () =>
      commitHubUserCommandLocked(
        { slot, io: defaultStoreIo, now: new Date(), faults },
        { op: "create", topic: "general", text: "torn", src: { project: "", label: "l", sid8: "s" } },
      ),
    );
    return { slot, attempt };
  };

  it("crash before the namespace seal ⇒ half-state ⇒ inert, adopt-only; retry still refuses", async () => {
    const { slot, attempt } = inject({
      beforeNamespaceSeal: () => {
        throw new Error("simulated crash before seal");
      },
    });
    const result = await attempt;
    expect(result.ok).toBe(false);
    const check = checkHubSlot(slot);
    expect(check).not.toBe("ok");
    const read = readHubCorpus(slot, { expectedHost: hubHostFingerprint() });
    expect(read.state).toBe("inert");
    expect(read.items).toHaveLength(0);
    const retry = await withHubStoreLock(slot, () =>
      commitHubUserCommandLocked(
        { slot, io: defaultStoreIo, now: new Date() },
        { op: "create", topic: "general", text: "after crash", src: { project: "", label: "l", sid8: "s" } },
      ),
    );
    expect(retry.ok).toBe(false);
    if (!retry.ok) expect(retry.code).toBe("E_NAMESPACE");
  });

  it("a fault AFTER the full seal leaves a consistent EMPTY store (ok), writable again", async () => {
    const { slot, attempt } = inject({
      afterNamespace: () => {
        throw new Error("simulated crash after seal");
      },
    });
    expect((await attempt).ok).toBe(false);
    expect(checkHubSlot(slot)).toBe("ok");
    expect(readHubCorpus(slot, { expectedHost: hubHostFingerprint() }).state).toBe("ok");
    expect((await userCreate(slot, "works after clean init")).ok).toBe(true);
  });

  it("crash after block write ⇒ provenance half-state detected on read (inert, not misattributed)", async () => {
    const { slot, attempt } = inject({
      afterBlockWrite: () => {
        throw new Error("simulated crash after block");
      },
    });
    const result = await attempt;
    expect(result.ok).toBe(false);
    const read = readHubCorpus(slot, { expectedHost: hubHostFingerprint() });
    expect(read.state).toBe("inert");
    // The block FILE exists but the store refuses to render it without provenance.
    expect(existsSync(join(slot.effectiveStateDir, "hub-memory", "blocks", "general.001.md"))).toBe(true);
  });

  it("no file outside <stateDir>/hub-memory is ever created", async () => {
    const h = home();
    const slot = resolveHubSlot({ launchHome: h, env: {}, getuid: () => uid });
    await userCreate(slot, "containment");
    const top = readdirSync(h);
    expect(top).toEqual([".pi"]);
    expect(readdirSync(join(h, ".pi", "agent"))).toEqual(["web-hub"]);
  });
});

describe("untrusted sidecar parsing", () => {
  it("corrupt/foreign items.json ⇒ inert (fail closed)", () => {
    const parsed = parseHubItemsFile('{"v":1,"items":{"general.001":{"grant":{"via":"command","by":"agent"}}}}');
    expect(parsed).toBeUndefined(); // command grants must be by user
    expect(parseHubItemsFile("nope")).toBeUndefined();
    expect(parseHubItemsFile('{"v":1,"items":{}}')!.items.size).toBe(0);
  });

  it("tampered items.json on disk ⇒ read inert, write refused", async () => {
    const h = home();
    const slot = resolveHubSlot({ launchHome: h, env: {}, getuid: () => uid });
    await userCreate(slot, "seed");
    writeFileSync(join(slot.effectiveStateDir, "hub-memory", "items.json"), "tampered", { mode: 0o600 });
    expect(readHubCorpus(slot, { expectedHost: hubHostFingerprint() }).state).toBe("inert");
    const refused = await userCreate(slot, "second");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe("E_NAMESPACE");
  });
});

// Regression gates for the independent review; every file is an own mkdtemp tree.
describe("review fixes: revision binding, source validation and bounded history", () => {
  const now = new Date("2026-11-07T09:00:00.000Z");
  const src = { project: "abc123", label: "test", sid8: "session" };
  const makeSlot = () => resolveHubSlot({ launchHome: home(), env: {}, getuid: () => uid });
  const command = (
    slot: ReturnType<typeof makeSlot>,
    req: Parameters<typeof commitHubUserCommandLocked>[1],
    io = defaultStoreIo,
    faults?: HubFaultPoints,
  ) => withHubStoreLock(slot, () => commitHubUserCommandLocked({ slot, io, now, ...(faults ? { faults } : {}) }, req));

  it.each(["throw-before-sidecar", "throw-after-block", "write-then-throw"])(
    "same-millisecond update interruption %s never renders mismatched new body",
    async (fault) => {
      const slot = makeSlot();
      const created = await userCreate(slot, "old body");
      if (!created.ok || !created.rev) throw new Error("create failed");
      const root = join(slot.effectiveStateDir, "hub-memory");
      const io: HubStoreIo = {
        ...defaultStoreIo,
        writePrivateFile(d, n, t) {
          if (n === "items.json") {
            if (fault === "write-then-throw") defaultStoreIo.writePrivateFile(d, n, t);
            throw new Error("sidecar write failure");
          }
          defaultStoreIo.writePrivateFile(d, n, t);
        },
      };
      const result = await command(
        slot,
        { op: "update", targetId: created.id, expectRev: created.rev, text: "NEW BODY", src },
        io,
        fault === "throw-after-block"
          ? {
              afterBlockWrite: () => {
                throw new Error("after block");
              },
            }
          : undefined,
      );
      expect(result).toEqual({ ok: false, code: "E_PERSIST_UNKNOWN" });
      const read = readHubCorpus(slot);
      if (fault === "write-then-throw") {
        // The callback MAY have committed both files: explicitly unknown to the caller, no blind retry.
        expect(read.state).toBe("ok");
        expect(read.items[0]!.src).toEqual(src);
        expect(read.items[0]!.text).toBe("NEW BODY");
      } else {
        expect(read).toMatchObject({ state: "inert", items: [] });
        expect(readFileSync(join(root, "blocks", `${created.id}.md`), "utf8")).toContain("NEW BODY");
      }
      expect(readFileSync(join(root, "audit.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
    },
  );

  it.each(["body", "missing-rev", "stale-rev", "stale-updated", "missing-entry", "missing-file"])(
    "fails closed on %s sidecar/block mismatch",
    async (fault) => {
      const slot = makeSlot();
      expect((await userCreate(slot, "original")).ok).toBe(true);
      const root = join(slot.effectiveStateDir, "hub-memory");
      const path = join(root, "items.json");
      const file = JSON.parse(readFileSync(path, "utf8"));
      if (fault === "body") {
        const block = join(root, "blocks", "general.001.md");
        writeFileSync(block, readFileSync(block, "utf8").replace("original", "edited!!"));
      } else if (fault === "missing-file") rmSync(path);
      else {
        if (fault === "missing-rev") delete file.items["general.001"].rev;
        if (fault === "stale-rev") file.items["general.001"].rev = "1-000000";
        if (fault === "stale-updated") file.items["general.001"].updated = "2026-11-07T08:59:59.999Z";
        if (fault === "missing-entry") delete file.items["general.001"];
        writeFileSync(path, JSON.stringify(file));
      }
      expect(readHubCorpus(slot)).toMatchObject({ state: "inert", items: [] });
      const provider = createHubMemoryProvider({
        capability: () => "ok",
        registry: createMemoryOpCapRegistry(),
        owner: () => owner(),
        slot: () => slot,
      });
      expect(provider.render()).toBe("");
    },
  );

  it("valid source boundaries roundtrip; invalid fields and getters reject before ALL IO", async () => {
    for (const project of ["", "a", "0123456789abcdef"]) {
      const slot = makeSlot();
      defaultStoreIo.ensureDir(join(slot.effectiveStateDir, "hub-memory"));
      const source = { project, sid8: "a_-12345", label: "界".repeat(13) + "a" };
      expect((await command(slot, { op: "create", topic: "t", text: "x", src: source })).ok).toBe(true);
      expect(readHubCorpus(slot).items[0]!.src).toEqual(source);
    }
    let getterCalls = 0;
    const badSources = [
      { ...src, project: "p" },
      { ...src, project: "a".repeat(17) },
      { ...src, project: "ABC" },
      { ...src, sid8: "" },
      { ...src, sid8: "123456789" },
      { ...src, label: "界".repeat(14) },
      { ...src, label: "bad\nlabel" },
      { ...src, extra: "not allowed" },
      {
        ...src,
        get label() {
          getterCalls++;
          return "unsafe";
        },
      },
    ];
    for (const source of badSources) {
      const slot = makeSlot();
      const wrap = counting();
      const result = commitHubUserCommandLocked(
        { slot, io: wrap.io, now },
        { op: "create", topic: "t", text: "x", src: source },
      );
      expect(result).toEqual({ ok: false, code: "E_META_INVALID" });
      expect(Object.values(wrap.counts).every((n) => n === 0)).toBe(true);
      expect(readdirSync(slot.effectiveStateDir.split("/.pi/")[0]!)).toEqual([]);
    }
    const slot = makeSlot();
    const wrap = counting();
    const request = {
      op: "create",
      topic: "t",
      text: "x",
      get src() {
        getterCalls++;
        return src;
      },
    } as const;
    expect(commitHubUserCommandLocked({ slot, io: wrap.io, now }, request)).toEqual({
      ok: false,
      code: "E_META_INVALID",
    });
    expect(Object.values(wrap.counts).every((n) => n === 0)).toBe(true);
    expect(getterCalls).toBe(0);
  });

  it("over 256 distinct churn entries preserve early live provenance and persist exactly the audit tail at fixed clock", async () => {
    const slot = makeSlot();
    expect((await userCreate(slot, "EARLY LIVE")).ok).toBe(true);
    const root = join(slot.effectiveStateDir, "hub-memory");
    for (let i = 0; i < 260; i++) {
      const created = await userCreate(slot, `churn-${i}`);
      if (!created.ok || !created.rev) throw new Error(`create ${i} failed`);
      expect((await command(slot, { op: "delete", targetId: created.id, expectRev: created.rev, src })).ok).toBe(true);
    }
    const read = readHubCorpus(slot);
    expect(read.state).toBe("ok");
    expect(read.items.map((item) => item.text)).toEqual(["EARLY LIVE"]);
    const sidecar = parseHubItemsFile(readFileSync(join(root, "items.json"), "utf8"))!;
    expect([...sidecar.items.keys()]).toEqual(["general.001"]);
    const audit = readFileSync(join(root, "audit.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(audit).toHaveLength(256); // 521 total operations, last 256 persisted, not just an in-memory cap
    expect(audit[0]).toMatchObject({ op: "create", id: "", at: now.toISOString() });
    expect(audit[1]).toMatchObject({ op: "delete", id: "general.134" });
    expect(audit[255]).toMatchObject({ op: "delete", id: "general.261", at: now.toISOString() });
    expect(audit.every((line) => line.at === now.toISOString())).toBe(true);
    expect(JSON.stringify(audit)).not.toContain("EARLY LIVE");
    expect(JSON.stringify(audit)).not.toContain("churn-");
  });

  it("namespace initialization independently rechecks actual directory uid, not its JSON stamp", async () => {
    const slot = makeSlot();
    const root = join(slot.effectiveStateDir, "hub-memory");
    defaultStoreIo.ensureDir(root);
    let wrongUid = false;
    const io: HubStoreIo = {
      ...defaultStoreIo,
      inspectDir(p) {
        const st = defaultStoreIo.inspectDir(p);
        return wrongUid && p === root && st && st !== "not-dir" ? { ...st, uid: uid + 1 } : st;
      },
    };
    const result = await command(slot, { op: "create", topic: "t", text: "not written", src }, io, {
      beforeInit: () => {
        wrongUid = true;
      },
    });
    expect(result).toEqual({ ok: false, code: "E_NAMESPACE" });
    expect(existsSync(join(root, "namespace.json"))).toBe(false);
    expect(existsSync(join(root, "blocks"))).toBe(false);
  });

  it.each(["chmod", "inode", "state-inode", "seal-chmod"])(
    "directory %s change at mutation boundary is E_NAMESPACE with zero new block bodies",
    async (fault) => {
      const slot = makeSlot();
      const root = join(slot.effectiveStateDir, "hub-memory");
      defaultStoreIo.ensureDir(root);
      const alter = () => {
        if (fault === "chmod" || fault === "seal-chmod") chmodSync(join(root, "blocks"), 0o777);
        else {
          const path = fault === "inode" ? join(root, "blocks") : slot.effectiveStateDir;
          renameSync(path, `${path}-old`);
          mkdirSync(path, { mode: 0o700 });
        }
      };
      const result = await command(
        slot,
        { op: "create", topic: "t", text: "SHOULD NOT LAND", src },
        defaultStoreIo,
        fault === "seal-chmod" ? { beforeNamespaceSeal: alter } : { beforeBlockWrite: alter },
      );
      expect(result).toEqual({ ok: false, code: "E_NAMESPACE" });
      expect(existsSync(join(root, "blocks", "t.001.md"))).toBe(false);
    },
  );
});
