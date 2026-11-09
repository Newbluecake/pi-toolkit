import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createScopedMemoryTool, type ScopedToolDeps } from "../../../src/memory/scopes/tool.js";
import { createSessionMemoryStore } from "../../../src/memory/scopes/session-store.js";
import { createSessionPoisonRegistry } from "../../../src/memory/scopes/session-poison.js";
import { createHubMemoryProvider } from "../../../src/memory/scopes/hub-store.js";
import { createHumanTurnTracker, createMemoryOpCapRegistry } from "../../../src/memory/scopes/op-cap.js";
import { createOpApprovalPort } from "../../../src/memory/scopes/authorize.js";
import type { MemoryOwner, OpApprovalRequest } from "../../../src/memory/scopes/types.js";
import surface from "../../fixtures/scoped-memory-tool-surface.json" with { type: "json" };
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture(child = false) {
  const dir = mkdtempSync(join(tmpdir(), "p4b-tool-"));
  dirs.push(dir);
  let owner: MemoryOwner = { incarnation: {}, sid: "session1", sessionEpoch: 1, branchGen: 0 };
  const branch: unknown[] = [],
    controller = new AbortController();
  const tracker = createHumanTurnTracker(),
    registry = createMemoryOpCapRegistry(() => tracker.current());
  let capability: ReturnType<ScopedToolDeps["capability"]> = "ok",
    reads = 0,
    dialogs = 0;
  const session = createSessionMemoryStore({
    currentOwner: () => owner,
    isLocked: () => capability !== "ok",
    getBranch: () => {
      reads++;
      return branch;
    },
    getSessionId: () => owner.sid,
    getSessionFile: () => undefined,
    appendCustomEntry: (customType, data) => {
      branch.push({ type: "custom", id: `e${branch.length}`, customType, data });
    },
    now: () => "2026-11-07T00:00:00.000Z",
    caps: registry,
    isChildSession: child,
    poisonRegistry: createSessionPoisonRegistry(),
  });
  const hub = createHubMemoryProvider({
    capability: () => capability,
    registry,
    owner: () => owner,
    slot: () => ({ effectiveStateDir: dir, uid: process.getuid?.() ?? 0 }),
    trustedCommand: () => true,
    commandSource: () => ({ project: "abc123", label: "test", sid8: "session1" }),
  });
  const approval = createOpApprovalPort({
    tracker,
    registry,
    select: async (_title, choices) => {
      dialogs++;
      return choices[1];
    },
  });
  const deps: ScopedToolDeps = {
    enabled: { session: true, hub: true },
    child,
    capability: () => capability,
    currentOwner: () => owner,
    session,
    hub,
    signal: () => controller.signal,
    humanTurn: () => tracker.current(),
    projectLabel: () => "test",
    sharedApproval: approval,
    caps: registry,
  };
  return {
    dir,
    deps,
    session,
    hub,
    tracker,
    registry,
    controller,
    branch,
    tool: createScopedMemoryTool(deps),
    dialogs: () => dialogs,
    reads: () => reads,
    owner: () => owner,
    setOwner: () => {
      owner = { ...owner, branchGen: owner.branchGen + 1 };
    },
    capability: (c: typeof capability) => {
      capability = c;
    },
  };
}
const create = { storageScope: "session", op: "create", text: "actual body" };
describe("declared-only factory tool", () => {
  it("pins only the new declared contract, not active registration", () => {
    const f = fixture();
    const sdkCompatible: ToolDefinition = f.tool;
    expect(sdkCompatible.name).toBe("scoped_memory");
    expect(
      JSON.parse(
        JSON.stringify({
          declaration: "declared-only; not registered",
          name: f.tool.name,
          description: f.tool.description,
          parameters: f.tool.parameters,
        }),
      ),
    ).toEqual(surface);
    expect(f.tool.parameters.properties.storageScope.anyOf?.map((s: { const: string }) => s.const)).toEqual([
      "session",
      "hub",
    ]);
    expect(
      createScopedMemoryTool({ ...f.deps, enabled: { session: false, hub: true } }).parameters.properties.storageScope,
    ).toMatchObject({ const: "hub" });
  });
  it("real store default agent, required rev, CAS, frozen full delete body", async () => {
    const f = fixture();
    expect(await f.tool.run("c", create)).toMatchObject({ ok: true, id: "n1" });
    const target = f.session.view().items[0]!;
    expect(target.item.authority).toBe("agent");
    expect(await f.tool.run("u", { ...create, op: "update", id: "n1" })).toMatchObject({
      ok: false,
      code: "E_REV_REQUIRED",
    });
    expect(await f.tool.run("u", { ...create, op: "update", id: "n1", rev: "deadbeef" })).toMatchObject({
      ok: false,
      code: "E_CONFLICT",
    });
    f.tracker.noteInteractive(f.owner());
    let seen: OpApprovalRequest | undefined;
    const tool = createScopedMemoryTool({
      ...f.deps,
      sharedApproval: {
        ...f.deps.sharedApproval,
        request: async (r, s) => {
          seen = r;
          return f.deps.sharedApproval.request(r, s);
        },
      },
    });
    expect(
      await tool.run("d", {
        storageScope: "session",
        op: "delete",
        id: "n1",
        rev: target.rev,
        authority: "user",
        text: "substitute",
      }),
    ).toMatchObject({ ok: true });
    expect(seen?.operation.text).toBe("actual body");
    expect(Object.isFrozen(seen?.operation)).toBe(true);
    expect(seen?.binding.nonce).toMatch(/^[a-f0-9]{32}$/);
    expect(seen?.binding.opDigest).toHaveLength(64);
    expect(f.session.view().items).toEqual([]);
  });
  it("child explicit authority (even agent) and inherited user mutation rejected", async () => {
    const f = fixture(true);
    for (const authority of ["agent", "user", null])
      expect(await f.tool.run("c", { ...create, authority })).toMatchObject({ ok: false, code: "E_CHILD_AUTHORITY" });
    expect(await f.tool.run("c", create)).toMatchObject({ ok: true });
    expect(f.tool.parameters.properties.storageScope).toMatchObject({ const: "session" });
    f.branch.push({
      type: "custom",
      id: "seed",
      customType: "subagent:memory-session",
      data: {
        v: 1,
        sid: "parent",
        op: "put",
        item: {
          id: "n2",
          text: "user",
          authority: "user",
          grant: { via: "command" },
          created: "2026-11-07T00:00:00.000Z",
          updated: "2026-11-07T00:00:00.000Z",
          originSid: "parent",
        },
      },
    });
    const target = f.session.view().items.find((i) => i.item.id === "n2");
    expect(target).toBeDefined();
    expect(await f.tool.run("d", { storageScope: "session", op: "delete", id: "n2", rev: target!.rev })).toMatchObject({
      ok: false,
      code: "E_AUTHORITY",
    });
  });
  it("real hub inspect rev + shared approval + store, no proof means no popup", async () => {
    const f = fixture(),
      op = { ...create, storageScope: "hub", topic: "general" };
    expect(await f.tool.run("c", op)).toMatchObject({ ok: false, code: "E_HUB_NEEDS_HUMAN_TURN" });
    expect(f.dialogs()).toBe(0);
    f.tracker.noteInteractive(f.owner());
    expect(await f.tool.run("c", op)).toMatchObject({ ok: true, id: "general.001" });
    expect(await f.tool.run("v", { op: "view", storageScope: "hub", id: "general.001" })).toMatchObject({
      ok: true,
      rev: expect.any(String),
    });
    const i = f.hub.management.inspect("general.001");
    if (!i.ok) throw Error(i.code);
    expect(await f.tool.run("d", { storageScope: "hub", op: "delete", id: i.item.id, rev: i.rev })).toMatchObject({
      ok: true,
    });
    expect(f.hub.view().items).toEqual([]);
  });
  it("model selfauth fields and disabled/secure/locked/unknown rejected before reads", async () => {
    const f = fixture();
    for (const key of ["grant", "owner", "source", "authorized", "cap"])
      expect(await f.tool.run("c", { ...create, [key]: true })).toMatchObject({ ok: false, code: "E_META_INVALID" });
    for (const c of ["disabled", "secure", "locked", "unknown"] as const) {
      f.capability(c);
      expect(await f.tool.run("v", { op: "view", storageScope: "session" })).toMatchObject({
        ok: false,
        code: "E_WRITE_GATE",
      });
    }
    expect(f.reads()).toBe(0);
  });
  it("misbound real cap rejected and late owner/abort never writes", async () => {
    const f = fixture();
    f.tracker.noteInteractive(f.owner());
    const bad = createScopedMemoryTool({
      ...f.deps,
      sharedApproval: {
        ...f.deps.sharedApproval,
        request: async (r) => {
          const other = { ...r.operation, text: "other" };
          const { bodyTextDigest, scopedOpDigest } = await import("../../../src/memory/scopes/limits.js");
          return {
            approved: true,
            cap: f.registry.mint({
              operation: other,
              binding: { ...r.binding, opDigest: scopedOpDigest({ ...other }), textDigest: bodyTextDigest("other") },
              channel: "tui",
              project: "test",
            }),
          };
        },
      },
    });
    expect(await bad.run("c", { ...create, authority: "user" })).toMatchObject({ ok: false, code: "E_HUB_CAP_STALE" });
    expect(f.branch).toEqual([]);
    const late = createScopedMemoryTool({
      ...f.deps,
      sharedApproval: {
        ...f.deps.sharedApproval,
        request: async (r, s) => {
          const a = await f.deps.sharedApproval.request(r, s);
          f.setOwner();
          return a;
        },
      },
    });
    expect(await late.run("c", { ...create, authority: "user" })).toMatchObject({ ok: false, code: "E_STALE_SESSION" });
    expect(f.branch).toEqual([]);
    f.controller.abort();
    expect(await f.tool.run("v", { op: "view", storageScope: "session" })).toMatchObject({
      ok: false,
      code: "E_WRITE_GATE",
    });
  });
});

