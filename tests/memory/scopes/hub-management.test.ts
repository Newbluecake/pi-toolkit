import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  renameSync,
  mkdirSync,
  symlinkSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createHubMemoryProvider,
  defaultStoreIo,
  hubHostFingerprint,
  type HubFaultPoints,
  type HubStoreIo,
} from "../../../src/memory/scopes/hub-store.js";
import { createHumanTurnTracker, createMemoryOpCapRegistry } from "../../../src/memory/scopes/op-cap.js";
import { bodyTextDigest, scopedOpDigest } from "../../../src/memory/scopes/limits.js";
import type { FrozenScopedOp, MemoryOwner } from "../../../src/memory/scopes/types.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const src = { project: "abc123", label: "current", sid8: "session" };
function fixture(io: HubStoreIo = defaultStoreIo, faults?: HubFaultPoints, queueLimit = 16) {
  const dir = mkdtempSync(join(tmpdir(), "p3c-manage-"));
  dirs.push(dir);
  const slot = { effectiveStateDir: dir, uid: process.getuid?.() ?? 0 };
  let owner: MemoryOwner = { incarnation: {}, sid: "session1", sessionEpoch: 1, branchGen: 0 };
  let trusted = true,
    available = true;
  const tracker = createHumanTurnTracker(),
    registry = createMemoryOpCapRegistry(() => tracker.current());
  tracker.noteInteractive(owner);
  const provider = createHubMemoryProvider({
    slot: () => slot,
    owner: () => owner,
    capability: () => (available ? "ok" : "locked"),
    registry,
    io,
    trustedCommand: () => trusted,
    commandSource: () => src,
    queueLimit,
    ...(faults ? { faults } : {}),
  });
  return {
    dir,
    slot,
    provider,
    registry,
    tracker,
    owner: () => owner,
    setOwner: (o: MemoryOwner) => {
      owner = o;
    },
    trust: (v: boolean) => {
      trusted = v;
    },
    available: (v: boolean) => {
      available = v;
    },
    root: join(dir, "hub-memory"),
  };
}
const add = { storageScope: "hub", authority: "user", op: "create", topic: "general", text: "body" } as const;
async function seeded(f = fixture()) {
  const r = await f.provider.management.command(add);
  expect(r.ok).toBe(true);
  return f;
}
function changeHost(root: string) {
  const p = join(root, "namespace.json"),
    ns = JSON.parse(readFileSync(p, "utf8"));
  ns.host = hubHostFingerprint() === "a".repeat(16) ? "b".repeat(16) : "a".repeat(16);
  writeFileSync(p, JSON.stringify(ns));
}

