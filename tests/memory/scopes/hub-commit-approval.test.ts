/**
 * #39 P3a hub commit-approval chain: the agent write path goes through the REAL P1
 * pieces (createHumanTurnTracker + createMemoryOpCapRegistry + createOpApprovalPort with
 * an injected fake TUI select — per approved plan the port is production code, only the
 * CHANNEL is faked) and then the P3a kernel commit with the full recheck ladder.
 *
 * Zero-disk is asserted with a counting wrapper over the REAL fs io.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHubMemoryProvider,
  defaultStoreIo,
  hubHostFingerprint,
  type HubStoreIo,
} from "../../../src/memory/scopes/hub-store.js";
import { lockCreate, lockRelease, readProcIdentity, type LockPayload } from "../../../src/memory/safe-fs.js";
import { resolveHubSlot } from "../../../src/memory/scopes/hub-slot.js";
import { createMemoryOpCapRegistry, createHumanTurnTracker } from "../../../src/memory/scopes/op-cap.js";
import { createOpApprovalPort, affirmLabel, REJECT_LABEL } from "../../../src/memory/scopes/authorize.js";
import { bodyTextDigest, scopedOpDigest } from "../../../src/memory/scopes/limits.js";
import type { ApprovalPort, FrozenScopedOp, MemoryOwner, PrivateOpCap } from "../../../src/memory/scopes/types.js";

const uid = process.getuid?.() ?? 0;
const homes: string[] = [];
const home = () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-approval-"));
  homes.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const mkOwner = (sid = "sess-live-001"): MemoryOwner => ({ incarnation: {}, sid, sessionEpoch: 1, branchGen: 0 });

const counting = (io: HubStoreIo = defaultStoreIo) => {
  const counts = { inspect: 0, stat: 0, read: 0, write: 0, create: 0, mkdir: 0, realpath: 0 };
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

/** Real P1 approval stack; only the TUI channel is a fake auto-responder. */
const approvalStack = (answer: "affirm" | "reject") => {
  const tracker = createHumanTurnTracker();
  const registry = createMemoryOpCapRegistry(() => tracker.current());
  const port: ApprovalPort = createOpApprovalPort({
    tracker,
    registry,
    select: async (_title, options) => (answer === "affirm" ? options[1] : options[0]) ?? REJECT_LABEL,
  });
  return { tracker, registry, port };
};

const requestCap = async (
  port: ApprovalPort,
  tracker: ReturnType<typeof createHumanTurnTracker>,
  owner: MemoryOwner,
  operation: FrozenScopedOp & { storageScope: "hub" },
  projectLabel = "pi-toolkit",
) => {
  const turn = tracker.current();
  if (turn === undefined) throw new Error("no human turn");
  return port.request({
    operation,
    binding: {
      owner,
      humanTurn: turn,
      toolCallId: "tc-1",
      nonce: randomBytes(16).toString("hex").slice(0, 32),
      opDigest: scopedOpDigest(operation as unknown as Record<string, unknown>),
      textDigest: bodyTextDigest(operation.text ?? ""),
    },
    projectLabel,
  });
};

