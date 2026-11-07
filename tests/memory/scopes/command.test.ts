import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createScopedMemoryCommand,
  trustedNativeMemoryCommand,
  type NativeMemoryCommandContext,
  type ScopedCommandDeps,
} from "../../../src/memory/scopes/command.js";
import { createSessionMemoryStore } from "../../../src/memory/scopes/session-store.js";
import { createSessionPoisonRegistry } from "../../../src/memory/scopes/session-poison.js";
import { createSessionCommandRegistry } from "../../../src/memory/scopes/session-command.js";
import { createHubMemoryProvider } from "../../../src/memory/scopes/hub-store.js";
import { createMemoryOpCapRegistry } from "../../../src/memory/scopes/op-cap.js";
import { bodyTextDigest, canonicalJson } from "../../../src/memory/scopes/limits.js";
import type { MemoryOwner, HubMemorySource } from "../../../src/memory/scopes/types.js";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "p4b-command-"));
  dirs.push(dir);
  let owner: MemoryOwner = { incarnation: {}, sid: "session1", sessionEpoch: 1, branchGen: 0 };
  let ctx: NativeMemoryCommandContext = { mode: "tui", hasUI: true, isWeb: false, interactive: true };
  let capability: "ok" | "locked" = "ok",
    reads = 0,
    flip = false;
  let controller = new AbortController();
  let source: HubMemorySource = { project: "abc123", label: "current", sid8: "session1" };
  const trusted = () => trustedNativeMemoryCommand({ child: false, commandContext: () => ctx });
  const registry = createSessionCommandRegistry(trusted),
    branch: unknown[] = [];
  const session = createSessionMemoryStore({
    currentOwner: () => owner,
    isLocked: () => capability !== "ok",
    getBranch: () => {
      reads++;
      if (flip) ctx = { ...ctx, isWeb: true };
      return branch;
    },
    getSessionId: () => owner.sid,
    getSessionFile: () => undefined,
    appendCustomEntry: (customType, data) => {
      branch.push({ type: "custom", customType, id: `e${branch.length}`, data });
    },
    now: () => "2026-11-07T00:00:00.000Z",
    commandGrants: registry,
    poisonRegistry: createSessionPoisonRegistry(),
  });
  const hub = createHubMemoryProvider({
    capability: () => capability,
    registry: createMemoryOpCapRegistry(),
    owner: () => owner,
    slot: () => ({ effectiveStateDir: dir, uid: process.getuid?.() ?? 0 }),
    trustedCommand: trusted,
    commandSource: () => source,
  });
  const deps: ScopedCommandDeps = {
    enabled: { session: true, hub: true },
    child: false,
    capability: () => capability,
    currentOwner: () => owner,
    signal: () => controller.signal,
    session,
    hub,
    sessionCommands: registry,
    sessionCommandTarget: session,
    commandContext: () => ctx,
    sessionPath: () => undefined,
    hubPath: () => join(dir, "hub-memory"),
  };
  return {
    dir,
    deps,
    session,
    hub,
    branch,
    command: createScopedMemoryCommand(deps),
    ctx: (c: NativeMemoryCommandContext) => {
      ctx = c;
    },
    flip: () => {
      flip = true;
    },
    lock: () => {
      capability = "locked";
    },
    source: (value: HubMemorySource) => {
      source = value;
    },
    reads: () => reads,
    abort: () => controller.abort(),
    renew: () => {
      owner = { ...owner, sessionEpoch: owner.sessionEpoch + 1 };
      controller = new AbortController();
    },
  };
}
it("optional exact subrouter does not consume original /mem, preserves full add body", async () => {
  const f = fixture();
  for (const old of ["", "path", "list", "sessional add x", "hubby list", " session add x"])
    expect(await f.command.route(old)).toEqual({ handled: false });
  expect(await f.command.route("session path")).toMatchObject({ result: { path: "memory-only" } });
  expect(await f.command.route("session add full\n body")).toMatchObject({ result: { ok: true, id: "n1" } });
  expect(f.session.view().items[0]!.item).toMatchObject({
    authority: "user",
    text: "full\n body",
    grant: { via: "command" },
  });
  expect(await f.command.route("session add")).toMatchObject({ result: { code: "E_META_INVALID" } });
});
it("RPC with UI, unknown, Web, noninteractive and child refuse writes", async () => {
  const f = fixture();
  for (const ctx of [
    { mode: "rpc", hasUI: true, isWeb: false, interactive: true },
    { mode: "unknown", hasUI: true, isWeb: false, interactive: true },
    { mode: "tui", hasUI: true, isWeb: true, interactive: true },
    { mode: "tui", hasUI: true, isWeb: false, interactive: false },
    { mode: "tui", hasUI: false, isWeb: false, interactive: true },
  ]) {
    f.ctx(ctx);
    expect(await f.command.route("session add denied")).toMatchObject({ result: { code: "E_AUTHORITY" } });
    expect(await f.command.route("hub add denied")).toMatchObject({ result: { code: "E_AUTHORITY" } });
  }
  expect(f.branch).toEqual([]);
  expect(readdirSync(f.dir)).toEqual([]);
  const child = createScopedMemoryCommand({ ...f.deps, child: true });
  expect(await child.route("session add denied")).toMatchObject({ result: { code: "E_CHILD_READONLY" } });
});
it("shared real session registry rechecks trust at commit; abort old request does not poison next owner", async () => {
  const f = fixture();
  f.flip();
  expect(await f.command.route("session add denied")).toMatchObject({ result: { code: "E_AUTHORITY" } });
  expect(f.branch).toEqual([]);
  const g = fixture();
  g.abort();
  expect(await g.command.route("session add old")).toMatchObject({ result: { code: "E_WRITE_GATE" } });
  g.renew();
  expect(await g.command.route("session add new")).toMatchObject({ result: { ok: true } });
  expect(g.session.view().items[0]!.item.text).toBe("new");
});
it("Hub CRUD uses actual inspect rev and SAME management provider; exact rm args", async () => {
  const f = fixture();
  expect(await f.command.route("hub add actual body")).toMatchObject({ result: { ok: true, id: "general.001" } });
  const inspected = await f.command.route("hub show general.001");
  expect(inspected).toMatchObject({
    result: { ok: true, item: { text: "actual body", src: { label: "current" } }, rev: expect.any(String) },
  });
  expect(await f.command.route("hub rm general.001 extra")).toMatchObject({ result: { code: "E_META_INVALID" } });
  expect(await f.command.route("hub rm general.001")).toMatchObject({ result: { ok: true } });
  expect(f.hub.view().items).toEqual([]);
  expect(await f.command.route("hub trash")).toMatchObject({ result: { items: [{ provenance: "known" }] } });
});
it("missing native select fails closed; prepared tokens cancelled without commit", async () => {
  const f = fixture();
  await f.command.route("hub add original");
  await f.command.route("hub rm general.001");
  const trash = f.hub.management.listTrash()[0]!;
  expect(await f.command.route(`hub restore ${trash.fileName}`)).toMatchObject({
    result: { code: "E_HUB_CONFIRM_UNAVAILABLE" },
  });
  expect(f.hub.view().items).toEqual([]);
  expect(await f.command.route("hub adopt")).toMatchObject({ result: { code: "E_HUB_CONFIRM_UNAVAILABLE" } });
  expect(await f.command.route(`hub restore ${trash.fileName}`)).toMatchObject({
    result: { code: "E_HUB_CONFIRM_UNAVAILABLE" },
  });
});
it("locked reads do not touch branch or paths", async () => {
  const f = fixture();
  f.lock();
  for (const args of ["session list", "session path", "hub path", "hub list", "hub show general.001"])
    expect(await f.command.route(args)).toMatchObject({ result: { code: "E_WRITE_GATE" } });
  expect(f.reads()).toBe(0);
  expect(readdirSync(f.dir)).toEqual([]);
});