it("unavailable actual shared approval / RPC local-forbidden never pop up", async () => {
  const f = fixture();
  f.tracker.noteInteractive(f.owner());
  let calls = 0;
  const approval = createOpApprovalPort({
    tracker: f.tracker,
    registry: f.registry,
    localSelectForbidden: true,
    select: async () => {
      calls++;
      return "not human";
    },
  });
  const tool = createScopedMemoryTool({ ...f.deps, sharedApproval: approval });
  expect(await tool.run("c", { ...create, authority: "user" })).toMatchObject({
    ok: false,
    code: "E_HUB_CONFIRM_UNAVAILABLE",
  });
  expect(calls).toBe(0);
  expect(f.branch).toEqual([]);
});

it("real approval rejects Feishu, busy reentry; cancel+late answer cannot affect new request", async () => {
  const f = fixture();
  f.tracker.noteInteractive(f.owner());
  type Outcome = import("../../../src/ask-user/remote.js").RemoteOutcome;
  let callback: ((o: Outcome) => boolean) | undefined,
    affirm = "",
    closed = 0;
  const approval = createOpApprovalPort({
    tracker: f.tracker,
    registry: f.registry,
    remote: {
      open(req) {
        affirm = req.questions[0]!.options[1]!.label;
        return {
          setOnRemote: (fn) => {
            callback = fn;
          },
          close: () => {
            closed++;
          },
        };
      },
    },
  });
  let controller = new AbortController();
  const tool = createScopedMemoryTool({ ...f.deps, signal: () => controller.signal, sharedApproval: approval });
  const pending = tool.run("c", { ...create, authority: "user" });
  const first = callback!;
  expect(first({ kind: "answer", answers: { "0": affirm }, origin: "feishu", originKind: "feishu" })).toBe(false);
  expect(JSON.parse((await tool.execute("busy", { ...create, authority: "user" })).content[0]!.text)).toEqual({
    ok: false,
    code: "E_HUB_RATE",
    message: "上一个批准请求仍在进行中；请等它结算（批准 / 拒绝 / 超时）后再重试。",
  });
  controller.abort();
  expect(await pending).toMatchObject({ ok: false, code: "E_HUB_DECLINED" });
  expect(closed).toBe(1);
  expect(f.branch).toEqual([]);
  controller = new AbortController();
  f.tracker.noteInteractive(f.owner());
  const next = tool.run("new", { ...create, authority: "user" });
  expect(first({ kind: "answer", answers: { "0": affirm }, origin: "browser", originKind: "loopback" })).toBe(false);
  expect(callback!({ kind: "answer", answers: { "0": affirm }, origin: "browser", originKind: "loopback" })).toBe(true);
  expect(await next).toMatchObject({ ok: true });
  expect(f.session.view().items).toHaveLength(1);
});