describe("full chain: human turn → exact-content approval → cap → durable hub write", () => {
  it("affirmed cap writes once with cap-derived grant/audit and is one-shot", async () => {
    const h = home();
    const slot = resolveHubSlot({ launchHome: h, env: {}, getuid: () => uid });
    const wrap = counting();
    const who = mkOwner();
    const { tracker, registry, port } = approvalStack("affirm");
    tracker.noteInteractive(who);
    const operation = {
      storageScope: "hub",
      authority: "user",
      op: "create",
      topic: "general",
      text: "approved text",
    } as const;
    const approval = await requestCap(port, tracker, who, operation);
    expect(approval.approved).toBe(true);
    const provider = createHubMemoryProvider({
      capability: () => "ok",
      registry,
      owner: () => who,
      slot: () => slot,
      io: wrap.io,
    });
    const result = await provider.enqueue({ operation, owner: who, cap: (approval as { cap: PrivateOpCap }).cap });
    expect(result.ok).toBe(true);
    const view = provider.view();
    expect(view.state).toBe("ok");
    const item = view.items[0]!;
    expect(item.grant.via).toBe("dialog");
    expect(item.grant.by).toBe("agent");
    expect(item.grant.channel).toBe("tui");
    expect(item.grant.turn).toBe(tracker.current()!.id.slice(0, 8));
    expect(item.grant.cap).toMatch(/^[a-f0-9]{8}$/);
    expect(item.src.project).toMatch(/^[a-f0-9]{12}$/);
    // one-shot: the consumed cap can never write again
    const again = await provider.enqueue({ operation, owner: who, cap: (approval as { cap: PrivateOpCap }).cap });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.code).toBe("E_HUB_CAP_STALE");
    expect(provider.view().items).toHaveLength(1);
  });

  it("REJECT ⇒ E_HUB_DECLINED, no cap, zero disk; same turn re-request ⇒ E_HUB_DECLINED_TURN", async () => {
    const h = home();
    const slot = resolveHubSlot({ launchHome: h, env: {}, getuid: () => uid });
    const wrap = counting();
    const who = mkOwner();
    const { tracker, registry, port } = approvalStack("reject");
    tracker.noteInteractive(who);
    const operation = {
      storageScope: "hub",
      authority: "user",
      op: "create",
      topic: "general",
      text: "denied",
    } as const;
    const first = await requestCap(port, tracker, who, operation);
    expect(first).toEqual({ approved: false, code: "E_HUB_DECLINED" });
    const second = await requestCap(port, tracker, who, operation);
    expect(second).toEqual({ approved: false, code: "E_HUB_DECLINED_TURN" });
    expect(wrap.counts.inspect).toBe(0);
    expect(readdirSync(h)).toEqual([]); // nothing created anywhere
  });
});