it("per-command abort never cancels shared lifecycle or later request", async () => {
  const f = fixture(),
    request = new AbortController();
  request.abort();
  expect(await f.command.route("session add old", request.signal)).toMatchObject({
    result: { code: "E_STALE_SESSION" },
  });
  expect(await f.command.route("session add next")).toMatchObject({ result: { ok: true } });
  expect(f.session.view().items.map((i) => i.item.text)).toEqual(["next"]);
});

it("restore renders ONLY complete token-bound confirmation, reject-first digest label, retains old history/new grant", async () => {
  const f = fixture(),
    body = "完整中文🧠\n" + "x".repeat(1007);
  // Exactly 1024 UTF-8 bytes; factory tests the port's full title, NOT a TUI viewport.
  expect(Buffer.byteLength(body)).toBe(1024);
  expect(
    await f.hub.management.command({
      storageScope: "hub",
      op: "create",
      authority: "user",
      topic: "general",
      text: body,
      from: "session:n1",
    }),
  ).toMatchObject({ ok: true });
  const target = f.hub.management.inspect("general.001");
  if (!target.ok) throw Error(target.code);
  await f.command.route("hub rm general.001");
  const trash = f.hub.management.listTrash()[0]!;
  f.source({ project: "def456", label: "NEW", sid8: "new" });
  let title = "",
    labels: readonly string[] = [],
    expectedDigest = "";
  const command = createScopedMemoryCommand({
    ...f.deps,
    hub: {
      ...f.hub,
      management: {
        ...f.hub.management,
        prepareRestore: (name, signal) => {
          const prepared = f.hub.management.prepareRestore(name, signal);
          if (prepared.ok) expectedDigest = bodyTextDigest(canonicalJson(prepared.confirmation));
          return prepared;
        },
        status: () => {
          throw Error("surface must not reconstruct prepared confirmation via status");
        },
        inspect: () => {
          throw Error("surface must not reconstruct prepared confirmation via inspect");
        },
      },
    },
    select: async (t, options) => {
      title = t;
      labels = options;
      return options[1];
    },
  });
  expect(await command.route(`hub restore ${trash.fileName}`)).toMatchObject({ result: { ok: true } });
  expect(title).toContain(expectedDigest);
  expect(labels[1]).toContain(expectedDigest.slice(0, 8));
  expect(title).toContain('"oldFrom": "session:n1"');
  expect(labels[0]).toBe("拒绝（不写入）");
  expect(labels[1]).toMatch(/^确认执行 HUB restore · [a-f0-9]{8}$/);
  for (const value of [
    body,
    target.rev,
    target.item.updated,
    trash.fileName,
    f.dir,
    join(f.dir, "hub-memory"),
    '"oldSource"',
    '"oldGrant"',
    '"newSource"',
    '"newAuthorization"',
    '"issued": "on-commit"',
    "NEW",
    "current",
    "不复用旧权限",
  ])
    expect(title).toContain(value);
  const restored = f.hub.management.inspect("general.001");
  if (!restored.ok) throw Error(restored.code);
  expect(restored.item).toMatchObject({ text: body, src: { label: "NEW" }, grant: { via: "command", by: "user" } });
  expect(restored.rev).toBe(target.rev);
});