it("tool execute preserves the per-turn approval limit message after three approved dialogs", async () => {
  const f = fixture();
  f.tracker.noteInteractive(f.owner());
  const op = { ...create, authority: "user" };
  for (let i = 0; i < 3; i++) expect(await f.tool.run(`approved-${i}`, op)).toMatchObject({ ok: true });
  expect(f.dialogs()).toBe(3);
  expect(JSON.parse((await f.tool.execute("limit", op)).content[0]!.text)).toEqual({
    ok: false,
    code: "E_HUB_RATE",
    message: "本回合批准请求次数已达上限，因此不能继续请求；请等待用户的新消息后再按需重试。",
  });
  expect(f.dialogs()).toBe(3);
  expect(f.session.view().items).toHaveLength(3);
});

it("delete approval freezes exact Hub body and CAS rejects a changed target after confirmation", async () => {
  const f = fixture();
  expect(
    await f.hub.management.command({
      storageScope: "hub",
      op: "create",
      authority: "user",
      topic: "general",
      text: "old full body",
    }),
  ).toMatchObject({ ok: true });
  const original = f.hub.management.inspect("general.001");
  if (!original.ok) throw Error(original.code);
  f.tracker.noteInteractive(f.owner());
  let frozen: OpApprovalRequest | undefined;
  const tool = createScopedMemoryTool({
    ...f.deps,
    sharedApproval: {
      ...f.deps.sharedApproval,
      request: async (r, s) => {
        frozen = r;
        const approved = await f.deps.sharedApproval.request(r, s);
        expect(
          await f.hub.management.command({
            storageScope: "hub",
            op: "update",
            authority: "user",
            targetId: original.item.id,
            expectRev: original.rev,
            text: "new body",
          }),
        ).toMatchObject({ ok: true });
        return approved;
      },
    },
  });
  expect(
    await tool.run("d", {
      storageScope: "hub",
      op: "delete",
      id: original.item.id,
      rev: original.rev,
      text: "model empty substitute",
    }),
  ).toMatchObject({ ok: false, code: "E_CONFLICT" });
  expect(frozen?.operation).toMatchObject({
    text: "old full body",
    expectRev: original.rev,
    authority: "user",
    targetId: original.item.id,
  });
  expect(f.hub.view().items[0]!.text).toBe("new body");
});