describe("late/stale permissions can never write", () => {
  const operation = { storageScope: "hub", authority: "user", op: "create", topic: "general", text: "late" } as const;

  it("cap minted, then the turn is invalidated before enqueue ⇒ E_HUB_CAP_STALE, zero disk", async () => {
    const h = home();
    const slot = resolveHubSlot({ launchHome: h, env: {}, getuid: () => uid });
    const wrap = counting();
    const who = mkOwner();
    const { tracker, registry, port } = approvalStack("affirm");
    tracker.noteInteractive(who);
    const approval = await requestCap(port, tracker, who, operation);
    expect(approval.approved).toBe(true);
    tracker.invalidate("input"); // new input kills the turn AND every cap
    const provider = createHubMemoryProvider({
      capability: () => "ok",
      registry,
      owner: () => who,
      slot: () => slot,
      io: wrap.io,
    });
    const result = await provider.enqueue({ operation, owner: who, cap: (approval as { cap: PrivateOpCap }).cap });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("E_HUB_CAP_STALE");
    expect(wrap.counts).toEqual({ inspect: 0, stat: 0, realpath: 0, read: 0, write: 0, create: 0, mkdir: 0 });
  });

  it("owner flips while the write waits for the directory lock ⇒ in-lock recheck fails, zero writes", async () => {
    const h = home();
    const slot = resolveHubSlot({ launchHome: h, env: {}, getuid: () => uid });
    const who = mkOwner();
    const { tracker, registry, port } = approvalStack("affirm");
    tracker.noteInteractive(who);
    const approval = await requestCap(port, tracker, who, operation);
    expect(approval.approved).toBe(true);
    let current = who;
    const provider = createHubMemoryProvider({
      capability: () => "ok",
      registry,
      owner: () => current,
      slot: () => slot,
    });
    // Hold the hub lock with the REAL lock primitive (as a competing process would), so the
    // enqueued write deques, blocks on the lock, and the owner flips while it waits.
    const root = join(slot.effectiveStateDir, "hub-memory");
    defaultStoreIo.ensureDir(root);
    const token = randomBytes(8).toString("hex");
    const identity = readProcIdentity(process.pid);
    const payload: LockPayload = {
      pid: process.pid,
      host: hostname(),
      token,
      at: Date.now(),
      ...(identity?.startTicks !== undefined ? { startTicks: identity.startTicks } : {}),
      ...(identity?.bootId !== undefined ? { bootId: identity.bootId } : {}),
    };
    expect(lockCreate(root, payload)).toBe(true);
    const pending = provider.enqueue({ operation, owner: who, cap: (approval as { cap: PrivateOpCap }).cap });
    await new Promise((resolve) => setTimeout(resolve, 80)); // the write is now waiting on the lock
    current = { ...who, sid: "sess-flipped-99", incarnation: {} }; // session switched mid-flight
    tracker.invalidate("session");
    const release = new Promise<void>((resolve) =>
      setTimeout(() => {
        lockRelease(root, token);
        resolve();
      }, 120),
    );
    const result = await pending;
    await release;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(["E_STALE_SESSION", "E_HUB_CAP_STALE"]).toContain(result.code);
    // The lock may have materialized hub-memory itself, but NO store structure was written.
    expect(existsSync(join(slot.effectiveStateDir, "hub-memory", "blocks"))).toBe(false);
    expect(existsSync(join(slot.effectiveStateDir, "hub-memory", "namespace.json"))).toBe(false);
  });

  it("abort signal before dequeue ⇒ refused, zero disk", async () => {
    const h = home();
    const slot = resolveHubSlot({ launchHome: h, env: {}, getuid: () => uid });
    const wrap = counting();
    const who = mkOwner();
    const { tracker, registry, port } = approvalStack("affirm");
    tracker.noteInteractive(who);
    const approval = await requestCap(port, tracker, who, operation);
    const controller = new AbortController();
    controller.abort();
    const provider = createHubMemoryProvider({
      capability: () => "ok",
      registry,
      owner: () => who,
      slot: () => slot,
      io: wrap.io,
    });
    const result = await provider.enqueue({
      operation,
      owner: who,
      cap: (approval as { cap: PrivateOpCap }).cap,
      signal: controller.signal,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("E_HUB_CAP_STALE");
    expect(wrap.counts.inspect).toBe(0);
  });
});

describe("authority surface", () => {
  it("a hub operation carrying authority:'agent' (or session scope) is refused before any disk", async () => {
    const h = home();
    const slot = resolveHubSlot({ launchHome: h, env: {}, getuid: () => uid });
    const wrap = counting();
    const who = mkOwner();
    const { tracker, registry } = approvalStack("affirm");
    tracker.noteInteractive(who);
    const provider = createHubMemoryProvider({
      capability: () => "ok",
      registry,
      owner: () => who,
      slot: () => slot,
      io: wrap.io,
    });
    const bad = await provider.enqueue({
      operation: { storageScope: "hub", authority: "agent", op: "create", topic: "general", text: "x" } as never,
      owner: who,
      cap: {} as never,
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe("E_AUTHORITY");
    const noCap = await provider.enqueue({
      operation: { storageScope: "hub", authority: "user", op: "create", topic: "general", text: "x" } as never,
      owner: who,
      cap: undefined as never,
    });
    expect(noCap.ok).toBe(false);
    if (!noCap.ok) expect(noCap.code).toBe("E_HUB_CAP_STALE"); // a string/`authority:"user"` grants nothing
    expect(wrap.counts.inspect).toBe(0);
  });
});

describe("review fixes: every observed permission failure permanently revokes its cap", () => {
  const operation = {
    storageScope: "hub",
    authority: "user",
    op: "create",
    topic: "general",
    text: "must not write",
  } as const;

  it.each(["owner", "turn", "capability", "gate", "abort"])(
    "%s changes while waiting for lock; restoring conditions cannot resurrect the cap",
    async (reason) => {
      const slot = resolveHubSlot({ launchHome: home(), env: {}, getuid: () => uid });
      const who = mkOwner();
      let current = who;
      let enabled = true;
      let gateOpen = true;
      const abort = new AbortController();
      const { tracker, registry, port } = approvalStack("affirm");
      const originalTurn = tracker.noteInteractive(who);
      const approval = await requestCap(port, tracker, who, operation);
      if (!approval.approved) throw new Error("approval failed");
      const wrap = counting();
      const root = join(slot.effectiveStateDir, "hub-memory");
      defaultStoreIo.ensureDir(root);
      const token = randomBytes(8).toString("hex");
      const identity = readProcIdentity(process.pid);
      expect(
        lockCreate(root, {
          pid: process.pid,
          host: hostname(),
          token,
          at: Date.now(),
          ...(identity?.startTicks !== undefined ? { startTicks: identity.startTicks } : {}),
          ...(identity?.bootId !== undefined ? { bootId: identity.bootId } : {}),
        }),
      ).toBe(true);
      const provider = createHubMemoryProvider({
        capability: () => (enabled ? "ok" : "disabled"),
        registry,
        owner: () => current,
        slot: () => slot,
        io: wrap.io,
        gate: { check: () => (gateOpen ? { ok: true } : { ok: false, reason: "locked" }) },
      });
      const pending = provider.enqueue({ operation, owner: who, cap: approval.cap, signal: abort.signal });
      await new Promise((resolve) => setTimeout(resolve, 40));
      if (reason === "owner") current = { ...who, sessionFile: "/different-session" };
      if (reason === "turn") tracker.noteInteractive(who);
      if (reason === "capability") enabled = false;
      if (reason === "gate") gateOpen = false;
      if (reason === "abort") abort.abort();
      lockRelease(root, token);
      const result = await pending;
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(["E_STALE_SESSION", "E_HUB_CAP_STALE", "E_SCOPE_DISABLED", "E_WRITE_GATE"]).toContain(result.code);
      expect(registry.stateOf(approval.cap)).toBe("revoked");
      current = who;
      enabled = true;
      gateOpen = true;
      const restoreTurn = vi.spyOn(tracker, "current").mockReturnValue(originalTurn);
      expect(await provider.enqueue({ operation, owner: who, cap: approval.cap })).toEqual({
        ok: false,
        code: "E_HUB_CAP_STALE",
      });
      restoreTurn.mockRestore();
      expect(wrap.counts.write + wrap.counts.create).toBe(0);
      expect(existsSync(join(root, "blocks"))).toBe(false);
    },
  );

  it("ensureDir throw is a resolved E_PERSIST, revokes cap and releases queue bookkeeping", async () => {
    const slot = resolveHubSlot({ launchHome: home(), env: {}, getuid: () => uid });
    const who = mkOwner();
    const { tracker, registry, port } = approvalStack("affirm");
    tracker.noteInteractive(who);
    const approved = await requestCap(port, tracker, who, operation);
    if (!approved.approved) throw new Error("no approval");
    let failMkdir = true;
    const wrap = counting();
    const io: HubStoreIo = {
      ...wrap.io,
      ensureDir(p) {
        if (failMkdir) throw new Error("mkdir failure");
        wrap.io.ensureDir(p);
      },
    };
    const provider = createHubMemoryProvider({
      capability: () => "ok",
      registry,
      owner: () => who,
      slot: () => slot,
      io,
      queueLimit: 1,
    });
    await expect(provider.enqueue({ operation, owner: who, cap: approved.cap })).resolves.toEqual({
      ok: false,
      code: "E_PERSIST",
    });
    expect(registry.stateOf(approved.cap)).toBe("revoked");
    expect(wrap.counts.write + wrap.counts.create).toBe(0);
    failMkdir = false;
    const fresh = await requestCap(port, tracker, who, operation);
    if (!fresh.approved) throw new Error("no fresh approval");
    expect((await provider.enqueue({ operation, owner: who, cap: fresh.cap })).ok).toBe(true);
    expect(provider.view().items).toHaveLength(1);
  });

  it("owner flip at final synchronous mutation boundary revokes without writing content", async () => {
    const slot = resolveHubSlot({ launchHome: home(), env: {}, getuid: () => uid });
    const who = mkOwner();
    let current = who;
    const { tracker, registry, port } = approvalStack("affirm");
    tracker.noteInteractive(who);
    const approved = await requestCap(port, tracker, who, operation);
    if (!approved.approved) throw new Error("no approval");
    const provider = createHubMemoryProvider({
      capability: () => "ok",
      registry,
      owner: () => current,
      slot: () => slot,
      faults: {
        beforeBlockWrite: () => {
          current = { ...who, incarnation: {} };
        },
      },
    });
    expect(await provider.enqueue({ operation, owner: who, cap: approved.cap })).toEqual({
      ok: false,
      code: "E_HUB_CAP_STALE",
    });
    current = who;
    expect(registry.stateOf(approved.cap)).toBe("revoked");
    expect(await provider.enqueue({ operation, owner: who, cap: approved.cap })).toEqual({
      ok: false,
      code: "E_HUB_CAP_STALE",
    });
    expect(existsSync(join(slot.effectiveStateDir, "hub-memory", "blocks", "general.001.md"))).toBe(false);
  });
});