it("adopt displays complete multi-item bodies/revs/history and namespace before/after diff", async () => {
  const f = fixture();
  await f.command.route("hub add first\n完整🧠");
  await f.command.route("hub add second raw body");
  const original = f.hub.management.status().items;
  const namespace = join(f.dir, "hub-memory", "namespace.json"),
    old = JSON.parse(readFileSync(namespace, "utf8"));
  old.host = old.host === "a".repeat(16) ? "b".repeat(16) : "a".repeat(16);
  writeFileSync(namespace, JSON.stringify(old));
  let title = "";
  const command = createScopedMemoryCommand({
    ...f.deps,
    select: async (t, options) => {
      title = t;
      return options[1];
    },
  });
  expect(await command.route("hub adopt")).toMatchObject({ result: { ok: true } });
  for (const text of ["first\n完整🧠", "second raw body", '"current"', '"reseal"', '"changedFields"', old.host, f.dir])
    expect(title).toContain(text);
  for (const item of original) {
    const inspected = f.hub.management.inspect(item.id);
    if (!inspected.ok) throw Error(inspected.code);
    for (const value of [item.id, item.updated, inspected.rev, ...Object.values(item.src)])
      expect(title).toContain(value);
  }
  expect(f.hub.management.status().state).toBe("ok");
});