describe("trusted command port / local real revision", () => {
  it("native predicate is required twice; read-only inspection exposes the actual block revision", async () => {
    const f = fixture();
    f.trust(false);
    expect(await f.provider.management.command(add)).toEqual({ ok: false, code: "E_AUTHORITY" });
    expect(readdirSync(f.dir)).toEqual([]);
    f.trust(true);
    await seeded(f);
    const i = f.provider.management.inspect("general.001");
    expect(i.ok).toBe(true);
    if (!i.ok) throw Error("inspect");
    expect(i.rev).toMatch(/^1-[a-f0-9]{6}$/);
    expect(i.item.text).toBe("body");
    const a = f.provider.management.command({
      ...add,
      op: "update",
      targetId: i.item.id,
      expectRev: i.rev,
      text: "updated",
    });
    f.trust(false);
    expect(await a).toEqual({ ok: false, code: "E_AUTHORITY" });
    expect(f.provider.view().items[0]?.text).toBe("body");
  });
  it("one shared bounded FIFO for command, adopt and provider operations", async () => {
    const f = await seeded(fixture(defaultStoreIo, undefined, 1));
    changeHost(f.root);
    const p = f.provider.management.prepareAdopt();
    expect(p.ok).toBe(true);
    if (!p.ok) throw Error("prepare");
    const commit = f.provider.management.commit(p.token);
    expect(await f.provider.management.command(add)).toEqual({ ok: false, code: "E_BUSY" });
    expect((await commit).ok).toBe(true);
  });
  it.each(["text", "topic", "op", "from", "rev"])(
    "explicitly rejects request/cap %s mismatch, never substitutes cap operation",
    async (field) => {
      const f = fixture(),
        owner = f.owner(),
        turn = f.tracker.current()!;
      const original: FrozenScopedOp = { ...add };
      const cap = f.registry.mint({
        operation: original,
        binding: {
          owner,
          humanTurn: turn,
          toolCallId: "call",
          nonce: "a".repeat(32),
          opDigest: scopedOpDigest({ ...original }),
          textDigest: bodyTextDigest("body"),
        },
        channel: "tui",
        project: "test",
      });
      const operation = {
        ...add,
        ...(field === "text"
          ? { text: "other" }
          : field === "topic"
            ? { topic: "other" }
            : field === "op"
              ? { op: "delete", targetId: "general.001", expectRev: "1-000000" }
              : field === "from"
                ? { from: "session:n1" }
                : { expectRev: "1-000000" }),
      } as FrozenScopedOp & { storageScope: "hub" };
      expect(await f.provider.enqueue({ owner, cap, operation })).toEqual({ ok: false, code: "E_HUB_CAP_STALE" });
      expect(readdirSync(f.dir)).toEqual([]);
      expect(f.registry.stateOf(cap)).toBe("revoked");
    },
  );
  it("rejects getter source/op without executing it", async () => {
    const f = fixture();
    let calls = 0;
    const bad = {
      ...add,
      get text() {
        calls++;
        return "x";
      },
    };
    expect(await f.provider.management.command(bad)).toEqual({ ok: false, code: "E_META_INVALID" });
    expect(calls).toBe(0);
    expect(readdirSync(f.dir)).toEqual([]);
  });
});
describe("management token lifecycle", () => {
  it("cancel after commit admission but before dequeue prevents reseal", async () => {
    const f = await seeded();
    changeHost(f.root);
    const p = f.provider.management.prepareAdopt();
    if (!p.ok) throw Error("prepare");
    const before = readFileSync(join(f.root, "namespace.json"), "utf8");
    const task = f.provider.management.commit(p.token);
    f.provider.management.cancel(p.token);
    expect(await task).toEqual({ ok: false, code: "E_HUB_CAP_STALE" });
    expect(readFileSync(join(f.root, "namespace.json"), "utf8")).toBe(before);
  });
  it("trust lost before first dequeue creates no root", async () => {
    const f = fixture();
    const task = f.provider.management.command(add);
    f.trust(false);
    expect(await task).toEqual({ ok: false, code: "E_AUTHORITY" });
    expect(readdirSync(f.dir)).toEqual([]);
  });
  it("preparations bounded at 16, cancel releases only its slot; dispose invalidates all", async () => {
    const f = await seeded();
    changeHost(f.root);
    const prepared = Array.from({ length: 16 }, () => f.provider.management.prepareAdopt());
    expect(prepared.every((p) => p.ok)).toBe(true);
    expect(f.provider.management.prepareAdopt()).toEqual({ ok: false, code: "E_BUSY" });
    const first = prepared[0]!;
    if (!first.ok) throw Error("prepare");
    f.provider.management.cancel(first.token);
    expect(f.provider.management.prepareAdopt().ok).toBe(true);
    f.provider.dispose();
    const last = prepared[15]!;
    if (!last.ok) throw Error("prepare");
    expect(await f.provider.management.commit(last.token)).toEqual({ ok: false, code: "E_HUB_CAP_STALE" });
  });
});
describe("adopt: prepare/read-only -> one-shot exact CAS -> reseal only", () => {
  it("reseals complete safe corpus with same bytes/grants; no repair or project import", async () => {
    const f = await seeded();
    changeHost(f.root);
    const old = readFileSync(join(f.root, "items.json"), "utf8"),
      body = readFileSync(join(f.root, "blocks/general.001.md"), "utf8");
    expect(f.provider.management.status()).toMatchObject({ state: "inert", reason: "host-mismatch" });
    const p = f.provider.management.prepareAdopt();
    expect(p.ok).toBe(true);
    expect(readFileSync(join(f.root, "items.json"), "utf8")).toBe(old);
    if (!p.ok) throw Error("prepare");
    expect(await f.provider.management.commit(p.token)).toMatchObject({ ok: true, id: "namespace" });
    expect(f.provider.view().state).toBe("ok");
    expect(readFileSync(join(f.root, "items.json"), "utf8")).toBe(old);
    expect(readFileSync(join(f.root, "blocks/general.001.md"), "utf8")).toBe(body);
    expect(await f.provider.management.commit(p.token)).toEqual({ ok: false, code: "E_HUB_CAP_STALE" });
  });
  it.each([
    "namespace",
    "source",
    "body",
    "root-inode",
    "blocks-inode",
    "mode",
    "uid",
    "symlink",
    "owner",
    "cancel",
    "abort",
    "trust",
    "slot",
  ])("%s changed after preparation: no content mutation and token spent", async (kind) => {
    let wrongUid = false;
    const io: HubStoreIo = {
      ...defaultStoreIo,
      inspectDir(p) {
        const st = defaultStoreIo.inspectDir(p);
        return wrongUid && st && st !== "not-dir" ? { ...st, uid: st.uid + 1 } : st;
      },
    };
    const f = await seeded(fixture(io));
    changeHost(f.root);
    const controller = new AbortController();
    const p = f.provider.management.prepareAdopt(controller.signal);
    if (!p.ok) throw Error(`prepare ${p.code}`);
    if (kind === "namespace")
      writeFileSync(join(f.root, "namespace.json"), readFileSync(join(f.root, "namespace.json"), "utf8") + " ");
    if (kind === "source")
      writeFileSync(
        join(f.root, "items.json"),
        readFileSync(join(f.root, "items.json"), "utf8").replace("current", "changed"),
      );
    if (kind === "body")
      writeFileSync(
        join(f.root, "blocks/general.001.md"),
        readFileSync(join(f.root, "blocks/general.001.md"), "utf8").replace("body", "edit"),
      );
    if (kind === "root-inode" || kind === "blocks-inode") {
      const path = kind === "root-inode" ? f.root : join(f.root, "blocks");
      renameSync(path, `${path}-old`);
      mkdirSync(path, { mode: 0o700 });
    }
    if (kind === "mode") chmodSync(join(f.root, "blocks"), 0o755);
    if (kind === "uid") wrongUid = true;
    if (kind === "symlink") {
      renameSync(join(f.root, "items.json"), join(f.root, "old.json"));
      symlinkSync("old.json", join(f.root, "items.json"));
    }
    if (kind === "owner") f.setOwner({ ...f.owner(), sessionFile: "new-session" });
    if (kind === "cancel") f.provider.management.cancel(p.token);
    if (kind === "abort") controller.abort();
    if (kind === "trust") f.trust(false);
    if (kind === "slot") f.slot.uid++;
    const before = (() => {
      try {
        return readFileSync(join(f.root, "namespace.json"), "utf8");
      } catch {
        return "missing";
      }
    })();
    const r = await f.provider.management.commit(p.token);
    expect(r.ok).toBe(false);
    expect(
      (() => {
        try {
          return readFileSync(join(f.root, "namespace.json"), "utf8");
        } catch {
          return "missing";
        }
      })(),
    ).toBe(before);
    expect(await f.provider.management.commit(p.token)).toEqual({ ok: false, code: "E_HUB_CAP_STALE" });
  });
  it.each(["missing-source", "missing-rev", "invalid-block", "project-block", "unsafe-dir", "missing-namespace"])(
    "refuses %s, never fabricates or repairs",
    async (kind) => {
      const f = await seeded();
      changeHost(f.root);
      if (kind === "missing-source") writeFileSync(join(f.root, "items.json"), '{"v":1,"items":{}}');
      if (kind === "missing-rev")
        writeFileSync(
          join(f.root, "items.json"),
          readFileSync(join(f.root, "items.json"), "utf8").replace(/,"rev":"[^"]+"/, ""),
        );
      if (kind === "invalid-block") writeFileSync(join(f.root, "blocks/bad.md"), "project content", { mode: 0o600 });
      if (kind === "project-block")
        writeFileSync(
          join(f.root, "blocks/general.001.md"),
          readFileSync(join(f.root, "blocks/general.001.md"), "utf8").replace("storageScope: hub\n", ""),
        );
      if (kind === "unsafe-dir") chmodSync(join(f.root, "blocks"), 0o755);
      if (kind === "missing-namespace") rmSync(join(f.root, "namespace.json"));
      expect(f.provider.management.prepareAdopt().ok).toBe(false);
      expect(f.provider.view().state).toBe("inert");
    },
  );
  it("inert diagnostics and disabled management do not write/repair", async () => {
    const f = await seeded();
    changeHost(f.root);
    const before = readFileSync(join(f.root, "namespace.json"), "utf8");
    expect(f.provider.management.status().reason).toBe("host-mismatch");
    expect(readFileSync(join(f.root, "namespace.json"), "utf8")).toBe(before);
    f.available(false);
    expect(f.provider.management.status().state).toBe("disabled");
    expect(f.provider.management.prepareAdopt()).toEqual({ ok: false, code: "E_SCOPE_DISABLED" });
  });
});