it("oversized and malformed provenance rejected before human dialogs; getters never execute", async () => {
  const f = fixture();
  f.tracker.noteInteractive(f.owner());
  let getterCalls = 0;
  expect(await f.tool.run("c", { ...create, authority: "user", text: "x".repeat(1025) })).toMatchObject({
    ok: false,
    code: "E_TOO_LARGE",
  });
  expect(await f.tool.run("c", { ...create, authority: "user", from: "untrusted-source" })).toMatchObject({
    ok: false,
    code: "E_FROM_INVALID",
  });
  const malicious = {
    ...create,
    get authority() {
      getterCalls++;
      return "user";
    },
  };
  expect(await f.tool.run("c", malicious)).toMatchObject({ ok: false, code: "E_META_INVALID" });
  expect(getterCalls).toBe(0);
  expect(f.dialogs()).toBe(0);
  expect(f.branch).toEqual([]);
});

it.each(["user", "agent"] as const)("hub authority %s uses real TUI approval and cap", async (authority) => {
  const f = fixture();
  f.tracker.noteInteractive(f.owner());
  expect(
    await f.tool.run("c", { op: "create", storageScope: "hub", topic: "general", text: "exact body", authority }),
  ).toMatchObject({ ok: true });
  expect(f.dialogs()).toBe(1);
  expect(f.hub.view().items[0]).toMatchObject({
    text: "exact body",
    authority: "user",
    grant: { via: "dialog", channel: "tui" },
  });
});