it("reject/default/foreign answer cancel only the private prepared token; no accidental confirmation", async () => {
  const f = fixture();
  await f.command.route("hub add original");
  await f.command.route("hub rm general.001");
  const name = f.hub.management.listTrash()[0]!.fileName;
  for (const answer of [undefined, "", "yes", "拒绝（不写入）"]) {
    const command = createScopedMemoryCommand({ ...f.deps, select: async () => answer });
    expect(await command.route(`hub restore ${name}`)).toMatchObject({ result: { code: "E_HUB_DECLINED" } });
    expect(f.hub.view().items).toEqual([]);
  }
  const accepted = createScopedMemoryCommand({ ...f.deps, select: async (_t, o) => o[1] });
  expect(await accepted.route(`hub restore ${name}`)).toMatchObject({ result: { ok: true } });
});

it("prepare popup trust/owner/source drift rejected after answer, token cannot be reused", async () => {
  for (const kind of ["trust", "owner", "source"] as const) {
    const f = fixture();
    await f.command.route("hub add original");
    await f.command.route("hub rm general.001");
    const name = f.hub.management.listTrash()[0]!.fileName;
    const command = createScopedMemoryCommand({
      ...f.deps,
      select: async (_t, options) => {
        if (kind === "trust") f.ctx({ mode: "rpc", hasUI: true, isWeb: false, interactive: true });
        if (kind === "owner") f.renew();
        if (kind === "source") f.source({ project: "def456", label: "different", sid8: "other" });
        return options[1];
      },
    });
    expect(await command.route(`hub restore ${name}`)).toMatchObject({ result: { code: "E_STALE_SESSION" } });
    expect(f.hub.view().items).toEqual([]);
  }
});

it("popup abort closes even an uncooperative select; late answer does not write or cancel new owner", async () => {
  const f = fixture();
  await f.command.route("hub add original");
  await f.command.route("hub rm general.001");
  const name = f.hub.management.listTrash()[0]!.fileName,
    request = new AbortController();
  let answer: ((v: string) => void) | undefined,
    affirm = "",
    popupSignal: AbortSignal | undefined;
  const command = createScopedMemoryCommand({
    ...f.deps,
    select: (_t, o, opts) => {
      affirm = o[1]!;
      popupSignal = opts?.signal;
      return new Promise((resolve) => {
        answer = resolve;
      });
    },
  });
  const pending = command.route(`hub restore ${name}`, request.signal);
  request.abort();
  expect(await pending).toMatchObject({ result: { code: "E_STALE_SESSION" } });
  expect(popupSignal?.aborted).toBe(true);
  expect(f.hub.view().items).toEqual([]);
  f.renew();
  const newer = createScopedMemoryCommand({ ...f.deps, select: async (_t, o) => o[1] });
  answer?.(affirm);
  expect(await newer.route(`hub restore ${name}`)).toMatchObject({ result: { ok: true } });
  expect(f.hub.view().items).toHaveLength(1);
});

it("confirmation has bounded request-local timeout even if native select never settles", async () => {
  const f = fixture();
  await f.command.route("hub add original");
  await f.command.route("hub rm general.001");
  const name = f.hub.management.listTrash()[0]!.fileName;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    let popupSignal: AbortSignal | undefined;
    const command = createScopedMemoryCommand({
      ...f.deps,
      select: (_t, _o, options) => {
        popupSignal = options?.signal;
        return new Promise(() => {});
      },
    });
    const pending = command.route(`hub restore ${name}`);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await pending).toMatchObject({ result: { code: "E_HUB_DECLINED" } });
    expect(popupSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(f.hub.view().items).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});
