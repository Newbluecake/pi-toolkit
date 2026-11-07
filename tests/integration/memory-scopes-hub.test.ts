/**
 * #39 P3a integration: the hub kernel end-to-end on REAL local /tmp trees — slot
 * resolution through the real resolveHubPaths, the P1 approval stack (fake TUI channel
 * only), the directory lock, durable writes, cross-layer section rendering, CAS under
 * contending providers, and tamper detection. No real hub daemon, no user dirs, no mounts,
 * no paid APIs; every byte lands under this process's own tmpdir.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  createHubMemoryProvider,
  defaultStoreIo,
  hubHostFingerprint,
  readHubCorpus,
} from "../../src/memory/scopes/hub-store.js";
import { lockCreate, lockRelease, readProcIdentity, type LockPayload } from "../../src/memory/safe-fs.js";
import { hostname } from "node:os";
import { checkHubSlot, resolveHubSlot } from "../../src/memory/scopes/hub-slot.js";
import { createHubMemorySection } from "../../src/memory/scopes/hub-section.js";
import { createHumanTurnTracker, createMemoryOpCapRegistry } from "../../src/memory/scopes/op-cap.js";
import { createOpApprovalPort } from "../../src/memory/scopes/authorize.js";
import { SKIP } from "../../src/prompt-sections/stable-section.js";
import { bodyTextDigest, scopedOpDigest } from "../../src/memory/scopes/limits.js";
import type { FoldedSessionItem, MemoryOwner, PrivateOpCap, SessionItem } from "../../src/memory/scopes/types.js";

const uid = process.getuid?.() ?? 0;
const homes: string[] = [];
const home = () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-int-"));
  homes.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const mkOwner = (sid: string): MemoryOwner => ({ incarnation: {}, sid, sessionEpoch: 1, branchGen: 0 });

const approvalStackFor = (who: MemoryOwner) => {
  const tracker = createHumanTurnTracker();
  const registry = createMemoryOpCapRegistry(() => tracker.current());
  const port = createOpApprovalPort({
    tracker,
    registry,
    select: async (_title, options) => options[1]!, // the exact AFFIRM label, as P1 requires
  });
  tracker.noteInteractive(who);
  return {
    registry,
    tracker,
    request: async (operation: Record<string, unknown>) => {
      const turn = tracker.current()!;
      const outcome = await portRequest(port, tracker, who, operation);
      if (!outcome.approved) throw new Error(`approval failed: ${outcome.code}`);
      return { registry, cap: outcome.cap as PrivateOpCap };
    },
  };
};

const approvedCap = (who: MemoryOwner, operation: Record<string, unknown>) => approvalStackFor(who).request(operation);

const portRequest = async (
  port: ReturnType<typeof createOpApprovalPort>,
  tracker: ReturnType<typeof createHumanTurnTracker>,
  who: MemoryOwner,
  operation: Record<string, unknown>,
) => {
  const turn = tracker.current()!;
  const result = await port.request({
    operation: operation as never,
    binding: {
      owner: who,
      humanTurn: turn,
      toolCallId: "tc-int",
      nonce: randomBytes(16).toString("hex").slice(0, 32),
      opDigest: scopedOpDigest(operation),
      textDigest: bodyTextDigest(typeof operation.text === "string" ? operation.text : ""),
    },
    projectLabel: "pi-toolkit",
  });
  return result;
};

const sessionItem = (id: string, text: string, authority: "user" | "agent" = "agent"): FoldedSessionItem => ({
  item: {
    id,
    text,
    authority,
    created: "2026-11-07T08:00:00.000Z",
    updated: "2026-11-07T08:00:00.000Z",
  } as SessionItem,
  rev: "deadbee0",
});

describe("hub kernel end-to-end (own /tmp only)", () => {
  it("resolve → approve → commit → view → render → section, with cross-layer dedup", async () => {
    const h = home();
    const slot = resolveHubSlot({ launchHome: h, env: {}, getuid: () => uid });
    expect(slot.effectiveStateDir).toBe(join(h, ".pi", "agent", "web-hub"));
    expect(slot.source).toBe("default-slot");
    const who = mkOwner("sess-int-0001");
    const { registry, cap } = await approvedCap(who, {
      storageScope: "hub",
      authority: "user",
      op: "create",
      topic: "general",
      text: "deploy via /mem hub after review",
    });
    const provider = createHubMemoryProvider({
      capability: () => "ok",
      registry,
      owner: () => who,
      slot: () => slot,
      currentProjectSlug: () => "noslug",
    });
    const write = await provider.enqueue({
      operation: {
        storageScope: "hub",
        authority: "user",
        op: "create",
        topic: "general",
        text: "deploy via /mem hub after review",
      },
      owner: who,
      cap,
    });
    expect(write.ok).toBe(true);
    const view = provider.view();
    expect(view.state).toBe("ok");
    expect(view.items).toHaveLength(1);
    // Section: dedup against an identical session agent entry — hub user copy must win.
    const sessionItems = [sessionItem("n1", "deploy via /mem hub after review")];
    const section = createHubMemorySection({
      isLocked: () => false,
      view: () => provider.view(),
      sessionItems: () => sessionItems,
      currentProjectSlug: () => "noslug",
    });
    const text = section();
    expect(typeof text).toBe("string");
    expect(text as string).toContain("Hub memory");
    expect(text as string).toContain("general.001 user src=other#");
    // hub user entry has no dup marker; the SESSION agent copy would carry it (P1 render).
    expect(text as string).not.toContain("dup of session");
    // Locked ⇒ SKIP without touching the store.
    const lockedSection = createHubMemorySection({ isLocked: () => true, view: () => provider.view() });
    expect(lockedSection()).toBe(SKIP); // and view() was never called: no disk on locked
  });

  it("two providers on one slot: CAS makes exactly one update win, loser gets E_CONFLICT", async () => {
    const h = home();
    const slot = resolveHubSlot({ launchHome: h, env: {}, getuid: () => uid });
    const whoA = mkOwner("sess-int-0002");
    const whoB = mkOwner("sess-int-0003");
    const mintA = await approvedCap(whoA, {
      storageScope: "hub",
      authority: "user",
      op: "create",
      topic: "work",
      text: "shared entry",
    });
    const providerA = createHubMemoryProvider({
      capability: () => "ok",
      registry: mintA.registry,
      owner: () => whoA,
      slot: () => slot,
    });
    const created = await providerA.enqueue({
      operation: { storageScope: "hub", authority: "user", op: "create", topic: "work", text: "shared entry" },
      owner: whoA,
      cap: mintA.cap,
    });
    expect(created.ok).toBe(true);
    const rev = created.ok ? (created.rev ?? "") : "";
    // Both update the SAME rev: first lands, second loses (multi-process/multi-cwd semantics).
    // One tracker/registry mints BOTH caps (same human turn, two approved operations).
    const stack = approvalStackFor(whoB);
    const mintB = await stack.request({
      storageScope: "hub",
      authority: "user",
      op: "update",
      targetId: "work.001",
      text: "B wins",
      expectRev: rev,
    });
    const mintB2 = await stack.request({
      storageScope: "hub",
      authority: "user",
      op: "update",
      targetId: "work.001",
      text: "B too late",
      expectRev: rev,
    });
    const providerB = createHubMemoryProvider({
      capability: () => "ok",
      registry: mintB.registry,
      owner: () => whoB,
      slot: () => slot,
    });
    const first = await providerB.enqueue({
      operation: {
        storageScope: "hub",
        authority: "user",
        op: "update",
        targetId: "work.001",
        text: "B wins",
        expectRev: rev,
      },
      owner: whoB,
      cap: mintB.cap,
    });
    expect(first.ok).toBe(true);
    const loser = await providerB.enqueue({
      operation: {
        storageScope: "hub",
        authority: "user",
        op: "update",
        targetId: "work.001",
        text: "B too late",
        expectRev: rev,
      },
      owner: whoB,
      cap: mintB2.cap,
    });
    expect(loser.ok).toBe(false);
    if (!loser.ok) expect(loser.code).toBe("E_CONFLICT");
    const final = readHubCorpus(slot, { expectedHost: hubHostFingerprint() });
    expect(final.state).toBe("ok");
    expect(final.items[0]!.text).toBe("B wins");
  });

  it("directory-lock contention ⇒ E_BUSY with the store untouched", async () => {
    const h = home();
    const slot = resolveHubSlot({ launchHome: h, env: {}, getuid: () => uid });
    const who = mkOwner("sess-int-0004");
    const mint = await approvedCap(who, {
      storageScope: "hub",
      authority: "user",
      op: "create",
      topic: "busy",
      text: "waiting write",
    });
    const provider = createHubMemoryProvider({
      capability: () => "ok",
      registry: mint.registry,
      owner: () => who,
      slot: () => slot,
      lockTimeoutMs: 120,
    });
    // Real lock held "by another process" (manual lockCreate + delayed release).
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
    const result = await provider.enqueue({
      operation: { storageScope: "hub", authority: "user", op: "create", topic: "busy", text: "waiting write" },
      owner: who,
      cap: mint.cap,
    });
    lockRelease(root, token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("E_BUSY");
    expect(readHubCorpus(slot, { expectedHost: hubHostFingerprint() }).state).toBe("absent");
  });

  it("namespace tampering (mode widened / host swapped) ⇒ inert until user adopt", async () => {
    const h = home();
    const slot = resolveHubSlot({ launchHome: h, env: {}, getuid: () => uid });
    const who = mkOwner("sess-int-0005");
    const mint = await approvedCap(who, {
      storageScope: "hub",
      authority: "user",
      op: "create",
      topic: "t",
      text: "sealed",
    });
    const provider = createHubMemoryProvider({
      capability: () => "ok",
      registry: mint.registry,
      owner: () => who,
      slot: () => slot,
    });
    expect(
      (
        await provider.enqueue({
          operation: { storageScope: "hub", authority: "user", op: "create", topic: "t", text: "sealed" },
          owner: who,
          cap: mint.cap,
        })
      ).ok,
    ).toBe(true);
    const nsPath = join(slot.effectiveStateDir, "hub-memory", "namespace.json");
    chmodSync(nsPath, 0o644);
    expect(provider.view().state).toBe("inert");
    const ns = JSON.parse(readFileSync(nsPath, "utf8"));
    writeFileSync(nsPath, JSON.stringify({ ...ns, host: "0000000000000000" }));
    chmodSync(nsPath, 0o600); // writeFileSync does not re-chmod an existing file
    expect(checkHubSlot(slot, { expectedHost: hubHostFingerprint() })).toEqual({ inert: "host-mismatch" });
    expect(readHubCorpus(slot, { expectedHost: hubHostFingerprint() }).items).toHaveLength(0);
    expect(existsSync(join(slot.effectiveStateDir, "hub-memory", "blocks", "t.001.md"))).toBe(true); // untouched, just sealed
  });
});

describe("directory identity across the real lock await", () => {
  it.each(["mode", "inode"])("%s change refuses content write and permanently revokes permission", async (fault) => {
    const slot = resolveHubSlot({ launchHome: home(), env: {}, getuid: () => uid });
    const who = mkOwner("sess-dir-001");
    const operation = {
      storageScope: "hub",
      authority: "user",
      op: "create",
      topic: "t",
      text: "must not land",
    } as const;
    const mint = await approvedCap(who, operation);
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
      capability: () => "ok",
      registry: mint.registry,
      owner: () => who,
      slot: () => slot,
    });
    const pending = provider.enqueue({ operation, owner: who, cap: mint.cap });
    await new Promise((resolve) => setTimeout(resolve, 40));
    if (fault === "mode") {
      chmodSync(root, 0o777);
      lockRelease(root, token);
    } else {
      renameSync(root, `${root}-old`);
      defaultStoreIo.ensureDir(root);
      lockRelease(`${root}-old`, token);
    }
    expect(await pending).toEqual({ ok: false, code: "E_NAMESPACE" });
    expect(mint.registry.stateOf(mint.cap)).toBe("revoked");
    chmodSync(root, 0o700);
    expect(await provider.enqueue({ operation, owner: who, cap: mint.cap })).toEqual({
      ok: false,
      code: "E_HUB_CAP_STALE",
    });
    expect(existsSync(join(root, "blocks"))).toBe(false);
    expect(existsSync(join(root, "namespace.json"))).toBe(false);
  });
});