it("hub delete with explicit authority uses web confirmation and web cap", async () => {
  const f = fixture();
  expect(
    await f.hub.management.command({
      storageScope: "hub",
      op: "create",
      authority: "user",
      topic: "general",
      text: "web exact body",
    }),
  ).toMatchObject({ ok: true });
  const item = f.hub.management.inspect("general.001");
  if (!item.ok) throw Error(item.code);
  f.tracker.noteInteractive(f.owner());
  const { createDialogBridge } = await import("../../../src/web-hub/agent/dialogs.js");
  const dialogs = createDialogBridge({ enabled: true, epoch: "hub-fix", isAttached: () => true });
  const approval = createOpApprovalPort({ tracker: f.tracker, registry: f.registry, remote: dialogs });
  const tool = createScopedMemoryTool({ ...f.deps, sharedApproval: approval });
  const pending = tool.run("delete-web", {
    op: "delete",
    storageScope: "hub",
    id: item.item.id,
    rev: item.rev,
    authority: "user",
  });
  const dialog = dialogs.frame().open[0]!;
  expect(dialog.questions[0]!.question).toContain("web exact body");
  expect(
    dialogs.answer(
      dialog.dialogId,
      [{ selected: [dialog.questions[0]!.options[1]!.label], other: null }],
      { listener: "loopback", ip: "127.0.0.1", reqId: "web-fix" },
      "answer",
      "hub-fix",
    ),
  ).toMatchObject({ ok: true });
  expect(await pending).toMatchObject({ ok: true });
  expect(f.hub.view().items).toEqual([]);
  const audit = readFileSync(join(f.dir, "hub-memory", "audit.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(audit.at(-1)).toMatchObject({ op: "delete", channel: "web", via: "dialog" });
  dialogs.dispose();
});

it.each(["user", "agent"] as const)(
  "hub authority %s cannot bypass missing proof or rejected confirmation",
  async (authority) => {
    const f = fixture();
    const op = { op: "create", storageScope: "hub", topic: "general", text: "must not persist", authority };
    expect(await f.tool.run("no-proof", op)).toMatchObject({ ok: false, code: "E_HUB_NEEDS_HUMAN_TURN" });
    expect(f.dialogs()).toBe(0);
    f.tracker.noteInteractive(f.owner());
    const approval = createOpApprovalPort({
      tracker: f.tracker,
      registry: f.registry,
      select: async (_title, choices) => choices[0],
    });
    expect(await createScopedMemoryTool({ ...f.deps, sharedApproval: approval }).run("decline", op)).toMatchObject({
      ok: false,
      code: "E_HUB_DECLINED",
    });
    expect(f.hub.view().items).toEqual([]);
  },
);

it("explains the screenshot input and preserves the existing hub authority semantics", async () => {
  const f = fixture();
  const result = (await f.tool.run("screenshot", {
    storageScope: "hub",
    authority: "agent",
    id: "",
    rev: "",
    op: "create",
  })) as { ok: boolean; code: string; message: string };
  expect(result).toMatchObject({ ok: false, code: "E_META_INVALID" });
  expect(result.message).toContain("user");
  expect(result.message).toContain("id");
  expect(result.message).toContain("rev");
  expect(result.message).toContain("空字符串");
  expect(f.hub.view().items).toEqual([]);
});

it("adds guidance to failures returned by the underlying management port", async () => {
  const f = fixture();
  expect(await f.tool.run("bad-id", { op: "view", storageScope: "hub", id: "invalid" })).toMatchObject({
    ok: false,
    code: "E_META_INVALID",
    message: expect.any(String),
  });
});
